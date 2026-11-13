/**
 * Texture renditions for a quality tier (assetforge#136): every image larger than the tier's
 * `textureMaxPx` is area-averaged down to fit, aspect kept, so UVs still land on the same texels.
 * Look-dev's external side maps (groom, tint, eye mask) go the same way, or are dropped from a tier
 * that draws no fur.
 */
import { createRaster, decodeImage, encodePng } from "../../image/raster.ts";
import type { Raster } from "../../image/raster.ts";
import type { Glb } from "../glb.ts";
import { bufferViewBytes } from "../glb.ts";
import { appendBufferView, compactBin } from "../lookdev/edit.ts";
import { imageSize } from "../scene.ts";

/** The size that fits within `maxPx` on its longest edge, aspect kept; unchanged when it fits. */
export function fittedSize(width: number, height: number, maxPx: number) {
  const longest = Math.max(width, height);
  if (longest <= maxPx) return { width, height };
  const scale = maxPx / longest;
  return {
    width: Math.max(1, Math.min(maxPx, Math.round(width * scale))),
    height: Math.max(1, Math.min(maxPx, Math.round(height * scale))),
  };
}

/**
 * Area-averages `src` down to `width` × `height`, each channel on its own (not premultiplied), so
 * a data map (a comb direction, a tint's alpha weight) keeps its encoding where alpha is 0.
 */
export function downsample(src: Raster, width: number, height: number): Raster {
  const out = createRaster(width, height);
  const sx = src.width / width;
  const sy = src.height / height;
  const sums = new Float64Array(4);
  for (let y = 0; y < height; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < width; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      sums.fill(0);
      let total = 0;
      for (let j = Math.floor(y0); j < Math.min(src.height, Math.ceil(y1)); j++) {
        const wy = Math.min(y1, j + 1) - Math.max(y0, j);
        if (wy <= 0) continue;
        for (let i = Math.floor(x0); i < Math.min(src.width, Math.ceil(x1)); i++) {
          const w = wy * (Math.min(x1, i + 1) - Math.max(x0, i));
          if (w <= 0) continue;
          const at = (j * src.width + i) * 4;
          for (let c = 0; c < 4; c++) sums[c]! += w * src.data[at + c]!;
          total += w;
        }
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) out.data[o + c] = Math.round(sums[c]! / (total || 1));
    }
  }
  return out;
}

/** PNG or JPEG bytes within `maxPx`: the same bytes when they fit, else a downsampled PNG. */
export function fitImage(bytes: Uint8Array, maxPx: number): Uint8Array {
  const size = imageSize(bytes);
  if (size && Math.max(size.width, size.height) <= maxPx) return bytes;
  const raster = decodeImage(bytes);
  const fitted = fittedSize(raster.width, raster.height, maxPx);
  if (fitted.width === raster.width && fitted.height === raster.height) return bytes;
  return encodePng(downsample(raster, fitted.width, fitted.height));
}

/** Fits every image embedded in the `.glb` within `maxPx`; returns how many were resized. */
export function fitEmbeddedImages(glb: Glb, maxPx: number): number {
  let resized = 0;
  for (const image of glb.json.images ?? []) {
    if (image.bufferView === undefined) continue;
    const bytes = bufferViewBytes(glb, image.bufferView);
    const fitted = fitImage(bytes, maxPx);
    if (fitted === bytes) continue;
    image.bufferView = appendBufferView(glb, fitted);
    image.mimeType = "image/png";
    resized++;
  }
  if (resized > 0) compactBin(glb);
  return resized;
}

/** One external side image beside a `.glb`, as staging and `pick` carry it. */
export interface SideFile {
  name: string;
  bytes: Uint8Array;
  mediaType: string;
  field: string;
  extra?: Record<string, unknown>;
}

type LookdevImages = Record<string, { image?: number; uri?: string } & Record<string, unknown>>;

function lookdevImages(glb: Glb): LookdevImages | undefined {
  const extras = glb.json.asset.extras as { lookdev?: { images?: LookdevImages } } | undefined;
  return extras?.lookdev?.images;
}

/**
 * A tier's side images: each external image the `.glb` references by `uri` is fitted within
 * `maxPx` and renamed by `rename`, its `uri` (and `asset.extras.lookdev.images`) following; or,
 * with `fur` false, every external image no texture samples is dropped from the `.glb`, with its
 * `asset.extras.lookdev.images` entry. Returns the tier's side files. `sides` are the source's.
 */
export function tierSideImages(
  glb: Glb,
  sides: SideFile[],
  options: { maxPx?: number; fur: boolean; rename: (name: string) => string },
): SideFile[] {
  const json = glb.json;
  const images = json.images ?? [];
  const byName = new Map(sides.map((s) => [s.name, s]));
  const sampled = new Set((json.textures ?? []).map((t) => t.source));
  const lookdev = lookdevImages(glb);
  const out: SideFile[] = [];
  const fit = (side: SideFile): SideFile => {
    const bytes = options.maxPx === undefined ? side.bytes : fitImage(side.bytes, options.maxPx);
    return {
      ...side,
      name: options.rename(side.name),
      bytes,
      mediaType: bytes === side.bytes ? side.mediaType : "image/png",
    };
  };
  // Side files the `.glb` does not reference (look-dev's copy of the embedded base colour) are
  // not fur: every tier keeps them, fitted.
  const referenced = new Set(
    images.flatMap((image) => (image.uri === undefined ? [] : [decodeURIComponent(image.uri)])),
  );
  for (const side of sides) {
    if (!referenced.has(side.name) && side.mediaType.startsWith("image/")) out.push(fit(side));
  }
  if (!options.fur) {
    const keep: number[] = [];
    images.forEach((image, i) => {
      const external = image.uri !== undefined && !image.uri.startsWith("data:");
      if (!external || sampled.has(i)) keep.push(i);
    });
    const remap = new Map(keep.map((old, i) => [old, i]));
    json.images = keep.map((i) => images[i]!);
    for (const texture of json.textures ?? []) {
      if (texture.source !== undefined) texture.source = remap.get(texture.source)!;
    }
    for (const [field, entry] of Object.entries(lookdev ?? {})) {
      const moved = entry.image === undefined ? undefined : remap.get(entry.image);
      if (moved === undefined) delete lookdev![field];
      else entry.image = moved;
    }
  }
  for (const [i, image] of (json.images ?? []).entries()) {
    if (image.uri === undefined || image.uri.startsWith("data:")) continue;
    const side = byName.get(decodeURIComponent(image.uri));
    if (!side) continue;
    const fitted = fit(side);
    const name = fitted.name;
    out.push(fitted);
    image.uri = encodeURIComponent(name);
    for (const entry of Object.values(lookdev ?? {})) {
      if (entry.image === i && entry.uri !== undefined) entry.uri = name;
    }
  }
  return out;
}
