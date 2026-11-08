import { drawDigits, textWidth } from "../image/digits.ts";
import { createRaster, getPixel, setPixel } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { encodeAnimatedWebp } from "../image/webp.ts";
import type { Point, Size } from "../types.ts";

/** Media types of the two preview files, for callers that declare each output's type. */
export const PREVIEW_MEDIA_TYPES = { onion: "image/png", preview: "image/webp" } as const;

const BACKDROP = 236;
const MAX_COLUMNS = 8;
const PAD = 4;
const LABEL_HEIGHT = 20;
const NEIGHBOUR_OPACITY = 0.35;
const OVERLAY_OPACITY = 0.3;
const PREVIOUS_TINT: readonly number[] = [255, 0, 0];
const NEXT_TINT: readonly number[] = [0, 80, 255];
const GROUND_COLOUR = [0, 150, 90, 255];
const FLAG_COLOUR = [220, 0, 0, 255];
const LABEL_COLOUR = [30, 30, 36, 255];

/** Whole-number zoom that brings a frame's longer side near 192 px. */
export function previewZoom(frame: Size): number {
  return Math.max(1, Math.floor(192 / Math.max(frame.width, frame.height)));
}

/** Source-over of one pixel onto the raster, `opacity` scaling the pixel's own alpha. */
function over(
  out: Raster,
  x: number,
  y: number,
  [r, g, b, a]: readonly number[],
  opacity: number,
): void {
  if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
  const alpha = ((a ?? 0) / 255) * opacity;
  if (alpha <= 0) return;
  const [dr, dg, db, da] = getPixel(out, x, y);
  const outAlpha = alpha + (da / 255) * (1 - alpha);
  const mix = (s: number, d: number) =>
    Math.round((s * alpha + d * (da / 255) * (1 - alpha)) / outAlpha);
  setPixel(out, x, y, [
    mix(r ?? 0, dr),
    mix(g ?? 0, dg),
    mix(b ?? 0, db),
    Math.round(outAlpha * 255),
  ]);
}

/** Draws `frame` zoomed with its top-left at (ox, oy), optionally pulled halfway toward a tint. */
function drawFrame(
  out: Raster,
  frame: Raster,
  ox: number,
  oy: number,
  zoom: number,
  opacity: number,
  tint?: readonly number[],
): void {
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const [r, g, b, a] = getPixel(frame, x, y);
      if (a === 0) continue;
      const px = tint
        ? [(r + (tint[0] ?? 0)) >> 1, (g + (tint[1] ?? 0)) >> 1, (b + (tint[2] ?? 0)) >> 1, a]
        : [r, g, b, a];
      for (let sy = 0; sy < zoom; sy++) {
        for (let sx = 0; sx < zoom; sx++)
          over(out, ox + x * zoom + sx, oy + y * zoom + sy, px, opacity);
      }
    }
  }
}

function fill(out: Raster, x: number, y: number, w: number, h: number, rgba: readonly number[]) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) over(out, xx, yy, rgba, 1);
}

function drawGuides(out: Raster, ox: number, oy: number, size: Size, anchor: Point, zoom: number) {
  const gy = Math.min(size.height * zoom - 1, (anchor.y + 1) * zoom - 1);
  fill(out, ox, oy + gy, size.width * zoom, 1, GROUND_COLOUR);
  const cx = anchor.x * zoom + Math.floor(zoom / 2);
  fill(out, ox + cx - 3, oy + gy, 7, 1, GROUND_COLOUR);
  fill(out, ox + cx, oy + gy - 3, 1, 7, GROUND_COLOUR);
}

/**
 * A grid of cells, one per frame, each showing the frame over its neighbours: the previous frame
 * tinted red and the next tinted blue, both faint. A loop wraps the neighbours, so frame 1 shows
 * the last and the last shows frame 1. A final row holds every frame overlaid, so drift shows at a
 * glance. The ground line and anchor cross are drawn in each cell; flagged frames get a red border.
 */
export function onionSkinSheet(
  frames: Raster[],
  options: { anchor: Point; loop: boolean; flagged?: number[] },
): Raster {
  const first = frames[0];
  if (!first) throw new Error("An onion-skin sheet needs at least one frame");
  const size = { width: first.width, height: first.height };
  const zoom = previewZoom(size);
  const cellW = size.width * zoom + 2 * PAD;
  const cellH = size.height * zoom + PAD + LABEL_HEIGHT;
  const columns = Math.min(MAX_COLUMNS, frames.length);
  const gridRows = Math.ceil(frames.length / columns);
  const out = createRaster(columns * cellW, (gridRows + 1) * cellH);
  for (let i = 0; i < out.data.length; i += 4) out.data.set([BACKDROP, BACKDROP, BACKDROP, 255], i);
  const flagged = new Set(options.flagged ?? []);
  const count = frames.length;

  frames.forEach((frame, i) => {
    const cx = (i % columns) * cellW;
    const cy = Math.floor(i / columns) * cellH;
    const previous = frames[options.loop ? (i + count - 1) % count : i - 1];
    const next = frames[options.loop ? (i + 1) % count : i + 1];
    if (previous)
      drawFrame(out, previous, cx + PAD, cy + PAD, zoom, NEIGHBOUR_OPACITY, PREVIOUS_TINT);
    if (next) drawFrame(out, next, cx + PAD, cy + PAD, zoom, NEIGHBOUR_OPACITY, NEXT_TINT);
    drawFrame(out, frame, cx + PAD, cy + PAD, zoom, 1);
    drawGuides(out, cx + PAD, cy + PAD, size, options.anchor, zoom);
    const label = String(i + 1);
    drawDigits(
      out,
      label,
      cx + Math.floor((cellW - textWidth(label, 2)) / 2),
      cy + cellH - 14,
      2,
      LABEL_COLOUR,
    );
    if (flagged.has(i + 1)) {
      fill(out, cx, cy, cellW, 2, FLAG_COLOUR);
      fill(out, cx, cy + cellH - 2, cellW, 2, FLAG_COLOUR);
      fill(out, cx, cy, 2, cellH, FLAG_COLOUR);
      fill(out, cx + cellW - 2, cy, 2, cellH, FLAG_COLOUR);
    }
  });

  const oy = gridRows * cellH;
  for (const frame of frames) drawFrame(out, frame, PAD, oy + PAD, zoom, OVERLAY_OPACITY);
  drawGuides(out, PAD, oy + PAD, size, options.anchor, zoom);
  return out;
}

/** A looping animated WebP of the frames, zoomed and flattened over a neutral opaque backdrop. */
export function loopPreview(frames: Raster[], options: { durationMs: number }): Uint8Array {
  const first = frames[0];
  if (!first) throw new Error("A loop preview needs at least one frame");
  const zoom = previewZoom(first);
  const flat = frames.map((frame) => {
    const out = createRaster(frame.width * zoom, frame.height * zoom);
    for (let i = 0; i < out.data.length; i += 4)
      out.data.set([BACKDROP, BACKDROP, BACKDROP, 255], i);
    drawFrame(out, frame, 0, 0, zoom, 1);
    return out;
  });
  return encodeAnimatedWebp(flat, {
    durationMs: options.durationMs,
    loopCount: 0,
    background: [BACKDROP, BACKDROP, BACKDROP, 255],
  });
}
