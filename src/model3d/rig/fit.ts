/**
 * Fitting a skeleton template to a character's mesh: the mesh is baked at rest into the facing
 * frame, the template's rest positions are scaled by body length, each joint moves to the centre of
 * the mesh around it, and the mesh is skinned with smooth weights.
 */
import { InputError } from "../../errors.ts";
import type { Glb } from "../glb.ts";
import { posedPrimitives } from "../scene.ts";
import { add, cross, dot, length, normalize, rotY, rotate, scale, sub } from "./math.ts";
import type { V3 } from "./math.ts";
import type { SkeletonTemplate, TemplateFoot } from "./template.ts";

/** The mesh at rest: world-space primitives and every vertex in the facing frame. */
export interface BakedMesh {
  primitives: Array<{
    /** World positions and normals at rest (the file's frame, in metres). */
    positions: Float64Array;
    normals?: Float64Array;
    uvs?: Float64Array;
    indices: Uint32Array;
    material?: number;
    /** Index of this primitive's first vertex in `facing`. */
    first: number;
  }>;
  /** Every vertex in the facing frame (+z forward, +y up, +x left), flat xyz. */
  facing: Float64Array;
  count: number;
  /** Yaw in radians from the facing frame to the file's frame. */
  yaw: number;
}

export function bakeMesh(glb: Glb, yaw: number): BakedMesh {
  const posed = posedPrimitives(glb);
  if (posed.length === 0) throw new InputError("the model has no triangle geometry to rig");
  const count = posed.reduce((n, p) => n + p.positions.length / 3, 0);
  const facing = new Float64Array(count * 3);
  const back = rotY(-yaw);
  let first = 0;
  const primitives: BakedMesh["primitives"] = [];
  for (const p of posed) {
    const n = p.positions.length / 3;
    for (let v = 0; v < n; v++) {
      const f = rotate(back, [
        p.positions[v * 3]!,
        p.positions[v * 3 + 1]!,
        p.positions[v * 3 + 2]!,
      ]);
      facing.set(f, (first + v) * 3);
    }
    primitives.push({
      positions: p.positions,
      ...(p.normals && { normals: p.normals }),
      ...(p.uvs && { uvs: p.uvs }),
      indices: p.indices,
      ...(p.material !== undefined && { material: p.material }),
      first,
    });
    first += n;
  }
  return { primitives, facing, count, yaw };
}

const vertex = (mesh: BakedMesh, v: number): V3 => [
  mesh.facing[v * 3]!,
  mesh.facing[v * 3 + 1]!,
  mesh.facing[v * 3 + 2]!,
];

/** The fitted skeleton in the facing frame; rest rotations are identity. */
export interface Skeleton {
  names: string[];
  parent: number[];
  /** Rest world positions in the facing frame. */
  rest: V3[];
  bodyLength: number;
  /** The facing-frame point template coordinates are measured from (bounds centre on x and z). */
  origin: V3;
  feet: Array<TemplateFoot & { chain: [number, number, number, number] }>;
  template: SkeletonTemplate;
  /** How far fitting moved each joint from its template position, in body lengths. */
  moved: number[];
}

/** Indices ordered so that parents come before children. */
export function topological(parent: number[]): number[] {
  const order: number[] = [];
  const done = new Set<number>();
  const visit = (j: number) => {
    if (done.has(j)) return;
    if (parent[j]! >= 0) visit(parent[j]!);
    done.add(j);
    order.push(j);
  };
  parent.forEach((_, j) => visit(j));
  return order;
}

