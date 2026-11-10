import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";
import { writeGlb } from "../../src/model3d/glb.ts";
import type { GltfDocument } from "../../src/model3d/glb.ts";

export interface SyntheticCharacterOptions {
  /** Approximate triangle count; a box has 12 and each face is subdivided into n × n quads. */
  triangles?: number;
  textureSize?: number;
  materials?: number;
  joints?: number;
  clips?: Array<{ name: string; durationS: number; loopClosed: boolean }>;
  /** When set, each clip also moves the last joint by this much along z by its last frame. */
  translationDrift?: number;
  heightUnits?: number;
  forward?: "+z";
}

const FLOAT = 5126;
const UINT = 5125;
const UBYTE = 5121;

class Buffer3d {
  readonly chunks: Uint8Array[] = [];
  length = 0;
  readonly json: {
    bufferViews: NonNullable<GltfDocument["bufferViews"]> extends Array<infer V>
      ? Array<V & { target?: number }>
      : never;
    accessors: NonNullable<GltfDocument["accessors"]>;
  } = {
    bufferViews: [],
    accessors: [],
  };

  view(bytes: Uint8Array, target?: number): number {
    const padded = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4);
    padded.set(bytes);
    this.json.bufferViews.push({
      buffer: 0,
      byteOffset: this.length,
      byteLength: bytes.byteLength,
      ...(target !== undefined && { target }),
    });
    this.chunks.push(padded);
    this.length += padded.byteLength;
    return this.json.bufferViews.length - 1;
  }

  accessor(
    bytes: Uint8Array,
    spec: {
      componentType: number;
      count: number;
      type: string;
      target?: number;
      min?: number[];
      max?: number[];
    },
  ): number {
    const bufferView = this.view(bytes, spec.target);
    this.json.accessors.push({
      bufferView,
      componentType: spec.componentType,
      count: spec.count,
      type: spec.type,
      ...(spec.min && { min: spec.min }),
      ...(spec.max && { max: spec.max }),
    });
    return this.json.accessors.length - 1;
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

function floats(values: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(values).buffer);
}

function minMax(values: number[], width: number) {
  const min = Array<number>(width).fill(Infinity);
  const max = Array<number>(width).fill(-Infinity);
  for (let i = 0; i < values.length; i++) {
    const c = i % width;
    min[c] = Math.min(min[c]!, values[i]!);
    max[c] = Math.max(max[c]!, values[i]!);
  }
  return { min, max };
}

/**
 * A valid skinned, textured, animated `.glb` of a box standing off-origin (bottom at y = 0.5, centred
 * on x = 0.3), so normalisation has work to do.
 */
