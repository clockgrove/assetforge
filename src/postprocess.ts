import type { Box, Point, Rgb, Size } from "./types.ts";
import { createRaster, getPixel, opaqueBox, parseHex, setPixel, toHex } from "./image/raster.ts";
import type { Raster } from "./image/raster.ts";

export interface PostprocessOptions {
  frame: Size;
  frameCount: number;
  anchor: Point;
  /** "#rrggbb" bible palette. */
  palette: string[];
  /** RGB euclidean distance within which a pixel counts as background. Default 48. */
  backgroundTolerance?: number;
  /** Pixels kept free around the subject inside the frame. Default 1. */
  margin?: number;
}

export interface Processed {
  strip: Raster;
  bounds: Box;
  /** Bible colours actually used, in bible order. */
  palette: string[];
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(
    (a[0] ?? 0) - (b[0] ?? 0),
    (a[1] ?? 0) - (b[1] ?? 0),
    (a[2] ?? 0) - (b[2] ?? 0),
  );
}

/** Returns a copy whose alpha is strictly 0 or 255. */
function toTrueAlpha(src: Raster, tolerance: number): Raster {
  const out = createRaster(src.width, src.height);
  out.data.set(src.data);
  const { width, height } = src;
  let hasAlpha = false;
  for (let i = 3; i < out.data.length; i += 4) {
    if ((out.data[i] ?? 255) < 255) {
      hasAlpha = true;
      break;
    }
  }
  if (hasAlpha) {
    for (let i = 3; i < out.data.length; i += 4) out.data[i] = (out.data[i] ?? 0) < 128 ? 0 : 255;
    return out;
  }

  const corners = [
    getPixel(src, 0, 0),
    getPixel(src, width - 1, 0),
    getPixel(src, 0, height - 1),
    getPixel(src, width - 1, height - 1),
  ];
  let bg = corners[0] ?? [0, 0, 0, 255];
  let best = 0;
  for (const c of corners) {
    const count = corners.filter((o) => o[0] === c[0] && o[1] === c[1] && o[2] === c[2]).length;
    if (count > best) {
      best = count;
      bg = c;
    }
  }

  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  const visit = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idx = y * width + x;
    if (seen[idx]) return;
    if (distance(getPixel(src, x, y), bg) > tolerance) return;
    seen[idx] = 1;
    stack.push(idx);
  };
  for (let x = 0; x < width; x++) {
    visit(x, 0);
    visit(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    visit(0, y);
    visit(width - 1, y);
  }
  while (stack.length > 0) {
    const idx = stack.pop() as number;
    const x = idx % width;
    const y = Math.floor(idx / width);
    visit(x + 1, y);
    visit(x - 1, y);
    visit(x, y + 1);
    visit(x, y - 1);
  }
  for (let idx = 0; idx < seen.length; idx++) {
    out.data[idx * 4 + 3] = seen[idx] ? 0 : 255;
  }
  return out;
}

/** Resamples the box to dw x dh: area averaging when shrinking, nearest neighbour when growing. */
function resample(src: Raster, box: Box, dw: number, dh: number): Raster {
  const out = createRaster(dw, dh);
  const sx = box.width / dw;
  const sy = box.height / dh;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      if (sx <= 1 && sy <= 1) {
        const px = box.x + Math.min(box.width - 1, Math.floor((x + 0.5) * sx));
        const py = box.y + Math.min(box.height - 1, Math.floor((y + 0.5) * sy));
        setPixel(out, x, y, getPixel(src, px, py));
        continue;
      }
      const x0 = x * sx;
      const x1 = (x + 1) * sx;
      const y0 = y * sy;
      const y1 = (y + 1) * sy;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
        for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
          const w =
            (Math.min(px + 1, x1) - Math.max(px, x0)) * (Math.min(py + 1, y1) - Math.max(py, y0));
          const [pr, pg, pb, pa] = getPixel(src, box.x + px, box.y + py);
          area += w;
          const wa = w * (pa / 255);
          a += wa;
          r += pr * wa;
          g += pg * wa;
          b += pb * wa;
        }
      }
      if (area > 0 && a / area >= 0.5) {
        setPixel(out, x, y, [Math.round(r / a), Math.round(g / a), Math.round(b / a), 255]);
      }
    }
  }
  return out;
}

export function postprocessFrames(frames: Raster[], options: PostprocessOptions): Processed {
  const { frame, frameCount, anchor } = options;
  const tolerance = options.backgroundTolerance ?? 48;
  const margin = options.margin ?? 1;
  if (frames.length !== frameCount) {
    throw new Error(`expected ${frameCount} frames but got ${frames.length}`);
  }
  if (options.palette.length === 0) throw new Error("palette is empty");
  const palette = options.palette.map(parseHex);

  const keyed = frames.map((f) => toTrueAlpha(f, tolerance));
  const boxes = keyed.map((f, i) => {
    const box = opaqueBox(f);
    if (!box) throw new Error(`frame ${i} has no subject after background removal`);
    return box;
  });

  const availW = Math.max(1, frame.width - 2 * margin);
  const availH = Math.max(1, frame.height - 2 * margin);
  const maxW = Math.max(...boxes.map((b) => b.width));
  const maxH = Math.max(...boxes.map((b) => b.height));
  const scale = Math.min(availW / maxW, availH / maxH);

  const strip = createRaster(frame.width * frameCount, frame.height);
  const used = new Set<number>();
  let union: Box | undefined;

  keyed.forEach((src, i) => {
    const box = boxes[i] as Box;
    const dw = Math.min(frame.width, Math.max(1, Math.round(box.width * scale)));
    const dh = Math.min(frame.height, Math.max(1, Math.round(box.height * scale)));
    const scaled = resample(src, box, dw, dh);
    const ox = Math.min(frame.width - dw, Math.max(0, Math.round(anchor.x - dw / 2)));
    const oy = Math.min(frame.height - dh, Math.max(0, Math.round(anchor.y - dh)));
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const px = getPixel(scaled, x, y);
        if (px[3] === 0) continue;
        let bestIdx = 0;
        let bestDist = Infinity;
        palette.forEach((p: Rgb, idx) => {
          const dr = px[0] - p[0];
          const dg = px[1] - p[1];
          const db = px[2] - p[2];
          const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
          if (d < bestDist) {
            bestDist = d;
            bestIdx = idx;
          }
        });
        used.add(bestIdx);
        setPixel(strip, i * frame.width + ox + x, oy + y, [...(palette[bestIdx] as Rgb), 255]);
      }
    }
    const placed = opaqueBox(strip, { x: i * frame.width, y: 0, ...frame });
    if (!placed) throw new Error(`frame ${i} has no subject after scaling`);
    if (!union) union = placed;
    else {
      const x = Math.min(union.x, placed.x);
      const y = Math.min(union.y, placed.y);
      union = {
        x,
        y,
        width: Math.max(union.x + union.width, placed.x + placed.width) - x,
        height: Math.max(union.y + union.height, placed.y + placed.height) - y,
      };
    }
  });

  return {
    strip,
    bounds: union as Box,
    palette: options.palette
      .map((hex, idx) => ({ hex: toHex(palette[idx] as Rgb), idx }))
      .filter((p) => used.has(p.idx))
      .map((p) => p.hex),
  };
}
