/**
 * The deterministic edge-halo check of a strip: a soft edge that carries a colour the figure does
 * not have there (a tint left by a removed background, or a fringe from unmixing it), and
 * transparent pixels that keep a colour. Nothing here assumes a style.
 */
import type { Raster } from "../image/raster.ts";
import type { AnimationReason, AnimationThresholds } from "./types.ts";

/** Px within which a soft edge pixel finds the figure colours it fades from. */
const HALO_RADIUS = 3;
/** RGB distance from every nearby opaque colour beyond which a soft edge pixel is a halo. */
const HALO_DISTANCE = 64;

export interface FrameHalo {
  /** Soft edge pixels (0 < alpha < 255) with a fully opaque pixel within HALO_RADIUS px. */
  edgePixels: number;
  /** Of those, the ones whose colour is far from every opaque colour within reach. */
  haloPixels: number;
  /** Fully transparent pixels that still carry a colour. */
  colouredTransparent: number;
}

/**
 * The colour halo of one frame. A soft edge pixel should carry the colour of the figure it fades
 * from, so its colour must be near one of the fully opaque pixels within HALO_RADIUS px. A
 * transparent pixel that keeps a colour shows wherever a renderer or provider drops alpha.
 */
export function frameHalo(frame: Raster): FrameHalo {
  const { width, height, data } = frame;
  let edgePixels = 0;
  let haloPixels = 0;
  let colouredTransparent = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3] ?? 0;
      if (a === 0) {
        if (data[i] || data[i + 1] || data[i + 2]) colouredTransparent++;
        continue;
      }
      if (a === 255) continue;
      let best = Infinity;
      for (let dy = -HALO_RADIUS; dy <= HALO_RADIUS; dy++) {
        for (let dx = -HALO_RADIUS; dx <= HALO_RADIUS; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const j = (yy * width + xx) * 4;
          if (data[j + 3] !== 255) continue;
          const d = Math.hypot(
            (data[i] ?? 0) - (data[j] ?? 0),
            (data[i + 1] ?? 0) - (data[j + 1] ?? 0),
            (data[i + 2] ?? 0) - (data[j + 2] ?? 0),
          );
          if (d < best) best = d;
        }
      }
      if (best === Infinity) continue;
      edgePixels++;
      if (best > HALO_DISTANCE) haloPixels++;
    }
  }
  return { edgePixels, haloPixels, colouredTransparent };
}

/** The share of a frame's soft edge (and coloured transparent pixels) that is halo. */
export function haloShare(h: FrameHalo): number {
  const total = h.edgePixels + h.colouredTransparent;
  return total === 0 ? 0 : (h.haloPixels + h.colouredTransparent) / total;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** The `edge-halo` reasons of a strip: one passing reason, or one failing reason per frame. */
export function edgeHaloReasons(
  frames: Raster[],
  thresholds: Pick<AnimationThresholds, "edgeHaloShare">,
): AnimationReason[] {
  const limit = thresholds.edgeHaloShare;
  const halos = frames.map(frameHalo);
  const failing = halos.map((h, i) => ({ h, i, s: haloShare(h) })).filter((x) => x.s > limit);
  if (failing.length === 0) {
    const worst = Math.max(0, ...halos.map(haloShare));
    return [
      {
        check: "edge-halo",
        passed: true,
        reason: `every frame's soft edge carries the figure's own colours: at most ${pct(worst)} of it is more than ${HALO_DISTANCE} from every opaque colour within ${HALO_RADIUS} px (limit ${pct(limit)})`,
        source: "deterministic",
      },
    ];
  }
  return failing.map(({ h, i, s }) => ({
    check: "edge-halo",
    passed: false,
    reason:
      `frame ${i + 1}: ${h.haloPixels} of ${h.edgePixels} soft edge pixels carry a colour more than ${HALO_DISTANCE} from every opaque colour within ${HALO_RADIUS} px` +
      (h.colouredTransparent > 0
        ? `, and ${h.colouredTransparent} transparent pixels keep a colour`
        : "") +
      ` (${pct(s)}, limit ${pct(limit)})`,
    source: "deterministic",
    frames: [i + 1],
  }));
}
