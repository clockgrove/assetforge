/**
 * Writes the re-rigged character: the baked mesh with the template's skeleton, smooth skin weights
 * and the generated clips. Materials, textures and images carry over from the source model; its own
 * skins, animations and nodes do not.
 */
import { bufferViewBytes } from "../glb.ts";
import type { Glb, GltfDocument } from "../glb.ts";
import type { BakedMesh, Skeleton, SkinWeights } from "./fit.ts";
import type { GeneratedClip } from "./gait.ts";
import { rotY } from "./math.ts";

const FLOAT = 5126;
const UINT = 5125;
const USHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

class BinWriter {
  chunks: Uint8Array[] = [];
  length = 0;
  bufferViews: NonNullable<GltfDocument["bufferViews"]> = [];
  accessors: NonNullable<GltfDocument["accessors"]> = [];

  view(bytes: Uint8Array, target?: number): number {
    const padded = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4);
    padded.set(bytes);
    this.bufferViews.push({
      buffer: 0,
      byteOffset: this.length,
      byteLength: bytes.byteLength,
      ...(target !== undefined && { target }),
    });
    this.chunks.push(padded);
    this.length += padded.byteLength;
    return this.bufferViews.length - 1;
  }

  accessor(
    data: Float32Array | Uint32Array | Uint16Array,
    type: string,
    width: number,
    target?: number,
    withBounds = false,
  ): number {
    const componentType =
      data instanceof Float32Array ? FLOAT : data instanceof Uint32Array ? UINT : USHORT;
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const bufferView = this.view(bytes, target);
    const count = data.length / width;
    let bounds: { min: number[]; max: number[] } | undefined;
    if (withBounds) {
      const min = Array<number>(width).fill(Infinity);
      const max = Array<number>(width).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {
        min[i % width] = Math.min(min[i % width]!, data[i]!);
        max[i % width] = Math.max(max[i % width]!, data[i]!);
      }
      bounds = { min, max };
    }
    this.accessors.push({ bufferView, componentType, count, type, ...bounds });
    return this.accessors.length - 1;
  }

  bin(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }
}

/** Extension names used anywhere inside a JSON value. */
function extensionsIn(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) value.forEach((v) => extensionsIn(v, out));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "extensions" && v !== null && typeof v === "object") {
        Object.keys(v).forEach((name) => out.add(name));
      }
      extensionsIn(v, out);
    }
  }
}

export const RIG_ROOT_NAME = "assetforge-root";

/** Node indices in the rigged file: the root, the mesh node, then one per joint in template order. */
export const jointNode = (joint: number) => 2 + joint;

