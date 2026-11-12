/**
 * Fur groom maps on a character's UVs: per-texel region, length, comb direction and density, and an
 * optional tint. Regions come from the rig template's joint roles and feet, never from names.
 */
import { createRaster } from "../../image/raster.ts";
import type { Raster } from "../../image/raster.ts";
import type { Vec3 } from "../scene.ts";
import { dilate } from "./project.ts";
import type { TexelMap } from "./texels.ts";

export const GROOM_MAPS = ["length", "direction", "density"] as const;
export type GroomRegion = "face" | "cheek" | "head" | "neck" | "body" | "leg" | "tail";
export const GROOM_REGIONS: readonly GroomRegion[] = [
  "face",
  "cheek",
  "head",
  "neck",
  "body",
  "leg",
  "tail",
];

export interface GroomSkeleton {
  /** In `skin.joints` order, so a texel's `joint` indexes it. */
  joints: Array<{
    name: string;
    parent: number;
    position: Vec3;
    role?: "pelvis" | "spine" | "neck" | "head" | "tail";
    /** A joint of a template foot chain. */
    foot?: boolean;
  }>;
  /** The unit vector the character faces (+z after normalisation). */
  forward: Vec3;
}

export interface SeasonGroom {
  lengthMm: Record<GroomRegion, number>;
  /** 0..1. */
  density: Record<GroomRegion, number>;
  /** Multiplies the base colour; `tipWeight` is how strongly it reaches the fur tips. */
  tint?: { color: [number, number, number]; tipWeight: number };
}

export interface SurfaceMarker {
  point: Vec3;
  radius: number;
}

const DILATE_PX = 8;

function regionIndex(region: GroomRegion): number {
  return GROOM_REGIONS.indexOf(region);
}

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}

/** Each joint's region class: foot chains are legs, a role names its own, others inherit the parent's. */
function jointClasses(skeleton: GroomSkeleton): Array<GroomRegion> {
  const { joints } = skeleton;
  const memo: Array<GroomRegion | undefined> = new Array(joints.length);
  const resolve = (j: number, depth: number): GroomRegion => {
    const known = memo[j];
    if (known) return known;
    const joint = joints[j]!;
    let result: GroomRegion;
    if (joint.foot) result = "leg";
    else if (joint.role === "head") result = "head";
    else if (joint.role === "neck") result = "neck";
    else if (joint.role === "tail") result = "tail";
    else if (joint.role) result = "body";
    else if (joint.parent >= 0 && joint.parent < joints.length && depth < joints.length) {
      result = resolve(joint.parent, depth + 1);
    } else result = "body";
    memo[j] = result;
    return result;
  };
  return joints.map((_, j) => resolve(j, 0));
}

/**
 * Per-texel region as an index into `GROOM_REGIONS`. Head texels in front of the head joint (toward
 * `forward`) are face, lateral ones below the head joint's height are cheek, the rest head; neck,
 * tail and foot chains map to neck, tail and leg; pelvis, spine, unskinned and anything else body.
 */
export function texelRegions(texels: TexelMap, skeleton: GroomSkeleton): Uint8Array {
  const { size, covered, position, normal, joint } = texels;
  const total = size * size;
  const out = new Uint8Array(total).fill(regionIndex("body"));
  const classes = jointClasses(skeleton);
  const fwd = unit(skeleton.forward);
  const rightAxis = unit([fwd[2], 0, -fwd[0]]);
  const face = regionIndex("face");
  const cheek = regionIndex("cheek");
  const head = regionIndex("head");
  for (let i = 0; i < total; i++) {
    if (!covered[i]) continue;
    const j = joint[i]!;
    if (j < 0 || j >= classes.length) continue;
    const cls = classes[j]!;
    if (cls !== "head") {
      out[i] = regionIndex(cls);
      continue;
    }
    let anchor = j;
    for (let k = 0; k < classes.length && skeleton.joints[anchor]!.role !== "head"; k++) {
      const parent = skeleton.joints[anchor]!.parent;
      if (parent < 0 || classes[parent] !== "head") break;
      anchor = parent;
    }
    const origin = skeleton.joints[anchor]!.position;
    const dx = position[i * 3]! - origin[0];
    const dy = position[i * 3 + 1]! - origin[1];
    const dz = position[i * 3 + 2]! - origin[2];
    if (dx * fwd[0] + dy * fwd[1] + dz * fwd[2] > 0) {
      out[i] = face;
      continue;
    }
    const lateral =
      Math.abs(normal[i * 3]! * rightAxis[0] + normal[i * 3 + 2]! * rightAxis[2]) > 0.5;
    out[i] = lateral && dy < 0 ? cheek : head;
  }
  return out;
}

