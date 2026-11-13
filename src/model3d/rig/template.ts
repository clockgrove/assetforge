/**
 * The shared-rig contract (assetforge#84, shared with clockgrove/raccoon-world#39): the profile's
 * `model3d.rig`, `model3d.gaits` and `model3d.motions` (assetforge#135), and the skeleton template
 * file a rig names. Everything here is
 * target data; nothing is specific to one animal.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { InputError } from "../../errors.ts";
import { sha256 } from "../../request.ts";
import type { TargetProfile } from "../../types.ts";

export type Range = [number, number];
/** Limits in degrees of a joint's local rotation from rest, as X-Y-Z Euler angles. */
export interface JointLimits {
  x?: Range;
  y?: Range;
  z?: Range;
}

export const JOINT_ROLES = ["pelvis", "spine", "neck", "head", "tail"] as const;
export type JointRole = (typeof JOINT_ROLES)[number];

export interface TemplateJoint {
  name: string;
  /** The parent joint's name; null (or absent) for the root. */
  parent: string | null;
  /** Rest position in the facing frame (+z forward, +y up, +x left) as fractions of body length. */
  rest: [number, number, number];
  /** The joint's range in any phase. */
  limits?: JointLimits;
  /** The tighter range of a weight-bearing joint (a foot's ankle or wrist) during its stance. */
  stanceLimits?: JointLimits;
  /** Where the gait puts the back arch, head carriage and tail. */
  role?: JointRole;
}

export interface TemplateFoot {
  name: string;
  /** The leg chain: upper (hip or shoulder), lower (knee or elbow), ankle (or wrist), toe. */
  joints: [string, string, string, string];
  plantigrade: boolean;
  pair: "fore" | "hind";
}

export interface SkeletonTemplate {
  kind?: string;
  joints: TemplateJoint[];
  feet: TemplateFoot[];
}

export interface GaitProfile {
  /** Feet in footfall order; foot i touches down at phase i ÷ count. */
  footfall: string[];
  /** The fraction of the cycle each foot is on the ground. */
  dutyFactor: number;
  /** Distance travelled per cycle, in body lengths. */
  strideBodyLengths: number;
  /** Peak swing lift, in body lengths. */
  stepHeightBodyLengths: number;
  /** Spine curve over the spine joints, degrees; positive hunches the back. */
  backArchDeg: number;
  /**
   * Hip height over shoulder height in the clip (the hind legs' upper joints over the fore legs'),
   * so above 1 carries the rump high. The body stands as tall as its legs reach with feet planted.
   */
  hipHeightRatio: number;
  /** Head and neck pitch, degrees; positive lowers the head. */
  headPitchDeg: number;
  /** Tail pitch, degrees; positive lowers the tail. */
  tailPitchDeg: number;
  /** Tail yaw amplitude, degrees, in step with the hips. */
  tailSwayDeg: number;
  speedBodyLengthsPerSecond: number;
  /** Downward paw curl at mid-swing, degrees (added here). */
  swingCurlDeg?: { fore?: number; hind?: number };
  /** Hip yaw amplitude, degrees (added here); a third of tailSwayDeg by default. */
  hipSwayDeg?: number;
  /** A directory of gait reference frames, relative to the profile (added here). */
  reference?: string;
  /** Whether the clip loops (added here); true by default. */
  loop?: boolean;
}

/** A foot's place in a motion pose, from where it stands at rest, in body lengths and degrees. */
export interface MotionFoot {
  /** Height of the sole above the ground; 0 (the default) plants the foot. */
  liftBodyLengths?: number;
  forwardBodyLengths?: number;
  /** Toward the character's left (+x). */
  sideBodyLengths?: number;
  /** Downward curl of the foot, degrees. */
  curlDeg?: number;
}

