/**
 * Background removal for one sliced figure. Interior pixels stay opaque and untouched; only a thin
 * band around the figure's mask is unmixed from the background colour into soft alpha. Light
 * markings that slicing took for background (they sit within the colour tolerance) are given back
 * to the figure first: only pixels that are the flat background colour, and the blend right next to
 * them, are background. The style profile then decides whether alpha stays soft or is thresholded,
 * and whether colours are snapped to a palette. Nothing here assumes a style.
 */
import { createRaster, parseHex, toHex } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import type { ResolvedStyle } from "../style.ts";
import type { Reason, Rgb, Transform } from "../types.ts";
import type { MatteQuality, MattedFigure, SlicedFigure } from "./types.ts";

/** Alpha below this (of 255) after unmixing is noise and becomes 0. */
const MIN_ALPHA = 8;
/** Per-channel difference from the background ignored as sensor or compression noise. */
const NOISE = 4;
/** The least RGB distance within which a pixel is the flat background colour itself. */
const FLAT_MIN = 2 * NOISE;
/**
 * An enclosed run of background-like pixels can be a gap (background showing through) only when
 * at least this share of it is the flat background colour or a blend of it with the figure around
 * it; otherwise it is a light marking of the figure.
 */
const GAP_FLAT_SHARE = 0.5;
/** Flat pixels that show an enclosed gap even without a flat core (a 2 x 2 gap). */
const GAP_MIN_FLAT = 4;
/** RGB distance within which a blend of the background and a colour explains a pixel. */
const EXPLAINED = 3 * NOISE;

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(
    (a[0] ?? 0) - (b[0] ?? 0),
    (a[1] ?? 0) - (b[1] ?? 0),
    (a[2] ?? 0) - (b[2] ?? 0),
  );
}

/** Per pixel: whether a pixel with the opposite mask value lies within `band` px (Euclidean). */
function nearOpposite(mask: Uint8Array, width: number, height: number, band: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const r = Math.ceil(band);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const own = mask[y * width + x];
      let near = 0;
      for (let dy = -r; dy <= r && !near; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width || dx * dx + dy * dy > band * band) continue;
          if (mask[yy * width + xx] !== own) {
            near = 1;
            break;
          }
        }
      }
      out[y * width + x] = near;
    }
  }
  return out;
}

/**
 * The alpha and colour of an edge pixel `c` as a blend of a local foreground colour `fg` (read from
 * the nearby solid interior) and the background: alpha is the projection of c - bg onto fg - bg.
 * The colour is `fg` plus what of `c` the blend does not explain, scaled by alpha and never divided
 * by it: dividing amplifies the background's tint and noise into a saturated fringe on faint pixels. Without a
 * usable foreground estimate (the figure is the background's colour there), the smallest alpha at
 * which `c` is a blend of some colour and the background is used, and the pixel keeps its colour.
 */
function unmix(
  c: readonly number[],
  bg: Rgb,
  fg?: readonly number[],
): { alpha: number; colour: Rgb } {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const span = fg ? distance(fg, bg) : 0;
  if (fg && span > 3 * NOISE) {
    let dot = 0;
    for (let k = 0; k < 3; k++) dot += ((c[k] ?? 0) - (bg[k] ?? 0)) * ((fg[k] ?? 0) - (bg[k] ?? 0));
    const a = Math.max(0, Math.min(1, dot / (span * span)));
    if (a < MIN_ALPHA / 255) return { alpha: 0, colour: [0, 0, 0] };
    const f = ([0, 1, 2] as const).map((k) => {
      const blend = a * (fg[k] ?? 0) + (1 - a) * (bg[k] ?? 0);
      return clamp((fg[k] ?? 0) + a * ((c[k] ?? 0) - blend));
    });
    return { alpha: a, colour: [f[0] ?? 0, f[1] ?? 0, f[2] ?? 0] };
  }
  let a = 0;
  for (let k = 0; k < 3; k++) {
    const ck = c[k] ?? 0;
    const bk = bg[k] ?? 0;
    let ak = 0;
    if (ck > bk + NOISE) ak = (ck - bk) / (255 - bk);
    else if (ck < bk - NOISE) ak = (bk - ck) / bk;
    if (ak > a) a = ak;
  }
  if (a < MIN_ALPHA / 255) return { alpha: 0, colour: [0, 0, 0] };
  return { alpha: a, colour: [clamp(c[0] ?? 0), clamp(c[1] ?? 0), clamp(c[2] ?? 0)] };
}

