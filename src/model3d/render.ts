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
  const textureIndex = pbr?.baseColorTexture?.index;
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

/** Renders one view of the model into an opaque RGBA raster. */
export function renderView(glb: Glb, options: RenderOptions): Raster {
  const size = options.sizePx;
  const raster = createRaster(size, size);
  raster.data.fill(BACKGROUND);
  for (let i = 3; i < raster.data.length; i += 4) raster.data[i] = 255;

  const { min, max } = options.framing;
  const centre: Vec = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2, 1e-6);
  const tanHalf = Math.tan(FOV / 2);
  const distance = radius / Math.sin(Math.atan(FILL * tanHalf));
  const yaw = (options.yawDeg * Math.PI) / 180;
  const toEye: Vec = [
    Math.sin(yaw) * Math.cos(ELEVATION),
    Math.sin(ELEVATION),
    Math.cos(yaw) * Math.cos(ELEVATION),
  ];
  const eye: Vec = [
    centre[0] + toEye[0] * distance,
    centre[1] + toEye[1] * distance,
    centre[2] + toEye[2] * distance,
  ];
  const forward: Vec = [-toEye[0], -toEye[1], -toEye[2]];
  const right = normalise(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const focal = size / 2 / tanHalf;
  const near = Math.max(distance - radius * 4, distance * 0.01);

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
    const texture = prim.uvs ? baseColorTexture(glb, prim.material) : null;
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
      if (flat) {
        flatLight =
          AMBIENT +
          (1 - AMBIENT) *
            Math.max(0, facing * (face[0] * LIGHT[0] + face[1] * LIGHT[1] + face[2] * LIGHT[2]));
      }

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
            const l = Math.hypot(nx, ny, nz) || 1;
            const d = (facing * (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2])) / l;
            light = AMBIENT + (1 - AMBIENT) * Math.max(0, d);
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
          const o = at * 4;
          raster.data[o] = Math.round(Math.min(1, r * light) * 255);
          raster.data[o + 1] = Math.round(Math.min(1, g * light) * 255);
          raster.data[o + 2] = Math.round(Math.min(1, b * light) * 255);
        }
      }
    }
  }
  return raster;
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
