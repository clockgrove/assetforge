import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";
import { writeGlb } from "../../src/model3d/glb.ts";
import type { GltfDocument } from "../../src/model3d/glb.ts";
import type { SkeletonTemplate, TemplateJoint, JointRole } from "../../src/model3d/rig/template.ts";
import {
  Buffer3d,
  FLOAT,
  UINT,
  addBox,
  addTube,
  densify,
  floats,
  limits,
  minMax,
  taper,
} from "./quadruped.ts";
import type { Mesh, Vec } from "./quadruped.ts";

export interface BipedOptions {
  scale?: number;
  /** Added to every vertex after scaling, so normalisation has work to do. */
  offset?: Vec;
  /** Sides of each tube. */
  segments?: number;
}

/** Joint positions in the model's own units (about 0.5 m tall), facing +z with +x its left. */
export const BIPED_JOINTS: Record<string, Vec> = {
  pelvis: [0, 0.25, 0],
  spine: [0, 0.31, 0],
  chest: [0, 0.37, 0],
  neck: [0, 0.42, 0],
  head: [0, 0.45, 0.005],
  head_top: [0, 0.5, 0.005],
  upper_arm_l: [0.11, 0.4, 0],
  forearm_l: [0.11, 0.29, -0.01],
  hand_l: [0.11, 0.19, 0],
  hand_tip_l: [0.11, 0.14, 0.01],
  upper_arm_r: [-0.11, 0.4, 0],
  forearm_r: [-0.11, 0.29, -0.01],
  hand_r: [-0.11, 0.19, 0],
  hand_tip_r: [-0.11, 0.14, 0.01],
  hip_l: [0.05, 0.24, -0.005],
  knee_l: [0.05, 0.13, 0.01],
  ankle_l: [0.05, 0.035, 0],
  toe_l: [0.05, 0.035, 0.09],
  hip_r: [-0.05, 0.24, -0.005],
  knee_r: [-0.05, 0.13, 0.01],
  ankle_r: [-0.05, 0.035, 0],
  toe_r: [-0.05, 0.035, 0.09],
};

/**
 * The back and front of the mesh along z: the heel box ends at the rear and the toe box at the front
 * (the torso is shallower than both), whatever the number of sides.
 */
const Z_BACK = -0.06;
const Z_FRONT = 0.11;
const BODY_LENGTH = Z_FRONT - Z_BACK;
const MID_Z = (Z_FRONT + Z_BACK) / 2;
const FOOT_HEIGHT = 0.06;

/**
 * A valid `.glb` of a low-poly two-legged character facing +z (+y up, +x its left), about 0.5 m
 * tall with the underside of its feet at y = 0, before `scale` and `offset`.
 */
export function syntheticBiped(options: BipedOptions = {}): Uint8Array {
  const scale = options.scale ?? 1;
  const offset = options.offset ?? [0.3, 0.5, 0];
  const sides = Math.max(3, options.segments ?? 8);
  const J = BIPED_JOINTS;
  const mesh: Mesh = { positions: [], normals: [], uvs: [], indices: [] };

  const torso: Vec[] = [
    [0, 0.2, 0],
    [0, 0.3, 0],
    [0, 0.41, 0],
  ];
  addTube(mesh, torso, [0.055, 0.055, 0.055], sides);
  const head: Vec[] = [
    [0, 0.4, 0],
    [0, 0.44, 0],
    [0, 0.46, 0.005],
    [0, 0.5, 0.005],
  ];
  addTube(mesh, head, [0.03, 0.025, 0.045, 0.04], sides);

  for (const s of ["l", "r"]) {
    const arm = densify([
      J[`upper_arm_${s}`]!,
      J[`forearm_${s}`]!,
      J[`hand_${s}`]!,
      J[`hand_tip_${s}`]!,
    ]);
    addTube(mesh, arm, taper(arm, 0.025, 0.02), sides);
    const leg = densify([J[`hip_${s}`]!, J[`knee_${s}`]!, J[`ankle_${s}`]!]);
    addTube(mesh, leg, taper(leg, 0.03, 0.03), sides);
    const ankle = J[`ankle_${s}`]!;
    const toe = J[`toe_${s}`]!;
    const [x0, x1] = [ankle[0] - 0.035, ankle[0] + 0.035];
    const [zBack, zFront] = [Z_BACK, toe[2] + 0.02];
    addBox(mesh, [
      [x0, 0, zBack],
      [x1, 0, zBack],
      [x1, 0, zFront],
      [x0, 0, zFront],
      [x0, FOOT_HEIGHT, zBack],
      [x1, FOOT_HEIGHT, zBack],
      [x1, FOOT_HEIGHT, zFront],
      [x0, FOOT_HEIGHT, zFront],
    ]);
  }

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
  const indexAccessor = buffer.accessor(new Uint8Array(Uint32Array.from(mesh.indices).buffer), {
    componentType: UINT,
    count: mesh.indices.length,
    type: "SCALAR",
    target: 34963,
  });

  const texture = createRaster(8, 8);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      setPixel(texture, x, y, (x + y) % 2 === 0 ? [150, 150, 150, 255] : [70, 70, 80, 255]);
    }
  }
  const image = buffer.view(encodePng(texture));

  const json: GltfDocument = {
    asset: { version: "2.0", generator: "assetforge-test-fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "biped", mesh: 0 }],
    meshes: [
      {
        name: "biped",
        primitives: [{ attributes, indices: indexAccessor, material: 0, mode: 4 }],
      },
    ],
    materials: [
      {
        name: "cloth",
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
  };
  return writeGlb({ json, bin: buffer.bin() });
}

/** The skeleton template matching `syntheticBiped`: rest positions in body lengths from its origin. */
export function bipedTemplate(): SkeletonTemplate {
  const joints: TemplateJoint[] = [];
  const joint = (name: string, parent: string | null, extra: Partial<TemplateJoint> = {}): void => {
    const [x, y, z] = BIPED_JOINTS[name]!;
    joints.push({
      name,
      parent,
      rest: [x / BODY_LENGTH, y / BODY_LENGTH, (z - MID_Z) / BODY_LENGTH],
      ...extra,
    });
  };
  const trunk = limits(45, 30, 20);
  const role = (r: JointRole): Partial<TemplateJoint> => ({ role: r, limits: trunk });
  joint("pelvis", null, role("pelvis"));
  joint("spine", "pelvis", role("spine"));
  joint("chest", "spine", role("spine"));
  joint("neck", "chest", role("neck"));
  joint("head", "neck", role("head"));
  joint("head_top", "head");
  for (const s of ["l", "r"]) {
    joint(`upper_arm_${s}`, "chest", { limits: limits(150, 90, 90) });
    joint(`forearm_${s}`, `upper_arm_${s}`, { limits: limits(150, 90, 90) });
    joint(`hand_${s}`, `forearm_${s}`, { limits: limits(150, 90, 90) });
    joint(`hip_${s}`, "pelvis", { limits: limits(90, 20, 20) });
    joint(`knee_${s}`, `hip_${s}`, { limits: limits(120, 10, 10) });
    joint(`ankle_${s}`, `knee_${s}`, {
      limits: limits(60, 15, 15),
      stanceLimits: limits(45, 10, 10),
    });
    joint(`toe_${s}`, `ankle_${s}`);
  }
  const foot = (s: string) => ({
    name: `foot_${s}`,
    joints: [`hip_${s}`, `knee_${s}`, `ankle_${s}`, `toe_${s}`] as [string, string, string, string],
    plantigrade: true,
    pair: "hind" as const,
  });
  return { kind: "synthetic-biped", joints, feet: [foot("l"), foot("r")] };
}
