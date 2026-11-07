import { InputError } from "../errors.ts";
import { createRaster, getPixel, setPixel } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import type { Reason } from "../types.ts";

export type MaterialChannel = "normal" | "height" | "emissive" | "roughness" | "wind";
export interface MaterialGrid {
  width: number;
  height: number;
  count: number;
}
export interface MapMethod {
  method: string;
  version: string;
}
export const CORE_METHODS = {
  extraction: { method: "mask-extraction", version: "1" },
  normals: { method: "height-gradient", version: "1" },
} as const;
export interface MapValidationOptions {
  range?: [number, number];
  emissiveSources?: { name: string; mask: Raster }[];
  namedLightSources?: string[];
}

function gridCheck(raster: Raster, grid: MaterialGrid): void {
  if (
    ![grid.width, grid.height, grid.count].every((n) => Number.isSafeInteger(n) && n > 0) ||
    raster.width !== grid.width * grid.count ||
    raster.height !== grid.height ||
    raster.data.length !== raster.width * raster.height * 4
  ) {
    throw new InputError("material image does not match its declared frame grid");
  }
}
function rangeCheck(range: [number, number]): void {
  if (!range.every(Number.isFinite) || range[0] < 0 || range[1] > 1 || range[0] > range[1]) {
    throw new InputError("material range must be an ordered interval within [0,1]");
  }
}
function reason(check: string, passed: boolean, message: string): Reason {
  return { check, passed, reason: message, source: "deterministic" };
}

export function extractScalarMap(
  albedo: Raster,
  source: Raster,
  grid: MaterialGrid,
  options: { component?: "red" | "alpha" | "luminance"; range?: [number, number] } = {},
): Raster {
  gridCheck(albedo, grid);
  gridCheck(source, grid);
  const range = options.range ?? [0, 1];
  rangeCheck(range);
  const out = createRaster(source.width, source.height);
  for (let y = 0; y < source.height; y++)
    for (let x = 0; x < source.width; x++) {
      const [r, g, b, a] = getPixel(source, x, y);
      const value =
        options.component === "alpha"
          ? a
          : options.component === "luminance"
            ? Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
            : r;
      const alpha = getPixel(albedo, x, y)[3];
      if (alpha && (value / 255 < range[0] || value / 255 > range[1]))
        throw new InputError("extracted material value is outside its declared range");
      setPixel(out, x, y, [alpha ? value : 0, alpha ? value : 0, alpha ? value : 0, alpha]);
    }
  return out;
}

export function deriveNormals(height: Raster, grid: MaterialGrid, strength = 1): Raster {
  gridCheck(height, grid);
  if (!Number.isFinite(strength) || strength <= 0)
    throw new InputError("normal strength must be positive and finite");
  const out = createRaster(height.width, height.height);
  for (let y = 0; y < height.height; y++)
    for (let x = 0; x < height.width; x++) {
      const center = getPixel(height, x, y);
      if (!center[3]) continue;
      const frameStart = Math.floor(x / grid.width) * grid.width;
      const sample = (sx: number, sy: number): number => {
        if (sx < frameStart || sx >= frameStart + grid.width || sy < 0 || sy >= grid.height)
          return center[0] / 255;
        const p = getPixel(height, sx, sy);
        return (p[3] ? p[0] : center[0]) / 255;
      };
      // Image Y points down; tangent-space Y points up. Never sample across frame boundaries.
      const nx = (-(sample(x + 1, y) - sample(x - 1, y)) * strength) / 2;
      const ny = ((sample(x, y + 1) - sample(x, y - 1)) * strength) / 2;
      const length = Math.hypot(nx, ny, 1);
      setPixel(out, x, y, [
        Math.round((nx / length + 1) * 127.5),
        Math.round((ny / length + 1) * 127.5),
        Math.round((1 / length + 1) * 127.5),
        center[3],
      ]);
    }
  return out;
}

