/**
 * The scene of a `.glb` character: node transforms, animation sampling, skinning, the measures the
 * target profile budgets, and the edits Assetforge makes (normalisation, clip names, loop closing).
 */
import { InputError } from "../errors.ts";
import { readAccessor, writeAccessorElement } from "./glb.ts";
import type { Glb, GltfDocument, GltfNode } from "./glb.ts";

export type Mat4 = Float64Array;
export type Vec3 = [number, number, number];

// --- math (column-major 4×4, as glTF stores matrices) ---

export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

export function fromTrs(t: ArrayLike<number>, q: ArrayLike<number>, s: ArrayLike<number>): Mat4 {
  const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
  const [sx, sy, sz] = [s[0]!, s[1]!, s[2]!];
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * sx;
  m[1] = 2 * (x * y + z * w) * sx;
  m[2] = 2 * (x * z - y * w) * sx;
  m[4] = 2 * (x * y - z * w) * sy;
  m[5] = (1 - 2 * (x * x + z * z)) * sy;
  m[6] = 2 * (y * z + x * w) * sy;
  m[8] = 2 * (x * z + y * w) * sz;
  m[9] = 2 * (y * z - x * w) * sz;
  m[10] = (1 - 2 * (x * x + y * y)) * sz;
  m[12] = t[0]!;
  m[13] = t[1]!;
  m[14] = t[2]!;
  m[15] = 1;
  return m;
}

export function transformPoint(m: Mat4, x: number, y: number, z: number): Vec3 {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

export function transformDirection(m: Mat4, x: number, y: number, z: number): Vec3 {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z,
    m[1]! * x + m[5]! * y + m[9]! * z,
    m[2]! * x + m[6]! * y + m[10]! * z,
  ];
}

function slerp(a: ArrayLike<number>, b: ArrayLike<number>, t: number): number[] {
  let dot = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!;
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  let wa = 1 - t;
  let wb = t * sign;
  if (dot < 0.9995) {
    const theta = Math.acos(dot);
    const sin = Math.sin(theta);
    wa = Math.sin((1 - t) * theta) / sin;
    wb = (Math.sin(t * theta) / sin) * sign;
  }
  const q = [0, 1, 2, 3].map((i) => wa * a[i]! + wb * b[i]!);
  const length = Math.hypot(...q) || 1;
  return q.map((v) => v / length);
}

