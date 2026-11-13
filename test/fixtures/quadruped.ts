import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";
import { writeGlb } from "../../src/model3d/glb.ts";
import type { GltfDocument } from "../../src/model3d/glb.ts";
import type {
  GaitProfile,
  JointLimits,
  JointRole,
  MotionProfile,
  SkeletonTemplate,
  TemplateJoint,
} from "../../src/model3d/rig/template.ts";

export type Vec = [number, number, number];

export interface QuadrupedOptions {
  digitigrade?: boolean;
  /** Plantigrade only: hind ankles stay raised and the hind foot is tilted, like a dog-like provider model. */
  raisedHeels?: boolean;
  scale?: number;
  /** Added to every vertex after scaling, so normalisation has work to do. */
  offset?: Vec;
  /** Adds a 2-joint skin and a "walk" animation that a re-rig must drop. */
  providerRig?: boolean;
  /** The tail curls to the character's left (+x), so the bounds' centre is off the body's midline. */
  curledTail?: boolean;
  /** The left hind foot rests splayed outward by this much (knee by half), as a posed scan might. */
  splayedHindL?: number;
  /** Sides of each tube. */
  segments?: number;
  /** `asset.extras` a provider writes into its own file. */
  assetExtras?: Record<string, unknown>;
  /** The way the model faces: +z (default), or +x as Tripo's models do (a root node turns it). */
  facing?: "+z" | "+x";
  /**
   * Gives each part (tube or box) its own cell of a UV atlas, as a real model's unwrap does,
   * instead of every part covering the whole 0-1 square.
   */
  atlasUvs?: boolean;
}

const PLANTIGRADE_JOINTS: Record<string, Vec> = {
  pelvis: [0, 0.33, -0.2],
  spine: [0, 0.33, 0],
  chest: [0, 0.32, 0.15],
  neck: [0, 0.34, 0.22],
  head: [0, 0.38, 0.32],
  nose: [0, 0.4, 0.5],
  tail_base: [0, 0.31, -0.26],
  tail_mid: [0, 0.29, -0.38],
  tail_tip: [0, 0.27, -0.5],
  hip_l: [0.08, 0.3, -0.2],
  knee_l: [0.08, 0.18, -0.16],
  ankle_l: [0.08, 0.035, -0.22],
  toe_l: [0.08, 0.035, -0.12],
  hip_r: [-0.08, 0.3, -0.2],
  knee_r: [-0.08, 0.18, -0.16],
  ankle_r: [-0.08, 0.035, -0.22],
  toe_r: [-0.08, 0.035, -0.12],
  shoulder_l: [0.08, 0.3, 0.15],
  elbow_l: [0.08, 0.17, 0.12],
  wrist_l: [0.08, 0.035, 0.15],
  ftoe_l: [0.08, 0.035, 0.22],
  shoulder_r: [-0.08, 0.3, 0.15],
  elbow_r: [-0.08, 0.17, 0.12],
  wrist_r: [-0.08, 0.035, 0.15],
  ftoe_r: [-0.08, 0.035, 0.22],
};

export const QUADRUPED_JOINTS: Record<string, Vec> = PLANTIGRADE_JOINTS;

export const DIGITIGRADE_JOINTS: Record<string, Vec> = {
  ...PLANTIGRADE_JOINTS,
  ankle_l: [0.08, 0.1, -0.2],
  toe_l: [0.08, 0.035, -0.14],
  ankle_r: [-0.08, 0.1, -0.2],
  toe_r: [-0.08, 0.035, -0.14],
  wrist_l: [0.08, 0.09, 0.15],
  ftoe_l: [0.08, 0.035, 0.2],
  wrist_r: [-0.08, 0.09, 0.15],
  ftoe_r: [-0.08, 0.035, 0.2],
};

export const FLOAT = 5126;
export const UINT = 5125;
const UBYTE = 5121;