export function buildRiggedGlb(
  source: Glb,
  mesh: BakedMesh,
  skeleton: Skeleton,
  skin: SkinWeights,
  clips: GeneratedClip[],
  /** The shared-rig identity the target compares (`asset.extras.rig`), as the manifest records it. */
  rig: { template: string; sha256: string },
  /** Keep the source's own `asset.extras` (re-rigging a look-dev'd model keeps its groom record). */
  keepAssetExtras = false,
): Glb {
  const out = new BinWriter();
  const json: GltfDocument = {
    // Only a re-rig keeps the source's asset extras (look-dev's groom record); `stage` writes the
    // rig's alone, so a provider's own extras never ship. The rig's replaces any.
    asset: {
      version: "2.0",
      generator: "assetforge shared rig",
      extras: {
        ...(keepAssetExtras && (source.json.asset.extras as Record<string, unknown> | undefined)),
        rig,
      },
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
  };

  // Images, textures, samplers and materials carry over in order, so indices stay valid.
  const images = (source.json.images ?? []).map((image) => {
    if (image.bufferView === undefined) return { ...image };
    const bufferView = out.view(new Uint8Array(bufferViewBytes(source, image.bufferView)));
    return { bufferView, ...(image.mimeType && { mimeType: image.mimeType }) };
  });
  if (images.length) json.images = images;
  for (const key of ["textures", "samplers", "materials"] as const) {
    const value = source.json[key];
    if (Array.isArray(value) && value.length) json[key] = structuredClone(value);
  }
  const used = new Set<string>();
  extensionsIn([json.images, json.textures, json.samplers, json.materials], used);
  if (used.size) json.extensionsUsed = [...used].sort();
  const required = (source.json.extensionsRequired as string[] | undefined)?.filter((e) =>
    used.has(e),
  );
  if (required?.length) json["extensionsRequired"] = required;

  const primitives = mesh.primitives.map((prim) => {
    const n = prim.positions.length / 3;
    const attributes: Record<string, number> = {
      POSITION: out.accessor(Float32Array.from(prim.positions), "VEC3", 3, ARRAY_BUFFER, true),
    };
    if (prim.normals) {
      attributes["NORMAL"] = out.accessor(Float32Array.from(prim.normals), "VEC3", 3, ARRAY_BUFFER);
    }
    if (prim.uvs) {
      attributes["TEXCOORD_0"] = out.accessor(Float32Array.from(prim.uvs), "VEC2", 2, ARRAY_BUFFER);
    }
    attributes["JOINTS_0"] = out.accessor(
      skin.joints.slice(prim.first * 4, (prim.first + n) * 4),
      "VEC4",
      4,
      ARRAY_BUFFER,
    );
    attributes["WEIGHTS_0"] = out.accessor(
      skin.weights.slice(prim.first * 4, (prim.first + n) * 4),
      "VEC4",
      4,
      ARRAY_BUFFER,
    );
    const indices = out.accessor(Uint32Array.from(prim.indices), "SCALAR", 1, ELEMENT_ARRAY_BUFFER);
    return {
      attributes,
      indices,
      mode: 4,
      ...(prim.material !== undefined && { material: prim.material }),
    };
  });
  json.meshes = [{ name: "character", primitives }];

  const J = skeleton.names.length;
  const root = skeleton.parent.indexOf(-1);
  const yawQ = rotY(mesh.yaw);
  json.nodes = [
    {
      name: RIG_ROOT_NAME,
      children: [1, jointNode(root)],
      ...(Math.abs(mesh.yaw) > 1e-9 && { rotation: [...yawQ] }),
    },
    { name: "character", mesh: 0, skin: 0 },
    ...skeleton.names.map((name, j) => {
      const p = skeleton.parent[j]!;
      const local =
        p < 0 ? skeleton.rest[j]! : skeleton.rest[j]!.map((v, c) => v - skeleton.rest[p]![c]!);
      const children = skeleton.parent.flatMap((q, c) => (q === j ? [jointNode(c)] : []));
      return {
        name,
        translation: local.map((v) => (Math.abs(v) < 1e-12 ? 0 : v)),
        ...(children.length && { children }),
      };
    }),
  ];

  // Inverse bind matrices: the inverse of each joint's world transform at rest (yaw, then the
  // facing-frame position), column-major.
  const ibm = new Float32Array(J * 16);
  const c = Math.cos(mesh.yaw);
  const s = Math.sin(mesh.yaw);
  skeleton.rest.forEach(([x, y, z], j) => {
    // World = Ry(yaw) · T(p); inverse = T(-p) · Ry(-yaw).
    const m = [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, -x, -y, -z, 1];
    ibm.set(m, j * 16);
  });
  json.skins = [
    {
      joints: skeleton.names.map((_, j) => jointNode(j)),
      inverseBindMatrices: out.accessor(ibm, "MAT4", 16),
      skeleton: jointNode(root),
    },
  ];

  if (clips.length) {
    json.animations = clips.map((clip) => {
      const input = out.accessor(Float32Array.from(clip.times), "SCALAR", 1, undefined, true);
      const samplers: NonNullable<GltfDocument["animations"]>[number]["samplers"] = [];
      const channels: NonNullable<GltfDocument["animations"]>[number]["channels"] = [];
      for (let j = 0; j < J; j++) {
        const values = new Float32Array(clip.times.length * 4);
        clip.rotations.forEach((pose, k) => values.set(pose[j]!, k * 4));
        samplers.push({ input, output: out.accessor(values, "VEC4", 4), interpolation: "LINEAR" });
        channels.push({
          sampler: samplers.length - 1,
          target: { node: jointNode(j), path: "rotation" },
        });
      }
      const t = new Float32Array(clip.times.length * 3);
      clip.rootTranslation.forEach((v, k) => t.set(v, k * 3));
      samplers.push({ input, output: out.accessor(t, "VEC3", 3), interpolation: "LINEAR" });
      channels.push({
        sampler: samplers.length - 1,
        target: { node: jointNode(root), path: "translation" },
      });
      // glTF has no playback-loop flag; targets read it, and whether the clip was generated, here.
      return {
        name: clip.family,
        channels,
        samplers,
        extras: { loop: clip.loop, generated: true },
      };
    });
  }

  json.accessors = out.accessors;
  json.bufferViews = out.bufferViews;
  json.buffers = [{ byteLength: out.length }];
  return { json, bin: out.bin() };
}