/** The angle in degrees between two unit quaternions. */
export function quatAngleDeg(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const dot = Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

// --- nodes and poses ---

export interface Trs {
  t: number[];
  r: number[];
  s: number[];
}

/** A pose: each animated node's TRS; nodes not in it keep their rest transform. */
export type Pose = Map<number, Trs>;

function restTrs(node: GltfNode): Trs {
  return {
    t: [...(node.translation ?? [0, 0, 0])],
    r: [...(node.rotation ?? [0, 0, 0, 1])],
    s: [...(node.scale ?? [1, 1, 1])],
  };
}

function localMatrix(node: GltfNode, pose?: Trs): Mat4 {
  if (pose) return fromTrs(pose.t, pose.r, pose.s);
  if (node.matrix) return Float64Array.from(node.matrix);
  const rest = restTrs(node);
  return fromTrs(rest.t, rest.r, rest.s);
}

/** The scene's root nodes. */
export function sceneRoots(json: GltfDocument): number[] {
  const scene = json.scenes?.[json.scene ?? 0];
  if (scene?.nodes) return scene.nodes;
  const children = new Set((json.nodes ?? []).flatMap((n) => n.children ?? []));
  return (json.nodes ?? []).map((_, i) => i).filter((i) => !children.has(i));
}

/** Every node's world matrix, in a pose (or the rest pose). Nodes outside the scene are absent. */
export function worldMatrices(json: GltfDocument, pose?: Pose): Map<number, Mat4> {
  const out = new Map<number, Mat4>();
  const visit = (index: number, parent: Mat4, depth: number) => {
    if (depth > 256 || out.has(index)) return;
    const node = json.nodes?.[index];
    if (!node) return;
    const world = multiply(parent, localMatrix(node, pose?.get(index)));
    out.set(index, world);
    for (const child of node.children ?? []) visit(child, world, depth + 1);
  };
  for (const root of sceneRoots(json)) visit(root, identity(), 0);
  return out;
}

// --- animation ---

export interface Clip {
  index: number;
  name: string;
  durationS: number;
}

export function clips(glb: Glb): Clip[] {
  return (glb.json.animations ?? []).map((animation, index) => {
    let duration = 0;
    for (const sampler of animation.samplers) {
      const max = glb.json.accessors?.[sampler.input]?.max?.[0];
      const times = max === undefined ? readAccessor(glb, sampler.input) : [max];
      for (const t of times) duration = Math.max(duration, t);
    }
    return { index, name: animation.name ?? `animation ${index}`, durationS: duration };
  });
}

interface Track {
  node: number;
  path: "translation" | "rotation" | "scale";
  times: Float64Array;
  values: Float64Array;
  width: number;
  interpolation: string;
}

const trackCache = new WeakMap<Glb, Map<number, Track[]>>();

function tracks(glb: Glb, animation: number): Track[] {
  let perGlb = trackCache.get(glb);
  if (!perGlb) trackCache.set(glb, (perGlb = new Map()));
  const cached = perGlb.get(animation);
  if (cached) return cached;
  const a = glb.json.animations?.[animation];
  if (!a) throw new InputError(`animation ${animation} does not exist`);
  const out: Track[] = [];
  for (const channel of a.channels) {
    const { node, path } = channel.target;
    if (node === undefined || !["translation", "rotation", "scale"].includes(path)) continue;
    const sampler = a.samplers[channel.sampler];
    if (!sampler) continue;
    out.push({
      node,
      path: path as Track["path"],
      times: readAccessor(glb, sampler.input),
      values: readAccessor(glb, sampler.output),
      width: path === "rotation" ? 4 : 3,
      interpolation: sampler.interpolation ?? "LINEAR",
    });
  }
  perGlb.set(animation, out);
  return out;
}

function keyValue(track: Track, key: number): number[] {
  // Cubic-spline outputs hold in-tangent, value, out-tangent per key; take the value.
  const stride = track.interpolation === "CUBICSPLINE" ? track.width * 3 : track.width;
  const offset = track.interpolation === "CUBICSPLINE" ? track.width : 0;
  const start = key * stride + offset;
  return Array.from(track.values.subarray(start, start + track.width));
}

function sampleTrack(track: Track, time: number): number[] {
  const { times } = track;
  const last = times.length - 1;
  if (last < 0) return [];
  if (time <= times[0]!) return keyValue(track, 0);
  if (time >= times[last]!) return keyValue(track, last);
  let k = 0;
  while (k < last - 1 && times[k + 1]! <= time) k++;
  const a = keyValue(track, k);
  if (track.interpolation === "STEP") return a;
  const b = keyValue(track, k + 1);
  const t = (time - times[k]!) / (times[k + 1]! - times[k]! || 1);
  if (track.path === "rotation") return slerp(a, b, t);
  return a.map((v, i) => v + (b[i]! - v) * t);
}

/** The pose of an animation at a time in seconds (clamped to its keys). */
export function samplePose(glb: Glb, animation: number, time: number): Pose {
  const pose: Pose = new Map();
  for (const track of tracks(glb, animation)) {
    const node = glb.json.nodes?.[track.node];
    if (!node) continue;
    let trs = pose.get(track.node);
    if (!trs) pose.set(track.node, (trs = restTrs(node)));
    const value = sampleTrack(track, time);
    if (value.length === 0) continue;
    if (track.path === "translation") trs.t = value;
    else if (track.path === "rotation") trs.r = value;
    else trs.s = value;
  }
  return pose;
}

// --- geometry ---

/** One triangle-list primitive in world space for a pose, with what the renderer needs. */
export interface PosedPrimitive {
  positions: Float64Array;
  normals?: Float64Array;
  uvs?: Float64Array;
  indices: Uint32Array;
  material?: number;
}

function triangleIndices(glb: Glb, primitive: { indices?: number; mode?: number }, count: number) {
  const mode = primitive.mode ?? 4;
  const raw =
    primitive.indices === undefined
      ? Uint32Array.from({ length: count }, (_, i) => i)
      : Uint32Array.from(readAccessor(glb, primitive.indices));
  if (mode === 4) return raw.subarray(0, raw.length - (raw.length % 3));
  const out: number[] = [];
  if (mode === 5) {
    for (let i = 0; i + 2 < raw.length; i++) {
      if (i % 2 === 0) out.push(raw[i]!, raw[i + 1]!, raw[i + 2]!);
      else out.push(raw[i + 1]!, raw[i]!, raw[i + 2]!);
    }
  } else if (mode === 6) {
    for (let i = 1; i + 1 < raw.length; i++) out.push(raw[0]!, raw[i]!, raw[i + 1]!);
  }
  return Uint32Array.from(out);
}

/**
 * Every triangle primitive in world space for a pose (the rest pose when none is given): skinned
 * meshes through their joints, the rest through their node's world matrix.
 */
export function posedPrimitives(glb: Glb, pose?: Pose): PosedPrimitive[] {
  const { json } = glb;
  const world = worldMatrices(json, pose);
  const out: PosedPrimitive[] = [];
  for (const [nodeIndex, nodeWorld] of world) {
    const node = json.nodes?.[nodeIndex];
    if (node?.mesh === undefined) continue;
    const mesh = json.meshes?.[node.mesh];
    if (!mesh) continue;
    const skin = node.skin === undefined ? undefined : json.skins?.[node.skin];
    let jointMatrices: Mat4[] | undefined;
    if (skin) {
      const ibm =
        skin.inverseBindMatrices === undefined
          ? undefined
          : readAccessor(glb, skin.inverseBindMatrices);
      jointMatrices = skin.joints.map((joint, j) =>
        multiply(
          world.get(joint) ?? identity(),
          ibm ? Float64Array.from(ibm.subarray(j * 16, j * 16 + 16)) : identity(),
        ),
      );
    }
    for (const primitive of mesh.primitives) {
      const mode = primitive.mode ?? 4;
      if (![4, 5, 6].includes(mode) || primitive.attributes["POSITION"] === undefined) continue;
      const source = readAccessor(glb, primitive.attributes["POSITION"]);
      const count = source.length / 3;
      const normalsSource =
        primitive.attributes["NORMAL"] === undefined
          ? undefined
          : readAccessor(glb, primitive.attributes["NORMAL"]);
      const positions = new Float64Array(source.length);
      const normals = normalsSource ? new Float64Array(normalsSource.length) : undefined;
      const joints =
        jointMatrices && primitive.attributes["JOINTS_0"] !== undefined
          ? readAccessor(glb, primitive.attributes["JOINTS_0"])
          : undefined;
      const weights =
        joints && primitive.attributes["WEIGHTS_0"] !== undefined
          ? readAccessor(glb, primitive.attributes["WEIGHTS_0"])
          : undefined;
      for (let v = 0; v < count; v++) {
        let m: Mat4 = nodeWorld;
        if (jointMatrices && joints && weights) {
          m = new Float64Array(16);
          let total = 0;
          for (let k = 0; k < 4; k++) {
            const w = weights[v * 4 + k]!;
            const jm = jointMatrices[joints[v * 4 + k]!];
            if (!w || !jm) continue;
            total += w;
            for (let e = 0; e < 16; e++) m[e]! += jm[e]! * w;
          }
          if (total === 0) m = nodeWorld;
          else if (Math.abs(total - 1) > 1e-6) for (let e = 0; e < 16; e++) m[e]! /= total;
        }
        const p = transformPoint(m, source[v * 3]!, source[v * 3 + 1]!, source[v * 3 + 2]!);
        positions.set(p, v * 3);
        if (normals && normalsSource) {
          const n = transformDirection(
            m,
            normalsSource[v * 3]!,
            normalsSource[v * 3 + 1]!,
            normalsSource[v * 3 + 2]!,
          );
          const length = Math.hypot(...n) || 1;
          normals.set([n[0] / length, n[1] / length, n[2] / length], v * 3);
        }
      }
      const uvs =
        primitive.attributes["TEXCOORD_0"] === undefined
          ? undefined
          : readAccessor(glb, primitive.attributes["TEXCOORD_0"]);
      out.push({
        positions,
        ...(normals && { normals }),
        ...(uvs && { uvs }),
        indices: triangleIndices(glb, primitive, count),
        ...(primitive.material !== undefined && { material: primitive.material }),
      });
    }
  }
  return out;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export function boundsOf(primitives: PosedPrimitive[]): Bounds | undefined {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of primitives) {
    for (let i = 0; i < p.positions.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c]!, p.positions[i + c]!);
        max[c] = Math.max(max[c]!, p.positions[i + c]!);
      }
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : undefined;
}

