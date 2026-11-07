import { InputError } from "../errors.ts";
import { createRaster, getPixel, setPixel } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import type { MaterialGrid } from "./core.ts";
export function downsample(
  source: Raster,
  grid: MaterialGrid,
  scale: number,
  native: number,
  normal: boolean,
): Raster {
  if (
    !Number.isInteger(native) ||
    ![1, 2, 4].includes(scale) ||
    scale > native ||
    source.width !== grid.width * grid.count * native ||
    source.height !== grid.height * native
  )
    throw new InputError("material rendition cannot exceed native resolution or change frame grid");
  const factor = native / scale;
  const out = createRaster(grid.width * grid.count * scale, grid.height * scale);
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const sums = [0, 0, 0];
      let alpha = 0;
      for (let sy = Math.floor(y * factor); sy < Math.ceil((y + 1) * factor); sy++)
        for (let sx = Math.floor(x * factor); sx < Math.ceil((x + 1) * factor); sx++) {
          const weight =
            (Math.min((x + 1) * factor, sx + 1) - Math.max(x * factor, sx)) *
            (Math.min((y + 1) * factor, sy + 1) - Math.max(y * factor, sy));
          const p = getPixel(source, sx, sy);
          alpha += p[3] * weight;
          for (let c = 0; c < 3; c++)
            sums[c] =
              (sums[c] ?? 0) +
              (normal ? (p[c] as number) / 127.5 - 1 : (p[c] as number)) * p[3] * weight;
        }
      if (!alpha) continue;
      let rgb = sums.map((v) => v / alpha);
      if (normal) {
        const length = Math.hypot(...rgb);
        rgb = length ? rgb.map((v) => (v / length + 1) * 127.5) : [128, 128, 255];
      }
      setPixel(out, x, y, [...rgb.map(Math.round), Math.round(alpha / (factor * factor))]);
    }
  return out;
}

/** Validate a KTX2 container and its level data; the target is responsible for the actual codec. */
export function checkCompressed(bytes: Uint8Array, width: number, height: number): void {
  const signature = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 104 || signature.some((v, i) => bytes[i] !== v))
    throw new InputError("compressor did not produce KTX2");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vk = view.getUint32(12, true),
    scheme = view.getUint32(44, true);
  if (
    view.getUint32(20, true) !== width ||
    view.getUint32(24, true) !== height ||
    view.getUint32(28, true) !== 0 ||
    view.getUint32(32, true) !== 0 ||
    view.getUint32(36, true) !== 1 ||
    !view.getUint32(40, true)
  )
    throw new InputError("KTX2 dimensions or levels do not match rendition");
  // KTX 2.0 §3.10: BasisLZ uses ETC1S (163); UASTC (166) permits optional Zstandard.
  const blockCompressed =
    ((vk >= 131 && vk <= 184) || (vk >= 1000066000 && vk <= 1000066013)) &&
    [0, 2, 3].includes(scheme);
  const dfdOffset = view.getUint32(48, true),
    dfdLength = view.getUint32(52, true);
  const basisDfd = dfdLength >= 28 && dfdOffset >= 104 && dfdOffset + dfdLength <= bytes.length;
  const model = basisDfd ? bytes[dfdOffset + 12] : undefined;
  if (!(
    blockCompressed ||
    (vk === 0 &&
      basisDfd &&
      ((scheme === 1 && model === 163) || ([0, 2].includes(scheme) && model === 166)))
  ))
    throw new InputError("KTX2 is not GPU-compressed/Basis");
  const levels = view.getUint32(40, true);
  if (80 + levels * 24 > bytes.length) throw new InputError("truncated KTX2 level index");
  for (let i = 0; i < levels; i++) {
    const offset = Number(view.getBigUint64(80 + i * 24, true));
    const length = Number(view.getBigUint64(88 + i * 24, true));
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      offset < 80 + levels * 24 ||
      offset + length > bytes.length
    )
      throw new InputError("truncated KTX2 level data");
  }
}