/**
 * The local foreground colours near (x, y): first the mean of the solid interior pixels (mask 1,
 * outside the band) within `radius`, else the mask pixel within it that differs most from the
 * background (thin parts such as legs have no interior); then each solid interior pixel, for an
 * edge pixel whose colour the mean does not explain (a pale strand beside dark fur).
 */
function localForeground(
  crop: Raster,
  mask: Uint8Array,
  near: Uint8Array,
  x: number,
  y: number,
  radius: number,
  bg: Rgb,
): number[][] {
  const { width, height } = crop;
  let best: { d: number; px: number[] } | undefined;
  const sum = [0, 0, 0];
  const solid: number[][] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const p = yy * width + xx;
      if (mask[p] !== 1) continue;
      const px = [crop.data[p * 4] ?? 0, crop.data[p * 4 + 1] ?? 0, crop.data[p * 4 + 2] ?? 0];
      if (!near[p]) {
        for (let k = 0; k < 3; k++) sum[k] = (sum[k] ?? 0) + (px[k] ?? 0);
        solid.push(px);
      }
      const d = distance(px, bg);
      if (!best || d > best.d) best = { d, px };
    }
  }
  if (solid.length > 0) return [sum.map((v) => v / solid.length), ...solid];
  return best ? [best.px] : [];
}

/** How far `c` is from the nearest blend of `fg` and `bg` (alpha clamped to 0..1). */
function residual(c: readonly number[], bg: Rgb, fg: readonly number[]): number {
  const span = distance(fg, bg);
  if (span <= 3 * NOISE) return Infinity;
  let dot = 0;
  for (let k = 0; k < 3; k++) dot += ((c[k] ?? 0) - (bg[k] ?? 0)) * ((fg[k] ?? 0) - (bg[k] ?? 0));
  const a = Math.max(0, Math.min(1, dot / (span * span)));
  return Math.hypot(
    ...([0, 1, 2] as const).map((k) => (c[k] ?? 0) - a * (fg[k] ?? 0) - (1 - a) * (bg[k] ?? 0)),
  );
}

/**
 * The foreground colour an edge pixel is unmixed against: the candidate that explains it best as a
 * blend with the background, or the first candidate (the local mean, steadier than any one pixel)
 * when it explains the pixel within noise of the best.
 */
function pickForeground(
  c: readonly number[],
  bg: Rgb,
  candidates: number[][],
): number[] | undefined {
  const [first] = candidates;
  if (!first) return undefined;
  const firstR = residual(c, bg, first);
  let best = first;
  let bestR = firstR;
  for (const f of candidates) {
    const r = residual(c, bg, f);
    if (r < bestR) {
      bestR = r;
      best = f;
    }
  }
  return firstR <= bestR + NOISE ? first : best;
}

/**
 * The RGB distance within which a pixel is the flat background colour: the spread of the crop's own
 * border background (its 99th percentile, plus noise), at least FLAT_MIN and at most `cap`.
 */
function flatTolerance(
  crop: Raster,
  mask: Uint8Array,
  excluded: Uint8Array | undefined,
  bg: Rgb,
  cap: number,
): number {
  const { width, height, data } = crop;
  const d: number[] = [];
  const sample = (x: number, y: number) => {
    const p = y * width + x;
    if (mask[p] === 1 || excluded?.[p] === 1) return;
    d.push(distance([data[p * 4] ?? 0, data[p * 4 + 1] ?? 0, data[p * 4 + 2] ?? 0], bg));
  };
  for (let x = 0; x < width; x++) {
    sample(x, 0);
    if (height > 1) sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    sample(0, y);
    if (width > 1) sample(width - 1, y);
  }
  d.sort((a, b) => a - b);
  const p99 = d[Math.floor(0.99 * (d.length - 1))] ?? 0;
  return Math.min(cap, Math.max(FLAT_MIN, p99 + NOISE));
}