export function syntheticCharacter(options: SyntheticCharacterOptions = {}): Uint8Array {
  const height = options.heightUnits ?? 2;
  const jointCount = Math.max(1, options.joints ?? 2);
  const materialCount = Math.max(1, options.materials ?? 1);
  const textureSize = options.textureSize ?? 8;
  const n = Math.max(1, Math.round(Math.sqrt((options.triangles ?? 12) / 12)));
  const bottom = 0.5;
  const centreX = 0.3;
  const half: [number, number, number] = [0.5, height / 2, 0.3];
  const centre: [number, number, number] = [centreX, bottom + height / 2, 0];

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const jointIds: number[] = [];
  const weights: number[] = [];
  const indices: number[] = [];
  const faces: Array<{
    normal: [number, number, number];
    u: [number, number, number];
    v: [number, number, number];
  }> = [
    { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { normal: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    { normal: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  ];
  for (const face of faces) {
    const base = positions.length / 3;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * 2 - 1;
        const b = (j / n) * 2 - 1;
        const p = [0, 1, 2].map(
          (c) => centre[c]! + half[c]! * (face.normal[c]! + a * face.u[c]! + b * face.v[c]!),
        );
        positions.push(p[0]!, p[1]!, p[2]!);
        normals.push(...face.normal);
        uvs.push(i / n, 1 - j / n);
        const along = Math.min(Math.max((p[1]! - bottom) / height, 0), 1) * (jointCount - 1);
        const lower = Math.min(Math.floor(along), jointCount - 1);
        const upper = Math.min(lower + 1, jointCount - 1);
        const w = upper === lower ? 0 : along - lower;
        jointIds.push(lower, upper, 0, 0);
        weights.push(1 - w, w, 0, 0);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = base + j * (n + 1) + i;
        const b = a + 1;
        const c = a + n + 1;
        const d = c + 1;
        // a→b runs along u and a→c along v, so (a, b, c) is counter-clockwise when u × v = normal.
        const outward = cross3(face.u, face.v).every((value, k) => value === face.normal[k]);
        if (outward) indices.push(a, b, c, b, d, c);
        else indices.push(a, c, b, b, c, d);
      }
    }
  }

  const buffer = new Buffer3d();
  const count = positions.length / 3;
  const { min, max } = minMax(positions, 3);
  const attributes = {
    POSITION: buffer.accessor(floats(positions), {
      componentType: FLOAT,
      count,
      type: "VEC3",
      target: 34962,
      min,
      max,
    }),
    NORMAL: buffer.accessor(floats(normals), {
      componentType: FLOAT,
      count,
      type: "VEC3",
      target: 34962,
    }),
    TEXCOORD_0: buffer.accessor(floats(uvs), {
      componentType: FLOAT,
      count,
      type: "VEC2",
      target: 34962,
    }),
    JOINTS_0: buffer.accessor(Uint8Array.from(jointIds), {
      componentType: UBYTE,
      count,
      type: "VEC4",
      target: 34962,
    }),
    WEIGHTS_0: buffer.accessor(floats(weights), {
      componentType: FLOAT,
      count,
      type: "VEC4",
      target: 34962,
    }),
  };

  const triangleCount = indices.length / 3;
  const used = Math.min(materialCount, triangleCount);
  const primitives = Array.from({ length: used }, (_, m) => {
    const own: number[] = [];
    for (let t = 0; t < triangleCount; t++) {
      if (t % used === m) own.push(indices[t * 3]!, indices[t * 3 + 1]!, indices[t * 3 + 2]!);
    }
    const accessor = buffer.accessor(new Uint8Array(Uint32Array.from(own).buffer), {
      componentType: UINT,
      count: own.length,
      type: "SCALAR",
      target: 34963,
    });
    return { attributes, indices: accessor, material: m, mode: 4 };
  });

  const texture = createRaster(textureSize, textureSize);
  for (let y = 0; y < textureSize; y++) {
    for (let x = 0; x < textureSize; x++) {
      const on = (x + y) % 2 === 0;
      setPixel(texture, x, y, on ? [230, 90, 60, 255] : [60, 120, 220, 255]);
    }
  }
  const image = buffer.view(encodePng(texture));

  // Joint chain: joint 0 at the box's bottom centre, each next one a segment higher.
  const step = height / Math.max(1, jointCount - 1);
  const nodes: NonNullable<GltfDocument["nodes"]> = [
    { name: "body", mesh: 0, skin: 0 },
    ...Array.from({ length: jointCount }, (_, j) => ({
      name: `joint-${j}`,
      translation: j === 0 ? [centreX, bottom, 0] : [0, step, 0],
      ...(j < jointCount - 1 && { children: [j + 2] }),
    })),
  ];
  const ibm: number[] = [];
  for (let j = 0; j < jointCount; j++) {
    ibm.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -centreX, -(bottom + step * j), 0, 1);
  }
  const ibmAccessor = buffer.accessor(floats(ibm), {
    componentType: FLOAT,
    count: jointCount,
    type: "MAT4",
  });

  const animations: NonNullable<GltfDocument["animations"]> = [];
  for (const clip of options.clips ?? []) {
    const times = [0, clip.durationS / 2, clip.durationS];
    const angles = [0, 30, clip.loopClosed ? 0 : 20].map((deg) => (deg * Math.PI) / 180);
    const input = buffer.accessor(floats(times), {
      componentType: FLOAT,
      count: 3,
      type: "SCALAR",
      min: [0],
      max: [clip.durationS],
    });
    const samplers: NonNullable<GltfDocument["animations"]>[number]["samplers"] = [];
    const channels: NonNullable<GltfDocument["animations"]>[number]["channels"] = [];
    for (let j = 0; j < jointCount; j++) {
      const values = angles.flatMap((a) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)]);
      const output = buffer.accessor(floats(values), {
        componentType: FLOAT,
        count: 3,
        type: "VEC4",
      });
      samplers.push({ input, output, interpolation: "LINEAR" });
      channels.push({ sampler: j, target: { node: j + 1, path: "rotation" } });
    }
    if (options.translationDrift !== undefined) {
      const last = jointCount - 1;
      const base = last === 0 ? [centreX, bottom, 0] : [0, step, 0];
      const values = [0, 0, options.translationDrift].flatMap((d) => [
        base[0]!,
        base[1]!,
        base[2]! + d,
      ]);
      const output = buffer.accessor(floats(values), {
        componentType: FLOAT,
        count: 3,
        type: "VEC3",
      });
      samplers.push({ input, output, interpolation: "LINEAR" });
      channels.push({
        sampler: samplers.length - 1,
        target: { node: last + 1, path: "translation" },
      });
    }
    animations.push({ name: clip.name, channels, samplers });
  }

  const json: GltfDocument = {
    asset: { version: "2.0", generator: "assetforge-test-fixture" },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes,
    meshes: [{ name: "body", primitives }],
    skins: [
      {
        joints: Array.from({ length: jointCount }, (_, j) => j + 1),
        inverseBindMatrices: ibmAccessor,
        skeleton: 1,
      },
    ],
    materials: Array.from({ length: used }, (_, m) => ({
      name: `material-${m}`,
      pbrMetallicRoughness: {
        baseColorFactor: [1 - 0.15 * m, 1, 1 - 0.1 * m, 1].map((v) => Math.max(0.2, v)),
        baseColorTexture: { index: 0 },
        metallicFactor: 0,
      },
    })),
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9728, minFilter: 9728 }],
    images: [{ bufferView: image, mimeType: "image/png" }],
    accessors: buffer.json.accessors,
    bufferViews: buffer.json.bufferViews,
    buffers: [{ byteLength: buffer.length }],
    ...(animations.length > 0 && { animations }),
  };
  return writeGlb({ json, bin: buffer.bin() });
}

function cross3(a: number[], b: number[]): number[] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
}
