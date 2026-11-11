/**
 * The shared-rig contract (assetforge#84, shared with clockgrove/raccoon-world#39): the profile's
 * `model3d.rig` and `model3d.gaits`, and the skeleton template file a rig names. Everything here is
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
  return {
    templatePath: rig.template,
    kind: rig.kind,
    template,
    templateSha256: sha256(bytes),
    gaits,
    gaitSha256,
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