/** Texels within `radius` (3D distance) of any marker. */
export function markerMask(texels: TexelMap, markers: SurfaceMarker[]): Uint8Array {
  const { size, covered, position } = texels;
  const out = new Uint8Array(size * size);
  for (let i = 0; i < out.length; i++) {
    if (!covered[i]) continue;
    for (const m of markers) {
      const d = Math.hypot(
        position[i * 3]! - m.point[0],
        position[i * 3 + 1]! - m.point[1],
        position[i * 3 + 2]! - m.point[2],
      );
      if (d <= m.radius) {
        out[i] = 1;
        break;
      }
    }
  }
  return out;
}

/**
 * Paw pads: covered texels whose normal points down (n.y < -0.5) and whose position lies under a
 * foot, within `radius` in xz of the ankle-to-toe segment and below the ankle's height.
 */
export function padMask(
  texels: TexelMap,
  feet: Array<{ ankle: Vec3; toe: Vec3 }>,
  radius: number,
): Uint8Array {
  const { size, covered, position, normal } = texels;
  const out = new Uint8Array(size * size);
  for (let i = 0; i < out.length; i++) {
    if (!covered[i] || normal[i * 3 + 1]! >= -0.5) continue;
    const x = position[i * 3]!;
    const y = position[i * 3 + 1]!;
    const z = position[i * 3 + 2]!;
    for (const foot of feet) {
      if (y >= foot.ankle[1]) continue;
      const sx = foot.toe[0] - foot.ankle[0];
      const sz = foot.toe[2] - foot.ankle[2];
      const l2 = sx * sx + sz * sz;
      const t =
        l2 > 0
          ? Math.min(1, Math.max(0, ((x - foot.ankle[0]) * sx + (z - foot.ankle[2]) * sz) / l2))
          : 0;
      if (Math.hypot(x - foot.ankle[0] - sx * t, z - foot.ankle[2] - sz * t) <= radius) {
        out[i] = 1;
        break;
      }
    }
  }
  return out;
}

export interface GroomMaps {
  length: Raster;
  direction: Raster;
  density: Raster;
  tint?: Raster;
  /** The season's longest region length; length 255 is this. */
  maxLengthM: number;
}

/** A box blur of `field` over covered texels only (masked mean), radius `r`. */
function blurCovered(
  field: Float32Array,
  covered: Uint8Array,
  size: number,
  r: number,
): Float32Array {
  const tmpV = new Float32Array(size * size);
  const tmpW = new Float32Array(size * size);
  const outV = new Float32Array(size * size);
  const outW = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    let v = 0;
    let w = 0;
    const row = y * size;
    for (let x = -r; x < size; x++) {
      const add = x + r;
      if (add < size && covered[row + add]) {
        v += field[row + add]!;
        w++;
      }
      const drop = x - r - 1;
      if (drop >= 0 && covered[row + drop]) {
        v -= field[row + drop]!;
        w--;
      }
      if (x >= 0) {
        tmpV[row + x] = v;
        tmpW[row + x] = w;
      }
    }
  }
  for (let x = 0; x < size; x++) {
    let v = 0;
    let w = 0;
    for (let y = -r; y < size; y++) {
      const add = y + r;
      if (add < size) {
        v += tmpV[add * size + x]!;
        w += tmpW[add * size + x]!;
      }
      const drop = y - r - 1;
      if (drop >= 0) {
        v -= tmpV[drop * size + x]!;
        w -= tmpW[drop * size + x]!;
      }
      if (y >= 0) {
        outV[y * size + x] = v;
        outW[y * size + x] = w;
      }
    }
  }
  for (let i = 0; i < outV.length; i++) {
    outV[i] = covered[i] && outW[i]! > 0.5 ? outV[i]! / outW[i]! : (field[i] ?? 0);
  }
  return outV;
}