/** Body length is the mesh's rest extent along its facing axis (z), tail and nose included. */
export function bodyFrame(mesh: BakedMesh): { bodyLength: number; origin: V3 } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxY = -Infinity;
  for (let v = 0; v < mesh.count; v++) {
    const x = mesh.facing[v * 3]!;
    maxY = Math.max(maxY, mesh.facing[v * 3 + 1]!);
    const z = mesh.facing[v * 3 + 2]!;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const bodyLength = maxZ - minZ;
  if (!(bodyLength > 0)) throw new InputError("the model has no extent along its facing axis");
  // The midline is the median x of the torso (the middle of the body, above a third of its
  // height), so a tail curled to one side or a splayed leg does not pull it off the body.
  const midZ = (minZ + maxZ) / 2;
  const torso: number[] = [];
  for (let v = 0; v < mesh.count; v++) {
    const z = mesh.facing[v * 3 + 2]!;
    if (Math.abs(z - midZ) > TORSO_BODY_LENGTHS * bodyLength) continue;
    if (mesh.facing[v * 3 + 1]! < maxY / 3) continue;
    torso.push(mesh.facing[v * 3]!);
  }
  torso.sort((a, b) => a - b);
  const midX = torso.length > 0 ? torso[torso.length >> 1]! : (minX + maxX) / 2;
  return { bodyLength, origin: [midX, 0, midZ] };
}

/** Half the length of the torso band whose median x is the midline, in body lengths. */
const TORSO_BODY_LENGTHS = 0.2;
/** Ground-contact vertices: at most this high above the lowest vertex, in body lengths. */
const GROUND_BODY_LENGTHS = 0.03;
/** How far a foot's ground contact is searched for, and moved, from the template's, in body lengths. */
const FOOT_SEARCH_BODY_LENGTHS = 0.15;
const MIN_FOOT_VERTICES = 3;
/** How far along the foot its ground contact may be from the template's before the foot moves. */
const FOOT_DEAD_ZONE_BODY_LENGTHS = 0.02;

/**
 * Where each foot's ground contact is on the mesh, as an x-z shift from the template's: the
 * centroid of the ground-contact vertices nearest that foot (the sole between ankle and toe for a
 * plantigrade foot, the toe for a digitigrade one). A foot with too few vertices does not move.
 */
function footShifts(
  template: SkeletonTemplate,
  initial: V3[],
  index: Map<string, number>,
  mesh: BakedMesh,
  L: number,
): Array<[number, number]> {
  const contacts = template.feet.map((foot) => {
    const ankle = initial[index.get(foot.joints[2])!]!;
    const toe = initial[index.get(foot.joints[3])!]!;
    return foot.plantigrade
      ? ([(ankle[0] + toe[0]) / 2, (ankle[2] + toe[2]) / 2] as [number, number])
      : ([toe[0], toe[2]] as [number, number]);
  });
  let minY = Infinity;
  for (let v = 0; v < mesh.count; v++) minY = Math.min(minY, mesh.facing[v * 3 + 1]!);
  const sums = contacts.map(() => [0, 0, 0]);
  const search = FOOT_SEARCH_BODY_LENGTHS * L;
  for (let v = 0; v < mesh.count; v++) {
    if (mesh.facing[v * 3 + 1]! > minY + GROUND_BODY_LENGTHS * L) continue;
    const x = mesh.facing[v * 3]!;
    const z = mesh.facing[v * 3 + 2]!;
    let best = -1;
    let bestD = search;
    contacts.forEach(([cx, cz], f) => {
      const d = Math.hypot(x - cx, z - cz);
      if (d < bestD) [best, bestD] = [f, d];
    });
    if (best < 0) continue;
    const sum = sums[best]!;
    sum[0]! += x;
    sum[1]! += z;
    sum[2]! += 1;
  }
  return contacts.map(([cx, cz], f) => {
    const [sx, sz, n] = sums[f]!;
    if (n! < MIN_FOOT_VERTICES) return [0, 0];
    // Across the foot the sole's centroid is the foot's centre line, so x moves in full. Along it,
    // the centroid is not exactly between ankle and toe, so the template is trusted within a dead
    // zone and only a foot further off than that moves, by the excess.
    const dx = sx! / n! - cx;
    const dz = sz! / n! - cz;
    const dead = FOOT_DEAD_ZONE_BODY_LENGTHS * L;
    return [dx, Math.sign(dz) * Math.max(0, Math.abs(dz) - dead)];
  });
}

