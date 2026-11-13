/**
 * Mesh simplification for detail levels: meshoptimizer picks the triangles to keep, then the kept
 * vertices are copied byte-for-byte, so skin weights, UVs and every other attribute stay exactly
 * as authored and the rig, clips and textures need no change.
 */
import { MeshoptSimplifier } from "meshoptimizer";
import type { SimplifierFlags } from "meshoptimizer";
import { InputError } from "../../errors.ts";
import type { Glb, GltfAccessor, GltfPrimitive } from "../glb.ts";
import { readAccessor } from "../glb.ts";
import { compactBin, appendBufferView } from "../lookdev/edit.ts";
import { measure } from "../scene.ts";

export interface SimplifiedPrimitive {
  mesh: number;
  primitive: number;
  /** Triangle list over the compacted vertices. */
  indices: Uint32Array;
  /** For each compacted vertex, its vertex index in the source primitive. */
  vertexSources: Uint32Array;
  sourceTriangles: number;
}

const COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};
const SIZES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

const NORMAL_WEIGHT = 0.5;
const UV_WEIGHT = 1;
/** Relative error allowances, tried in turn until the target is reached. */
const ATTEMPTS: Array<{ error: number; flags: SimplifierFlags[] }> = [
  { error: 1, flags: [] },
  { error: 10, flags: ["Permissive"] },
  { error: 100, flags: ["Permissive", "Prune"] },
];

function usedMeshes(glb: Glb): number[] {
  const used = new Set<number>();
  for (const node of glb.json.nodes ?? []) {
    if (node.mesh !== undefined && glb.json.meshes?.[node.mesh]) used.add(node.mesh);
  }
  return [...used].sort((a, b) => a - b);
}

/** Triangles a part may keep however small its share: enough to keep an eye an eye. */
const MIN_TRIANGLES = 16;

function triangleCount(glb: Glb, primitive: GltfPrimitive): number {
  const accessor =
    primitive.indices !== undefined ? primitive.indices : primitive.attributes["POSITION"]!;
  return Math.floor((glb.json.accessors?.[accessor]?.count ?? 0) / 3);
}

function isTriangleList(primitive: GltfPrimitive): boolean {
  return (primitive.mode ?? 4) === 4 && primitive.attributes["POSITION"] !== undefined;
}

function simplifyOne(
  glb: Glb,
  primitive: GltfPrimitive,
  ratio: number,
  targetTriangles: number,
): { indices: Uint32Array; vertexSources: Uint32Array; sourceTriangles: number } {
  const positions = Float32Array.from(readAccessor(glb, primitive.attributes["POSITION"]!));
  const vertexCount = positions.length / 3;
  const raw =
    primitive.indices !== undefined
      ? Uint32Array.from(readAccessor(glb, primitive.indices))
      : Uint32Array.from({ length: vertexCount - (vertexCount % 3) }, (_, i) => i);
  const sourceTriangles = Math.floor(raw.length / 3);
  const source = raw.slice(0, sourceTriangles * 3);
  for (const i of source) {
    if (i >= vertexCount) throw new InputError("a primitive's indices point past its vertices");
  }
  const target = targetTriangles * 3;
  let kept: Uint32Array = source;
  if (ratio < 1 && source.length > 0) {
    const attributes = attributeData(glb, primitive, vertexCount);
    const run = (error: number, flags: SimplifierFlags[]) =>
      attributes
        ? MeshoptSimplifier.simplifyWithAttributes(
            source,
            positions,
            3,
            attributes.data,
            attributes.stride,
            attributes.weights,
            null,
            target,
            error,
            flags,
          )[0]
        : MeshoptSimplifier.simplify(source, positions, 3, target, error, flags)[0];
    // The smallest result that keeps some triangles: a small part (an eye) is never lost.
    for (const attempt of ATTEMPTS) {
      const next = run(attempt.error, attempt.flags);
      if (next.length > 0 && next.length < kept.length) kept = next;
      if (kept.length <= target) break;
    }
  }
  const remap = new Int32Array(vertexCount).fill(-1);
  const sources: number[] = [];
  const indices = new Uint32Array(kept.length);
  for (let i = 0; i < kept.length; i++) {
    const v = kept[i]!;
    if (remap[v] === -1) {
      remap[v] = sources.length;
      sources.push(v);
    }
    indices[i] = remap[v]!;
  }
  if (ratio >= 1) {
    // Unchanged means every vertex stays, even ones no triangle uses.
    return {
      indices: Uint32Array.from(source),
      vertexSources: Uint32Array.from({ length: vertexCount }, (_, i) => i),
      sourceTriangles,
    };
  }
  return { indices, vertexSources: Uint32Array.from(sources), sourceTriangles };
}