function boneDirections(skeleton: GroomSkeleton): { toward: Vec3[]; along: Vec3[] } {
  const { joints } = skeleton;
  const back = unit([-skeleton.forward[0], -skeleton.forward[1], -skeleton.forward[2]]);
  const firstChild = new Array<number>(joints.length).fill(-1);
  joints.forEach((joint, j) => {
    if (joint.parent >= 0 && joint.parent < joints.length && firstChild[joint.parent]! < 0) {
      firstChild[joint.parent] = j;
    }
  });
  const between = (from: Vec3, to: Vec3): Vec3 =>
    unit([to[0] - from[0], to[1] - from[1], to[2] - from[2]]);
  const toward = joints.map((joint): Vec3 => {
    const parent = joints[joint.parent];
    const d = parent ? between(joint.position, parent.position) : back;
    return d[0] === 0 && d[1] === 0 && d[2] === 0 ? back : d;
  });
  const along = joints.map((joint, j): Vec3 => {
    const child = joints[firstChild[j]!];
    const parent = joints[joint.parent];
    const d = child
      ? between(joint.position, child.position)
      : parent
        ? between(parent.position, joint.position)
        : back;
    return d[0] === 0 && d[1] === 0 && d[2] === 0 ? back : d;
  });
  return { toward, along };
}

/**
 * The groom maps. Length is grey, 0 on every `bare` texel and at least 1 on any other covered
 * texel, 255 = `maxLengthM`; region values are blurred across borders before the bare mask applies.
 * Direction is the model-space comb direction (rgb = d*0.5+0.5): the bone direction of the texel's
 * joint (joint to child for tail and leg, toward the parent otherwise, so fur combs snout to tail),
 * tangent to the surface and blended 30% toward gravity. Density is grey per region, blurred, 0 on
 * bare. The tint (only with `season.tint`) is RGBA with alpha = tipWeight on covered non-bare
 * texels. Uncovered texels are dilated so filtering stays clean.
 */
