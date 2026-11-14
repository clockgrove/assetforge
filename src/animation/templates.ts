/**
 * Motion templates: per family, the beats, timing, contact frames and silhouette variation a
 * strip is checked against. The built-in ones are plain data in the same shape a target profile
 * uses under `animation.templates`, so a target adds its own (sleep, groom, climb, converse) or
 * overrides one without an Assetgrove change.
 */
import { InputError } from "../errors.ts";
import type { TargetProfile } from "../types.ts";
import type { AnimationThresholds, GaitRule, MotionTemplate } from "./types.ts";

export const DEFAULT_THRESHOLDS: AnimationThresholds = {
  groundTolerancePx: 1,
  anchorDriftPx: 1,
  footprintDriftPx: 2,
  loopSeamRatio: 1.5,
  loopSeamFloor: 0.02,
  flickerCutoff: 0.7,
  edgeHaloShare: 0.22,
  holeMinPx: 3,
  holeCutoff: 0.7,
};

export const BUILTIN_TEMPLATES: readonly MotionTemplate[] = [
  {
    name: "idle",
    description: "standing in place, breathing; barely moves",
    loop: true,
    frames: { min: 2, max: 12 },
    beats: [
      { name: "rest", at: 0, contact: true },
      { name: "breathe-in", at: 0.5, contact: true },
    ],
    contact: "all",
    silhouette: { min: 0, max: 0.15 },
  },
  {
    name: "walk",
    description: "a walk cycle: two contacts and two passing poses, feet on the ground line",
    loop: true,
    frames: { min: 4, max: 16 },
    cycleMs: { min: 400, max: 2000 },
    beats: [
      { name: "contact-a", at: 0, contact: true },
      { name: "passing-a", at: 0.25, contact: true },
      { name: "contact-b", at: 0.5, contact: true },
      { name: "passing-b", at: 0.75, contact: true },
    ],
    contact: "all",
    silhouette: { min: 0.01, max: 0.4 },
    footprint: "moving",
    strides: 2,
    footprintDriftPx: 6,
    gaits: {
      // Four legs: the contact pattern runs once per cycle and two or three feet are down at
      // once, so the footprint is every foot near the ground (the bottom 30% of the figure), held
      // to the loop's mean.
      quadruped: { strides: 1, footprintBand: 0.3, footprintDriftPx: 12 },
    },
  },
  {
    name: "sniff",
    description: "head down to the ground and back, body planted",
    loop: true,
    frames: { min: 2, max: 12 },
    beats: [
      { name: "neutral", at: 0, contact: true },
      { name: "nose-down", at: 0.5, contact: true },
    ],
    contact: "all",
    silhouette: { min: 0, max: 0.25 },
  },
  {
    name: "eat",
    description: "reach, bite and chew, body planted",
    loop: true,
    frames: { min: 2, max: 12 },
    beats: [
      { name: "reach", at: 0, contact: true },
      { name: "bite", at: 0.34, contact: true },
      { name: "chew", at: 0.67, contact: true },
    ],
    contact: "all",
    silhouette: { min: 0, max: 0.3 },
  },
  {
    name: "play",
    description: "crouch, pounce or hop, land; the feet leave the ground between contacts",
    loop: true,
    frames: { min: 3, max: 16 },
    beats: [
      { name: "crouch", at: 0, contact: true },
      { name: "airborne", at: 0.4 },
      { name: "land", at: 0.8, contact: true },
    ],
    contact: "beats",
    silhouette: { min: 0.01, max: 0.5 },
    footprint: "moving",
    footprintDriftPx: 8,
  },
  {
    name: "shelter",
    description: "huddled in cover, a small tremble",
    loop: true,
    frames: { min: 2, max: 12 },
    beats: [
      { name: "huddle", at: 0, contact: true },
      { name: "tremble", at: 0.5, contact: true },
    ],
    contact: "all",
    silhouette: { min: 0, max: 0.15 },
  },
];

