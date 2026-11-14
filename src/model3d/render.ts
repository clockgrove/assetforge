/**
 * A deterministic CPU rasteriser for turntable views and clip frames of a `.glb` character: one fixed
 * perspective camera and light, a z-buffer, two-sided Lambert shading and base-colour textures.
 */
import { bufferViewBytes } from "./glb.ts";
import type { Glb } from "./glb.ts";
import { boundsOf, clips, posedPrimitives, samplePose } from "./scene.ts";
import type { Bounds, Pose, PosedPrimitive } from "./scene.ts";
import { createRaster, decodeImage, encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";

export interface RenderOptions {
  sizePx: number;
  yawDeg: number;
  pose?: Pose;
  /** The rest-pose bounds, so every view and clip frame of a candidate shares one camera. */
  framing: Bounds;
  /** A camera to use instead of the turntable framing (close-ups); `framing` is then ignored. */
  camera?: ViewCamera;
  /** Replaces the base-colour texture of every textured primitive (look-dev before/after). */
  baseColor?: Raster;
  /** Draws map-driven shell fur over the surface. */
  fur?: FurMaps;
  /** Camera elevation above the horizon, default 15. Ignored when `camera` is set. */
  elevationDeg?: number;
  /** Shades with light 1: base colour × factor only, no Lambert, specular or fur self-shadow. */
  unlit?: boolean;
  /** Background colour, 0–255 per channel; default the turntable grey. */
  background?: [number, number, number];
  /**
   * Preview lighting (look-dev's before and after renders): view-relative ambient plus key light,
   * scaled by an exposure. Without it, the turntable's fixed light (ambient 0.35 and one key).
   */
  lighting?: PreviewLighting;
}

/** Lighting relative to the camera, so every view is lit alike, as a turnaround is drawn. */
export interface PreviewLighting {
  ambient: number;
  key: number;
  /** The key light's direction from the surface, in camera space: x right, y up, z toward the camera. */
  keyDirection: [number, number, number];
  /** Multiplies the shading; 1 leaves it as ambient plus key. */
  exposure: number;
}

/** Groom maps for shell fur. Direction is an RGB vector (channel/255*2-1, model space). */
export interface FurMaps {
  length: Raster;
  direction: Raster;
  density: Raster;
  tint?: Raster;
  /** Metres that length 255 stands for. */
  maxLengthM: number;
  /** Shell count, default 16. */
  shells?: number;
  /** Strand cells per unit of UV, default 192. */
  strandsPerUv?: number;
}

export const TURNTABLE_VIEWS = [
  { name: "front", yawDeg: 0 },
  { name: "three-quarter", yawDeg: 45 },
  { name: "side", yawDeg: 90 },
  { name: "back", yawDeg: 180 },
] as const;

const BACKGROUND = 0xd8;
const ELEVATION = (15 * Math.PI) / 180;
const FOV = (30 * Math.PI) / 180;
const FILL = 0.9;
const AMBIENT = 0.35;
const LIGHT = (() => {
  const l = [0.4, 0.8, 0.6];
  const n = Math.hypot(...(l as [number, number, number]));
  return l.map((v) => v / n) as [number, number, number];
})();

type Vec = [number, number, number];

const textureCache = new WeakMap<Glb, Map<number, Raster | null>>();

function baseColorTexture(glb: Glb, material: number | undefined): Raster | null {
  const pbr =
    material === undefined ? undefined : glb.json.materials?.[material]?.pbrMetallicRoughness;
  return textureRaster(glb, pbr?.baseColorTexture?.index);
}

/** The material's emissive texture, decoded, or null when it has none. */
function emissiveTexture(glb: Glb, material: number | undefined): Raster | null {
  const entry =
    material === undefined
      ? undefined
      : (glb.json.materials?.[material] as { emissiveTexture?: { index?: number } } | undefined);
  return textureRaster(glb, entry?.emissiveTexture?.index);
}

function textureRaster(glb: Glb, textureIndex: number | undefined): Raster | null {
  if (textureIndex === undefined) return null;
  const source = glb.json.textures?.[textureIndex]?.source;
  if (source === undefined) return null;
  let perGlb = textureCache.get(glb);
  if (!perGlb) textureCache.set(glb, (perGlb = new Map()));
  if (perGlb.has(source)) return perGlb.get(source) ?? null;
  let decoded: Raster | null = null;
  const view = glb.json.images?.[source]?.bufferView;
  if (view !== undefined) {
    try {
      decoded = decodeImage(bufferViewBytes(glb, view));
    } catch {
      decoded = null;
    }
  }
  perGlb.set(source, decoded);
  return decoded;
}

function sampleTexture(texture: Raster, u: number, v: number, out: Vec): void {
  const { width, height, data } = texture;
  const x = (u - Math.floor(u)) * width - 0.5;
  const y = (v - Math.floor(v)) * height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const wrap = (n: number, size: number) => ((n % size) + size) % size;
  const xa = wrap(x0, width);
  const xb = wrap(x0 + 1, width);
  const ya = wrap(y0, height);
  const yb = wrap(y0 + 1, height);
  for (let c = 0; c < 3; c++) {
    const top = data[(ya * width + xa) * 4 + c]! * (1 - fx) + data[(ya * width + xb) * 4 + c]! * fx;
    const bottom =
      data[(yb * width + xa) * 4 + c]! * (1 - fx) + data[(yb * width + xb) * 4 + c]! * fx;
    out[c] = (top * (1 - fy) + bottom * fy) / 255;
  }
}

function cross(a: Vec, b: Vec): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalise(a: Vec): Vec {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** The fixed turntable camera for one view: where it is, its axes and its pixel projection. */
export interface ViewCamera {
  sizePx: number;
  eye: Vec;
  forward: Vec;
  right: Vec;
  up: Vec;
  /** Focal length in pixels. */
  focal: number;
  near: number;
  /** A world point's pixel position (x right, y down) and its depth along the view axis. */
  project(x: number, y: number, z: number): Vec;
}

/**
 * The camera `renderView` uses: 15° above the horizon at `yawDeg`, framed on the bounds so their
 * bounding sphere fills 90% of the view. Exported so other passes (look-dev's back-projection)
 * map pixels to the same rays.
 */
export function viewCamera(options: {
  sizePx: number;
  yawDeg: number;
  framing: Bounds;
  elevationDeg?: number;
}): ViewCamera {
  const { min, max } = options.framing;
  const centre: Vec = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2, 1e-6);
  const distance = radius / Math.sin(Math.atan(FILL * Math.tan(FOV / 2)));
  return orbitCamera(
    options.sizePx,
    centre,
    distance,
    options.yawDeg,
    Math.max(distance - radius * 4, distance * 0.01),
    options.elevationDeg,
  );
}

/**
 * The camera of `viewCamera`'s direction, aimed and zoomed so the figure's own outline (every
 * point in `positions`, projected) fills `fill` of the view's larger side, rather than its
 * bounding sphere. A view that sees the figure end-on or small then still spends its pixels on it.
 */
export function framedCamera(options: {
  sizePx: number;
  yawDeg: number;
  framing: Bounds;
  elevationDeg?: number;
  positions: Float64Array[];
  fill: number;
}): ViewCamera {
  const { min, max } = options.framing;
  const size = options.sizePx;
  const radius = Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2, 1e-6);
  let focus: Vec = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let distance = radius / Math.sin(Math.atan(FILL * Math.tan(FOV / 2)));
  const near = (d: number) => Math.max(d - radius * 4, d * 0.01);
  let camera = orbitCamera(
    size,
    focus,
    distance,
    options.yawDeg,
    near(distance),
    options.elevationDeg,
  );
  // Two passes: the second corrects the first's perspective error.
  for (let pass = 0; pass < 2; pass++) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of options.positions) {
      for (let v = 0; v + 2 < p.length; v += 3) {
        const [x, y, d] = camera.project(p[v]!, p[v + 1]!, p[v + 2]!);
        if (!(d > 0)) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    const extent = Math.max(x1 - x0, y1 - y0);
    if (!(extent > 0)) break;
    const perPixel = distance / camera.focal;
    const dx = ((x0 + x1) / 2 - size / 2) * perPixel;
    const dy = ((y0 + y1) / 2 - size / 2) * perPixel;
    const { right, up } = camera;
    focus = [
      focus[0] + right[0] * dx - up[0] * dy,
      focus[1] + right[1] * dx - up[1] * dy,
      focus[2] + right[2] * dx - up[2] * dy,
    ];
    distance *= extent / (options.fill * size);
    camera = orbitCamera(
      size,
      focus,
      distance,
      options.yawDeg,
      near(distance),
      options.elevationDeg,
    );
  }
  return camera;
}