/** One key pose of a motion (added here, assetforge#135). Every field defaults to 0. */
export interface MotionPose {
  /** The root's offset and turn from the neutral stance. Positive pitch lowers the front. */
  body?: {
    raiseBodyLengths?: number;
    forwardBodyLengths?: number;
    sideBodyLengths?: number;
    pitchDeg?: number;
    yawDeg?: number;
    rollDeg?: number;
  };
  /** Spread over the `spine` joints; positive hunches the back. */
  backArchDeg?: number;
  /** Spread over the `neck` and `head` joints; positive lowers the head, positive yaw turns it left. */
  headPitchDeg?: number;
  headYawDeg?: number;
  /** Spread over the `tail` joints; positive lowers the tail. */
  tailPitchDeg?: number;
  tailYawDeg?: number;
  /** Extra local rotation of named template joints, X-Y-Z Euler degrees, after the roles'. */
  joints?: Record<string, { x?: number; y?: number; z?: number }>;
  /** Feet by template foot name; a foot not listed stays planted where it stands. */
  feet?: Record<string, MotionFoot>;
}

/**
 * A clip family besides locomotion (assetforge#135): a looping idle or a one-shot gesture or
 * interaction, keyed as poses on the shared rig.
 */
export interface MotionProfile {
  /** A looping family (an idle) or a one-shot (a gesture or an interaction). */
  loop: boolean;
  /** Seconds the keys span; a one-shot's clip also includes its entry and exit. */
  durationS: number;
  /** Key poses, `at` a fraction of `durationS` from 0, ascending; eased between keys. */
  keys: Array<{ at: number; pose: MotionPose }>;
  /** One-shots: the looping motion whose first pose the clip starts from and returns to. */
  idle?: string;
  /** One-shots: seconds blending from the idle's first pose into the first key. */
  entryS?: number;
  /** One-shots: seconds blending from the last key back to the idle's first pose. */
  exitS?: number;
}

export interface RigQaTolerances {
  /** How far a stance foot's sole may be from the ground line, in body lengths. */
  contactBodyLengths: number;
  /** How far a stance foot may slide in the ground frame, in body lengths. */
  slideBodyLengths: number;
  /** How far a plantigrade heel may sit above its toe in stance, in body lengths. */
  heelBodyLengths: number;
  /** The smallest posed-over-rest girth at a bent leg joint. */
  minGirthRatio: number;
}

export const DEFAULT_RIG_QA: RigQaTolerances = {
  contactBodyLengths: 0.01,
  slideBodyLengths: 0.01,
  heelBodyLengths: 0.02,
  minGirthRatio: 0.7,
};

/** The profile's `model3d.rig`. */
export interface RigProfile {
  /** Path to the skeleton template file, relative to the profile file. */
  template: string;
  /** The kind of character the template serves, for example `raccoon`. */
  kind: string;
  qa?: Partial<RigQaTolerances>;
}

export interface LoadedRig {
  /** The template path as the profile declares it. */
  templatePath: string;
  kind: string;
  template: SkeletonTemplate;
  /** SHA-256 of the template file's bytes. */
  templateSha256: string;
  gaits: Record<string, GaitProfile>;
  /** SHA-256 of each gait profile's canonical JSON. */
  gaitSha256: Record<string, string>;
  /** Clip families besides locomotion (`model3d.motions`). */
  motions: Record<string, MotionProfile>;
  /** SHA-256 of each motion's canonical JSON. */
  motionSha256: Record<string, string>;
  qa: RigQaTolerances;
  /** Directory relative paths resolved against. */
  baseDir: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function limitsOf(value: unknown, where: string): JointLimits | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new InputError(`${where} must be an object of x, y and z ranges`);
  const out: JointLimits = {};
  for (const [axis, range] of Object.entries(value)) {
    if (axis !== "x" && axis !== "y" && axis !== "z") {
      throw new InputError(`${where} has an unknown axis "${axis}" (x, y or z)`);
    }
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !finite(range[0]) ||
      !finite(range[1]) ||
      range[0] > range[1]
    ) {
      throw new InputError(`${where}.${axis} must be [min, max] in degrees`);
    }
    out[axis] = [range[0], range[1]];
  }
  return out;
}

