/**
 * The in-house engine: Assetforge's own TypeScript raster code (pngjs and jpeg-js decode, the
 * sheet slicer, matte and registration, an in-house lossless WebP encoder). Every implementation is
 * a pure function of its input pixels and parameters.
 */
import { createHash } from "node:crypto";
import { combineDigitalSourceTypes, DIGITAL_SOURCE_TYPES } from "../metadata.ts";
import { InputError } from "../errors.ts";
import { applyStyle } from "../image/apply-style.ts";
import { createRaster, decodeImage, encodePng, toHex } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { flipHorizontal, resampleTo } from "../image/resample.ts";
import { encodeWebpLossless } from "../image/webp.ts";
import { matteChecks, matteFigure } from "../sheet/matte.ts";
import { registerFrames } from "../sheet/register.ts";
import { sliceSheet, wholeImageFigure } from "../sheet/slice.ts";
import type { RegisterOptions, SliceOptions, SlicedFigure } from "../sheet/types.ts";
import type { Box, Point, Size } from "../types.ts";
import type { ImageEngine, ImageItem, OperationImpl } from "./types.ts";

/** A new item from `item` with new pixels; the slice figure no longer lines up, so it is dropped. */
function derive(item: ImageItem, raster: Raster, meta: Record<string, unknown> = {}): ImageItem {
  return { ...item, raster, figure: undefined, meta: { ...item.meta, ...meta } };
}

/** Copies `box` out of `src`; pixels outside the source are transparent. */
export function cropRaster(src: Raster, box: Box): Raster {
  const out = createRaster(box.width, box.height);
  for (let y = 0; y < box.height; y++) {
    const sy = box.y + y;
    if (sy < 0 || sy >= src.height) continue;
    const x0 = Math.max(0, -box.x);
    const x1 = Math.min(box.width, src.width - box.x);
    if (x1 <= x0) continue;
    const from = (sy * src.width + box.x + x0) * 4;
    out.data.set(src.data.subarray(from, from + (x1 - x0) * 4), (y * box.width + x0) * 4);
  }
  return out;
}