function orbitCamera(
  size: number,
  focus: Vec,
  distance: number,
  yawDeg: number,
  near: number,
  elevationDeg?: number,
): ViewCamera {
  const elevation = elevationDeg === undefined ? ELEVATION : (elevationDeg * Math.PI) / 180;
  const tanHalf = Math.tan(FOV / 2);
  const yaw = (yawDeg * Math.PI) / 180;
  const toEye: Vec = [
    Math.sin(yaw) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(yaw) * Math.cos(elevation),
  ];
  const eye: Vec = [
    focus[0] + toEye[0] * distance,
    focus[1] + toEye[1] * distance,
    focus[2] + toEye[2] * distance,
  ];
  const forward: Vec = [-toEye[0], -toEye[1], -toEye[2]];
  const right = normalise(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const focal = size / 2 / tanHalf;
  return {
    sizePx: size,
    eye,
    forward,
    right,
    up,
    focal,
    near,
    project(x, y, z) {
      const dx = x - eye[0];
      const dy = y - eye[1];
      const dz = z - eye[2];
      const depth = dx * forward[0] + dy * forward[1] + dz * forward[2];
      return [
        size / 2 + (focal * (dx * right[0] + dy * right[1] + dz * right[2])) / depth,
        size / 2 - (focal * (dx * up[0] + dy * up[1] + dz * up[2])) / depth,
        depth,
      ];
    },
  };
}

/**
 * A camera at the target's closest zoom: the character's full height `heightM` spans
 * `screenHeightPx * characterScreenFraction` pixels at the focus depth, with the turntable's
 * elevation and field of view.
 */
export function closeUpCamera(options: {
  sizePx: number;
  yawDeg: number;
  focus: Vec;
  heightM: number;
  screenHeightPx: number;
  characterScreenFraction: number;
  elevationDeg?: number;
}): ViewCamera {
  const focal = options.sizePx / 2 / Math.tan(FOV / 2);
  const pixels = options.screenHeightPx * options.characterScreenFraction;
  const distance = (focal * options.heightM) / pixels;
  const near = Math.max(distance - options.heightM * 2, distance * 0.01);
  return orbitCamera(
    options.sizePx,
    options.focus,
    distance,
    options.yawDeg,
    near,
    options.elevationDeg,
  );
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Environment-style catch-light strength for a glossy material, 0 at roughness 0.3 and above. */
function glossStrength(roughness: number | undefined): number {
  if (roughness === undefined || roughness > 0.3) return 0;
  return 0.85 * Math.min(1, (0.3 - roughness) / 0.25);
}

function hash2(x: number, y: number, salt: number): number {
  let h =
    (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1)) >>>
    0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function texelAt(map: Raster, u: number, v: number, channel: number): number {
  const x = Math.min(map.width - 1, Math.floor((u - Math.floor(u)) * map.width));
  const y = Math.min(map.height - 1, Math.floor((v - Math.floor(v)) * map.height));
  return map.data[(y * map.width + x) * 4 + channel]! / 255;
}

/** The light reaching a surface with (unnormalised) normal n, facing ±1, under the render's lighting. */
type Shade = (nx: number, ny: number, nz: number, facing: number) => number;

/** Where the preview lighting's highlight shoulder starts, as a share of full scale. */
const SHOULDER = 0.8;

/**
 * Preview lighting's tone curve: linear up to the shoulder, then rolling smoothly toward 1, so a
 * pale marking in the key light keeps its tone instead of clipping to white. The fixed turntable
 * lighting clips.
 */
function toneFor(options: RenderOptions): (v: number) => number {
  if (!options.lighting) return (v) => Math.min(1, v);
  return (v) =>
    v <= SHOULDER
      ? v
      : SHOULDER + (1 - SHOULDER) * (1 - Math.exp(-(v - SHOULDER) / (1 - SHOULDER)));
}

function shaderFor(options: RenderOptions, camera: ViewCamera): Shade {
  const lighting = options.lighting;
  if (!lighting) {
    return (nx, ny, nz, facing) => {
      const l = Math.hypot(nx, ny, nz) || 1;
      const d = (facing * (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2])) / l;
      return AMBIENT + (1 - AMBIENT) * Math.max(0, d);
    };
  }
  const [kx, ky, kz] = lighting.keyDirection;
  const { right, up, forward } = camera;
  const key = normalise([
    right[0] * kx + up[0] * ky - forward[0] * kz,
    right[1] * kx + up[1] * ky - forward[1] * kz,
    right[2] * kx + up[2] * ky - forward[2] * kz,
  ]);
  return (nx, ny, nz, facing) => {
    const l = Math.hypot(nx, ny, nz) || 1;
    const d = (facing * (nx * key[0] + ny * key[1] + nz * key[2])) / l;
    return lighting.exposure * (lighting.ambient + lighting.key * Math.max(0, d));
  };
}

/** Renders one view of the model into an opaque RGBA raster. */
export function renderView(glb: Glb, options: RenderOptions): Raster {
  return renderViewWithDepth(glb, options).raster;
}

/** Like `renderView`, also returning the view-axis depth per pixel (Infinity where nothing drew). */
export function renderViewWithDepth(
  glb: Glb,
  options: RenderOptions,
): { raster: Raster; depth: Float64Array } {
  const size = options.sizePx;
  const raster = createRaster(size, size);
  if (options.background) {
    for (let i = 0; i < raster.data.length; i += 4) {
      raster.data[i] = options.background[0];
      raster.data[i + 1] = options.background[1];
      raster.data[i + 2] = options.background[2];
    }
  } else raster.data.fill(BACKGROUND);
  for (let i = 3; i < raster.data.length; i += 4) raster.data[i] = 255;

  const camera = options.camera ?? viewCamera(options);
  const unlit = options.unlit === true;
  const { eye, forward, right, up, focal, near } = camera;
  const shade = shaderFor(options, camera);
  const tone = toneFor(options);

  const depthBuffer = new Float64Array(size * size).fill(Infinity);
  const texel: Vec = [0, 0, 0];

  const primitives: PosedPrimitive[] = posedPrimitives(glb, options.pose);
  for (const prim of primitives) {
    const count = prim.positions.length / 3;
    const sx = new Float64Array(count);
    const sy = new Float64Array(count);
    const sz = new Float64Array(count);
    for (let v = 0; v < count; v++) {
      const dx = prim.positions[v * 3]! - eye[0];
      const dy = prim.positions[v * 3 + 1]! - eye[1];
      const dz = prim.positions[v * 3 + 2]! - eye[2];
      const z = dx * forward[0] + dy * forward[1] + dz * forward[2];
      sz[v] = z;
      sx[v] = size / 2 + (focal * (dx * right[0] + dy * right[1] + dz * right[2])) / z;
      sy[v] = size / 2 - (focal * (dx * up[0] + dy * up[1] + dz * up[2])) / z;
    }
    const material = prim.material === undefined ? undefined : glb.json.materials?.[prim.material];
    const factor = material?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
    const own = prim.uvs ? baseColorTexture(glb, prim.material) : null;
    const texture = own && options.baseColor ? options.baseColor : own;
    const gloss = unlit
      ? 0
      : glossStrength(
          (material?.pbrMetallicRoughness as { roughnessFactor?: number } | undefined)
            ?.roughnessFactor,
        );
    const emissive = unlit || !prim.uvs ? null : emissiveTexture(glb, prim.material);
    const emissiveFactor = (material as { emissiveFactor?: number[] } | undefined)
      ?.emissiveFactor ?? [0, 0, 0];
    const uvs = prim.uvs;
    const normals = prim.normals;

    for (let t = 0; t + 2 < prim.indices.length; t += 3) {
      const i0 = prim.indices[t]!;
      const i1 = prim.indices[t + 1]!;
      const i2 = prim.indices[t + 2]!;
      if (i0 >= count || i1 >= count || i2 >= count) continue;
      const z0 = sz[i0]!;
      const z1 = sz[i1]!;
      const z2 = sz[i2]!;
      if (z0 < near || z1 < near || z2 < near) continue;
      const x0 = sx[i0]!;
      const y0 = sy[i0]!;
      const x1 = sx[i1]!;
      const y1 = sy[i1]!;
      const x2 = sx[i2]!;
      const y2 = sy[i2]!;
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (area === 0) continue;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1, y2)));
      if (minX > maxX || minY > maxY) continue;

      const p = prim.positions;
      const e1: Vec = [
        p[i1 * 3]! - p[i0 * 3]!,
        p[i1 * 3 + 1]! - p[i0 * 3 + 1]!,
        p[i1 * 3 + 2]! - p[i0 * 3 + 2]!,
      ];
      const e2: Vec = [
        p[i2 * 3]! - p[i0 * 3]!,
        p[i2 * 3 + 1]! - p[i0 * 3 + 1]!,
        p[i2 * 3 + 2]! - p[i0 * 3 + 2]!,
      ];
      const face = normalise(cross(e1, e2));
      const toViewer: Vec = [eye[0] - p[i0 * 3]!, eye[1] - p[i0 * 3 + 1]!, eye[2] - p[i0 * 3 + 2]!];
      const facing =
        face[0] * toViewer[0] + face[1] * toViewer[1] + face[2] * toViewer[2] >= 0 ? 1 : -1;

      const iz0 = 1 / z0;
      const iz1 = 1 / z1;
      const iz2 = 1 / z2;
      const invArea = 1 / area;
      const flat = !normals;
      let flatLight = 0;
      if (flat) flatLight = shade(face[0], face[1], face[2], facing);

      for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * invArea;
          const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * invArea;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const invZ = w0 * iz0 + w1 * iz1 + w2 * iz2;
          const depth = 1 / invZ;
          const at = y * size + x;
          if (depth >= depthBuffer[at]!) continue;
          depthBuffer[at] = depth;
          const b0 = (w0 * iz0) / invZ;
          const b1 = (w1 * iz1) / invZ;
          const b2 = 1 - b0 - b1;

          let light = flatLight;
          if (normals) {
            const nx = b0 * normals[i0 * 3]! + b1 * normals[i1 * 3]! + b2 * normals[i2 * 3]!;
            const ny =
              b0 * normals[i0 * 3 + 1]! + b1 * normals[i1 * 3 + 1]! + b2 * normals[i2 * 3 + 1]!;
            const nz =
              b0 * normals[i0 * 3 + 2]! + b1 * normals[i1 * 3 + 2]! + b2 * normals[i2 * 3 + 2]!;
            light = shade(nx, ny, nz, facing);
          }

          let r = factor[0] ?? 1;
          let g = factor[1] ?? 1;
          let b = factor[2] ?? 1;
          if (texture && uvs) {
            sampleTexture(
              texture,
              b0 * uvs[i0 * 2]! + b1 * uvs[i1 * 2]! + b2 * uvs[i2 * 2]!,
              b0 * uvs[i0 * 2 + 1]! + b1 * uvs[i1 * 2 + 1]! + b2 * uvs[i2 * 2 + 1]!,
              texel,
            );
            r *= texel[0];
            g *= texel[1];
            b *= texel[2];
          }
          if (unlit) light = 1;
          r *= light;
          g *= light;
          b *= light;
          if (gloss > 0) {
            let nx = face[0];
            let ny = face[1];
            let nz = face[2];
            if (normals) {
              nx = b0 * normals[i0 * 3]! + b1 * normals[i1 * 3]! + b2 * normals[i2 * 3]!;
              ny =
                b0 * normals[i0 * 3 + 1]! + b1 * normals[i1 * 3 + 1]! + b2 * normals[i2 * 3 + 1]!;
              nz =
                b0 * normals[i0 * 3 + 2]! + b1 * normals[i1 * 3 + 2]! + b2 * normals[i2 * 3 + 2]!;
            }
            const nl = (Math.hypot(nx, ny, nz) || 1) * facing;
            nx /= nl;
            ny /= nl;
            nz /= nl;
            const kx = (px - size / 2) / focal;
            const ky = -(py - size / 2) / focal;
            const rx = forward[0] + right[0] * kx + up[0] * ky;
            const ry = forward[1] + right[1] * kx + up[1] * ky;
            const rz = forward[2] + right[2] * kx + up[2] * ky;
            const rl = Math.hypot(rx, ry, rz);
            const dn = (rx * nx + ry * ny + rz * nz) / rl;
            const reflectY = ry / rl - 2 * dn * ny;
            const fresnel = 0.6 + 0.4 * Math.pow(1 - Math.min(1, Math.max(0, -dn)), 5);
            const spec = gloss * smoothstep(0.55, 0.85, reflectY) * fresnel;
            r += spec;
            g += spec;
            b += spec;
          }
          if (emissive && uvs) {
            sampleTexture(
              emissive,
              b0 * uvs[i0 * 2]! + b1 * uvs[i1 * 2]! + b2 * uvs[i2 * 2]!,
              b0 * uvs[i0 * 2 + 1]! + b1 * uvs[i1 * 2 + 1]! + b2 * uvs[i2 * 2 + 1]!,
              texel,
            );
            r += texel[0] * (emissiveFactor[0] ?? 0);
            g += texel[1] * (emissiveFactor[1] ?? 0);
            b += texel[2] * (emissiveFactor[2] ?? 0);
          }
          const o = at * 4;
          raster.data[o] = Math.round(tone(r) * 255);
          raster.data[o + 1] = Math.round(tone(g) * 255);
          raster.data[o + 2] = Math.round(tone(b) * 255);
        }
      }
    }
  }

  if (options.fur) {
    drawFur(glb, primitives, options, camera, raster, depthBuffer);
  }
  return { raster, depth: depthBuffer };
}