/**
 * Whether pixel p is mostly background blended with a figure colour around it (within 4 px): a
 * blend of the background and that colour explains it within noise, at alpha 0.5 or less.
 */
function backgroundBlend(crop: Raster, mask: Uint8Array, p: number, bg: Rgb): boolean {
  const { width, height, data } = crop;
  const c = [data[p * 4] ?? 0, data[p * 4 + 1] ?? 0, data[p * 4 + 2] ?? 0];
  const x = p % width;
  const y = (p - x) / width;
  const radius = 4;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const q = yy * width + xx;
      if (mask[q] !== 1) continue;
      const f = [data[q * 4] ?? 0, data[q * 4 + 1] ?? 0, data[q * 4 + 2] ?? 0];
      const span = distance(f, bg);
      if (span <= 3 * NOISE) continue;
      let dot = 0;
      for (let k = 0; k < 3; k++)
        dot += ((c[k] ?? 0) - (bg[k] ?? 0)) * ((f[k] ?? 0) - (bg[k] ?? 0));
      const a = dot / (span * span);
      if (a < 0 || a > 0.5) continue;
      if (residual(c, bg, f) <= EXPLAINED) return true;
    }
  }
  return false;
}

/**
 * The figure's mask with the light markings slicing missed given back: the parts of the figure
 * within the slice tolerance of the background colour (a white blaze on a pale sheet). The
 * background is the flat background colour, and every non-figure pixel within `reach` px of it
 * (the blend at the edge). A flat run counts only where background can be: connected to the crop's
 * border, or an enclosed gap (a space between an arm and the body) that is mostly background and
 * shows it. Every other non-figure pixel (a marking, a highlight in it, or a hole in one) joins the
 * figure. Dropped labels, specks and neighbours never join.
 */
function reclaimMarkings(
  figure: Pick<SlicedFigure, "crop" | "mask" | "excluded" | "background">,
  options: { reach: number; flat: number },
): { mask: Uint8Array; flat: Uint8Array; reclaimed: number } {
  const { crop, mask, excluded, background: bg } = figure;
  const { width, height, data } = crop;
  const n = width * height;
  const flat = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if (mask[p] === 1) continue;
    const c = [data[p * 4] ?? 0, data[p * 4 + 1] ?? 0, data[p * 4 + 2] ?? 0];
    if (distance(c, bg) <= options.flat) flat[p] = 1;
  }
  // Regions of non-figure pixels (4-connected); keep the flat pixels of the background ones.
  const region = new Int32Array(n).fill(-1);
  const seed = new Uint8Array(n);
  let next = 0;
  for (let start = 0; start < n; start++) {
    if (mask[start] === 1 || region[start] !== -1) continue;
    const members: number[] = [];
    const stack = [start];
    region[start] = next;
    let touches = false;
    let flats = 0;
    while (stack.length > 0) {
      const p = stack.pop() as number;
      members.push(p);
      flats += flat[p] ?? 0;
      const x = p % width;
      const y = (p - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touches = true;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (q < 0 || q >= n || mask[q] === 1 || region[q] !== -1) continue;
        region[q] = next;
        stack.push(q);
      }
    }
    if (touches) {
      for (const p of members) if (flat[p]) seed[p] = 1;
    } else {
      // An enclosed gap shows the background: a flat core (a flat pixel whose four neighbours are
      // flat too), a few flat pixels together, or, in a narrow gap, flat pixels among blends of the
      // background with the figure around it. A light marking shows none of these: a stray flat
      // pixel in it is a highlight, and a pale grey marking can sit on the line from the background
      // to the fur, but is never flat.
      const core = members.some(
        (p) => flat[p] && flat[p - 1] && flat[p + 1] && flat[p - width] && flat[p + width],
      );
      const blends = members.filter((p) => !flat[p] && backgroundBlend(crop, mask, p, bg));
      const shows = core || flats >= GAP_MIN_FLAT || (flats > 0 && blends.length > 0);
      if (shows && flats + blends.length >= GAP_FLAT_SHARE * members.length) {
        for (const p of members) if (flat[p]) seed[p] = 1;
        for (const p of blends) seed[p] = 1;
      }
    }
    next++;
  }
  // Background is the seeds grown by `reach`; every other non-figure pixel is the figure's.
  const r = Math.ceil(options.reach);
  const out = Uint8Array.from(mask);
  let reclaimed = 0;
  for (let p = 0; p < n; p++) {
    if (mask[p] === 1 || seed[p] === 1 || excluded?.[p] === 1) continue;
    const x = p % width;
    const y = (p - x) / width;
    let background = false;
    for (let dy = -r; dy <= r && !background; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= height) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= width || dx * dx + dy * dy > options.reach * options.reach) continue;
        if (seed[yy * width + xx] === 1) {
          background = true;
          break;
        }
      }
    }
    if (!background) {
      out[p] = 1;
      reclaimed++;
    }
  }
  return { mask: out, flat, reclaimed };
}