function fail(where: string, message: string): never {
  throw new InputError(`motion template ${where}: ${message}`);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function range(v: unknown, where: string, field: string, lo: number, hi: number) {
  if (!isRecord(v)) fail(where, `${field} must be an object { min, max }`);
  const { min, max } = v;
  if (typeof min !== "number" || typeof max !== "number" || !(min >= lo) || !(max <= hi)) {
    fail(where, `${field} needs numbers min and max within ${lo}..${hi}`);
  }
  if (min > max) fail(where, `${field}.min is above ${field}.max`);
  return { min, max };
}

/** Validates one template given as data; throws InputError naming the field. */
export function parseTemplate(value: unknown, index = 0): MotionTemplate {
  if (!isRecord(value)) fail(`#${index + 1}`, "must be an object");
  const name = value["name"];
  if (typeof name !== "string" || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(name)) {
    fail(
      `#${index + 1}`,
      "name must be lowercase words joined by '-' or '_' (it also matches name-<suffix>)",
    );
  }
  const where = `"${name}"`;
  if (typeof value["loop"] !== "boolean") fail(where, "loop must be true or false");
  const frames = range(value["frames"], where, "frames", 1, 1024);
  if (!Number.isInteger(frames.min) || !Number.isInteger(frames.max)) {
    fail(where, "frames.min and frames.max must be integers");
  }
  const cycleMs =
    value["cycleMs"] === undefined
      ? undefined
      : range(value["cycleMs"], where, "cycleMs", 0, Number.MAX_SAFE_INTEGER);
  const beatsRaw = value["beats"];
  if (!Array.isArray(beatsRaw)) fail(where, "beats must be an array");
  const beats = beatsRaw.map((b: unknown, i) => {
    if (!isRecord(b) || typeof b["name"] !== "string" || b["name"] === "") {
      fail(where, `beats[${i}] needs a name`);
    }
    const at = b["at"];
    if (typeof at !== "number" || !(at >= 0 && at < 1))
      fail(where, `beats[${i}].at must be in 0..1`);
    if (b["contact"] !== undefined && typeof b["contact"] !== "boolean") {
      fail(where, `beats[${i}].contact must be true or false`);
    }
    return {
      name: b["name"] as string,
      at,
      ...(b["contact"] !== undefined && { contact: b["contact"] as boolean }),
    };
  });
  const contact = value["contact"];
  if (contact !== "all" && contact !== "beats" && contact !== "none") {
    fail(where, 'contact must be "all", "beats" or "none"');
  }
  const silhouette = range(value["silhouette"], where, "silhouette", 0, 1);
  const rule = gaitRule(value, where, "");
  const gaitsRaw = value["gaits"];
  let gaits: Record<string, GaitRule> | undefined;
  if (gaitsRaw !== undefined) {
    if (!isRecord(gaitsRaw)) fail(where, "gaits must be an object of gait name → footprint rule");
    gaits = {};
    for (const [gait, r] of Object.entries(gaitsRaw)) {
      if (!GAIT_NAME.test(gait)) fail(where, `gaits.${gait}: ${GAIT_NAME_RULE}`);
      if (!isRecord(r)) fail(where, `gaits.${gait} must be an object`);
      const unknown = Object.keys(r).filter((k) => !GAIT_FIELDS.includes(k));
      if (unknown.length > 0) {
        fail(
          where,
          `gaits.${gait} may only set ${GAIT_FIELDS.join(", ")} (not ${unknown.join(", ")})`,
        );
      }
      gaits[gait] = gaitRule(r, where, `gaits.${gait}.`);
    }
  }
  const description = value["description"];
  if (description !== undefined && typeof description !== "string") {
    fail(where, "description must be text");
  }
  return {
    name,
    ...(description !== undefined && { description }),
    loop: value["loop"],
    frames,
    ...(cycleMs !== undefined && { cycleMs }),
    beats,
    contact,
    silhouette,
    ...rule,
    ...(gaits !== undefined && { gaits }),
  };
}

const GAIT_NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const GAIT_NAME_RULE = "a gait name is lowercase words joined by '-' or '_', for example quadruped";
const GAIT_FIELDS = ["footprint", "strides", "footprintDriftPx", "footprintBand"];

/** The footprint fields of a template or of one of its gait rules, validated. */
function gaitRule(value: Record<string, unknown>, where: string, prefix: string): GaitRule {
  const footprint = value["footprint"];
  if (footprint !== undefined && footprint !== "planted" && footprint !== "moving") {
    fail(where, `${prefix}footprint must be "planted" or "moving"`);
  }
  const drift = value["footprintDriftPx"];
  if (drift !== undefined && (typeof drift !== "number" || !(drift >= 0))) {
    fail(where, `${prefix}footprintDriftPx must be a number of px, 0 or more`);
  }
  const strides = value["strides"];
  if (strides !== undefined && (!Number.isInteger(strides) || !((strides as number) >= 1))) {
    fail(where, `${prefix}strides must be a whole number, 1 or more`);
  }
  const band = value["footprintBand"];
  if (band !== undefined && (typeof band !== "number" || !(band > 0 && band <= 1))) {
    fail(
      where,
      `${prefix}footprintBand must be a fraction of the figure's height, above 0 and at most 1`,
    );
  }
  return {
    ...(footprint !== undefined && { footprint }),
    ...(strides !== undefined && { strides: strides as number }),
    ...(drift !== undefined && { footprintDriftPx: drift }),
    ...(band !== undefined && { footprintBand: band }),
  };
}

/**
 * The gait animation QA uses: the asset spec's, else the profile's `animation.gait`. Undefined
 * when neither declares one; Assetgrove never guesses a gait.
 */
export function gaitFor(
  profile?: Pick<TargetProfile, "animation">,
  specGait?: string,
): string | undefined {
  const gait = specGait ?? profile?.animation?.gait;
  if (gait === undefined) return undefined;
  if (typeof gait !== "string" || !GAIT_NAME.test(gait)) {
    throw new InputError(`invalid gait ${JSON.stringify(gait)}: ${GAIT_NAME_RULE}`);
  }
  return gait;
}

/**
 * The template as the gait sees it: the gait's rule under `gaits` over the template's own
 * footprint fields. `applied` says whether the template had a rule for the gait.
 */
export function withGait(
  template: MotionTemplate,
  gait: string | undefined,
): { template: MotionTemplate; applied: boolean } {
  const rule = gait === undefined ? undefined : template.gaits?.[gait];
  if (!rule) return { template, applied: false };
  return { template: { ...template, ...rule }, applied: true };
}

/** The built-in templates with the profile's added or overriding ones, by name. */
export function templatesFor(profile?: Pick<TargetProfile, "animation">): MotionTemplate[] {
  const byName = new Map(BUILTIN_TEMPLATES.map((t) => [t.name, t]));
  const own = profile?.animation?.templates;
  if (own !== undefined) {
    if (!Array.isArray(own)) throw new InputError("animation.templates must be an array");
    own.forEach((t, i) => {
      const parsed = parseTemplate(t, i);
      byName.set(parsed.name, parsed);
    });
  }
  return [...byName.values()];
}

/**
 * The template for a family: an exact name match, else the longest template name that prefixes
 * the family before a "-" (walk-right and walk-left → walk). Undefined when none matches.
 */
export function templateFor(
  family: string,
  templates: readonly MotionTemplate[],
): MotionTemplate | undefined {
  const exact = templates.find((t) => t.name === family);
  if (exact) return exact;
  return templates
    .filter((t) => family.startsWith(`${t.name}-`))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

/** The defaults with the profile's thresholds over them, validated. */
export function thresholdsFor(profile?: Pick<TargetProfile, "animation">): AnimationThresholds {
  const own = profile?.animation?.thresholds ?? {};
  if (!isRecord(own)) throw new InputError("animation.thresholds must be an object");
  const merged = { ...DEFAULT_THRESHOLDS };
  for (const [key, value] of Object.entries(own)) {
    if (!(key in DEFAULT_THRESHOLDS)) {
      throw new InputError(
        `unknown animation threshold "${key}" (known: ${Object.keys(DEFAULT_THRESHOLDS).join(", ")})`,
      );
    }
    if (typeof value !== "number" || !(value >= 0)) {
      throw new InputError(`animation threshold ${key} must be a number, 0 or more`);
    }
    if ((key === "flickerCutoff" || key === "holeCutoff" || key === "edgeHaloShare") && value > 1) {
      throw new InputError(`animation threshold ${key} must be within 0..1`);
    }
    merged[key as keyof AnimationThresholds] = value;
  }
  return merged;
}