/** The box of pixels with alpha >= threshold, or undefined when there is none. */
export function boundsAt(r: Raster, threshold: number): Box | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if ((r.data[(y * r.width + x) * 4 + 3] ?? 0) >= threshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return undefined;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function flipVertical(src: Raster): Raster {
  const out = createRaster(src.width, src.height);
  const row = src.width * 4;
  for (let y = 0; y < src.height; y++) {
    out.data.set(src.data.subarray(y * row, (y + 1) * row), (src.height - 1 - y) * row);
  }
  return out;
}

function scaleBy(src: Raster, factor: number, filter: "antialiased" | "crisp"): Raster {
  const size = {
    width: Math.max(1, Math.round(src.width * factor)),
    height: Math.max(1, Math.round(src.height * factor)),
  };
  return resampleTo(src, factor, { x: 0, y: 0 }, size, filter);
}

function formatScale(s: number): string {
  return String(Number(s.toFixed(4)));
}

const ENCODERS: ImageEngine["encoders"] = {
  "image/png": { extension: "png", encode: encodePng },
  "image/webp": { extension: "webp", encode: encodeWebpLossless },
};

const crop: OperationImpl = ([item], p) => {
  const it = item as ImageItem;
  const box = p as unknown as Box;
  if (box.x + box.width > it.raster.width || box.y + box.height > it.raster.height) {
    throw new InputError(
      `crop box ${box.width}x${box.height} at ${box.x},${box.y} lies outside ${it.name} (${it.raster.width}x${it.raster.height})`,
    );
  }
  return { items: [derive(it, cropRaster(it.raster, box))] };
};

const trim: OperationImpl = ([item], p) => {
  const it = item as ImageItem;
  const threshold = p["threshold"] as number;
  const margin = p["margin"] as number;
  const bounds = boundsAt(it.raster, threshold);
  if (!bounds) throw new InputError(`${it.name} has no pixel at alpha ${threshold} or more`);
  const box = {
    x: bounds.x - margin,
    y: bounds.y - margin,
    width: bounds.width + 2 * margin,
    height: bounds.height + 2 * margin,
  };
  return { items: [derive(it, cropRaster(it.raster, box), { trimmedBox: box })] };
};

const pad: OperationImpl = ([item], p) => {
  const it = item as ImageItem;
  const [top, right, bottom, left] = ["top", "right", "bottom", "left"].map((k) => p[k] as number);
  const box = {
    x: -(left as number),
    y: -(top as number),
    width: it.raster.width + (left as number) + (right as number),
    height: it.raster.height + (top as number) + (bottom as number),
  };
  return { items: [derive(it, cropRaster(it.raster, box))] };
};

const scale: OperationImpl = ([item], p) => {
  const it = item as ImageItem;
  const given = ["factor", "width", "height"].filter((k) => p[k] !== undefined);
  if (given.length !== 1) {
    throw new InputError("scale takes exactly one of factor, width or height");
  }
  const factor =
    p["factor"] !== undefined
      ? (p["factor"] as number)
      : p["width"] !== undefined
        ? (p["width"] as number) / it.raster.width
        : (p["height"] as number) / it.raster.height;
  const filter = p["filter"] as "antialiased" | "crisp";
  const size: Size = {
    width: (p["width"] as number | undefined) ?? Math.max(1, Math.round(it.raster.width * factor)),
    height:
      (p["height"] as number | undefined) ?? Math.max(1, Math.round(it.raster.height * factor)),
  };
  return { items: [derive(it, resampleTo(it.raster, factor, { x: 0, y: 0 }, size, filter))] };
};

const slice: OperationImpl = ([item], p) => {
  const it = item as ImageItem;
  const sliced = sliceSheet(it.raster, p as SliceOptions);
  if (sliced.figures.length === 0) throw new InputError("no figures found on the sheet");
  const items = sliced.figures.map((figure): ImageItem => ({
    name: `${it.name}-f${String(figure.id).padStart(3, "0")}`,
    raster: figure.crop,
    digitalSourceType: it.digitalSourceType ?? DIGITAL_SOURCE_TYPES.undeclared,
    mediaType: it.mediaType,
    meta: {
      frame: figure.id,
      cell: figure.cell,
      box: figure.box,
      background: toHex(figure.background),
      transforms: figure.transforms,
    },
    figure,
  }));
  return {
    items,
    report: {
      mode: sliced.mode,
      ...(sliced.grid !== undefined && { grid: sliced.grid }),
      background: toHex(sliced.background),
      figures: items.length,
    },
  };
};

/**
 * A hash of a sliced figure's mask, exclusion mask and background: what `matte` reads besides the
 * pixels, recorded in its step so the step can be replayed from its record.
 */
function figureHash(figure: SlicedFigure): string {
  const h = createHash("sha256");
  h.update(`figure ${figure.crop.width}x${figure.crop.height} ${toHex(figure.background)}\n`);
  h.update(figure.mask);
  if (figure.excluded) h.update("excluded\n").update(figure.excluded);
  return h.digest("hex");
}

const matte: OperationImpl = ([item], p, { style }) => {
  const it = item as ImageItem;
  const options = { band: p["band"] as number, tolerance: p["tolerance"] as number };
  const checkOptions = { maxHaloFraction: p["maxHaloFraction"] as number };
  // A sliced item mattes with its slice figure (mask, exclusions, cell background), recorded as a
  // hash. Any other image (generated, hand-made, or changed since slicing) is one figure: every
  // pixel away from its border colour is kept, however small or detached.
  const figure = it.figure ?? wholeImageFigure(it.raster, p["sliceTolerance"] as number);
  const matted = matteFigure(figure, style, options);
  return {
    items: [
      derive(it, matted.image, {
        transforms: matted.transforms,
        quality: matted.quality,
        checks: matteChecks(matted.quality, checkOptions),
      }),
    ],
    report: {
      figure: {
        source: it.figure ? "slice" : "whole-image",
        background: toHex(figure.background),
        ...(it.figure && { sha256: figureHash(it.figure) }),
      },
    },
  };
};

const style: OperationImpl = ([item], _p, context) => {
  const it = item as ImageItem;
  return { items: [derive(it, applyStyle(it.raster, context.style))] };
};

const register: OperationImpl = (items, p) => {
  const frame = p["frame"] as Size | undefined;
  if (!frame)
    throw new InputError("register needs a frame size (params.frame or a target profile)");
  if (items.length === 0) throw new InputError("register needs at least one image");
  const families = p["families"] as string[] | undefined;
  const options: RegisterOptions = {
    frame,
    anchor: p["anchor"] as Point,
    edges: p["filter"] as "antialiased" | "crisp",
    measureThreshold: p["measureThreshold"] as number,
    margin: p["margin"] as number,
    clamp: (p["clamp"] as number[]).slice(0, 2) as [number, number],
    ...(families !== undefined && { families }),
    ...(p["scale"] !== undefined && { scale: p["scale"] as number }),
  };
  const registration = registerFrames(
    items.map((i) => i.raster),
    options,
  );
  return {
    items: items.map((it, i) => {
      const r = registration.frames[i];
      if (!r) throw new Error("registration lost a frame");
      return derive(it, r.image, {
        transforms: r.transforms,
        jitterPx: r.jitterPx,
        measure: r.measure,
      });
    }),
    report: { scale: registration.scale, jitterPx: registration.jitterPx },
  };
};

const join: OperationImpl = (items, p) => {
  const first = items[0];
  if (!first) throw new InputError("join needs at least one image");
  const columns = Math.min((p["columns"] as number | undefined) ?? items.length, items.length);
  const rows = Math.ceil(items.length / columns);
  const cell = {
    width: Math.max(...items.map((i) => i.raster.width)),
    height: Math.max(...items.map((i) => i.raster.height)),
  };
  const out = createRaster(cell.width * columns, cell.height * rows);
  const placed = items.map((it, i) => {
    const box = {
      x: (i % columns) * cell.width,
      y: Math.floor(i / columns) * cell.height,
      width: it.raster.width,
      height: it.raster.height,
    };
    const row = it.raster.width * 4;
    for (let y = 0; y < it.raster.height; y++) {
      out.data.set(
        it.raster.data.subarray(y * row, (y + 1) * row),
        ((box.y + y) * out.width + box.x) * 4,
      );
    }
    return { name: it.name, box };
  });
  const name =
    (p["name"] as string | undefined) ?? `${first.name}-${rows === 1 ? "strip" : "sheet"}`;
  return {
    items: [
      {
        name,
        raster: out,
        mediaType: first.mediaType,
        digitalSourceType: combineDigitalSourceTypes(
          items.map((i) => i.digitalSourceType ?? DIGITAL_SOURCE_TYPES.undeclared),
        ),
        meta: { cell, columns, rows, placed },
      },
    ],
  };
};

const flip: OperationImpl = ([item], p) => {
  const it = item as ImageItem;
  const raster =
    p["direction"] === "vertical" ? flipVertical(it.raster) : flipHorizontal(it.raster);
  return { items: [derive(it, raster)] };
};

const renditions: OperationImpl = ([item], p) => {
  const it = item as ImageItem;
  const filter = p["filter"] as "antialiased" | "crisp";
  return {
    items: (p["scales"] as number[]).map((s) => ({
      ...derive(it, scaleBy(it.raster, s, filter), { rendition: s }),
      name: `${it.name}@${formatScale(s)}x`,
    })),
  };
};

const convert: OperationImpl = ([item], p) => {
  const it = item as ImageItem;
  const format = (p["format"] as string).trim().toLowerCase().replace(/^\./, "");
  const mediaType = Object.entries(ENCODERS).find(
    ([type, e]) => type === format || e?.extension === format,
  )?.[0];
  if (!mediaType) {
    throw new InputError(
      `the ${RASTER_ENGINE_NAME} engine cannot encode "${p["format"] as string}"; it encodes ${Object.keys(ENCODERS).join(", ")}`,
    );
  }
  return { items: [{ ...it, mediaType }] };
};

export const RASTER_ENGINE_NAME = "assetforge-raster";

export const rasterEngine: ImageEngine = {
  name: RASTER_ENGINE_NAME,
  version: "1.1.0",
  operations: {
    crop,
    trim,
    pad,
    scale,
    slice,
    matte,
    "apply-style": style,
    register,
    join,
    flip,
    renditions,
    convert,
  },
  encoders: ENCODERS,
  decode(bytes) {
    try {
      return decodeImage(bytes);
    } catch (error) {
      throw new InputError(`cannot decode the image: ${(error as Error).message}`, {
        cause: error,
      });
    }
  },
};