export function matteFigure(
  figure: SlicedFigure,
  style: ResolvedStyle,
  options: { band?: number; tolerance?: number } = {},
): MattedFigure {
  const band = options.band ?? 2;
  const tolerance = options.tolerance ?? 24;
  const { crop, background, excluded } = figure;
  const { width, height } = crop;
  const hasAlpha = (() => {
    for (let i = 3; i < crop.data.length; i += 4) if ((crop.data[i] ?? 255) < 255) return true;
    return false;
  })();
  // On a sheet with real alpha the background is transparency, and the author's holes are meant.
  const flat = hasAlpha ? 0 : flatTolerance(crop, figure.mask, excluded, background, tolerance);
  const { mask, reclaimed, ...reclaim } = hasAlpha
    ? { mask: figure.mask, reclaimed: 0, flat: undefined }
    : reclaimMarkings(figure, { reach: band + 1, flat });
  const near = nearOpposite(mask, width, height, band);
  // A pixel off the figure that is not the flat background colour, within reach of the figure, is a
  // blend (a strand of fur over the background) and is unmixed too, so a fur fringe is not riddled
  // with transparent specks.
  const wide = reclaim.flat ? nearOpposite(mask, width, height, band + 2) : undefined;
  const blend = (p: number) => reclaim.flat?.[p] === 0 && wide?.[p] === 1;
  const out = createRaster(width, height);
  // For source alpha: the mask region is the mask grown by the band.
  const grown = hasAlpha
    ? nearOpposite(
        Uint8Array.from(mask, (m) => 1 - m),
        width,
        height,
        band,
      )
    : undefined;

  const transforms: Transform[] = [
    ...figure.transforms,
    {
      op: "matte",
      mode: hasAlpha ? "source-alpha" : "unmix",
      background: toHex(background),
      band,
      ...(!hasAlpha && { markingPixels: reclaimed }),
    },
  ];

  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const px = [crop.data[i] ?? 0, crop.data[i + 1] ?? 0, crop.data[i + 2] ?? 0];
    const m = mask[p] === 1;
    let alpha = 0;
    let colour: readonly number[] = [0, 0, 0];
    if (!m && excluded?.[p] === 1) {
      // A dropped label, speck or neighbour (or its fringe): never part of the frame.
    } else if (hasAlpha) {
      const inRegion = m || grown?.[p] === 1;
      alpha = inRegion ? (crop.data[i + 3] ?? 0) : 0;
      colour = px;
    } else if (!near[p] && (m || !blend(p))) {
      if (m) {
        alpha = 255;
        colour = px;
      }
    } else {
      const fg = pickForeground(
        px,
        background,
        localForeground(crop, mask, near, p % width, Math.floor(p / width), band + 2, background),
      );
      const u = unmix(px, background, fg);
      alpha = Math.round(u.alpha * 255);
      colour = u.colour;
    }
    out.data[i] = alpha === 0 ? 0 : (colour[0] ?? 0);
    out.data[i + 1] = alpha === 0 ? 0 : (colour[1] ?? 0);
    out.data[i + 2] = alpha === 0 ? 0 : (colour[2] ?? 0);
    out.data[i + 3] = alpha;
  }

  if (style.alpha.mode === "binary") {
    for (let i = 3; i < out.data.length; i += 4) {
      out.data[i] = (out.data[i] ?? 0) >= style.alpha.threshold ? 255 : 0;
      if (out.data[i] === 0) {
        out.data[i - 3] = 0;
        out.data[i - 2] = 0;
        out.data[i - 1] = 0;
      }
    }
    transforms.push({ op: "binarize", threshold: style.alpha.threshold });
  }

  if (style.color.rule === "palette") {
    const palette = style.color.palette.map(parseHex);
    for (let i = 0; i < out.data.length; i += 4) {
      if ((out.data[i + 3] ?? 0) === 0) continue;
      let best = palette[0] as Rgb;
      let bestD = Infinity;
      for (const c of palette) {
        const d = distance(c, [out.data[i] ?? 0, out.data[i + 1] ?? 0, out.data[i + 2] ?? 0]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      out.data[i] = best[0];
      out.data[i + 1] = best[1];
      out.data[i + 2] = best[2];
    }
    transforms.push({ op: "quantize", palette: style.color.palette });
  }

  return {
    image: out,
    // Halo and leftover background are the background colour itself (the flat tolerance), so a
    // light marking given back to the figure is not counted as either.
    quality: matteQuality(out, background, hasAlpha ? tolerance : flat, { interior: !hasAlpha }),
    transforms,
  };
}

/**
 * Edge and interior measurements of a matte; a pixel within `tolerance` of the background is its
 * colour. `interior` (default true) counts opaque interior pixels of that colour; off for
 * source-alpha sheets, where the background is transparency and its colour estimate means nothing.
 */
export function matteQuality(
  image: Raster,
  background: Rgb,
  tolerance = 24,
  options: { interior?: boolean } = {},
): MatteQuality {
  const interior = options.interior ?? true;
  const { width, height, data } = image;
  const alphaAt = (x: number, y: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : (data[(y * width + x) * 4 + 3] ?? 0);
  let softPixels = 0;
  let edgePixels = 0;
  let haloPixels = 0;
  let visiblePixels = 0;
  let backgroundPixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3] ?? 0;
      if (a > 0 && a < 255) softPixels++;
      if (a === 0) continue;
      visiblePixels++;
      const nearBackground =
        distance([data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0], background) <= tolerance;
      if (
        alphaAt(x - 1, y) === 0 ||
        alphaAt(x + 1, y) === 0 ||
        alphaAt(x, y - 1) === 0 ||
        alphaAt(x, y + 1) === 0
      ) {
        edgePixels++;
        if (nearBackground) haloPixels++;
      } else if (interior && a === 255 && nearBackground) backgroundPixels++;
    }
  }
  return {
    softPixels,
    haloPixels,
    edgePixels,
    haloFraction: edgePixels === 0 ? 0 : haloPixels / edgePixels,
    visiblePixels,
    backgroundPixels,
  };
}

