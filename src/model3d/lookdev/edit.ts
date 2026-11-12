/**
 * Look-dev's edits of a `.glb`: replace the base-colour image, split the eye triangles into their
 * own glossy material, reference the groom maps as external images, and drop binary data nothing
 * references any more.
 */
import type { Glb, GltfDocument } from "../glb.ts";
import type { Vec3 } from "../scene.ts";
import { posedPrimitives, worldMatrices } from "../scene.ts";
import type { SurfaceMarker } from "./groom.ts";

/** The material name the eyes get; the target shades it. */
export const EYE_MATERIAL = "eyes";
/** The eye material's roughness: wet enough to catch light. */
export const EYE_ROUGHNESS = 0.05;

function align4(n: number): number {
  return Math.ceil(n / 4) * 4;
}

/** Appends bytes to the binary chunk as a new buffer view and returns its index. */
export function appendBufferView(glb: Glb, bytes: Uint8Array): number {
  const offset = align4(glb.bin.byteLength);
  const bin = new Uint8Array(offset + bytes.byteLength);
  bin.set(glb.bin);
  bin.set(bytes, offset);
  glb.bin = bin;
  const json = glb.json;
  json.buffers ??= [{ byteLength: 0 }];
  json.buffers[0]!.byteLength = bin.byteLength;
  json.bufferViews ??= [];
  json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
  return json.bufferViews.length - 1;
}

/** Appends triangle indices as a new unsigned-int accessor and returns its index. */
function appendIndices(glb: Glb, indices: Uint32Array): number {
  const view = appendBufferView(
    glb,
    new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength),
  );
  (glb.json.bufferViews![view]! as Record<string, unknown>)["target"] = 34963;
  glb.json.accessors ??= [];
  let max = 0;
  let min = indices.length ? Infinity : 0;
  for (const i of indices) {
    if (i > max) max = i;
    if (i < min) min = i;
  }
  glb.json.accessors.push({
    bufferView: view,
    componentType: 5125,
    count: indices.length,
    type: "SCALAR",
    min: [min],
    max: [max],
  });
  return glb.json.accessors.length - 1;
}

/** The image index of the first material's base-colour texture, and that material. */
export function baseColorImage(
  json: GltfDocument,
): { material: number; image: number } | undefined {
  for (const [m, material] of (json.materials ?? []).entries()) {
    const texture = material.pbrMetallicRoughness?.baseColorTexture?.index;
    const source = texture === undefined ? undefined : json.textures?.[texture]?.source;
    if (source !== undefined) return { material: m, image: source };
  }
  return undefined;
}

/** Points the image at new PNG bytes in the binary chunk. */
export function replaceImage(glb: Glb, image: number, png: Uint8Array): void {
  const view = appendBufferView(glb, png);
  const entry = glb.json.images![image]!;
  delete entry.uri;
  entry.bufferView = view;
  entry.mimeType = "image/png";
}

/**
 * Moves every triangle of the textured material's primitives whose three corners lie inside an
 * eye marker into a new primitive with the eye material: the same textures, low roughness, no
 * metal. Returns the triangles moved.
 */