/** Normals and the first UV set, interleaved, with the simplifier's weight for each channel. */
function attributeData(
  glb: Glb,
  primitive: GltfPrimitive,
  vertexCount: number,
): { data: Float32Array; stride: number; weights: number[] } | undefined {
  const channels: Array<{ values: Float64Array; width: number; weight: number }> = [];
  const normal = primitive.attributes["NORMAL"];
  if (normal !== undefined && glb.json.accessors?.[normal]?.type === "VEC3") {
    channels.push({ values: readAccessor(glb, normal), width: 3, weight: NORMAL_WEIGHT });
  }
  const uv = primitive.attributes["TEXCOORD_0"];
  if (uv !== undefined && glb.json.accessors?.[uv]?.type === "VEC2") {
    channels.push({ values: readAccessor(glb, uv), width: 2, weight: UV_WEIGHT });
  }
  if (channels.length === 0) return undefined;
  const stride = channels.reduce((n, c) => n + c.width, 0);
  const data = new Float32Array(vertexCount * stride);
  const weights: number[] = [];
  let at = 0;
  for (const channel of channels) {
    for (let v = 0; v < vertexCount; v++) {
      for (let c = 0; c < channel.width; c++) {
        data[v * stride + at + c] = channel.values[v * channel.width + c] ?? 0;
      }
    }
    for (let c = 0; c < channel.width; c++) weights.push(channel.weight);
    at += channel.width;
  }
  return { data, stride, weights };
}

/**
 * Every triangle-list primitive (mode 4, indexed or not) of every mesh used by a node, simplified
 * to at most floor(ratio × its triangles) where the simplifier can get there. Ratio 1 returns the
 * primitives unchanged (all vertices, same triangles).
 */
export async function simplifyPrimitives(glb: Glb, ratio: number): Promise<SimplifiedPrimitive[]> {
  await MeshoptSimplifier.ready;
  const parts: Array<{
    mesh: number;
    primitive: number;
    source: GltfPrimitive;
    triangles: number;
  }> = [];
  for (const mesh of usedMeshes(glb)) {
    for (const [p, primitive] of glb.json.meshes![mesh]!.primitives.entries()) {
      if (!isTriangleList(primitive)) continue;
      parts.push({
        mesh,
        primitive: p,
        source: primitive,
        triangles: triangleCount(glb, primitive),
      });
    }
  }
  // Each part gets its share of the level's triangles, but a small part keeps a few (up to
  // MIN_TRIANGLES), paid for by the largest part, so the level stays within its ratio.
  const total = parts.reduce((n, part) => n + part.triangles, 0);
  const targets = parts.map((part) =>
    Math.max(Math.floor(ratio * part.triangles), Math.min(part.triangles, MIN_TRIANGLES)),
  );
  const excess = targets.reduce((n, t) => n + t, 0) - Math.floor(ratio * total);
  if (excess > 0 && parts.length > 0) {
    const largest = parts.reduce(
      (best, part, i) => (part.triangles > parts[best]!.triangles ? i : best),
      0,
    );
    targets[largest] = Math.max(0, targets[largest]! - excess);
  }
  return parts.map((part, i) => ({
    mesh: part.mesh,
    primitive: part.primitive,
    ...simplifyOne(glb, part.source, ratio, targets[i]!),
  }));
}

