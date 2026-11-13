/**
 * The target profile's look-dev fields: `model3d.groom` (the contract shared with
 * clockgrove/raccoon-world#39 and Clockgrove's fur material) and `model3d.lookdev`
 * (added by assetforge#82). See docs/look-dev.md.
 */
import { InputError } from "../../errors.ts";
import type { TargetProfile } from "../../types.ts";

export const DEFAULT_GROOM_MAPS = ["length", "direction", "density"] as const;
export type GroomMapName = (typeof DEFAULT_GROOM_MAPS)[number];

export interface GroomProfile {
  /** The maps the target's fur material reads; every one Assetforge knows by default. */
  maps?: string[];
  /** Edge of each map in pixels; the base colour's edge by default. */
  sizePx?: number;
  /** One groom per season; one groom with no seasons when absent. */
  seasons?: string[];
  /** Each season's look in words: the target's, read as given. */
  traits?: Record<string, string>;
  /** Which coat each month wears: the target's, carried but not read by Assetforge. */
  calendar?: unknown;
}

export interface LookdevProfile {
  /** The look-dev cap in USD for one character; $3 by default. */
  capUsd?: number;
  /** The target's closest zoom on desktop, for the close-up check render. */
  closestZoom?: { screenHeightPx?: number; characterScreenFraction?: number };
}

export interface LookdevSettings {
  maps: GroomMapName[];
  sizePx?: number;
  /** `undefined` (one groom, maps keyed by name) or the declared seasons. */
  seasons: string[] | undefined;
  traits: Record<string, string>;
  capUsd: number;
  closestZoom: { screenHeightPx: number; characterScreenFraction: number };
}

export const DEFAULT_LOOKDEV_CAP_USD = 3;
/** Kirk, 2026-11-10: zoom from the whole yard down to the character at about a third of the screen height; desktop first. */
export const DEFAULT_CLOSEST_ZOOM = { screenHeightPx: 1440, characterScreenFraction: 1 / 3 };

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** The look-dev settings with defaults; throws an InputError naming what is wrong. */
export function lookdevSettings(profile: TargetProfile): LookdevSettings {
  const groom = (profile.model3d?.groom ?? {}) as GroomProfile;
  const lookdev = (profile.model3d?.lookdev ?? {}) as LookdevProfile;
  const where = "the target profile's model3d.groom";
  if (typeof groom !== "object" || groom === null || Array.isArray(groom)) {
    throw new InputError(`${where} must be an object`);
  }
  const maps = groom.maps ?? [...DEFAULT_GROOM_MAPS];
  if (!Array.isArray(maps) || maps.length === 0) {
    throw new InputError(`${where}.maps must be a non-empty list`);
  }
  for (const map of maps) {
    if (!(DEFAULT_GROOM_MAPS as readonly string[]).includes(map)) {
      throw new InputError(
        `${where}.maps names "${String(map)}"; Assetforge writes ${DEFAULT_GROOM_MAPS.join(", ")}`,
      );
    }
  }
  if (groom.sizePx !== undefined && !(positive(groom.sizePx) && Number.isInteger(groom.sizePx))) {
    throw new InputError(`${where}.sizePx must be a positive whole number of pixels`);
  }
  let seasons: string[] | undefined;
  if (groom.seasons !== undefined) {
    const valid =
      Array.isArray(groom.seasons) &&
      groom.seasons.length > 0 &&
      groom.seasons.every((s) => typeof s === "string" && /^[a-z0-9][a-z0-9-]*$/i.test(s)) &&
      new Set(groom.seasons).size === groom.seasons.length;
    if (!valid) {
      throw new InputError(
        `${where}.seasons must be a list of distinct names (letters, digits, -)`,
      );
    }
    seasons = [...groom.seasons];
  }
  const traits: Record<string, string> = {};
  if (groom.traits !== undefined) {
    if (typeof groom.traits !== "object" || groom.traits === null) {
      throw new InputError(`${where}.traits must map a season to its look in words`);
    }
    for (const [season, text] of Object.entries(groom.traits)) {
      if (typeof text !== "string") {
        throw new InputError(`${where}.traits.${season} must be text`);
      }
      traits[season] = text;
    }
  }
  const capUsd = lookdev.capUsd ?? DEFAULT_LOOKDEV_CAP_USD;
  if (!(typeof capUsd === "number" && capUsd >= 0)) {
    throw new InputError("the target profile's model3d.lookdev.capUsd must be a USD amount");
  }
  const zoom = { ...DEFAULT_CLOSEST_ZOOM, ...(lookdev.closestZoom ?? {}) };
  if (!positive(zoom.screenHeightPx) || !positive(zoom.characterScreenFraction)) {
    throw new InputError(
      "the target profile's model3d.lookdev.closestZoom needs positive screenHeightPx and characterScreenFraction",
    );
  }
  return {
    maps: maps as GroomMapName[],
    ...(groom.sizePx !== undefined && { sizePx: groom.sizePx }),
    seasons,
    traits,
    capUsd,
    closestZoom: zoom,
  };
}