export class Buffer3d {
  readonly chunks: Uint8Array[] = [];
  length = 0;
  readonly bufferViews: NonNullable<GltfDocument["bufferViews"]> = [];
  readonly accessors: NonNullable<GltfDocument["accessors"]> = [];

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
    this.accessors.push({
      bufferView,
      componentType: spec.componentType,
      count: spec.count,
      type: spec.type,
      ...(spec.min && { min: spec.min }),
      ...(spec.max && { max: spec.max }),
    });
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

export function floats(values: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(values).buffer);
}

export function minMax(values: number[], width: number) {
  const min = Array<number>(width).fill(Infinity);
  const max = Array<number>(width).fill(-Infinity);
  for (let i = 0; i < values.length; i++) {
    const c = i % width;
    min[c] = Math.min(min[c]!, values[i]!);
    max[c] = Math.max(max[c]!, values[i]!);
  }
  return { min, max };
}

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec): Vec => mul(a, 1 / Math.hypot(a[0], a[1], a[2]));

export interface Mesh {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  /** The first vertex of each part, in order. */
  parts?: number[];
}

/**
 * A closed tube along a centre line: one ring per point, radial normals, a fan cap at each end. The
 * end rings of a tube with `flatEnds` lie in a plane of constant z so its extreme point is exact.
 */
export function addTube(
  mesh: Mesh,
  points: Vec[],
  radii: number[],
  sides: number,
  flatEnds = false,
): void {
  const base = mesh.positions.length / 3;
  (mesh.parts ??= []).push(base);
  const last = points.length - 1;
  const tangents = points.map((p, k): Vec => {
    if (k === 0 || k === last) {
      const seg = k === 0 ? sub(points[1]!, p) : sub(p, points[last - 1]!);
      return flatEnds ? ([0, 0, Math.sign(seg[2])] as Vec) : unit(seg);
    }
    return unit(add(unit(sub(p, points[k - 1]!)), unit(sub(points[k + 1]!, p))));
  });
  points.forEach((p, k) => {
    const t = tangents[k]!;
    // No tube here runs along x, so x is a stable reference and the rings do not twist.
    const u = unit(sub([1, 0, 0], mul(t, t[0])));
    const v = cross(t, u);
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const n = add(mul(u, Math.cos(a)), mul(v, Math.sin(a)));
      const q = add(p, mul(n, radii[k]!));
      mesh.positions.push(...q);
      mesh.normals.push(...n);
      mesh.uvs.push(j / sides, k / last);
    }
  });
  for (let k = 0; k < last; k++) {
    for (let j = 0; j < sides; j++) {
      const a = base + k * sides + j;
      const b = base + k * sides + ((j + 1) % sides);
      const c = a + sides;
      const d = b + sides;
      mesh.indices.push(a, b, c, b, d, c);
    }
  }
  for (const [end, ring] of [
    [0, 0],
    [last, last],
  ] as const) {
    const centre = mesh.positions.length / 3;
    mesh.positions.push(...points[end]!);
    mesh.normals.push(...mul(tangents[end]!, end === 0 ? -1 : 1));
    mesh.uvs.push(0.5, 0.5);
    for (let j = 0; j < sides; j++) {
      const a = base + ring * sides + j;
      const b = base + ring * sides + ((j + 1) % sides);
      if (end === 0) mesh.indices.push(centre, b, a);
      else mesh.indices.push(centre, a, b);
    }
  }
}

