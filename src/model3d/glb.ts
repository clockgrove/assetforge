/**
 * Binary glTF (`.glb`) reading and writing: the JSON document, the binary chunk and typed access to
 * accessors. Only what the 3D character path needs; the Khronos validator checks conformance.
 */
import { InputError } from "../errors.ts";

const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a; // "JSON"
const BIN_CHUNK = 0x004e4942; // "BIN\0"

export const GLB_MEDIA_TYPE = "model/gltf-binary";

/** The glTF 2.0 document, loosely typed: only the fields Assetforge reads are named. */
export interface GltfDocument {
  asset: { version: string; generator?: string; [key: string]: unknown };
  scene?: number;
  scenes?: Array<{ nodes?: number[]; [key: string]: unknown }>;
  nodes?: GltfNode[];
  meshes?: Array<{ primitives: GltfPrimitive[]; [key: string]: unknown }>;
  skins?: Array<{ joints: number[]; inverseBindMatrices?: number; skeleton?: number }>;
  animations?: GltfAnimation[];
  accessors?: GltfAccessor[];
  bufferViews?: Array<{
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }>;
  buffers?: Array<{ byteLength: number; uri?: string }>;
  materials?: Array<{
    name?: string;
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      baseColorTexture?: { index: number; texCoord?: number };
    };
    [key: string]: unknown;
  }>;
  textures?: Array<{ source?: number; [key: string]: unknown }>;
  images?: Array<{ bufferView?: number; mimeType?: string; uri?: string }>;
  extensionsUsed?: string[];
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  [key: string]: unknown;
}

export interface GltfAnimation {
  name?: string;
  channels: Array<{ sampler: number; target: { node?: number; path: string } }>;
  samplers: Array<{ input: number; output: number; interpolation?: string }>;
  [key: string]: unknown;
}

export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  [key: string]: unknown;
}

export interface Glb {
  json: GltfDocument;
  /** The binary chunk; empty when the file has none. */
  bin: Uint8Array;
}

/** Parses a `.glb`. Throws an InputError naming what is wrong when the bytes are not one. */
export function parseGlb(bytes: Uint8Array): Glb {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== MAGIC) {
    throw new InputError("not a binary glTF: the glTF magic is missing");
  }
  if (view.getUint32(4, true) !== 2) {
    throw new InputError(`unsupported glTF container version ${view.getUint32(4, true)}`);
  }
  const length = Math.min(view.getUint32(8, true), bytes.byteLength);
  let offset = 12;
  let json: GltfDocument | undefined;
  let bin = new Uint8Array(0);
  while (offset + 8 <= length) {
    const chunkLength = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const data = bytes.subarray(offset + 8, offset + 8 + chunkLength);
    if (type === JSON_CHUNK && json === undefined) {
      json = JSON.parse(Buffer.from(data).toString("utf8")) as GltfDocument;
    } else if (type === BIN_CHUNK && bin.byteLength === 0) {
      bin = new Uint8Array(data);
    }
    offset += 8 + chunkLength;
  }
  if (!json) throw new InputError("not a binary glTF: it has no JSON chunk");
  return { json, bin };
}

function pad(bytes: Uint8Array, fill: number): Uint8Array {
  const padded = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4).fill(fill);
  padded.set(bytes);
  return padded;
}

/** Writes a `.glb`; the binary chunk's buffer length is kept in step with `bin`. */
export function writeGlb(glb: Glb): Uint8Array {
  const json = structuredClone(glb.json);
  const bin = pad(glb.bin, 0);
  if (glb.bin.byteLength > 0 && json.buffers?.[0] && json.buffers[0].uri === undefined) {
    json.buffers[0].byteLength = glb.bin.byteLength;
  }
  const jsonBytes = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const total = 12 + 8 + jsonBytes.byteLength + (bin.byteLength > 0 ? 8 + bin.byteLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.byteLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  out.set(jsonBytes, 20);
  if (bin.byteLength > 0) {
    const at = 20 + jsonBytes.byteLength;
    view.setUint32(at, bin.byteLength, true);
    view.setUint32(at + 4, BIN_CHUNK, true);
    out.set(bin, at + 8);
  }
  return out;
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

function componentReader(
  view: DataView,
  componentType: number,
  normalized: boolean,
): (at: number) => number {
  switch (componentType) {
    case 5126:
      return (at) => view.getFloat32(at, true);
    case 5125:
      return (at) => view.getUint32(at, true);
    case 5123:
      return normalized
        ? (at) => view.getUint16(at, true) / 65535
        : (at) => view.getUint16(at, true);
    case 5122:
      return normalized
        ? (at) => Math.max(view.getInt16(at, true) / 32767, -1)
        : (at) => view.getInt16(at, true);
    case 5121:
      return normalized ? (at) => view.getUint8(at) / 255 : (at) => view.getUint8(at);
    case 5120:
      return normalized ? (at) => Math.max(view.getInt8(at) / 127, -1) : (at) => view.getInt8(at);
    default:
      throw new InputError(`unsupported accessor component type ${componentType}`);
  }
}

/** Where each element of an accessor sits in the binary chunk. */
function layout(glb: Glb, index: number) {
  const accessor = glb.json.accessors?.[index];
  if (!accessor) throw new InputError(`accessor ${index} does not exist`);
  const components = COMPONENTS[accessor.type];
  const size = SIZES[accessor.componentType];
  if (!components || !size) throw new InputError(`accessor ${index} has an unsupported type`);
  if (accessor.bufferView === undefined) return { accessor, components, size, view: undefined };
  const bufferView = glb.json.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new InputError(`accessor ${index} names a missing buffer view`);
  if (bufferView.buffer !== 0 || glb.json.buffers?.[0]?.uri !== undefined) {
    throw new InputError(`accessor ${index} reads an external buffer; only .glb-embedded data`);
  }
  const stride = bufferView.byteStride ?? components * size;
  const start = glb.bin.byteOffset + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return { accessor, components, size, view: { start, stride } };
}

/** An accessor's elements as one flat array of numbers (`count × components`), sparse ignored. */
export function readAccessor(glb: Glb, index: number): Float64Array {
  const { accessor, components, size, view } = layout(glb, index);
  const out = new Float64Array(accessor.count * components);
  if (!view) return out;
  const data = new DataView(glb.bin.buffer);
  const read = componentReader(data, accessor.componentType, accessor.normalized === true);
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < components; c++) {
      out[i * components + c] = read(view.start + i * view.stride + c * size);
    }
  }
  return out;
}

/** Overwrites one element of a float accessor in the binary chunk. */
export function writeAccessorElement(
  glb: Glb,
  index: number,
  element: number,
  values: ArrayLike<number>,
): void {
  const { accessor, components, size, view } = layout(glb, index);
  if (!view || accessor.componentType !== 5126) {
    throw new InputError(`accessor ${index} is not a float accessor in the binary chunk`);
  }
  const data = new DataView(glb.bin.buffer);
  for (let c = 0; c < components; c++) {
    data.setFloat32(view.start + element * view.stride + c * size, values[c] ?? 0, true);
  }
}

/** The bytes of a buffer view, for embedded images. */
export function bufferViewBytes(glb: Glb, index: number): Uint8Array {
  const bufferView = glb.json.bufferViews?.[index];
  if (!bufferView) throw new InputError(`buffer view ${index} does not exist`);
  const start = bufferView.byteOffset ?? 0;
  return glb.bin.subarray(start, start + bufferView.byteLength);
}