/** How high a raised heel's underside is looked for above the ground, in body lengths. */
const UNDERSIDE_HEIGHT_BODY_LENGTHS = 0.12;
/** Half the width of a foot's footprint, and the step along it, in body lengths. */
const UNDERSIDE_HALF_WIDTH_BODY_LENGTHS = 0.04;
const UNDERSIDE_STEP_BODY_LENGTHS = 0.01;
/** How far behind the ankle and ahead of the toe the underside is looked for, in body lengths. */
const UNDERSIDE_BEHIND_BODY_LENGTHS = 0.08;
const UNDERSIDE_AHEAD_BODY_LENGTHS = 0.04;
/** A heel end this much above the toe end (in body lengths) rests raised. */
const RAISED_HEEL_BODY_LENGTHS = 0.02;

/**
 * A plantigrade foot's underside when its heel rests raised: the lowest point of each step along
 * the foot's footprint (around the ankle and toe, below a raised heel's height), its extent along
 * the foot and its height above the ground there. Undefined when the foot rests flat, or has no
 * underside to measure.
 */
function raisedUnderside(
  mesh: BakedMesh,
  ankle: V3,
  toe: V3,
  L: number,
  groundY: number,
): { from: number; to: number; heightAt: (z: number) => number } | undefined {
  const x = (ankle[0] + toe[0]) / 2;
  const start = Math.min(ankle[2], toe[2]) - UNDERSIDE_BEHIND_BODY_LENGTHS * L;
  const end = Math.max(ankle[2], toe[2]) + UNDERSIDE_AHEAD_BODY_LENGTHS * L;
  const step = UNDERSIDE_STEP_BODY_LENGTHS * L;
  const lowest = new Map<number, number>();
  const consider = ([vx, vy, vz]: V3) => {
    if (Math.abs(vx - x) > UNDERSIDE_HALF_WIDTH_BODY_LENGTHS * L) return;
    if (vz < start || vz > end) return;
    const y = vy - groundY;
    if (y > UNDERSIDE_HEIGHT_BODY_LENGTHS * L) return;
    const bin = Math.floor((vz - start) / step);
    if (y < (lowest.get(bin) ?? Infinity)) lowest.set(bin, y);
  };
  // The surface, not only its vertices: a low-poly sole has none between heel and toe, so each
  // triangle edge is also sampled where it crosses the middle of each step.
  for (const prim of mesh.primitives) {
    for (let t = 0; t + 2 < prim.indices.length; t += 3) {
      const tri = [0, 1, 2].map((k) => vertex(mesh, prim.first + prim.indices[t + k]!));
      for (let e = 0; e < 3; e++) {
        const a = tri[e]!;
        const b = tri[(e + 1) % 3]!;
        consider(a);
        const lo = Math.max(Math.min(a[2], b[2]), start);
        const hi = Math.min(Math.max(a[2], b[2]), end);
        if (hi <= lo || a[2] === b[2]) continue;
        for (let k = Math.ceil((lo - start) / step - 0.5); start + (k + 0.5) * step <= hi; k++) {
          const z = start + (k + 0.5) * step;
          const u = (z - a[2]) / (b[2] - a[2]);
          if (u < 0 || u > 1) continue;
          consider(add(a, scale(sub(b, a), u)));
        }
      }
    }
  }
  const points = [...lowest.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bin, y]) => ({ z: start + (bin + 0.5) * step, y }));
  if (points.length < 3) return undefined;
  const from = points[0]!.z;
  const to = points.at(-1)!.z;
  const third = (to - from) / 3;
  const endY = (lo: number, hi: number) =>
    Math.min(...points.filter((p) => p.z >= lo && p.z <= hi).map((p) => p.y));
  if (endY(from, from + third) - endY(to - third, to) <= RAISED_HEEL_BODY_LENGTHS * L) {
    return undefined;
  }
  const heightAt = (z: number) => {
    let best = points[0]!;
    for (const p of points) if (Math.abs(p.z - z) < Math.abs(best.z - z)) best = p;
    return best.y;
  };
  return { from, to, heightAt };
}