/** Copies the chosen elements of an accessor, byte for byte, into a new tightly packed accessor. */
function copyAccessor(glb: Glb, index: number, sources: Uint32Array): number {
  const json = glb.json;
  const accessor = json.accessors?.[index];
  if (!accessor) throw new InputError(`accessor ${index} does not exist`);
  const components = COMPONENTS[accessor.type];
  const size = SIZES[accessor.componentType];
  if (!components || !size) throw new InputError(`accessor ${index} has an unsupported type`);
  const element = components * size;
  const stride = Math.ceil(element / 4) * 4;
  const clone: GltfAccessor = { ...structuredClone(accessor), count: sources.length };
  delete clone.byteOffset;
  delete clone["sparse"];
  delete clone.bufferView;
  delete clone.min;
  delete clone.max;
  if (accessor.bufferView !== undefined) {
    const view = json.bufferViews?.[accessor.bufferView];
    if (!view) throw new InputError(`accessor ${index} names a missing buffer view`);
    if (view.buffer !== 0) throw new InputError(`accessor ${index} reads an external buffer`);
    const sourceStride = view.byteStride ?? element;
    const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const bytes = new Uint8Array(sources.length * stride);
    for (const [i, source] of sources.entries()) {
      const at = base + source * sourceStride;
      bytes.set(glb.bin.subarray(at, at + element), i * stride);
    }
    const bufferView = appendBufferView(glb, bytes);
    Object.assign(json.bufferViews![bufferView]!, {
      target: 34962,
      ...(stride !== element && { byteStride: stride }),
    });
    clone.bufferView = bufferView;
  }
  json.accessors!.push(clone);
  return json.accessors!.length - 1;
}

function setMinMax(glb: Glb, index: number): void {
  const accessor = glb.json.accessors![index]!;
  const values = readAccessor(glb, index);
  const width = COMPONENTS[accessor.type]!;
  if (accessor.bufferView === undefined || values.length === 0) return;
  const min = Array.from({ length: width }, () => Infinity);
  const max = Array.from({ length: width }, () => -Infinity);
  for (let i = 0; i < values.length; i++) {
    const c = i % width;
    min[c] = Math.min(min[c]!, values[i]!);
    max[c] = Math.max(max[c]!, values[i]!);
  }
  accessor.min = min;
  accessor.max = max;
}

function copyAttribute(glb: Glb, name: string, index: number, sources: Uint32Array): number {
  const copy = copyAccessor(glb, index, sources);
  if (name === "POSITION") setMinMax(glb, copy);
  return copy;
}

function appendIndexAccessor(glb: Glb, indices: Uint32Array, vertices: number): number {
  const short = vertices < 65536;
  const packed = short ? Uint16Array.from(indices) : indices;
  const view = appendBufferView(
    glb,
    new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength),
  );
  Object.assign(glb.json.bufferViews![view]!, { target: 34963 });
  let min = indices.length ? Infinity : 0;
  let max = 0;
  for (const i of indices) {
    if (i < min) min = i;
    if (i > max) max = i;
  }
  glb.json.accessors!.push({
    bufferView: view,
    componentType: short ? 5123 : 5125,
    count: indices.length,
    type: "SCALAR",
    min: [min],
    max: [max],
  });
  return glb.json.accessors!.length - 1;
}

/**
 * Appends a new mesh to `glb` (the name plus `_lod<n>`, the same materials and primitive extras)
 * whose primitives hold only the kept vertices, every attribute and morph target copied
 * byte-for-byte. Primitives not in `simplified` are copied unchanged, sharing the accessors.
 * Returns the new mesh index.
 */