// --- measures ---

/** Width and height from a PNG or JPEG header, without decoding. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return undefined;
      const marker = bytes[at + 1]!;
      const length = view.getUint16(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
      }
      at += 2 + length;
    }
  }
  if (bytes.length >= 30 && Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP") {
    const chunk = Buffer.from(bytes.subarray(12, 16)).toString("latin1");
    if (chunk === "VP8X") {
      return {
        width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
        height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
      };
    }
    if (chunk === "VP8 ") {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    if (chunk === "VP8L") {
      const b = view.getUint32(21, true);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  return undefined;
}

export interface Measures {
  triangles: number;
  textureMaxPx: number;
  /** Images whose size could not be read (a `uri`, or a format the header reader does not know). */
  unmeasuredImages: number[];
  materials: number;
  bones: number;
  lods: number;
  meshes: number;
  skins: number;
  /** Rest-pose bounds in the file's units. */
  bounds?: Bounds;
}

/** Counts what the target profile budgets. */
export function measure(glb: Glb): Measures {
  const { json } = glb;
  let triangles = 0;
  for (const index of worldMatrices(json).keys()) {
    const node = json.nodes?.[index];
    const mesh = node?.mesh === undefined ? undefined : json.meshes?.[node.mesh];
    for (const primitive of mesh?.primitives ?? []) {
      const mode = primitive.mode ?? 4;
      const count =
        primitive.indices !== undefined
          ? (json.accessors?.[primitive.indices]?.count ?? 0)
          : (json.accessors?.[primitive.attributes["POSITION"] ?? -1]?.count ?? 0);
      if (mode === 4) triangles += Math.floor(count / 3);
      else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2);
    }
  }
  let textureMaxPx = 0;
  const unmeasuredImages: number[] = [];
  for (const [index, image] of (json.images ?? []).entries()) {
    const start = image.bufferView === undefined ? undefined : json.bufferViews?.[image.bufferView];
    if (!start) {
      unmeasuredImages.push(index);
      continue;
    }
    const bytes = glb.bin.subarray(
      start.byteOffset ?? 0,
      (start.byteOffset ?? 0) + start.byteLength,
    );
    const size = imageSize(bytes);
    if (size) textureMaxPx = Math.max(textureMaxPx, size.width, size.height);
    else unmeasuredImages.push(index);
  }
  let lods = 1;
  for (const node of json.nodes ?? []) {
    const ids = (node.extensions?.["MSFT_lod"] as { ids?: number[] } | undefined)?.ids;
    if (ids) lods = Math.max(lods, 1 + ids.length);
  }
  const bounds = boundsOf(posedPrimitives(glb));
  return {
    triangles,
    textureMaxPx,
    unmeasuredImages,
    materials: json.materials?.length ?? 0,
    bones: new Set((json.skins ?? []).flatMap((s) => s.joints)).size,
    lods,
    meshes: json.meshes?.length ?? 0,
    skins: json.skins?.length ?? 0,
    ...(bounds && { bounds }),
  };
}

