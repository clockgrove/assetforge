/**
 * Registration: every figure gets the same scale (after per-family normalisation) and is placed so
 * its feet baseline sits on anchor.y and its centre of mass on anchor.x, in the target's frame size.
 *
 * Coordinate convention: the centre of mass of a pixel in column x is x + 0.5, so a figure centred
 * on the anchor column has centerX = anchor.x + 0.5; the baseline is a row index.
 */
import { flipHorizontal, resampleTo } from "../image/resample.ts";
import type { Raster } from "../image/raster.ts";
import { opaqueBox } from "../image/raster.ts";
import type { Point, Transform } from "../types.ts";
import type { FrameMeasure, RegisterOptions, RegisteredFrame, Registration } from "./types.ts";

export { flipHorizontal };

export function measureFrame(image: Raster, threshold = 128): FrameMeasure | undefined {
  let baseline = -1;
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const a = image.data[(y * image.width + x) * 4 + 3] as number;
      if (a === 0) continue;
      sum += a;
      sx += a * (x + 0.5);
      sy += a * (y + 0.5);
      if (a >= threshold) baseline = y;
    }
  }
  if (baseline < 0) return undefined;
  return { baseline, centerX: sx / sum, centerY: sy / sum, area: sum / 255 };
}

function deviation(m: FrameMeasure | undefined, anchor: Point): number {
  if (!m) return Number.POSITIVE_INFINITY;
  return Math.max(Math.abs(m.baseline - anchor.y), Math.abs(m.centerX - (anchor.x + 0.5)));
}

/** Largest deviation of baseline and centre of mass from the anchor, per frame and overall, in px. */
export function jitterOf(
  frames: Raster[],
  anchor: Point,
  threshold = 128,
): { maxPx: number; perFrame: number[] } {
  const perFrame = frames.map((f) => deviation(measureFrame(f, threshold), anchor));
  return { maxPx: Math.max(0, ...perFrame), perFrame };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function registerFrames(figures: Raster[], options: RegisterOptions): Registration {
  const { frame, anchor, edges } = options;
  const threshold = options.measureThreshold ?? 128;
  const margin = options.margin ?? 1;
  const [lo, hi] = options.clamp ?? [0.8, 1.25];
  const measures = figures.map((f, i) => {
    const m = measureFrame(f, threshold);
    if (!m) throw new Error(`figure ${i + 1} has no pixel at or above alpha ${threshold}`);
    return m;
  });

  const norms = measures.map(() => 1);
  if (options.families) {
    const { families } = options;
    if (families.length !== figures.length)
      throw new Error("families must name one family per figure");
    measures.forEach((m, i) => {
      const peers = measures.filter((_, j) => families[j] === families[i]);
      const target = median(peers.map((p) => Math.sqrt(p.area)));
      norms[i] = Math.min(hi, Math.max(lo, target / Math.sqrt(m.area)));
    });
  }

  let scale = options.scale;
  if (scale === undefined) {
    // Per unit scale, each figure's reach left, right and above its anchor point; rows below the
    // baseline are faint and may be clipped by the frame bottom.
    let best = Number.POSITIVE_INFINITY;
    figures.forEach((f, i) => {
      const box = opaqueBox(f);
      const m = measures[i] as FrameMeasure;
      const n = norms[i] as number;
      if (!box) return;
      const left = (m.centerX - box.x) * n;
      const right = (box.x + box.width - m.centerX) * n;
      const up = (m.baseline + 1 - box.y) * n;
      best = Math.min(
        best,
        (anchor.x + 0.5 - margin) / left,
        (frame.width - margin - anchor.x - 0.5) / right,
        (anchor.y + 1 - margin) / up,
      );
    });
    if (!Number.isFinite(best) || best <= 0) throw new Error("the figures do not fit the frame");
    scale = best;
  }

  const frames: RegisteredFrame[] = figures.map((f, i) => {
    const m = measures[i] as FrameMeasure;
    const n = norms[i] as number;
    const t = scale * n;
    let x = anchor.x + 0.5 - m.centerX * t;
    let y = anchor.y + 1 - (m.baseline + 1) * t;
    if (edges === "crisp") {
      x = Math.round(x);
      y = Math.round(y);
    }
    const image = resampleTo(f, t, { x, y }, frame, edges);
    const measure = measureFrame(image, threshold);
    if (!measure) throw new Error(`figure ${i + 1} vanished when scaled into the frame`);
    const transforms: Transform[] = [];
    if (options.families) transforms.push({ op: "normalize-scale", factor: n });
    transforms.push({ op: "scale", factor: t, filter: edges });
    transforms.push({ op: "place", offset: { x, y }, frame: { ...frame }, anchor: { ...anchor } });
    return { image, measure, jitterPx: deviation(measure, anchor), transforms };
  });

  return { frames, scale, jitterPx: Math.max(0, ...frames.map((f) => f.jitterPx)) };
}