/** Smooth value noise on a grid of `cells` per unit of UV: bilinear between hashed corners, eased. */
function smoothNoise(u: number, v: number, cells: number, salt: number): number {
  const x = u * cells;
  const y = v * cells;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, salt);
  const b = hash2(x0 + 1, y0, salt);
  const c = hash2(x0, y0 + 1, salt);
  const d = hash2(x0 + 1, y0 + 1, salt);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/** Strands reach between this fraction and all of the local fur length. */
const SHORTEST_STRAND = 0.6;
/** How many fully covered shells' worth of opacity the coat holds at its root. */
const FUR_LAYERS = 6;

/**
 * The share of a shell at height `t` (0 root, 1 tip) that strands cover, pre-filtered: the strands'
 * expected cross-section over a pixel, not a hit-or-miss choice per strand, so the coat reads soft
 * and free of speckle at any zoom. `clump` scales the local strand length.
 */
export function strandCoverage(t: number, density: number, clump: number): number {
  const reach = Math.min(1, Math.max(0, (1 - t / clump) / (1 - SHORTEST_STRAND)));
  const diameter = 0.9 * (1 - 0.7 * t);
  return density * reach * ((Math.PI / 4) * diameter * diameter);
}

/**
 * Map-driven shell fur: `shells` offset copies of the surface, each alpha-blended over what is
 * drawn with the strands' expected coverage at its height. A preview of what the groom maps drive,
 * not the target's fur material.
 */