// --- edits ---

export type Axis = "+x" | "-x" | "+z" | "-z";
export const AXES: readonly Axis[] = ["+x", "-x", "+z", "-z"];

/** The rotation about +Y, in radians, that turns a model facing `from` to face `to`. */
export function yawBetween(from: Axis, to: Axis): number {
  const angle: Record<Axis, number> = {
    "+z": 0,
    "+x": Math.PI / 2,
    "-z": Math.PI,
    "-x": -Math.PI / 2,
  };
  return angle[to] - angle[from];
}

/**
 * Wraps the scene in one root node that faces the model along `forward`, scales it to `heightM`
 * (when given), stands it on y = 0 and centres it on x and z. Returns the new bounds.
 */
export function normalize(
  glb: Glb,
  options: { sourceForward: Axis; forward: Axis; heightM?: number },
): Bounds {
  const { json } = glb;
  const before = boundsOf(posedPrimitives(glb));
  if (!before) throw new InputError("the model has no triangle geometry");
  const yaw = yawBetween(options.sourceForward, options.forward);
  const height = before.max[1] - before.min[1];
  const scale = options.heightM !== undefined && height > 0 ? options.heightM / height : 1;
  const rotation = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
  const turned = fromTrs([0, 0, 0], rotation, [scale, scale, scale]);
  // Bounds after rotation and scale, to find the translation that grounds and centres the model.
  const corners: Vec3[] = [];
  for (const x of [before.min[0], before.max[0]])
    for (const y of [before.min[1], before.max[1]])
      for (const z of [before.min[2], before.max[2]]) corners.push(transformPoint(turned, x, y, z));
  const min = [0, 1, 2].map((c) => Math.min(...corners.map((p) => p[c]!)));
  const max = [0, 1, 2].map((c) => Math.max(...corners.map((p) => p[c]!)));
  const translation = [-(min[0]! + max[0]!) / 2, -min[1]!, -(min[2]! + max[2]!) / 2];
  const nodes = (json.nodes ??= []);
  const roots = sceneRoots(json);
  const root = nodes.length;
  nodes.push({
    name: "assetforge-root",
    children: roots,
    translation: translation.map((v) => (Math.abs(v) < 1e-12 ? 0 : v)),
    ...(Math.abs(yaw) > 1e-9 && { rotation }),
    ...(scale !== 1 && { scale: [scale, scale, scale] }),
  });
  json.scenes = json.scenes?.length ? json.scenes : [{}];
  const sceneIndex = json.scene ?? 0;
  json.scene = sceneIndex;
  json.scenes[sceneIndex] = { ...json.scenes[sceneIndex], nodes: [root] };
  trackCache.delete(glb);
  const after = boundsOf(posedPrimitives(glb));
  if (!after) throw new InputError("the model has no triangle geometry");
  return after;
}

