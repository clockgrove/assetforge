import { createRaster } from "./raster.ts";
import type { Raster } from "./raster.ts";
import type { Point, Size } from "../types.ts";

interface Tap {
  index: number;
  weight: number;
}

/** The source taps for output coordinate `o` on one axis; taps outside the source are dropped (transparent). */
function taps(o: number, scale: number, offset: number, length: number, antialiased: boolean) {
  const out: Tap[] = [];
  if (!antialiased) {
    const i = Math.floor((o + 0.5 - offset) / scale);
    if (i >= 0 && i < length) out.push({ index: i, weight: 1 });
  } else if (scale < 1) {
    const lo = (o - offset) / scale;
    const hi = (o + 1 - offset) / scale;
    const span = hi - lo;
    for (let i = Math.max(0, Math.floor(lo)); i < Math.min(length, Math.ceil(hi)); i++) {
      const overlap = Math.min(hi, i + 1) - Math.max(lo, i);
      if (overlap > 0) out.push({ index: i, weight: overlap / span });
    }
  } else {
    const u = (o + 0.5 - offset) / scale - 0.5;
    const i0 = Math.floor(u);
    const f = u - i0;
    if (i0 >= 0 && i0 < length) out.push({ index: i0, weight: 1 - f });
    if (i0 + 1 >= 0 && i0 + 1 < length) out.push({ index: i0 + 1, weight: f });
  }
  return out;
}

/**
 * Resamples `src` into a `size` raster. Output pixel (x, y) samples the source at
 * ((x + 0.5 - offset.x) / scale, (y + 0.5 - offset.y) / scale). Antialiased filtering is a
 * premultiplied box filter when shrinking and premultiplied bilinear when growing; crisp is
 * nearest neighbour and never makes a new alpha or colour value. Outside the source is transparent.
 */
export function resampleTo(
  src: Raster,
  scale: number,
  offset: Point,
  size: Size,
  mode: "antialiased" | "crisp",
): Raster {
  const out = createRaster(size.width, size.height);
  const antialiased = mode === "antialiased";
  const xTaps = Array.from({ length: size.width }, (_, x) =>
    taps(x, scale, offset.x, src.width, antialiased),
  );
  for (let y = 0; y < size.height; y++) {
    const yt = taps(y, scale, offset.y, src.height, antialiased);
    if (yt.length === 0) continue;
    for (let x = 0; x < size.width; x++) {
      let a = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (const ty of yt) {
        for (const tx of xTaps[x] as Tap[]) {
          const i = (ty.index * src.width + tx.index) * 4;
          const w = (tx.weight * ty.weight * (src.data[i + 3] as number)) / 255;
          a += w;
          r += w * (src.data[i] as number);
          g += w * (src.data[i + 1] as number);
          b += w * (src.data[i + 2] as number);
        }
      }
      if (a <= 0) continue;
      const o = (y * size.width + x) * 4;
      out.data[o] = Math.round(r / a);
      out.data[o + 1] = Math.round(g / a);
      out.data[o + 2] = Math.round(b / a);
      out.data[o + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  return out;
}

export function flipHorizontal(src: Raster): Raster {
  const out = createRaster(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const from = (y * src.width + x) * 4;
      const to = (y * src.width + (src.width - 1 - x)) * 4;
      for (let k = 0; k < 4; k++) out.data[to + k] = src.data[from + k] as number;
    }
  }
  return out;
}