export function groomMaps(
  texels: TexelMap,
  regions: Uint8Array,
  bare: Uint8Array,
  season: SeasonGroom,
  skeleton: GroomSkeleton,
): GroomMaps {
  const { size, covered, normal, joint } = texels;
  const total = size * size;
  const maxMm = Math.max(1e-6, ...GROOM_REGIONS.map((r) => season.lengthMm[r]));
  const lengthByRegion = GROOM_REGIONS.map((r) => season.lengthMm[r]);
  const densityByRegion = GROOM_REGIONS.map((r) => season.density[r]);

  const lengthField = new Float32Array(total);
  const densityField = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    if (!covered[i]) continue;
    const r = regions[i]!;
    lengthField[i] = lengthByRegion[r] ?? 0;
    densityField[i] = densityByRegion[r] ?? 0;
  }
  const radius = Math.max(2, Math.round(size / 512));
  const lengthBlur = blurCovered(lengthField, covered, size, radius);
  const densityBlur = blurCovered(densityField, covered, size, radius);

  const length = createRaster(size, size);
  const density = createRaster(size, size);
  const direction = createRaster(size, size);
  const tint = season.tint ? createRaster(size, size) : undefined;
  const { toward, along } = boneDirections(skeleton);
  const legIndex = regionIndex("leg");
  const tailIndex = regionIndex("tail");
  const back = unit([-skeleton.forward[0], -skeleton.forward[1], -skeleton.forward[2]]);
  const tintRgb = season.tint?.color.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255));
  const tintAlpha = season.tint
    ? Math.round(Math.min(1, Math.max(0, season.tint.tipWeight)) * 255)
    : 0;

  for (let i = 0; i < total; i++) {
    const o = i * 4;
    length.data[o + 3] = 255;
    density.data[o + 3] = 255;
    direction.data[o + 3] = 255;
    if (!covered[i]) continue;
    const isBare = bare[i] !== 0;
    const l = isBare ? 0 : Math.max(1, Math.round((lengthBlur[i]! / maxMm) * 255));
    const d = isBare ? 0 : Math.round(Math.min(1, Math.max(0, densityBlur[i]!)) * 255);
    length.data[o] = length.data[o + 1] = length.data[o + 2] = Math.min(255, l);
    density.data[o] = density.data[o + 1] = density.data[o + 2] = d;

    const r = regions[i]!;
    const j = joint[i]!;
    let dir: Vec3 = back;
    if (j >= 0 && j < toward.length)
      dir = r === legIndex || r === tailIndex ? along[j]! : toward[j]!;
    const nx = normal[i * 3]!;
    const ny = normal[i * 3 + 1]!;
    const nz = normal[i * 3 + 2]!;
    const tangent = (v: Vec3): Vec3 => {
      const dot = v[0] * nx + v[1] * ny + v[2] * nz;
      return unit([v[0] - dot * nx, v[1] - dot * ny, v[2] - dot * nz]);
    };
    const bone = tangent(dir);
    const gravity = tangent([0, -1, 0]);
    let comb = unit([
      bone[0] * 0.7 + gravity[0] * 0.3,
      bone[1] * 0.7 + gravity[1] * 0.3,
      bone[2] * 0.7 + gravity[2] * 0.3,
    ]);
    if (comb[0] === 0 && comb[1] === 0 && comb[2] === 0) comb = tangent(back);
    if (comb[0] === 0 && comb[1] === 0 && comb[2] === 0) comb = unit([ny, -nx, 0]);
    for (let k = 0; k < 3; k++) direction.data[o + k] = Math.round((comb[k]! * 0.5 + 0.5) * 255);

    if (tint && tintRgb) {
      tint.data[o] = tintRgb[0]!;
      tint.data[o + 1] = tintRgb[1]!;
      tint.data[o + 2] = tintRgb[2]!;
      tint.data[o + 3] = isBare ? 0 : tintAlpha;
    }
  }

  return {
    length: dilate(length, covered, DILATE_PX),
    direction: dilate(direction, covered, DILATE_PX),
    density: dilate(density, covered, DILATE_PX),
    ...(tint && { tint: dilate(tint, covered, DILATE_PX) }),
    maxLengthM: maxMm / 1000,
  };
}

/** Whether length is zero exactly on bare texels: counts of the two kinds of mismatch. */
export function groomMaskCheck(
  length: Raster,
  texels: TexelMap,
  bare: Uint8Array,
): { ok: boolean; zeroOnBare: number; zeroOutside: number; bareTexels: number } {
  let zeroOnBare = 0;
  let zeroOutside = 0;
  let bareTexels = 0;
  const total = texels.size * texels.size;
  for (let i = 0; i < total; i++) {
    if (!texels.covered[i]) continue;
    const value = length.data[i * 4]!;
    if (bare[i]) {
      bareTexels++;
      if (value > 0) zeroOnBare++;
    } else if (value === 0) zeroOutside++;
  }
  return { ok: zeroOnBare === 0 && zeroOutside === 0, zeroOnBare, zeroOutside, bareTexels };
}