/** A closed hexahedron from corners 0-3 (bottom, in a loop) and 4-7 (the matching top corners). */
export function addBox(mesh: Mesh, c: Vec[]): void {
  const faces = [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  (mesh.parts ??= []).push(mesh.positions.length / 3);
  const centre = mul(
    c.reduce((s, p) => add(s, p), [0, 0, 0] as Vec),
    1 / c.length,
  );
  for (const face of faces) {
    const [p0, p1, p2] = [c[face[0]!]!, c[face[1]!]!, c[face[2]!]!];
    let n = unit(cross(sub(p1, p0), sub(p2, p0)));
    const order = [0, 1, 2, 0, 2, 3];
    const outward = dot(n, sub(p0, centre)) > 0;
    if (!outward) n = mul(n, -1);
    const base = mesh.positions.length / 3;
    face.forEach((i, k) => {
      mesh.positions.push(...c[i]!);
      mesh.normals.push(...n);
      mesh.uvs.push(k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0);
    });
    const tri = outward ? order : [0, 2, 1, 0, 3, 2];
    for (const i of tri) mesh.indices.push(base + i);
  }
}

/** Moves each part's 0-1 UVs into its own cell of a square grid, with a margin. */
function atlas(mesh: Mesh): void {
  const parts = mesh.parts ?? [0];
  const grid = Math.ceil(Math.sqrt(parts.length));
  const cell = 1 / grid;
  const margin = cell * 0.08;
  const count = mesh.positions.length / 3;
  parts.forEach((start, p) => {
    const end = parts[p + 1] ?? count;
    const cx = (p % grid) * cell;
    const cy = Math.floor(p / grid) * cell;
    for (let v = start; v < end; v++) {
      mesh.uvs[v * 2] = cx + margin + mesh.uvs[v * 2]! * (cell - 2 * margin);
      mesh.uvs[v * 2 + 1] = cy + margin + mesh.uvs[v * 2 + 1]! * (cell - 2 * margin);
    }
  });
}

/** The joints themselves plus two interpolated points inside each segment. */
export function densify(points: Vec[]): Vec[] {
  const out: Vec[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    out.push(add(a, mul(sub(b, a), 1 / 3)), add(a, mul(sub(b, a), 2 / 3)), b);
  }
  return out;
}

export function taper(points: Vec[], from: number, to: number): number[] {
  return points.map((_, k) => from + ((to - from) * k) / (points.length - 1));
}

/**
 * A valid `.glb` of a low-poly four-legged animal facing +z (+y up, +x its left), one body length
 * long with its lowest point at y = 0, before `scale` and `offset`.
 */
export function syntheticQuadruped(options: QuadrupedOptions = {}): Uint8Array {
  const digitigrade = options.digitigrade === true;
  const raised = options.raisedHeels === true && !digitigrade;
  const scale = options.scale ?? 1;
  const offset = options.offset ?? [0.3, 0.5, 0];
  const sides = Math.max(3, options.segments ?? 8);
  const J = digitigrade ? DIGITIGRADE_JOINTS : QUADRUPED_JOINTS;
  const mesh: Mesh = { positions: [], normals: [], uvs: [], indices: [] };

  const body: Vec[] = [
    [0, 0.32, -0.28],
    [0, 0.33, -0.2],
    [0, 0.33, 0],
    [0, 0.32, 0.15],
    [0, 0.34, 0.22],
  ];
  addTube(mesh, body, taper(body, 0.09, 0.09), sides);
  const neck: Vec[] = [
    [0, 0.34, 0.22],
    [0, 0.38, 0.32],
    [0, 0.4, 0.42],
    [0, 0.4, 0.5],
  ];
  addTube(mesh, neck, [0.06, 0.055, 0.045, 0.03], sides, true);
  const tail: Vec[] = options.curledTail
    ? [
        [0, 0.31, -0.26],
        [0.08, 0.29, -0.4],
        [0.2, 0.27, -0.5],
      ]
    : [
        [0, 0.31, -0.26],
        [0, 0.29, -0.38],
        [0, 0.27, -0.5],
      ];
  addTube(mesh, tail, [0.04, 0.028, 0.015], sides, true);

  for (const s of ["l", "r"]) {
    const x = s === "l" ? 0.08 : -0.08;
    const hind = [J[`hip_${s}`]!, J[`knee_${s}`]!, J[`ankle_${s}`]!, J[`toe_${s}`]!];
    const fore = [J[`shoulder_${s}`]!, J[`elbow_${s}`]!, J[`wrist_${s}`]!, J[`ftoe_${s}`]!];
    if (raised) hind[2] = [x, 0.1, -0.21];
    const splay = s === "l" ? (options.splayedHindL ?? 0) : 0;
    if (splay) {
      const out = (p: Vec, k: number): Vec => [p[0] + splay * k, p[1], p[2]];
      hind.splice(1, 3, out(hind[1]!, 0.5), out(hind[2]!, 1), out(hind[3]!, 1));
    }
    for (const [chain, isHind] of [
      [hind, true],
      [fore, false],
    ] as const) {
      const [, , ankle, toe] = chain;
      const centre = digitigrade ? chain : chain.slice(0, 3);
      const pts = densify(centre);
      addTube(mesh, pts, taper(pts, 0.03, 0.03), sides);
      const zFront = toe![2];
      const zBack = digitigrade ? toe![2] - 0.03 : ankle![2] - 0.03;
      const zTop = zFront + 0.02;
      const [x0, x1] = [ankle![0] - 0.035, ankle![0] + 0.035];
      if (raised && isHind) {
        // Heel (back) end raised so the sole rises from y = 0 at the toe to y = 0.06 at the ankle.
        addBox(mesh, [
          [x0, 0.06, zBack],
          [x1, 0.06, zBack],
          [x1, 0, zTop],
          [x0, 0, zTop],
          [x0, 0.12, zBack],
          [x1, 0.12, zBack],
          [x1, 0.06, zTop],
          [x0, 0.06, zTop],
        ]);
      } else {
        addBox(mesh, [
          [x0, 0, zBack],
          [x1, 0, zBack],
          [x1, 0, zTop],
          [x0, 0, zTop],
          [x0, 0.06, zBack],
          [x1, 0.06, zBack],
          [x1, 0.06, zTop],
          [x0, 0.06, zTop],
        ]);
      }
    }
  }

  if (options.atlasUvs) atlas(mesh);
  const positions = mesh.positions.map((v, i) => v * scale + offset[i % 3]!);
  const count = positions.length / 3;
  const buffer = new Buffer3d();
  const { min, max } = minMax(positions, 3);
  const attributes: Record<string, number> = {
    POSITION: buffer.accessor(floats(positions), {
      componentType: FLOAT,
      count,
      type: "VEC3",
      target: 34962,
      min,
      max,
    }),
    NORMAL: buffer.accessor(floats(mesh.normals), {
      componentType: FLOAT,
      count,
      type: "VEC3",
      target: 34962,
    }),
    TEXCOORD_0: buffer.accessor(floats(mesh.uvs), {
      componentType: FLOAT,
      count,
      type: "VEC2",
      target: 34962,
    }),
  };

  if (options.providerRig) {
    const jointIds: number[] = [];
    const weights: number[] = [];
    for (let i = 0; i < count; i++) {
      const w = Math.min(Math.max(mesh.positions[i * 3 + 2]! + 0.5, 0), 1);
      jointIds.push(0, 1, 0, 0);
      weights.push(1 - w, w, 0, 0);
    }
    attributes["JOINTS_0"] = buffer.accessor(Uint8Array.from(jointIds), {
      componentType: UBYTE,
      count,
      type: "VEC4",
      target: 34962,
    });
    attributes["WEIGHTS_0"] = buffer.accessor(floats(weights), {
      componentType: FLOAT,
      count,
      type: "VEC4",
      target: 34962,
    });
  }

  const indexAccessor = buffer.accessor(new Uint8Array(Uint32Array.from(mesh.indices).buffer), {
    componentType: UINT,
    count: mesh.indices.length,
    type: "SCALAR",
    target: 34963,
  });

  // An atlas gets a finer texture with the same 8 x 8 checker, so each part's cell holds texels.
  const texturePx = options.atlasUvs ? 128 : 8;
  const square = texturePx / 8;
  const texture = createRaster(texturePx, texturePx);
  for (let y = 0; y < texturePx; y++) {
    for (let x = 0; x < texturePx; x++) {
      const odd = (Math.floor(x / square) + Math.floor(y / square)) % 2;
      setPixel(texture, x, y, odd === 0 ? [150, 150, 150, 255] : [70, 70, 80, 255]);
    }
  }
  const image = buffer.view(encodePng(texture));

  let nodes: NonNullable<GltfDocument["nodes"]> = [{ name: "quadruped", mesh: 0 }];
  let sceneNodes = [0];
  let skins: GltfDocument["skins"];
  let animations: GltfDocument["animations"];
  if (options.providerRig) {
    nodes = [
      { name: "quadruped", mesh: 0, skin: 0 },
      { name: "joint-0", translation: [0, 0, 0], children: [2] },
      { name: "joint-1", translation: [0, 0, 0.5] },
    ];
    sceneNodes = [0, 1];
    const ibm = [
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -0.5, 1],
    ].flat();
    const ibmAccessor = buffer.accessor(floats(ibm), {
      componentType: FLOAT,
      count: 2,
      type: "MAT4",
    });
    skins = [{ joints: [1, 2], inverseBindMatrices: ibmAccessor, skeleton: 1 }];
    const input = buffer.accessor(floats([0, 0.5, 1]), {
      componentType: FLOAT,
      count: 3,
      type: "SCALAR",
      min: [0],
      max: [1],
    });
    const values = [0, 30, 0].flatMap((deg) => {
      const a = (deg * Math.PI) / 360;
      return [Math.sin(a), 0, 0, Math.cos(a)];
    });
    const output = buffer.accessor(floats(values), {
      componentType: FLOAT,
      count: 3,
      type: "VEC4",
    });
    animations = [
      {
        name: "walk",
        channels: [{ sampler: 0, target: { node: 2, path: "rotation" } }],
        samplers: [{ input, output, interpolation: "LINEAR" }],
      },
    ];
  }

  if (options.facing === "+x") {
    nodes.push({
      name: "provider-root",
      rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      children: sceneNodes,
    });
    sceneNodes = [nodes.length - 1];
  }

  const json: GltfDocument = {
    asset: {
      version: "2.0",
      generator: "assetforge-test-fixture",
      ...(options.assetExtras && { extras: options.assetExtras }),
    },
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes,
    meshes: [
      {
        name: "quadruped",
        primitives: [{ attributes, indices: indexAccessor, material: 0, mode: 4 }],
      },
    ],
    ...(skins && { skins }),
    materials: [
      {
        name: "fur",
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          baseColorTexture: { index: 0 },
        },
      },
    ],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9728, minFilter: 9728 }],
    images: [{ bufferView: image, mimeType: "image/png" }],
    accessors: buffer.accessors,
    bufferViews: buffer.bufferViews,
    buffers: [{ byteLength: buffer.length }],
    ...(animations && { animations }),
  };
  return writeGlb({ json, bin: buffer.bin() });
}