/** Validates a skeleton template; throws an InputError naming what is wrong. */
export function parseTemplate(value: unknown, where = "the skeleton template"): SkeletonTemplate {
  if (!isObject(value)) throw new InputError(`${where} must be a JSON object`);
  const joints = value["joints"];
  if (!Array.isArray(joints) || joints.length < 2) {
    throw new InputError(`${where} needs a joints list of at least two joints`);
  }
  const names = new Set<string>();
  const parsed: TemplateJoint[] = joints.map((joint, i) => {
    const at = `${where} joints[${i}]`;
    if (!isObject(joint)) throw new InputError(`${at} must be an object`);
    const name = joint["name"];
    if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) {
      throw new InputError(`${at}.name must be a joint name (letters, digits, _ . -)`);
    }
    if (names.has(name)) throw new InputError(`${where} names joint "${name}" twice`);
    names.add(name);
    const parent = joint["parent"] ?? null;
    if (parent !== null && typeof parent !== "string") {
      throw new InputError(`${at}.parent must be a joint name or null`);
    }
    const rest = joint["rest"];
    if (!Array.isArray(rest) || rest.length !== 3 || !rest.every(finite)) {
      throw new InputError(`${at}.rest must be [x, y, z] in body lengths`);
    }
    const role = joint["role"];
    if (role !== undefined && !JOINT_ROLES.includes(role as JointRole)) {
      throw new InputError(`${at}.role must be one of ${JOINT_ROLES.join(", ")}`);
    }
    const limits = limitsOf(joint["limits"], `${at}.limits`);
    const stanceLimits = limitsOf(joint["stanceLimits"], `${at}.stanceLimits`);
    return {
      name,
      parent,
      rest: [rest[0], rest[1], rest[2]] as [number, number, number],
      ...(limits && { limits }),
      ...(stanceLimits && { stanceLimits }),
      ...(role !== undefined && { role: role as JointRole }),
    };
  });
  const roots = parsed.filter((j) => j.parent === null);
  if (roots.length !== 1) throw new InputError(`${where} needs exactly one root joint`);
  for (const joint of parsed) {
    if (joint.parent !== null && !names.has(joint.parent)) {
      throw new InputError(`${where}: joint "${joint.name}" names a missing parent`);
    }
  }
  // Every joint must reach the root (no cycles).
  const byName = new Map(parsed.map((j) => [j.name, j]));
  for (const joint of parsed) {
    let at: TemplateJoint | undefined = joint;
    for (let steps = 0; at && at.parent !== null; steps++) {
      if (steps > parsed.length) throw new InputError(`${where}: the joint hierarchy has a cycle`);
      at = byName.get(at.parent);
    }
  }
  const feet = value["feet"];
  if (!Array.isArray(feet) || feet.length === 0) {
    throw new InputError(`${where} needs a feet list`);
  }
  const footNames = new Set<string>();
  const parsedFeet: TemplateFoot[] = feet.map((foot, i) => {
    const at = `${where} feet[${i}]`;
    if (!isObject(foot)) throw new InputError(`${at} must be an object`);
    const name = foot["name"];
    if (typeof name !== "string" || name.length === 0)
      throw new InputError(`${at}.name is missing`);
    if (footNames.has(name)) throw new InputError(`${where} names foot "${name}" twice`);
    footNames.add(name);
    const chain = foot["joints"];
    if (
      !Array.isArray(chain) ||
      chain.length !== 4 ||
      !chain.every((j) => typeof j === "string" && names.has(j))
    ) {
      throw new InputError(
        `${at}.joints must name four template joints: upper, lower, ankle (or wrist), toe`,
      );
    }
    for (let k = 1; k < 4; k++) {
      if (byName.get(chain[k] as string)?.parent !== chain[k - 1]) {
        throw new InputError(`${at}.joints must be a parent-to-child chain`);
      }
    }
    if (typeof foot["plantigrade"] !== "boolean") {
      throw new InputError(`${at}.plantigrade must be true or false`);
    }
    const pair = foot["pair"];
    if (pair !== "fore" && pair !== "hind") throw new InputError(`${at}.pair must be fore or hind`);
    return {
      name,
      joints: chain as [string, string, string, string],
      plantigrade: foot["plantigrade"],
      pair,
    };
  });
  const kind = value["kind"];
  return {
    ...(typeof kind === "string" && { kind }),
    joints: parsed,
    feet: parsedFeet,
  };
}