const SEARCH_BODY_LENGTHS = 0.1;
const SLAB_BODY_LENGTHS = 0.02;
const MAX_MOVE_BODY_LENGTHS = 0.04;
const MIDLINE_BODY_LENGTHS = 0.02;
const MIN_SLAB_VERTICES = 8;

/**
 * Places the template on the mesh: rest positions × body length from the origin, then each joint
 * moves (across its bone, at most 0.05 body lengths) to the centroid of the mesh slab across the
 * bone at the joint, searching only its own side of the body.
 */
export function fitSkeleton(template: SkeletonTemplate, mesh: BakedMesh): Skeleton {
  const { bodyLength: L, origin } = bodyFrame(mesh);
  const names = template.joints.map((j) => j.name);
  const index = new Map(names.map((n, i) => [n, i]));
  const parent = template.joints.map((j) => (j.parent === null ? -1 : index.get(j.parent)!));
  const initial = template.joints.map((j) => add(origin, scale(j.rest, L)) as V3);
  // Each foot first goes to its ground contact on the mesh: the ankle and toe by the whole shift,
  // the knee (or elbow) by half, the hip (or shoulder) not at all.
  let groundY = Infinity;
  for (let v = 0; v < mesh.count; v++) groundY = Math.min(groundY, mesh.facing[v * 3 + 1]!);
  footShifts(template, initial, index, mesh, L).forEach(([dx, shiftZ], f) => {
    const foot = template.feet[f]!;
    const [, lower, ankle, toe] = foot.joints.map((n) => index.get(n)!);
    for (const j of [lower!, ankle!, toe!]) initial[j]![0] += dx * (j === lower ? 0.5 : 1);
    // A plantigrade foot that rests with its heel raised touches the ground only at its toe, so
    // its ground contact is not its middle: its underside, heel to toe, places it instead, and
    // the ankle and toe stand that far above the underside, so the ankle sits in the mesh's heel.
    const under = foot.plantigrade
      ? raisedUnderside(mesh, initial[ankle!]!, initial[toe!]!, L, groundY)
      : undefined;
    let dz = shiftZ;
    if (under) {
      const off = (under.from + under.to) / 2 - (initial[ankle!]![2] + initial[toe!]![2]) / 2;
      const dead = FOOT_DEAD_ZONE_BODY_LENGTHS * L;
      dz = Math.sign(off) * Math.max(0, Math.abs(off) - dead);
    }
    for (const j of [lower!, ankle!, toe!]) initial[j]![2] += dz * (j === lower ? 0.5 : 1);
    if (under) {
      for (const j of [ankle!, toe!]) initial[j]![1] += under.heightAt(initial[j]![2]);
    }
  });
  const children = names.map((_, i) => parent.flatMap((p, c) => (p === i ? [c] : [])));
  const rest: V3[] = initial.map((p) => [...p] as V3);
  const moved: number[] = names.map(() => 0);
  template.joints.forEach((joint, j) => {
    const p = initial[j]!;
    // The joint's bones: from its parent and to its children. It moves only across them, so a
    // joint at a corner (an ankle between shin and foot) re-centres sideways, not along a bone.
    const bonesAt: V3[] = [];
    if (parent[j]! >= 0) bonesAt.push(sub(p, initial[parent[j]!]!));
    for (const c of children[j]!) bonesAt.push(sub(initial[c]!, p));
    const basis: V3[] = [];
    for (const bone of bonesAt) {
      let d = bone;
      for (const e of basis) d = sub(d, scale(e, dot(d, e)));
      if (length(d) > 1e-6 * L && basis.length < 2) basis.push(normalize(d));
    }
    if (basis.length === 0) basis.push([0, 0, 1]);
    const axis = normalize(
      bonesAt[children[j]!.length > 0 ? bonesAt.length - children[j]!.length : 0] ?? [0, 0, 1],
    );
    const side = Math.abs(joint.rest[0]) > MIDLINE_BODY_LENGTHS ? Math.sign(joint.rest[0]) : 0;
    let n = 0;
    const sum: V3 = [0, 0, 0];
    for (let v = 0; v < mesh.count; v++) {
      const q = vertex(mesh, v);
      const d = sub(q, p);
      if (Math.abs(dot(d, axis)) > SLAB_BODY_LENGTHS * L) continue;
      if (length(d) > SEARCH_BODY_LENGTHS * L) continue;
      if (side !== 0 && Math.sign(q[0] - origin[0]) !== side) continue;
      sum[0] += q[0];
      sum[1] += q[1];
      sum[2] += q[2];
      n++;
    }
    if (n < MIN_SLAB_VERTICES) return;
    let shift = sub(scale(sum, 1 / n), p);
    for (const e of basis) shift = sub(shift, scale(e, dot(shift, e)));
    const distance = length(shift);
    const limit = MAX_MOVE_BODY_LENGTHS * L;
    if (distance > limit) shift = scale(shift, limit / distance);
    rest[j] = add(p, shift);
    moved[j] = length(shift) / L;
  });
  const feet = template.feet.map((foot) => ({
    ...foot,
    chain: foot.joints.map((name) => index.get(name)!) as [number, number, number, number],
  }));
  return { names, parent, rest, bodyLength: L, origin, feet, template, moved };
}