export function appendSimplifiedMesh(
  glb: Glb,
  mesh: number,
  simplified: SimplifiedPrimitive[],
  level: number,
): number {
  const json = glb.json;
  const source = json.meshes?.[mesh];
  if (!source) throw new InputError(`mesh ${mesh} does not exist`);
  json.accessors ??= [];
  const primitives = source.primitives.map((primitive, p) => {
    const kept = simplified.find((s) => s.mesh === mesh && s.primitive === p);
    const copy = structuredClone(primitive);
    if (!kept) return copy;
    copy.attributes = Object.fromEntries(
      Object.entries(primitive.attributes).map(([name, accessor]) => [
        name,
        copyAttribute(glb, name, accessor, kept.vertexSources),
      ]),
    );
    const targets = primitive["targets"] as Array<Record<string, number>> | undefined;
    if (targets) {
      copy["targets"] = targets.map((target) =>
        Object.fromEntries(
          Object.entries(target).map(([name, accessor]) => [
            name,
            copyAttribute(glb, name, accessor, kept.vertexSources),
          ]),
        ),
      );
    }
    copy.indices = appendIndexAccessor(glb, kept.indices, kept.vertexSources.length);
    return copy;
  });
  const next = {
    ...structuredClone(source),
    ...(typeof source["name"] === "string" && { name: `${source["name"]}_lod${level}` }),
    primitives,
  };
  json.meshes!.push(next);
  return json.meshes!.length - 1;
}

/** Drops accessors nothing references and renumbers the references. */
export function pruneAccessors(glb: Glb): void {
  const json = glb.json;
  const refs: Array<{ holder: Record<string, unknown>; key: string }> = [];
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      refs.push({ holder: primitive as Record<string, unknown>, key: "indices" });
      for (const key of Object.keys(primitive.attributes)) {
        refs.push({ holder: primitive.attributes, key });
      }
      for (const target of (primitive["targets"] as Array<Record<string, number>>) ?? []) {
        for (const key of Object.keys(target)) refs.push({ holder: target, key });
      }
    }
  }
  for (const animation of json.animations ?? []) {
    for (const sampler of animation.samplers) {
      refs.push({ holder: sampler, key: "input" }, { holder: sampler, key: "output" });
    }
  }
  for (const skin of json.skins ?? []) {
    refs.push({ holder: skin as Record<string, unknown>, key: "inverseBindMatrices" });
  }
  const live = refs.filter((r) => typeof r.holder[r.key] === "number");
  const used = [...new Set(live.map((r) => r.holder[r.key] as number))].sort((a, b) => a - b);
  const remap = new Map(used.map((old, i) => [old, i]));
  json.accessors = used.map((old) => json.accessors![old]!);
  for (const r of live) r.holder[r.key] = remap.get(r.holder[r.key] as number)!;
}

/**
 * A deep copy of `source` in which every node's mesh is replaced by its simplified mesh, the old
 * meshes removed and the binary chunk compacted. Skins, joints, nodes, animations, materials,
 * textures and images are untouched. Returns the level and its triangles as `measure` counts them.
 */
export async function levelGlb(
  source: Glb,
  ratio: number,
  level: number,
): Promise<{ glb: Glb; triangles: number; primitives: SimplifiedPrimitive[] }> {
  const primitives = await simplifyPrimitives(source, ratio);
  const glb: Glb = { json: structuredClone(source.json), bin: new Uint8Array(source.bin) };
  const oldCount = glb.json.meshes?.length ?? 0;
  const replacement = new Map<number, number>();
  for (const mesh of usedMeshes(source)) {
    replacement.set(mesh, appendSimplifiedMesh(glb, mesh, primitives, level) - oldCount);
  }
  if (glb.json.meshes) glb.json.meshes = glb.json.meshes.slice(oldCount);
  for (const node of glb.json.nodes ?? []) {
    if (node.mesh !== undefined) node.mesh = replacement.get(node.mesh)!;
  }
  pruneAccessors(glb);
  compactBin(glb);
  return { glb, triangles: measure(glb).triangles, primitives };
}