const GAIT_NUMBERS = [
  "dutyFactor",
  "strideBodyLengths",
  "stepHeightBodyLengths",
  "backArchDeg",
  "hipHeightRatio",
  "headPitchDeg",
  "tailPitchDeg",
  "tailSwayDeg",
  "speedBodyLengthsPerSecond",
] as const;

/** Validates one gait profile against a template; throws an InputError naming what is wrong. */
export function parseGait(value: unknown, template: SkeletonTemplate, where: string): GaitProfile {
  if (!isObject(value)) throw new InputError(`${where} must be an object`);
  for (const key of GAIT_NUMBERS) {
    if (!finite(value[key])) throw new InputError(`${where}.${key} must be a number`);
  }
  const g = value as unknown as GaitProfile;
  if (!(g.dutyFactor > 0 && g.dutyFactor < 1)) {
    throw new InputError(`${where}.dutyFactor must be between 0 and 1`);
  }
  for (const key of ["strideBodyLengths", "speedBodyLengthsPerSecond", "hipHeightRatio"] as const) {
    if (!(g[key] > 0)) throw new InputError(`${where}.${key} must be positive`);
  }
  if (g.stepHeightBodyLengths < 0) {
    throw new InputError(`${where}.stepHeightBodyLengths must be at least 0`);
  }
  const feet = new Set(template.feet.map((f) => f.name));
  if (
    !Array.isArray(g.footfall) ||
    g.footfall.length !== feet.size ||
    new Set(g.footfall).size !== feet.size ||
    !g.footfall.every((f) => feet.has(f))
  ) {
    throw new InputError(
      `${where}.footfall must list every template foot once (${[...feet].join(", ")})`,
    );
  }
  if (g.swingCurlDeg !== undefined) {
    if (
      !isObject(g.swingCurlDeg) ||
      ![g.swingCurlDeg.fore, g.swingCurlDeg.hind].every((v) => v === undefined || finite(v))
    ) {
      throw new InputError(`${where}.swingCurlDeg must be { fore, hind } in degrees`);
    }
  }
  if (g.hipSwayDeg !== undefined && !finite(g.hipSwayDeg)) {
    throw new InputError(`${where}.hipSwayDeg must be a number`);
  }
  if (g.reference !== undefined && typeof g.reference !== "string") {
    throw new InputError(`${where}.reference must be a directory path`);
  }
  if (g.loop !== undefined && typeof g.loop !== "boolean") {
    throw new InputError(`${where}.loop must be true or false`);
  }
  return structuredClone(g);
}

const POSE_KEYS = [
  "body",
  "backArchDeg",
  "headPitchDeg",
  "headYawDeg",
  "tailPitchDeg",
  "tailYawDeg",
  "joints",
  "feet",
] as const;
const BODY_KEYS = [
  "raiseBodyLengths",
  "forwardBodyLengths",
  "sideBodyLengths",
  "pitchDeg",
  "yawDeg",
  "rollDeg",
] as const;
const FOOT_KEYS = ["liftBodyLengths", "forwardBodyLengths", "sideBodyLengths", "curlDeg"] as const;

/** Checks an object holds only the given keys, each a finite number. */
function numbers(value: unknown, keys: readonly string[], where: string): void {
  if (!isObject(value)) throw new InputError(`${where} must be an object`);
  for (const [key, v] of Object.entries(value)) {
    if (!keys.includes(key)) {
      throw new InputError(`${where} has an unknown key "${key}" (${keys.join(", ")})`);
    }
    if (!finite(v)) throw new InputError(`${where}.${key} must be a number`);
  }
}