const range = (n: number): [number, number] => [-n, n];
export const limits = (x: number, y: number, z: number): JointLimits => ({
  x: range(x),
  y: range(y),
  z: range(z),
});

/** The skeleton template matching `syntheticQuadruped`. */
export function quadrupedTemplate(options: { digitigrade?: boolean } = {}): SkeletonTemplate {
  const digitigrade = options.digitigrade === true;
  const J = digitigrade ? DIGITIGRADE_JOINTS : QUADRUPED_JOINTS;
  const joints: TemplateJoint[] = [];
  const joint = (name: string, parent: string | null, extra: Partial<TemplateJoint> = {}): void => {
    joints.push({ name, parent, rest: [...J[name]!] as Vec, ...extra });
  };
  const trunk = limits(45, 30, 20);
  const role = (r: JointRole): Partial<TemplateJoint> => ({ role: r, limits: trunk });
  joint("pelvis", null, role("pelvis"));
  joint("spine", "pelvis", role("spine"));
  joint("chest", "spine", role("spine"));
  joint("neck", "chest", role("neck"));
  joint("head", "neck", role("head"));
  joint("nose", "head");
  joint("tail_base", "pelvis", role("tail"));
  joint("tail_mid", "tail_base", role("tail"));
  joint("tail_tip", "tail_mid");
  for (const s of ["l", "r"]) {
    for (const [upper, lower, ankle, toe, parent] of [
      ["hip", "knee", "ankle", "toe", "pelvis"],
      ["shoulder", "elbow", "wrist", "ftoe", "chest"],
    ] as const) {
      joint(`${upper}_${s}`, parent, { limits: limits(60, 15, 15) });
      joint(`${lower}_${s}`, `${upper}_${s}`, { limits: limits(120, 10, 10) });
      joint(`${ankle}_${s}`, `${lower}_${s}`, {
        limits: limits(90, 15, 15),
        stanceLimits: limits(45, 10, 10),
      });
      joint(`${toe}_${s}`, `${ankle}_${s}`);
    }
  }
  const foot = (name: string, chain: [string, string, string, string], pair: "fore" | "hind") => ({
    name,
    joints: chain,
    plantigrade: !digitigrade,
    pair,
  });
  return {
    kind: "synthetic-quadruped",
    joints,
    feet: [
      foot("hind_l", ["hip_l", "knee_l", "ankle_l", "toe_l"], "hind"),
      foot("hind_r", ["hip_r", "knee_r", "ankle_r", "toe_r"], "hind"),
      foot("fore_l", ["shoulder_l", "elbow_l", "wrist_l", "ftoe_l"], "fore"),
      foot("fore_r", ["shoulder_r", "elbow_r", "wrist_r", "ftoe_r"], "fore"),
    ],
  };
}

