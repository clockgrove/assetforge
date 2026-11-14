/**
 * The target profile's `model3d` section and the 3D character spec fields (the contract shared
 * with clockgrove/raccoon-world#39; see docs/characters-3d.md).
 */
import { InputError } from "../errors.ts";
import type { AssetSpec, TargetProfile } from "../types.ts";
import { handoffSettings } from "./handoff.ts";
import { AXES } from "./scene.ts";
import type { Axis } from "./scene.ts";

export const CHARACTER_3D_KIND = "character-3d";
export const GAITS = ["quadruped", "biped"] as const;
export type Gait = (typeof GAITS)[number];

export const BUDGET_KEYS = ["triangles", "textureMaxPx", "materials", "bones", "lods"] as const;
export type BudgetKey = (typeof BUDGET_KEYS)[number];

export const DEFAULT_TURNTABLE_PX = 512;
export const DEFAULT_LOOP_TOLERANCE = { rotationDeg: 2, translationFraction: 0.01 };
/** Clip frames rendered per clip, from the three-quarter view. */
export const FRAMES_PER_CLIP = 4;

export interface Model3dProfile {
  format: "glb";
  budgets: Record<BudgetKey, number>;
  /** The axis the character faces in the target; `+z` by default. */
  forward?: Axis;
  units: "m";
  turntable?: { sizePx?: number };
  /**
   * How close a looping clip's last pose must be to its first: the largest joint rotation in
   * degrees, and the largest joint translation as a fraction of the model's height.
   */
  loopTolerance?: { rotationDeg?: number; translationFraction?: number };
  /**
   * A skeleton template for this kind of character (assetgrove#84). When set, Assetgrove fits the
   * template and generates the clips that `gaits` declares instead of the provider's auto-rig and
   * clip library.
   */
  rig?: import("./rig/template.ts").RigProfile;
  /** Gait profiles per clip family, for example `walk` (assetgrove#84). */
  gaits?: Record<string, import("./rig/template.ts").GaitProfile>;
  /** Clip families besides locomotion: idles, gestures and interactions (assetgrove#135). */
  motions?: Record<string, import("./rig/template.ts").MotionProfile>;
  /** Fur groom maps per season (assetgrove#82; docs/look-dev.md). */
  groom?: import("./lookdev/settings.ts").GroomProfile;
  /** Look-dev settings (assetgrove#82; docs/look-dev.md). */
  lookdev?: import("./lookdev/settings.ts").LookdevProfile;
  /** How the hand-off carries clips and side images (assetgrove#137; docs/characters-3d.md). */
  handoff?: import("./handoff.ts").Model3dHandoffProfile;
  /** The detail-level chain, level 0 first (assetgrove#136). `budgets.lods` stays the count. */
  lods?: Array<{ level: number; triangleRatio: number; minScreenHeight: number }>;
  /** Texture and budget tiers, flat or nested by tier class (assetgrove#136). */
  tiers?: Record<string, unknown>;
  /** Detail-level QA tolerances (assetgrove#136). */
  lodQa?: { silhouette?: number };
}

export interface ResolvedModel3d {
  budgets: Record<BudgetKey, number>;
  forward: Axis;
  turntablePx: number;
  loopTolerance: { rotationDeg: number; translationFraction: number };
}

const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** The profile's `model3d` section with defaults; throws an InputError naming what is wrong. */
export function model3dSettings(profile: TargetProfile): ResolvedModel3d {
  const section = profile.model3d;
  if (section === undefined || section === null || typeof section !== "object") {
    throw new InputError(
      `the target profile "${profile.name}" does not declare 3D characters (no model3d section)`,
    );
  }
  if (section.format !== "glb") throw new InputError(`model3d.format must be "glb"`);
  if (section.units !== "m") throw new InputError(`model3d.units must be "m"`);
  const budgets = section.budgets as Record<string, unknown> | undefined;
  if (!budgets || typeof budgets !== "object") throw new InputError("model3d.budgets is missing");
  for (const key of BUDGET_KEYS) {
    const value = budgets[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new InputError(`model3d.budgets.${key} must be a whole number of at least 0`);
    }
  }
  handoffSettings(profile);
  const forward = section.forward ?? "+z";
  if (!AXES.includes(forward)) {
    throw new InputError(`model3d.forward must be one of ${AXES.join(", ")}: ${String(forward)}`);
  }
  const sizePx = section.turntable?.sizePx ?? DEFAULT_TURNTABLE_PX;
  if (!Number.isInteger(sizePx) || sizePx < 32 || sizePx > 4096) {
    throw new InputError(`model3d.turntable.sizePx must be a whole number from 32 to 4096`);
  }
  const rotationDeg = section.loopTolerance?.rotationDeg ?? DEFAULT_LOOP_TOLERANCE.rotationDeg;
  const translationFraction =
    section.loopTolerance?.translationFraction ?? DEFAULT_LOOP_TOLERANCE.translationFraction;
  if (!positive(rotationDeg) || !positive(translationFraction)) {
    throw new InputError("model3d.loopTolerance values must be positive numbers");
  }
  return {
    budgets: Object.fromEntries(BUDGET_KEYS.map((k) => [k, budgets[k] as number])) as Record<
      BudgetKey,
      number
    >,
    forward,
    turntablePx: sizePx,
    loopTolerance: { rotationDeg, translationFraction },
  };
}

export interface CharacterSpec {
  gait: Gait;
  clips: string[];
  heightM?: number;
}

/** The spec's 3D character fields; throws an InputError naming what is wrong. */
export function characterSpec(spec: AssetSpec): CharacterSpec {
  if (!GAITS.includes(spec.gait as Gait)) {
    throw new InputError(`a ${CHARACTER_3D_KIND} spec needs gait ${GAITS.join(" or ")}`);
  }
  const clips = spec.clips ?? [];
  if (
    !Array.isArray(clips) ||
    clips.some((c) => typeof c !== "string" || !/^[a-z][a-z0-9-]*$/.test(c)) ||
    new Set(clips).size !== clips.length
  ) {
    throw new InputError(
      "clips must be a list of distinct family names (lower case, for example idle)",
    );
  }
  if (spec.heightM !== undefined && !positive(spec.heightM)) {
    throw new InputError("heightM must be a positive number of metres");
  }
  return {
    gait: spec.gait as Gait,
    clips,
    ...(spec.heightM !== undefined && { heightM: spec.heightM }),
  };
}