function parsePose(value: unknown, template: SkeletonTemplate, where: string): void {
  if (!isObject(value)) throw new InputError(`${where} must be an object`);
  for (const [key, v] of Object.entries(value)) {
    if (!(POSE_KEYS as readonly string[]).includes(key)) {
      throw new InputError(`${where} has an unknown key "${key}" (${POSE_KEYS.join(", ")})`);
    }
    if (key === "body") numbers(v, BODY_KEYS, `${where}.body`);
    else if (key === "joints") {
      if (!isObject(v)) throw new InputError(`${where}.joints must map joint names to rotations`);
      // A leg's upper, lower and ankle joints are posed by the feet, through inverse kinematics.
      const solved = new Set(template.feet.flatMap((f) => f.joints.slice(0, 3)));
      for (const [name, rotation] of Object.entries(v)) {
        if (!template.joints.some((j) => j.name === name)) {
          throw new InputError(`${where}.joints names "${name}", which the template has not`);
        }
        if (solved.has(name)) {
          throw new InputError(
            `${where}.joints names "${name}", a leg joint the feet pose: move its foot under feet`,
          );
        }
        numbers(rotation, ["x", "y", "z"], `${where}.joints.${name}`);
      }
    } else if (key === "feet") {
      if (!isObject(v)) throw new InputError(`${where}.feet must map foot names to places`);
      for (const [name, foot] of Object.entries(v)) {
        if (!template.feet.some((f) => f.name === name)) {
          throw new InputError(`${where}.feet names "${name}", which the template has not`);
        }
        numbers(foot, FOOT_KEYS, `${where}.feet.${name}`);
        const lift = (foot as MotionFoot).liftBodyLengths;
        if (lift !== undefined && lift < 0) {
          throw new InputError(`${where}.feet.${name}.liftBodyLengths must be at least 0`);
        }
      }
    } else if (!finite(v)) throw new InputError(`${where}.${key} must be a number`);
  }
}

const MOTION_KEYS = ["loop", "durationS", "keys", "idle", "entryS", "exitS"];

/**
 * Validates one motion against a template; throws an InputError naming what is wrong. The `idle`
 * a one-shot names is checked against the other motions by `loadRig`.
 */