/** Per-vertex skin: four joint indices and weights each. */
export interface SkinWeights {
  joints: Uint16Array;
  weights: Float32Array;
}

function segmentDistance(p: V3, a: V3, b: V3): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return length(sub(p, add(a, scale(ab, t))));
}

/** Bones as segments, each owned by the joint at its start (leaf joints own no segment). */
export function bones(skeleton: Skeleton): Array<{ joint: number; a: V3; b: V3 }> {
  const out: Array<{ joint: number; a: V3; b: V3 }> = [];
  skeleton.parent.forEach((p, c) => {
    if (p >= 0) out.push({ joint: p, a: skeleton.rest[p]!, b: skeleton.rest[c]! });
  });
  return out;
}

const SMOOTHING_ROUNDS = 4;

/**
 * Smooth weights: inverse distance to each bone (power 4), then rounds of averaging across the
 * mesh with vertices welded by position, then the four largest, normalised.
 */
/** A plantigrade foot's bone reaches this share of its length behind the ankle, to the heel. */
const HEEL_SHARE = 0.6;

export function skinWeights(skeleton: Skeleton, mesh: BakedMesh): SkinWeights {
  const J = skeleton.names.length;
  // The heel lies behind a plantigrade ankle and moves with the foot, not the shin, so the foot's
  // bone starts behind the ankle.
  const heels = new Set(skeleton.feet.filter((f) => f.plantigrade).map((f) => f.chain[2]));
  const segments = bones(skeleton).map((s) =>
    heels.has(s.joint) ? { ...s, a: sub(s.a, scale(sub(s.b, s.a), HEEL_SHARE)) } : s,
  );
  const epsilon = 0.01 * skeleton.bodyLength;
  const dense = new Float64Array(mesh.count * J);
  for (let v = 0; v < mesh.count; v++) {
    const p = vertex(mesh, v);
    const row = v * J;
    for (const s of segments) {
      const d = segmentDistance(p, s.a, s.b) + epsilon;
      const w = 1 / (d * d * d * d);
      if (w > dense[row + s.joint]!) dense[row + s.joint] = w;
    }
    let total = 0;
    for (let j = 0; j < J; j++) total += dense[row + j]!;
    for (let j = 0; j < J; j++) dense[row + j]! /= total || 1;
  }

  // Weld by position so seams (split UVs, separate primitives) smooth together.
  const key = (v: number) =>
    [0, 1, 2]
      .map((c) => Math.round(mesh.facing[v * 3 + c]! / (skeleton.bodyLength * 1e-5)))
      .join(",");
  const weldId = new Int32Array(mesh.count);
  const ids = new Map<string, number>();
  for (let v = 0; v < mesh.count; v++) {
    const k = key(v);
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    weldId[v] = id;
  }
  const neighbours: Array<Set<number>> = Array.from({ length: ids.size }, () => new Set());
  for (const prim of mesh.primitives) {
    for (let t = 0; t + 2 < prim.indices.length; t += 3) {
      const tri = [0, 1, 2].map((k) => weldId[prim.first + prim.indices[t + k]!]!);
      for (const a of tri) for (const b of tri) if (a !== b) neighbours[a]!.add(b);
    }
  }
  // Weights per welded vertex: the mean of its copies.
  let welded = new Float64Array(ids.size * J);
  const copies = new Uint32Array(ids.size);
  for (let v = 0; v < mesh.count; v++) {
    const id = weldId[v]!;
    copies[id]!++;
    for (let j = 0; j < J; j++) welded[id * J + j]! += dense[v * J + j]!;
  }
  for (let id = 0; id < ids.size; id++) {
    for (let j = 0; j < J; j++) welded[id * J + j]! /= copies[id]! || 1;
  }
  for (let round = 0; round < SMOOTHING_ROUNDS; round++) {
    const next = new Float64Array(welded.length);
    for (let id = 0; id < ids.size; id++) {
      const around = neighbours[id]!;
      for (let j = 0; j < J; j++) {
        let mean = 0;
        for (const n of around) mean += welded[n * J + j]!;
        next[id * J + j] =
          around.size > 0
            ? 0.5 * welded[id * J + j]! + (0.5 * mean) / around.size
            : welded[id * J + j]!;
      }
    }
    welded = next;
  }

  const joints = new Uint16Array(mesh.count * 4);
  const weights = new Float32Array(mesh.count * 4);
  const top: Array<[number, number]> = [];
  for (let v = 0; v < mesh.count; v++) {
    const row = weldId[v]! * J;
    top.length = 0;
    for (let j = 0; j < J; j++) {
      const w = welded[row + j]!;
      if (w <= 0) continue;
      top.push([j, w]);
    }
    top.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const kept = top.slice(0, 4).filter(([, w]) => w > 1e-4);
    const total = kept.reduce((s, [, w]) => s + w, 0) || 1;
    kept.forEach(([j, w], k) => {
      joints[v * 4 + k] = j;
      weights[v * 4 + k] = w / total;
    });
    if (kept.length === 0) {
      joints[v * 4] = 0;
      weights[v * 4] = 1;
    }
  }
  return { joints, weights };
}