/** A walk gait for the synthetic quadruped. */
export function walkGait(options: { digitigrade?: boolean } = {}): GaitProfile {
  const footfall = ["hind_l", "fore_l", "hind_r", "fore_r"];
  if (options.digitigrade) {
    return {
      footfall,
      dutyFactor: 0.55,
      strideBodyLengths: 0.18,
      stepHeightBodyLengths: 0.04,
      backArchDeg: 0,
      hipHeightRatio: 1.0,
      headPitchDeg: 0,
      tailPitchDeg: -10,
      tailSwayDeg: 5,
      speedBodyLengthsPerSecond: 1.0,
      swingCurlDeg: { fore: 20, hind: 10 },
    };
  }
  return {
    footfall,
    dutyFactor: 0.65,
    strideBodyLengths: 0.2,
    stepHeightBodyLengths: 0.03,
    backArchDeg: 8,
    hipHeightRatio: 1.0,
    headPitchDeg: 10,
    tailPitchDeg: 15,
    tailSwayDeg: 10,
    speedBodyLengthsPerSecond: 0.6,
    swingCurlDeg: { fore: 40, hind: 15 },
  };
}

/** A quadruped's idle: head and tail sway, the back breathes. */
export const quadrupedIdle = (): MotionProfile => ({
  loop: true,
  durationS: 2.5,
  keys: [
    { at: 0, pose: { headPitchDeg: 0, tailPitchDeg: 0 } },
    { at: 0.5, pose: { backArchDeg: 3, headPitchDeg: 6, tailPitchDeg: 8, tailYawDeg: 6 } },
  ],
});

/** A quadruped's one-shot: a fore paw lifted, the head lowered, then back to the idle. */
export const quadrupedPaw = (): MotionProfile => ({
  loop: false,
  idle: "idle",
  entryS: 0.3,
  exitS: 0.3,
  durationS: 1,
  keys: [
    { at: 0, pose: {} },
    { at: 0.5, pose: { headPitchDeg: 10, feet: { fore_l: { liftBodyLengths: 0.04 } } } },
    { at: 1, pose: {} },
  ],
});