function drawFur(
  glb: Glb,
  primitives: PosedPrimitive[],
  options: RenderOptions,
  camera: ViewCamera,
  raster: Raster,
  depthBuffer: Float64Array,
): void {
  const fur = options.fur!;
  const size = options.sizePx;
  const { eye, forward, right, up, focal, near } = camera;
  const shells = Math.max(1, Math.round(fur.shells ?? 16));
  const strandsPerUv = fur.strandsPerUv ?? 192;
  // Clumps span about six strands: soft, low-frequency variation in length, never per pixel.
  const clumpCells = Math.max(1, strandsPerUv / 6);
  const BEND = 0.35;
  const shade = shaderFor(options, camera);
  const tone = toneFor(options);
  const texel: Vec = [0, 0, 0];
  // Fur behind the surface is hidden; fur behind other fur within this reach still blends, so
  // semi-transparent shells do not cut each other off at the silhouette.
  const reach = fur.maxLengthM * 2;
  const furDepth = new Float64Array(size * size).fill(Infinity);
  const exponent = FUR_LAYERS / shells;

  for (const prim of primitives) {
    const { uvs, normals } = prim;
    if (!uvs || !normals) continue;
    const count = prim.positions.length / 3;
    const material = prim.material === undefined ? undefined : glb.json.materials?.[prim.material];
    const factor = material?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
    const own = baseColorTexture(glb, prim.material);
    const texture = own && options.baseColor ? options.baseColor : own;

    // Per-vertex strand length (metres) and the combed direction, tangent to the surface.
    const vertexLength = new Float64Array(count);
    const comb = new Float64Array(count * 3);
    let any = false;
    for (let v = 0; v < count; v++) {
      const u = uvs[v * 2]!;
      const w = uvs[v * 2 + 1]!;
      const len = texelAt(fur.length, u, w, 0) * fur.maxLengthM;
      vertexLength[v] = len;
      if (len <= 0) continue;
      any = true;
      const nx = normals[v * 3]!;
      const ny = normals[v * 3 + 1]!;
      const nz = normals[v * 3 + 2]!;
      let dx = texelAt(fur.direction, u, w, 0) * 2 - 1;
      let dy = texelAt(fur.direction, u, w, 1) * 2 - 1;
      let dz = texelAt(fur.direction, u, w, 2) * 2 - 1;
      const along = dx * nx + dy * ny + dz * nz;
      dx -= along * nx;
      dy -= along * ny;
      dz -= along * nz;
      const l = Math.hypot(dx, dy, dz);
      if (l > 1e-6) {
        comb[v * 3] = dx / l;
        comb[v * 3 + 1] = dy / l;
        comb[v * 3 + 2] = dz / l;
      }
    }
    if (!any) continue;

    const sx = new Float64Array(count);
    const sy = new Float64Array(count);
    const sz = new Float64Array(count);
    const p = prim.positions;

    for (let shell = 1; shell <= shells; shell++) {
      const t = shell / shells;
      for (let v = 0; v < count; v++) {
        const h = t * vertexLength[v]!;
        const px = p[v * 3]! + (normals[v * 3]! * (1 - BEND) + comb[v * 3]! * BEND) * h;
        const py = p[v * 3 + 1]! + (normals[v * 3 + 1]! * (1 - BEND) + comb[v * 3 + 1]! * BEND) * h;
        const pz = p[v * 3 + 2]! + (normals[v * 3 + 2]! * (1 - BEND) + comb[v * 3 + 2]! * BEND) * h;
        const dx = px - eye[0];
        const dy = py - eye[1];
        const dz = pz - eye[2];
        const z = dx * forward[0] + dy * forward[1] + dz * forward[2];
        sz[v] = z;
        sx[v] = size / 2 + (focal * (dx * right[0] + dy * right[1] + dz * right[2])) / z;
        sy[v] = size / 2 - (focal * (dx * up[0] + dy * up[1] + dz * up[2])) / z;
      }

      for (let tri = 0; tri + 2 < prim.indices.length; tri += 3) {
        const i0 = prim.indices[tri]!;
        const i1 = prim.indices[tri + 1]!;
        const i2 = prim.indices[tri + 2]!;
        if (i0 >= count || i1 >= count || i2 >= count) continue;
        if (vertexLength[i0]! <= 0 && vertexLength[i1]! <= 0 && vertexLength[i2]! <= 0) continue;
        const z0 = sz[i0]!;
        const z1 = sz[i1]!;
        const z2 = sz[i2]!;
        if (z0 < near || z1 < near || z2 < near) continue;
        const x0 = sx[i0]!;
        const y0 = sy[i0]!;
        const x1 = sx[i1]!;
        const y1 = sy[i1]!;
        const x2 = sx[i2]!;
        const y2 = sy[i2]!;
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (area === 0) continue;
        const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
        const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2)));
        const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
        const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1, y2)));
        if (minX > maxX || minY > maxY) continue;

        // Facing from the surface normals against the viewer, so no face normal is needed.
        const gx = normals[i0 * 3]! + normals[i1 * 3]! + normals[i2 * 3]!;
        const gy = normals[i0 * 3 + 1]! + normals[i1 * 3 + 1]! + normals[i2 * 3 + 1]!;
        const gz = normals[i0 * 3 + 2]! + normals[i1 * 3 + 2]! + normals[i2 * 3 + 2]!;
        const toViewer: Vec = [
          eye[0] - p[i0 * 3]!,
          eye[1] - p[i0 * 3 + 1]!,
          eye[2] - p[i0 * 3 + 2]!,
        ];
        const facing = gx * toViewer[0] + gy * toViewer[1] + gz * toViewer[2] >= 0 ? 1 : -1;

        const iz0 = 1 / z0;
        const iz1 = 1 / z1;
        const iz2 = 1 / z2;
        const invArea = 1 / area;
        for (let y = minY; y <= maxY; y++) {
          const py = y + 0.5;
          for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5;
            const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * invArea;
            const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * invArea;
            const w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const invZ = w0 * iz0 + w1 * iz1 + w2 * iz2;
            const depth = 1 / invZ;
            const at = y * size + x;
            if (depth >= depthBuffer[at]! || depth > furDepth[at]! + reach) continue;
            const b0 = (w0 * iz0) / invZ;
            const b1 = (w1 * iz1) / invZ;
            const b2 = 1 - b0 - b1;
            const u = b0 * uvs[i0 * 2]! + b1 * uvs[i1 * 2]! + b2 * uvs[i2 * 2]!;
            const w = b0 * uvs[i0 * 2 + 1]! + b1 * uvs[i1 * 2 + 1]! + b2 * uvs[i2 * 2 + 1]!;

            if (texelAt(fur.length, u, w, 0) <= 0) continue;
            const clump = 0.8 + 0.4 * smoothNoise(u, w, clumpCells, 2);
            const coverage = strandCoverage(t, texelAt(fur.density, u, w, 0), clump);
            if (coverage <= 0) continue;
            const alpha = 1 - Math.pow(1 - Math.min(coverage, 0.999), exponent);
            if (depth < furDepth[at]!) furDepth[at] = depth;

            const nx = b0 * normals[i0 * 3]! + b1 * normals[i1 * 3]! + b2 * normals[i2 * 3]!;
            const ny =
              b0 * normals[i0 * 3 + 1]! + b1 * normals[i1 * 3 + 1]! + b2 * normals[i2 * 3 + 1]!;
            const nz =
              b0 * normals[i0 * 3 + 2]! + b1 * normals[i1 * 3 + 2]! + b2 * normals[i2 * 3 + 2]!;
            // A little darker toward the root, where strands shade each other.
            const light = options.unlit ? 1 : shade(nx, ny, nz, facing) * (0.85 + 0.15 * t);

            let r = factor[0] ?? 1;
            let g = factor[1] ?? 1;
            let b = factor[2] ?? 1;
            if (texture) {
              sampleTexture(texture, u, w, texel);
              r *= texel[0];
              g *= texel[1];
              b *= texel[2];
            }
            if (fur.tint) {
              const mix = texelAt(fur.tint, u, w, 3) * t;
              r += (r * texelAt(fur.tint, u, w, 0) - r) * mix;
              g += (g * texelAt(fur.tint, u, w, 1) - g) * mix;
              b += (b * texelAt(fur.tint, u, w, 2) - b) * mix;
            }
            const o = at * 4;
            raster.data[o] = Math.round(
              raster.data[o]! * (1 - alpha) + tone(r * light) * 255 * alpha,
            );
            raster.data[o + 1] = Math.round(
              raster.data[o + 1]! * (1 - alpha) + tone(g * light) * 255 * alpha,
            );
            raster.data[o + 2] = Math.round(
              raster.data[o + 2]! * (1 - alpha) + tone(b * light) * 255 * alpha,
            );
          }
        }
      }
    }
  }
  for (let i = 0; i < furDepth.length; i++) {
    if (furDepth[i]! < depthBuffer[i]!) depthBuffer[i] = furDepth[i]!;
  }
}