export function splitEyes(glb: Glb, material: number, eyes: SurfaceMarker[]): number {
  const json = glb.json;
  if (eyes.length === 0) return 0;
  const source = json.materials![material]!;
  const eyeMaterial = structuredClone(source) as Record<string, unknown> & typeof source;
  eyeMaterial.name = EYE_MATERIAL;
  const pbr = { ...(eyeMaterial.pbrMetallicRoughness ?? {}) } as Record<string, unknown>;
  delete pbr["metallicRoughnessTexture"];
  pbr["roughnessFactor"] = EYE_ROUGHNESS;
  pbr["metallicFactor"] = 0;
  eyeMaterial.pbrMetallicRoughness = pbr as typeof source.pbrMetallicRoughness;
  let eyeIndex = -1;
  let moved = 0;
  // World-space rest positions, in the same node and primitive order as posedPrimitives.
  const posed = posedPrimitives(glb);
  let p = 0;
  const inside = (pos: Float64Array, v: number) =>
    eyes.some((e) => {
      const dx = pos[v * 3]! - e.point[0];
      const dy = pos[v * 3 + 1]! - e.point[1];
      const dz = pos[v * 3 + 2]! - e.point[2];
      return dx * dx + dy * dy + dz * dz <= e.radius * e.radius;
    });
  const done = new Set<number>();
  for (const nodeIndex of worldMatrices(json).keys()) {
    const meshIndex = json.nodes?.[nodeIndex]?.mesh;
    const mesh = meshIndex === undefined ? undefined : json.meshes?.[meshIndex];
    if (meshIndex === undefined || !mesh) continue;
    const first = !done.has(meshIndex);
    done.add(meshIndex);
    const additions: typeof mesh.primitives = [];
    for (const primitive of mesh.primitives) {
      const mode = primitive.mode ?? 4;
      if (![4, 5, 6].includes(mode) || primitive.attributes["POSITION"] === undefined) continue;
      const posedPrim = posed[p++];
      if (!first || primitive.material !== material || !posedPrim || mode !== 4) continue;
      const indices = posedPrim.indices;
      const keep: number[] = [];
      const eye: number[] = [];
      for (let t = 0; t + 2 < indices.length; t += 3) {
        const a = indices[t]!;
        const b = indices[t + 1]!;
        const c = indices[t + 2]!;
        const target =
          inside(posedPrim.positions, a) &&
          inside(posedPrim.positions, b) &&
          inside(posedPrim.positions, c)
            ? eye
            : keep;
        target.push(a, b, c);
      }
      if (eye.length === 0) continue;
      if (eyeIndex < 0) {
        json.materials!.push(eyeMaterial);
        eyeIndex = json.materials!.length - 1;
      }
      primitive.indices = appendIndices(glb, Uint32Array.from(keep));
      additions.push({
        ...structuredClone(primitive),
        indices: appendIndices(glb, Uint32Array.from(eye)),
        material: eyeIndex,
      });
      moved += eye.length / 3;
    }
    mesh.primitives.push(...additions);
  }
  return moved;
}

/** Adds an external image (a file beside the `.glb`) and returns its index. */
export function addExternalImage(json: GltfDocument, uri: string, name: string): number {
  json.images ??= [];
  json.images.push({ uri, mimeType: "image/png", name } as { uri: string; mimeType: string });
  return json.images.length - 1;
}

/**
 * Rewrites the binary chunk with only the buffer views that accessors and images still reference,
 * in their original order, so replaced images and index lists take no space.
 */
export function compactBin(glb: Glb): void {
  const json = glb.json;
  const views = json.bufferViews ?? [];
  const used = new Set<number>();
  for (const a of json.accessors ?? []) {
    if (a.bufferView !== undefined) used.add(a.bufferView);
    const sparse = a["sparse"] as
      { indices: { bufferView: number }; values: { bufferView: number } } | undefined;
    if (sparse) {
      used.add(sparse.indices.bufferView);
      used.add(sparse.values.bufferView);
    }
  }
  for (const i of json.images ?? []) if (i.bufferView !== undefined) used.add(i.bufferView);
  const remap = new Map<number, number>();
  const kept: typeof views = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  views.forEach((view, i) => {
    if (!used.has(i) || view.buffer !== 0) {
      if (used.has(i)) {
        remap.set(i, kept.length);
        kept.push(view);
      }
      return;
    }
    const start = view.byteOffset ?? 0;
    const bytes = glb.bin.subarray(start, start + view.byteLength);
    offset = align4(offset);
    chunks.push(Object.assign(bytes, { at: offset }) as Uint8Array);
    remap.set(i, kept.length);
    kept.push({ ...view, byteOffset: offset });
    offset += view.byteLength;
  });
  const bin = new Uint8Array(align4(offset));
  for (const chunk of chunks) bin.set(chunk, (chunk as Uint8Array & { at: number }).at);
  glb.bin = bin;
  json.bufferViews = kept;
  if (json.buffers?.[0]) json.buffers[0].byteLength = bin.byteLength;
  for (const a of json.accessors ?? []) {
    if (a.bufferView !== undefined) a.bufferView = remap.get(a.bufferView)!;
    const sparse = a["sparse"] as
      { indices: { bufferView: number }; values: { bufferView: number } } | undefined;
    if (sparse) {
      sparse.indices.bufferView = remap.get(sparse.indices.bufferView)!;
      sparse.values.bufferView = remap.get(sparse.values.bufferView)!;
    }
  }
  for (const i of json.images ?? []) {
    if (i.bufferView !== undefined) i.bufferView = remap.get(i.bufferView)!;
  }
}

/** Rest-pose world positions of the named nodes (joints), in the model's own space. */
export function nodePositions(glb: Glb, world: Map<number, Float64Array>): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  for (const [i, node] of (glb.json.nodes ?? []).entries()) {
    const m = world.get(i);
    if (!m || node.name === undefined) continue;
    out.set(node.name, [m[12]!, m[13]!, m[14]!]);
  }
  return out;
}
