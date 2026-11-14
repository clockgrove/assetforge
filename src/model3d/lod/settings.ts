/**
 * The detail-level chain, texture tiers and packaging a target profile declares for a 3D model
 * (assetgrove#136; docs/characters-3d.md).
 */
import { InputError } from "../../errors.ts";
import type { TargetProfile } from "../../types.ts";
import { handoffSettings, LOD_PACKAGINGS } from "../handoff.ts";
import type { LodPackaging } from "../handoff.ts";
import { BUDGET_KEYS } from "../profile.ts";
import type { BudgetKey } from "../profile.ts";

export { LOD_PACKAGINGS };
export type { LodPackaging };

export interface LodLevel {
  level: number;
  triangleRatio: number;
  minScreenHeight: number;
}

export interface TierBudget {
  name: string;
  triangles?: number;
  textureMaxPx?: number;
  materials?: number;
  bones?: number;
  lods?: number;
  /** false: the tier draws no fur, so look-dev's external side maps are dropped from it. */
  fur: boolean;
}

export interface ResolvedLods {
  levels: LodLevel[];
  tiers: TierBudget[];
  packaging: LodPackaging;
  silhouette: number;
}

export const DEFAULT_SILHOUETTE_TOLERANCE = 0.06;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** Whether the profile declares a chain (model3d.lods is present). */
export function declaresLods(profile: TargetProfile): boolean {
  return profile.model3d?.lods !== undefined;
}

function levelsOf(raw: unknown): LodLevel[] {
  if (raw === undefined) {
    throw new InputError("the target profile declares no detail levels (model3d.lods)");
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new InputError("model3d.lods must be a non-empty list of detail levels");
  }
  const levels: LodLevel[] = [];
  raw.forEach((entry: unknown, i) => {
    const at = `model3d.lods[${i}]`;
    if (!isObject(entry)) throw new InputError(`${at} must be an object`);
    const { level, triangleRatio, minScreenHeight } = entry;
    if (level !== i) throw new InputError(`${at}.level must be ${i}`);
    if (
      typeof triangleRatio !== "number" ||
      !Number.isFinite(triangleRatio) ||
      triangleRatio <= 0 ||
      triangleRatio > 1
    ) {
      throw new InputError(`${at}.triangleRatio must be a number above 0 and at most 1`);
    }
    if (i === 0 && triangleRatio !== 1) {
      throw new InputError(`${at}.triangleRatio must be 1: level 0 is the full model`);
    }
    if (
      typeof minScreenHeight !== "number" ||
      !Number.isFinite(minScreenHeight) ||
      minScreenHeight < 0
    ) {
      throw new InputError(`${at}.minScreenHeight must be a number of at least 0`);
    }
    const before = levels[i - 1];
    if (before && triangleRatio >= before.triangleRatio) {
      throw new InputError(`${at}.triangleRatio must be below level ${i - 1}'s`);
    }
    if (before && minScreenHeight > before.minScreenHeight) {
      throw new InputError(`${at}.minScreenHeight must not exceed level ${i - 1}'s`);
    }
    levels.push({ level: i, triangleRatio, minScreenHeight });
  });
  return levels;
}

function tierOf(name: string, tier: unknown, tierClass: string | undefined): TierBudget {
  const at = `model3d.tiers.${name}`;
  if (!isObject(tier)) throw new InputError(`${at} must be an object`);
  let source: Obj = tier;
  let where = at;
  if (!BUDGET_KEYS.some((k) => k in tier)) {
    const classes = Object.keys(tier).filter((k) => isObject(tier[k]));
    const entry = tierClass === undefined ? undefined : tier[tierClass];
    if (!isObject(entry)) {
      throw new InputError(
        `${at} declares its limits per class (${classes.join(", ") || "none"}); ` +
          `the spec must set tierClass to one of them` +
          (tierClass === undefined ? "" : `: "${tierClass}" is not declared`),
      );
    }
    source = entry;
    where = `${at}.${tierClass}`;
  }
  const out: TierBudget = { name, fur: true };
  for (const key of BUDGET_KEYS as readonly BudgetKey[]) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new InputError(`${where}.${key} must be a whole number of at least 0`);
    }
    out[key] = value;
  }
  if (source["fur"] !== undefined) {
    if (typeof source["fur"] !== "boolean")
      throw new InputError(`${where}.fur must be true or false`);
    out.fur = source["fur"];
  }
  return out;
}

function tiersOf(raw: unknown, tierClass: string | undefined): TierBudget[] {
  if (raw === undefined) return [];
  if (!isObject(raw)) throw new InputError("model3d.tiers must be an object");
  return Object.entries(raw).map(([name, tier]) => tierOf(name, tier, tierClass));
}

function silhouetteOf(raw: unknown): number {
  if (raw === undefined) return DEFAULT_SILHOUETTE_TOLERANCE;
  if (!isObject(raw)) throw new InputError("model3d.lodQa must be an object");
  const { silhouette = DEFAULT_SILHOUETTE_TOLERANCE, ...rest } = raw;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) {
    throw new InputError(`model3d.lodQa has unknown field(s): ${unknown.join(", ")}`);
  }
  if (
    typeof silhouette !== "number" ||
    !Number.isFinite(silhouette) ||
    silhouette <= 0 ||
    silhouette > 1
  ) {
    throw new InputError("model3d.lodQa.silhouette must be a number above 0 and at most 1");
  }
  return silhouette;
}

/** The chain, tiers and packaging; throws an InputError naming what is wrong. `tierClass` is the spec's class for class-nested tiers. */
export function lodSettings(profile: TargetProfile, tierClass?: string): ResolvedLods {
  const section = profile.model3d;
  return {
    levels: levelsOf(section?.lods),
    tiers: tiersOf(section?.tiers, tierClass),
    packaging: handoffSettings(profile).lods ?? "embedded",
    silhouette: silhouetteOf(section?.lodQa),
  };
}
