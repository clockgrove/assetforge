/** Splitting a sprite strip into its frames and joining frames back into a strip. */
import { InputError } from "../errors.ts";
import { createRaster } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import type { Size } from "../types.ts";

/** The frames of a horizontal strip of `frame`-sized cells, left to right. */
export function splitStrip(strip: Raster, frame: Size): Raster[] {
  if (strip.height !== frame.height || strip.width % frame.width !== 0) {
    throw new InputError(
      `a ${strip.width}x${strip.height} strip is not a row of ${frame.width}x${frame.height} frames`,
    );
  }
  const count = strip.width / frame.width;
  const frames: Raster[] = [];
  for (let i = 0; i < count; i++) {
    const out = createRaster(frame.width, frame.height);
    for (let y = 0; y < frame.height; y++) {
      const from = (y * strip.width + i * frame.width) * 4;
      out.data.set(strip.data.subarray(from, from + frame.width * 4), y * frame.width * 4);
    }
    frames.push(out);
  }
  return frames;
}

/** Joins equal-size frames side by side, left to right. */
export function joinStrip(frames: Raster[]): Raster {
  const first = frames[0];
  if (!first) throw new InputError("a strip needs at least one frame");
  const { width, height } = first;
  const strip = createRaster(width * frames.length, height);
  frames.forEach((f, i) => {
    if (f.width !== width || f.height !== height) {
      throw new InputError(`frame ${i + 1} is ${f.width}x${f.height}, not ${width}x${height}`);
    }
    for (let y = 0; y < height; y++) {
      strip.data.set(
        f.data.subarray(y * width * 4, (y + 1) * width * 4),
        (y * strip.width + i * width) * 4,
      );
    }
  });
  return strip;
}

/** The alpha threshold animation QA measures at: the binary cut, else 128 as registration does. */
export function measureThreshold(style: { alpha: { mode: string; threshold: number } }): number {
  return style.alpha.mode === "binary" ? style.alpha.threshold : 128;
}