/**
 * Speckle: the share of the figure's pixels (those differing from `background`) whose luminance
 * differs from the median of their 3×3 neighbourhood by more than `threshold` (0–255). Isolated
 * bright or dark pixels, the noise a hit-or-miss strand pattern makes, score; smooth shading and
 * clean edges do not.
 */
export function speckle(
  raster: Raster,
  background: [number, number, number] = [BACKGROUND, BACKGROUND, BACKGROUND],
  threshold = 24,
): number {
  const { width, height, data } = raster;
  const lum = new Float32Array(width * height);
  const figure = new Uint8Array(width * height);
  for (let i = 0; i < lum.length; i++) {
    const o = i * 4;
    lum[i] = 0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!;
    figure[i] =
      Math.abs(data[o]! - background[0]) +
        Math.abs(data[o + 1]! - background[1]) +
        Math.abs(data[o + 2]! - background[2]) >
      6
        ? 1
        : 0;
  }
  let pixels = 0;
  let speckled = 0;
  const window: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!figure[i]) continue;
      pixels++;
      window.length = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) window.push(lum[i + dy * width + dx]!);
      window.sort((a, b) => a - b);
      if (Math.abs(lum[i]! - window[4]!) > threshold) speckled++;
    }
  }
  return pixels === 0 ? 0 : speckled / pixels;
}