/**
 * Deterministic halo and leftover-background checks over a matte's measured quality, both under
 * one limit (default 0.5%): halo is the share of edge pixels that keep the background colour;
 * background is the share of visible pixels that are opaque background colour inside the figure,
 * and fails outright when nothing was made transparent.
 */
export function matteChecks(
  quality: MatteQuality,
  options: { maxHaloFraction?: number } = {},
): Reason[] {
  const max = options.maxHaloFraction ?? 0.005;
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  const halo = quality.haloFraction <= max;
  const leftoverFraction =
    quality.visiblePixels === 0 ? 0 : quality.backgroundPixels / quality.visiblePixels;
  const leftover = quality.edgePixels > 0 && leftoverFraction <= max;
  return [
    {
      check: "halo",
      passed: halo,
      reason: `${quality.haloPixels} of ${quality.edgePixels} edge pixels (${pct(quality.haloFraction)}) keep the background colour; the limit is ${pct(max)}`,
      source: "deterministic",
    },
    {
      check: "background",
      passed: leftover,
      reason:
        quality.edgePixels === 0
          ? "no transparent edge: the background was not removed"
          : `${quality.backgroundPixels} of ${quality.visiblePixels} visible pixels (${pct(leftoverFraction)}) are opaque background colour inside the figure; the limit is ${pct(max)}`,
      source: "deterministic",
    },
  ];
}