export function validateMaterialMap(
  albedo: Raster,
  map: Raster,
  grid: MaterialGrid,
  channel: MaterialChannel,
  options: MapValidationOptions = {},
): Reason[] {
  gridCheck(albedo, grid);
  gridCheck(map, grid);
  const range = options.range ?? [0, 1];
  rangeCheck(range);
  let aligned = true,
    inRange = true,
    scalar = true,
    normals = true,
    emissive = true;
  const names = new Set(options.namedLightSources ?? []);
  const sources = options.emissiveSources ?? [];
  for (const source of sources) {
    gridCheck(source.mask, grid);
    if (!names.has(source.name))
      throw new InputError(`emissive source is not named in the asset spec: ${source.name}`);
  }
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++) {
      const p = getPixel(map, x, y);
      const a = getPixel(albedo, x, y)[3];
      if (p[3] !== a) aligned = false;
      if (!a) {
        if (p[0] || p[1] || p[2]) aligned = false;
        continue;
      }
      const values = channel === "normal" ? p.slice(0, 3) : [p[0]];
      if (values.some((v) => v / 255 < range[0] || v / 255 > range[1])) inRange = false;
      if (channel !== "normal" && (p[0] !== p[1] || p[0] !== p[2])) scalar = false;
      if (channel === "normal") {
        const [nx, ny, nz] = p.slice(0, 3).map((v) => v / 127.5 - 1) as [number, number, number];
        if (Math.abs(Math.hypot(nx, ny, nz) - 1) > 0.015 || nz < 0) normals = false;
      }
      if (
        channel === "emissive" &&
        p[0] > 0 &&
        !sources.some((s) => {
          const mask = getPixel(s.mask, x, y);
          return mask[0] > 0 && mask[3] > 0;
        })
      )
        emissive = false;
    }
  const emptyFrames = Array.from({ length: grid.count }, (_, frame) => frame).filter((frame) => {
    for (let y = 0; y < grid.height; y++)
      for (let x = 0; x < grid.width; x++) {
        if (getPixel(albedo, frame * grid.width + x, y)[3]) return false;
      }
    return true;
  });
  return [
    reason(
      "material-frame-coverage",
      emptyFrames.length === 0,
      emptyFrames.length
        ? `empty albedo frames: ${emptyFrames.join(", ")}`
        : "all albedo frames have geometry",
    ),
    reason(
      "material-alignment",
      aligned,
      aligned
        ? "map grid, alpha and transparent bounds match albedo"
        : "map alpha or transparent RGB differs from albedo bounds",
    ),
    reason(
      "material-range",
      inRange,
      inRange
        ? `map values are within [${range.join(", ")}]`
        : `map values exceed [${range.join(", ")}]`,
    ),
    ...(channel === "normal"
      ? [
          reason(
            "material-normal",
            normals,
            normals
              ? "normals are unit length with positive Z"
              : "normal length or Z orientation is invalid",
          ),
        ]
      : [
          reason(
            "material-scalar",
            scalar,
            scalar
              ? "scalar channels use identical RGB values"
              : "scalar map has unequal RGB components",
          ),
        ]),
    ...(channel === "emissive"
      ? [
          reason(
            "material-emissive",
            emissive,
            emissive
              ? "emission is confined to masks for spec-named light sources"
              : "emission occurs outside masks for spec-named light sources",
          ),
        ]
      : []),
  ];
}

function centroid(raster: Raster, grid: MaterialGrid, frame: number): [number, number] {
  let sx = 0,
    sy = 0,
    weight = 0;
  for (let y = 0; y < grid.height; y++)
    for (let x = 0; x < grid.width; x++) {
      const a = getPixel(raster, frame * grid.width + x, y)[3];
      sx += x * a;
      sy += y * a;
      weight += a;
    }
  return weight ? [sx / weight, sy / weight] : [0, 0];
}

export function temporalChecks(
  albedo: Raster,
  map: Raster,
  grid: MaterialGrid,
  bound: number,
): Reason[] {
  gridCheck(albedo, grid);
  gridCheck(map, grid);
  if (!Number.isFinite(bound) || bound < 0 || bound > 1)
    throw new InputError("material flicker bound must be within [0,1]");
  const checks: Reason[] = [];
  for (let frame = 0; grid.count > 1 && frame < grid.count; frame++) {
    const previousFrame = (frame + grid.count - 1) % grid.count;
    const previous = centroid(albedo, grid, previousFrame),
      current = centroid(albedo, grid, frame);
    const dx = Math.round(current[0] - previous[0]),
      dy = Math.round(current[1] - previous[1]);
    let residual = 0,
      samples = 0;
    for (let y = 0; y < grid.height; y++)
      for (let x = 0; x < grid.width; x++) {
        const px = x - dx,
          py = y - dy;
        if (px < 0 || px >= grid.width || py < 0 || py >= grid.height) continue;
        const a = getPixel(albedo, frame * grid.width + x, y),
          b = getPixel(albedo, previousFrame * grid.width + px, py);
        if (!a[3] || !b[3]) continue;
        const m = getPixel(map, frame * grid.width + x, y),
          n = getPixel(map, previousFrame * grid.width + px, py);
        const mapChange =
          Math.max(...m.slice(0, 3).map((v, i) => Math.abs(v - (n[i] as number)))) / 255;
        residual = Math.max(residual, mapChange);
        samples++;
      }
    const measured = samples ? residual : 0;
    checks.push(
      reason(
        "material-flicker",
        samples > 0 && measured <= bound,
        samples
          ? `frame ${frame}: residual ${measured.toFixed(6)} ${measured <= bound ? "<=" : ">"} bound ${bound}; ${samples} pose-corresponding pixels`
          : `frame ${frame}: temporal stability unmeasured; no pose-corresponding opaque pixels`,
      ),
    );
  }
  return checks;
}