/** The joint carrying most of a vertex's weight. */
export function dominantJoint(skin: SkinWeights, v: number): number {
  let best = 0;
  for (let k = 1; k < 4; k++) if (skin.weights[v * 4 + k]! > skin.weights[v * 4 + best]!) best = k;
  return skin.joints[v * 4 + best]!;
}

/** Bins along a plantigrade foot, heel to toe, whose lowest vertices make up its underside. */
const SOLE_BINS = 8;
/** The share of the foot's length, at each end, whose underside is its heel or its toe. */
const SOLE_END_SHARE = 1 / 3;

/** The foot's forward direction at rest, level: ankle to toe in x-z (else +z). */
function footForward(skeleton: Skeleton, ankle: number, toe: number): V3 {
  const d = sub(skeleton.rest[toe]!, skeleton.rest[ankle]!);
  const flat: V3 = [d[0], 0, d[2]];
  return length(flat) > 1e-9 ? normalize(flat) : [0, 0, 1];
}

/**
 * Each foot's sole: of the vertices the ankle (or wrist) and toe carry at least three quarters of
 * (else those they carry most), the lowest tenth at rest, at least three. A plantigrade foot's
 * sole also takes the lowest of the vertices they carry most along its whole length, heel to toe,
 * so a heel that rests raised is part of the sole and is measured. Indices into the mesh.
 */
