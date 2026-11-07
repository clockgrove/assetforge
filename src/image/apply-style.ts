import { createRaster, parseHex } from "./raster.ts";
import type { Raster } from "./raster.ts";
import type { ResolvedStyle } from "../style.ts";
import type { Rgb } from "../types.ts";

/** Re-applies the style's alpha and colour rule after resampling, which softens both. */
export function applyStyle(image: Raster, style: ResolvedStyle): Raster {
  const out = createRaster(image.width, image.height);
  out.data.set(image.data);
  const palette = style.color.rule === "palette" ? style.color.palette.map(parseHex) : [];
  for (let i = 0; i < out.data.length; i += 4) {
    let a = out.data[i + 3] ?? 0;
    if (style.alpha.mode === "binary") a = a >= style.alpha.threshold ? 255 : 0;
    out.data[i + 3] = a;
    if (a === 0) {
      out.data[i] = 0;
      out.data[i + 1] = 0;
      out.data[i + 2] = 0;
      continue;
    }
    if (palette.length > 0) {
      const px = [out.data[i] ?? 0, out.data[i + 1] ?? 0, out.data[i + 2] ?? 0];
      let best = palette[0] as Rgb;
      let bestDist = Infinity;
      for (const p of palette) {
        const d =
          2 * ((px[0] as number) - p[0]) ** 2 +
          4 * ((px[1] as number) - p[1]) ** 2 +
          3 * ((px[2] as number) - p[2]) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      out.data[i] = best[0];
      out.data[i + 1] = best[1];
      out.data[i + 2] = best[2];
    }
  }
  return out;
}