/** Renames animations: each entry maps an animation index to its family name. */
export function renameClips(glb: Glb, names: Map<number, string>): void {
  for (const [index, name] of names) {
    const animation = glb.json.animations?.[index];
    if (animation) animation.name = name;
  }
}

/** Keeps only the listed animations, in order, renumbered from 0. */
export function keepClips(glb: Glb, keep: number[]): void {
  const animations = glb.json.animations ?? [];
  glb.json.animations = keep.flatMap((i) => (animations[i] ? [animations[i]] : []));
  if (glb.json.animations.length === 0) delete glb.json.animations;
  trackCache.delete(glb);
}

/**
 * Closes a looping clip: the last key of every channel takes the first key's value, so the clip
 * ends in the pose it starts in. Returns how many channels changed.
 */
export function closeLoop(glb: Glb, animation: number): number {
  const a = glb.json.animations?.[animation];
  if (!a) throw new InputError(`animation ${animation} does not exist`);
  let changed = 0;
  const done = new Set<number>();
  for (const channel of a.channels) {
    const sampler = a.samplers[channel.sampler];
    if (!sampler || done.has(sampler.output)) continue;
    done.add(sampler.output);
    const accessor = glb.json.accessors?.[sampler.output];
    if (!accessor || accessor.count < 2 || accessor.componentType !== 5126) continue;
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type] ?? 0;
    if (width === 0) continue;
    const values = readAccessor(glb, sampler.output);
    const perKey = sampler.interpolation === "CUBICSPLINE" ? 3 : 1;
    const keys = accessor.count / perKey;
    const first = keys > 0 ? (perKey === 3 ? 1 : 0) : 0;
    const last = (keys - 1) * perKey + first;
    const a0 = values.subarray(first * width, first * width + width);
    const aN = values.subarray(last * width, last * width + width);
    if (a0.every((v, i) => v === aN[i])) continue;
    writeAccessorElement(glb, sampler.output, last, a0);
    changed++;
  }
  trackCache.delete(glb);
  return changed;
}

/** How far a clip's last pose is from its first: the largest rotation and translation difference. */
export function loopError(
  glb: Glb,
  animation: number,
): { rotationDeg: number; translation: number } {
  const clip = clips(glb)[animation];
  if (!clip) throw new InputError(`animation ${animation} does not exist`);
  const start = samplePose(glb, animation, 0);
  const end = samplePose(glb, animation, clip.durationS);
  let rotationDeg = 0;
  let translation = 0;
  for (const [node, a] of start) {
    const b = end.get(node);
    if (!b) continue;
    rotationDeg = Math.max(rotationDeg, quatAngleDeg(a.r, b.r));
    translation = Math.max(translation, Math.hypot(...a.t.map((v, i) => v - b.t[i]!)));
  }
  return { rotationDeg, translation };
}