export function soles(skeleton: Skeleton, mesh: BakedMesh, skin: SkinWeights): number[][] {
  return skeleton.feet.map((foot) => {
    const [, , ankle, toe] = foot.chain;
    const firm: number[] = [];
    const dominant: number[] = [];
    for (let v = 0; v < mesh.count; v++) {
      let carried = 0;
      for (let k = 0; k < 4; k++) {
        const j = skin.joints[v * 4 + k];
        if (j === ankle || j === toe) carried += skin.weights[v * 4 + k]!;
      }
      if (carried >= 0.75) firm.push(v);
      const j = dominantJoint(skin, v);
      if (j === ankle || j === toe) dominant.push(v);
    }
    const own = firm.length >= 3 ? firm : dominant;
    own.sort((a, b) => mesh.facing[a * 3 + 1]! - mesh.facing[b * 3 + 1]! || a - b);
    const lowest = own.slice(0, Math.max(3, Math.ceil(own.length / 10)));
    if (!foot.plantigrade || dominant.length === 0) return lowest;
    // Along the foot: the lowest tenth (at least one) of each bin, heel to toe, of the vertices
    // the ankle and toe carry most (a heel is carried partly by the shin too).
    dominant.sort((a, b) => mesh.facing[a * 3 + 1]! - mesh.facing[b * 3 + 1]! || a - b);
    const forward = footForward(skeleton, ankle, toe);
    const along = dominant.map((v) => dot(vertex(mesh, v), forward));
    const lo = Math.min(...along);
    const span = Math.max(...along) - lo;
    const bins: number[][] = Array.from({ length: SOLE_BINS }, () => []);
    dominant.forEach((v, i) => {
      const b =
        span > 0 ? Math.min(SOLE_BINS - 1, Math.floor(((along[i]! - lo) / span) * SOLE_BINS)) : 0;
      bins[b]!.push(v); // `own` is sorted lowest first, so each bin is too.
    });
    const sole = new Set(lowest);
    for (const bin of bins) for (const v of bin.slice(0, Math.ceil(bin.length / 10))) sole.add(v);
    return [...sole].sort((a, b) => a - b);
  });
}

/**
 * A plantigrade foot's sole split into its heel end and its toe end (the rear and front third of
 * the sole's length at rest), so a heel held above the toe can be measured on the mesh and laid
 * flat, and how far the heel end's lowest vertex rests above the toe end's. A digitigrade foot has
 * no ends: both are empty.
 */
export function soleEnds(
  skeleton: Skeleton,
  mesh: BakedMesh,
  soleVertices: number[][],
): Array<{ heel: number[]; toe: number[]; restRise: number }> {
  return skeleton.feet.map((foot, f) => {
    const sole = soleVertices[f]!;
    if (!foot.plantigrade || sole.length === 0) return { heel: [], toe: [], restRise: 0 };
    const forward = footForward(skeleton, foot.chain[2], foot.chain[3]);
    const along = sole.map((v) => dot(vertex(mesh, v), forward));
    const lo = Math.min(...along);
    const hi = Math.max(...along);
    const cut = (hi - lo) * SOLE_END_SHARE;
    const heel = sole.filter((_, i) => along[i]! <= lo + cut);
    const toe = sole.filter((_, i) => along[i]! >= hi - cut);
    const lowest = (vs: number[]) => Math.min(...vs.map((v) => mesh.facing[v * 3 + 1]!));
    return { heel, toe, restRise: heel.length && toe.length ? lowest(heel) - lowest(toe) : 0 };
  });
}

/** The unit normal of a leg's bend plane at rest (knee direction × upper-to-ankle direction). */
export function bendNormal(
  skeleton: Skeleton,
  chain: [number, number, number, number],
  fallbackKnee: V3,
): {
  knee: V3;
  normal: V3;
} {
  const [u, l, a] = chain;
  const P = skeleton.rest;
  const along = normalize(sub(P[a]!, P[u]!));
  const offset = sub(P[l]!, P[u]!);
  let knee = sub(offset, scale(along, dot(offset, along)));
  if (length(knee) < 1e-4 * skeleton.bodyLength) knee = fallbackKnee;
  knee = normalize(sub(knee, scale(along, dot(knee, along))));
  return { knee, normal: normalize(cross(knee, along)) };
}