export interface TurntableFrame {
  name: string;
  png: Uint8Array;
  view: string;
  clip?: string;
  timeS?: number;
}

/**
 * The four rest-pose views, then evenly spaced three-quarter frames of every clip. Views are
 * relative to the way the model faces: `forwardYawDeg` is its facing's yaw from +Z (90 for +X).
 */
export function renderTurntable(
  glb: Glb,
  options: { sizePx: number; framesPerClip: number; forwardYawDeg?: number },
): TurntableFrame[] {
  const facing = options.forwardYawDeg ?? 0;
  const framing = boundsOf(posedPrimitives(glb));
  if (!framing) return [];
  const out: TurntableFrame[] = [];
  for (const view of TURNTABLE_VIEWS) {
    const raster = renderView(glb, {
      sizePx: options.sizePx,
      yawDeg: facing + view.yawDeg,
      framing,
    });
    out.push({ name: `${view.name}.png`, png: encodePng(raster), view: view.name });
  }
  for (const clip of clips(glb)) {
    const slug =
      clip.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "clip";
    for (let i = 0; i < options.framesPerClip; i++) {
      const timeS = (i * clip.durationS) / options.framesPerClip;
      const raster = renderView(glb, {
        sizePx: options.sizePx,
        yawDeg: facing + 45,
        pose: samplePose(glb, clip.index, timeS),
        framing,
      });
      out.push({
        name: `clip-${slug}-${i}.png`,
        png: encodePng(raster),
        view: "three-quarter",
        clip: clip.name,
        timeS,
      });
    }
  }
  return out;
}
