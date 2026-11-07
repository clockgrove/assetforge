import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import type { Box, Rgb } from "../types.ts";

/** An 8-bit RGBA image, row-major. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8Array;
}

export function createRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function getPixel(r: Raster, x: number, y: number): [number, number, number, number] {
  const i = (y * r.width + x) * 4;
  const d = r.data;
  return [d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0, d[i + 3] ?? 0];
}

export function setPixel(
  r: Raster,
  x: number,
  y: number,
  [red, green, blue, alpha]: readonly number[],
): void {
  const i = (y * r.width + x) * 4;
  r.data[i] = red ?? 0;
  r.data[i + 1] = green ?? 0;
  r.data[i + 2] = blue ?? 0;
  r.data[i + 3] = alpha ?? 0;
}

/**
 * Decodes a model's raster image into 8-bit RGBA: any PNG pngjs reads (palette, grey, RGB, RGBA,
 * 16-bit), or a JPEG, which some edit models return. The bytes' own signature decides.
 */
export function decodeImage(bytes: Uint8Array): Raster {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const img = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true });
    return { width: img.width, height: img.height, data: new Uint8Array(img.data) };
  }
  return decodePng(bytes);
}

/** Decodes any PNG pngjs reads (palette, grey, RGB, RGBA, 16-bit) into 8-bit RGBA. */
export function decodePng(bytes: Uint8Array): Raster {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

/** Encodes as 8-bit RGBA (colour type 6), deterministically. */
export function encodePng(r: Raster): Uint8Array {
  const png = new PNG({ width: r.width, height: r.height, colorType: 6, inputColorType: 6 });
  Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength).copy(png.data);
  return new Uint8Array(
    PNG.sync.write(png, { colorType: 6, inputColorType: 6, deflateLevel: 9, filterType: 0 }),
  );
}

/** The opaque bounding box (alpha > 0), or undefined when nothing is opaque. */
export function opaqueBox(r: Raster, within?: Box): Box | undefined {
  const x0 = within?.x ?? 0;
  const y0 = within?.y ?? 0;
  const w = within?.width ?? r.width;
  const h = within?.height ?? r.height;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if ((r.data[(y * r.width + x) * 4 + 3] ?? 0) > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return undefined;
  return { x: minX - x0, y: minY - y0, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: Rgb): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