export function parseMotion(
  value: unknown,
  template: SkeletonTemplate,
  where: string,
): MotionProfile {
  if (!isObject(value)) throw new InputError(`${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!MOTION_KEYS.includes(key)) {
      throw new InputError(`${where} has an unknown key "${key}" (${MOTION_KEYS.join(", ")})`);
    }
  }
  const m = value as unknown as MotionProfile;
  if (typeof m.loop !== "boolean") {
    throw new InputError(`${where}.loop must be true (an idle) or false (a one-shot)`);
  }
  if (!finite(m.durationS) || m.durationS <= 0) {
    throw new InputError(`${where}.durationS must be a positive number of seconds`);
  }
  if (!Array.isArray(m.keys) || m.keys.length === 0) {
    throw new InputError(`${where}.keys must list at least one key pose`);
  }
  let previous = -Infinity;
  m.keys.forEach((key, i) => {
    const at = `${where}.keys[${i}]`;
    if (!isObject(key)) throw new InputError(`${at} must be { at, pose }`);
    for (const k of Object.keys(key)) {
      if (k !== "at" && k !== "pose") throw new InputError(`${at} has an unknown key "${k}"`);
    }
    if (!finite(key.at) || key.at < 0 || key.at > 1) {
      throw new InputError(`${at}.at must be a fraction of durationS, from 0 to 1`);
    }
    if (i === 0 && key.at !== 0) throw new InputError(`${where}.keys must start at 0`);
    if (key.at <= previous) throw new InputError(`${where}.keys must be in ascending order of at`);
    previous = key.at;
    parsePose(key.pose ?? {}, template, `${at}.pose`);
  });
  if (m.loop) {
    for (const key of ["idle", "entryS", "exitS"] as const) {
      if (m[key] !== undefined) {
        throw new InputError(`${where}.${key} is for one-shots; a looping motion has none`);
      }
    }
  } else {
    if (m.idle !== undefined && typeof m.idle !== "string") {
      throw new InputError(`${where}.idle must name a looping motion`);
    }
    for (const key of ["entryS", "exitS"] as const) {
      if (m[key] !== undefined && (!finite(m[key]) || m[key] < 0)) {
        throw new InputError(`${where}.${key} must be at least 0 seconds`);
      }
    }
  }
  return structuredClone(m);
}

/** Whether the profile declares a rig template (and so generated gaits). */
export function declaresRig(profile: TargetProfile): boolean {
  return profile.model3d?.rig !== undefined;
}

/** Checks the profile's `model3d.rig` and `model3d.gaits` shape without reading files. */
export function rigProfileOf(profile: TargetProfile): RigProfile {
  const rig = profile.model3d?.rig as unknown;
  if (!isObject(rig)) throw new InputError("model3d.rig must be { template, kind }");
  if (typeof rig["template"] !== "string" || rig["template"].length === 0) {
    throw new InputError("model3d.rig.template must be a path to a skeleton template file");
  }
  if (typeof rig["kind"] !== "string" || rig["kind"].length === 0) {
    throw new InputError("model3d.rig.kind must name the kind of character it serves");
  }
  const qa = rig["qa"];
  if (qa !== undefined) {
    if (!isObject(qa)) throw new InputError("model3d.rig.qa must be an object");
    for (const [key, v] of Object.entries(qa)) {
      if (!(key in DEFAULT_RIG_QA))
        throw new InputError(`model3d.rig.qa has an unknown key ${key}`);
      if (!finite(v) || v <= 0) throw new InputError(`model3d.rig.qa.${key} must be positive`);
    }
  }
  const gaits = profile.model3d?.gaits as unknown;
  if (gaits !== undefined && !isObject(gaits)) {
    throw new InputError("model3d.gaits must map clip families to gait profiles");
  }
  const motions = profile.model3d?.motions as unknown;
  if (motions !== undefined && !isObject(motions)) {
    throw new InputError("model3d.motions must map clip families to motions");
  }
  return rig as unknown as RigProfile;
}

/**
 * Loads the profile's rig: the template file (relative to `baseDir`, the profile's directory) and
 * every gait profile, validated against it. Throws an InputError before any spend.
 */
export async function loadRig(profile: TargetProfile, baseDir: string): Promise<LoadedRig> {
  const rig = rigProfileOf(profile);
  const path = resolve(baseDir, rig.template);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch {
    throw new InputError(`the rig template ${rig.template} cannot be read (from ${baseDir})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new InputError(`the rig template ${rig.template} is not JSON`);
  }
  const template = parseTemplate(json, `the rig template ${rig.template}`);
  const gaits: Record<string, GaitProfile> = {};
  const gaitSha256: Record<string, string> = {};
  for (const [family, value] of Object.entries(
    (profile.model3d?.gaits ?? {}) as Record<string, unknown>,
  )) {
    if (!/^[a-z][a-z0-9-]*$/.test(family)) {
      throw new InputError(`model3d.gaits has an invalid family name "${family}"`);
    }
    gaits[family] = parseGait(value, template, `model3d.gaits.${family}`);
    gaitSha256[family] = sha256(Buffer.from(canonicalJson(value)));
  }
  const motions: Record<string, MotionProfile> = {};
  const motionSha256: Record<string, string> = {};
  for (const [family, value] of Object.entries(
    (profile.model3d?.motions ?? {}) as Record<string, unknown>,
  )) {
    if (!/^[a-z][a-z0-9-]*$/.test(family)) {
      throw new InputError(`model3d.motions has an invalid family name "${family}"`);
    }
    if (gaits[family]) {
      throw new InputError(
        `"${family}" is declared as both a gait (model3d.gaits) and a motion (model3d.motions)`,
      );
    }
    motions[family] = parseMotion(value, template, `model3d.motions.${family}`);
    motionSha256[family] = sha256(Buffer.from(canonicalJson(value)));
  }
  for (const [family, motion] of Object.entries(motions)) {
    if (motion.idle !== undefined && motions[motion.idle]?.loop !== true) {
      throw new InputError(
        `model3d.motions.${family}.idle names "${motion.idle}", which is not a looping motion in model3d.motions`,
      );
    }
  }
  return {
    templatePath: rig.template,
    kind: rig.kind,
    template,
    templateSha256: sha256(bytes),
    gaits,
    gaitSha256,
    motions,
    motionSha256,
    qa: { ...DEFAULT_RIG_QA, ...rig.qa },
    baseDir,
  };
}

/** JSON with object keys sorted, so a hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
