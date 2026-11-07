/**
 * Background removal for one sliced figure. Interior pixels stay opaque and untouched; only a thin
 * band around the figure's mask is unmixed from the background colour into soft alpha. The style
 * profile then decides whether alpha stays soft or is thresholded, and whether colours are snapped
 * to a palette. Nothing here assumes a style.
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
 * the nearby solid interior) and the background: alpha is the projection of c - bg onto fg - bg,
 * and the colour is unmixed with it. Without a usable foreground estimate, the smallest alpha at
 * which `c` is a blend of some colour and the background is used instead.
 */
function unmix(
  c: readonly number[],
  bg: Rgb,
  fg?: readonly number[],
): { alpha: number; colour: Rgb } {
  let a = 0;
  const span = fg ? distance(fg, bg) : 0;
  if (fg && span > 3 * NOISE) {
    let dot = 0;
    for (let k = 0; k < 3; k++) dot += ((c[k] ?? 0) - (bg[k] ?? 0)) * ((fg[k] ?? 0) - (bg[k] ?? 0));
    a = Math.max(0, Math.min(1, dot / (span * span)));
  } else {
    for (let k = 0; k < 3; k++) {
      const ck = c[k] ?? 0;
      const bk = bg[k] ?? 0;
      let ak = 0;
      if (ck > bk + NOISE) ak = (ck - bk) / (255 - bk);
      else if (ck < bk - NOISE) ak = (bk - ck) / bk;
      if (ak > a) a = ak;
    }
  }
  if (a < MIN_ALPHA / 255) return { alpha: 0, colour: [0, 0, 0] };
  const f = ([0, 1, 2] as const).map((k) =>
    Math.max(0, Math.min(255, Math.round(((c[k] ?? 0) - (1 - a) * (bg[k] ?? 0)) / a))),
  );
  return { alpha: a, colour: [f[0] ?? 0, f[1] ?? 0, f[2] ?? 0] };
}

/**
 * The local foreground colour near (x, y): the mean of the solid interior pixels (mask 1, outside
 * the band) within `radius`, else of the mask pixels within it that differ most from the
 * background (thin parts such as legs have no interior).
 */
function localForeground(
  crop: Raster,
  mask: Uint8Array,
  near: Uint8Array,
  x: number,
  y: number,
  radius: number,
  bg: Rgb,
): number[] | undefined {
  const { width, height } = crop;
  let best: { d: number; sum: number[]; n: number } | undefined;
  const sum = [0, 0, 0];
  let n = 0;
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
        n++;
      }
      const d = distance(px, bg);
      if (!best || d > best.d) best = { d, sum: px, n: 1 };
    }
  }
  if (n > 0) return sum.map((v) => v / n);
  return best?.sum;
}

export function matteFigure(
  figure: SlicedFigure,
  style: ResolvedStyle,
  options: { band?: number; tolerance?: number } = {},
): MattedFigure {
  const band = options.band ?? 2;
  const tolerance = options.tolerance ?? 24;
  const { crop, mask, background } = figure;
  const { width, height } = crop;
  const near = nearOpposite(mask, width, height, band);
  const out = createRaster(width, height);
  const hasAlpha = (() => {
    for (let i = 3; i < crop.data.length; i += 4) if ((crop.data[i] ?? 255) < 255) return true;
    return false;
  })();
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
    },
  ];

  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const px = [crop.data[i] ?? 0, crop.data[i + 1] ?? 0, crop.data[i + 2] ?? 0];
    const m = mask[p] === 1;
    let alpha = 0;
    let colour: readonly number[] = [0, 0, 0];
    if (hasAlpha) {
      const inRegion = m || grown?.[p] === 1;
      alpha = inRegion ? (crop.data[i + 3] ?? 0) : 0;
      colour = px;
    } else if (!near[p]) {
      if (m) {
        alpha = 255;
        colour = px;
      }
    } else {
      const fg = localForeground(
        crop,
        mask,
        near,
        p % width,
        Math.floor(p / width),
        band + 2,
        background,
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

  return { image: out, quality: matteQuality(out, background, tolerance), transforms };
}

export function matteQuality(image: Raster, background: Rgb, tolerance = 24): MatteQuality {
  const { width, height, data } = image;
  const alphaAt = (x: number, y: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : (data[(y * width + x) * 4 + 3] ?? 0);
  let softPixels = 0;
  let edgePixels = 0;
  let haloPixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3] ?? 0;
      if (a > 0 && a < 255) softPixels++;
      if (a === 0) continue;
      if (
        alphaAt(x - 1, y) === 0 ||
        alphaAt(x + 1, y) === 0 ||
        alphaAt(x, y - 1) === 0 ||
        alphaAt(x, y + 1) === 0
      ) {
        edgePixels++;
        if (distance([data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0], background) <= tolerance) {
          haloPixels++;
        }
      }
    }
  }
  return {
    softPixels,
    haloPixels,
    edgePixels,
    haloFraction: edgePixels === 0 ? 0 : haloPixels / edgePixels,
  };
}

/** Deterministic halo and leftover-background checks over a matte's measured quality. */
export function matteChecks(
  quality: MatteQuality,
  options: { maxHaloFraction?: number } = {},
): Reason[] {
  const max = options.maxHaloFraction ?? 0.005;
  const halo = quality.haloFraction <= max;
  const leftover = quality.edgePixels > 0 && quality.haloPixels <= 2;
  return [
    {
      check: "halo",
      passed: halo,
      reason: `${quality.haloPixels} of ${quality.edgePixels} edge pixels (${(quality.haloFraction * 100).toFixed(2)}%) keep the background colour; the limit is ${(max * 100).toFixed(2)}%`,
      source: "deterministic",
    },
    {
      check: "background",
      passed: leftover,
      reason:
        quality.edgePixels === 0
          ? "no transparent edge: the background was not removed"
          : `${quality.haloPixels} edge pixels are leftover background colour; at most 2 are allowed`,
      source: "deterministic",
    },
  ];
}
