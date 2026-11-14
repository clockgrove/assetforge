/**
 * The target-declared shape of a 3D hand-off (assetgrove#137; docs/characters-3d.md, "Hand-off
 * shape"): how `output.clips` reaches the manifest, and whether look-dev's side images are written
 * beside the `.glb` or embedded in it. Without a declaration both go as produced.
 */
import { InputError } from "../errors.ts";
import type { TargetWrite } from "../handoff.ts";
import type { TargetProfile } from "../types.ts";
import { GLB_MEDIA_TYPE, parseGlb, writeGlb } from "./glb.ts";
import type { Glb } from "./glb.ts";
import { appendBufferView } from "./lookdev/edit.ts";
import { boundsOf, clips, posedPrimitives } from "./scene.ts";

export const SIDE_IMAGE_MODES = ["beside", "embedded"] as const;
export type SideImageMode = (typeof SIDE_IMAGE_MODES)[number];

export const LOD_PACKAGINGS = ["embedded", "files"] as const;
export type LodPackaging = (typeof LOD_PACKAGINGS)[number];

/** The profile's `model3d.handoff` section. */
export interface Model3dHandoffProfile {
  /**
   * The fields each manifest clip carries: manifest field name → Assetgrove's clip field. A clip
   * field not named is left out; a named field a clip lacks is left out of that clip.
   */
  clipFields?: Record<string, string>;
  /** `beside` (default): side images are files next to the `.glb`. `embedded`: inside it. */
  sideImages?: SideImageMode;
  /** `embedded` (default): the detail levels are in the `.glb`. `files`: one `.glb` per level (assetgrove#136). */
  lods?: LodPackaging;
}

export interface ResolvedHandoff {
  clipFields?: Record<string, string>;
  sideImages: SideImageMode;
  lods?: LodPackaging;
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The profile's `model3d.handoff` with defaults; throws an InputError naming what is wrong. */
export function handoffSettings(profile: TargetProfile): ResolvedHandoff {
  const section: unknown = profile.model3d?.handoff;
  if (section === undefined) return { sideImages: "beside" };
  if (section === null || typeof section !== "object" || Array.isArray(section)) {
    throw new InputError("model3d.handoff must be an object");
  }
  // Only Assetgrove's own fields are read and checked. Any other field is the target's own note
  // (raccoon-world, for example, describes its container and compression here) and is left alone,
  // as the rest of the profile's model3d section is.
  const { clipFields, sideImages = "beside", lods } = section as Record<string, unknown>;
  if (!SIDE_IMAGE_MODES.includes(sideImages as SideImageMode)) {
    throw new InputError(`model3d.handoff.sideImages must be ${SIDE_IMAGE_MODES.join(" or ")}`);
  }
  if (lods !== undefined && !LOD_PACKAGINGS.includes(lods as LodPackaging)) {
    throw new InputError(`model3d.handoff.lods must be ${LOD_PACKAGINGS.join(" or ")}`);
  }
  const base = {
    sideImages: sideImages as SideImageMode,
    ...(lods !== undefined && { lods: lods as LodPackaging }),
  };
  if (clipFields === undefined) return base;
  if (clipFields === null || typeof clipFields !== "object" || Array.isArray(clipFields)) {
    throw new InputError("model3d.handoff.clipFields must map manifest field names to clip fields");
  }
  const entries = Object.entries(clipFields);
  if (entries.length === 0) throw new InputError("model3d.handoff.clipFields is empty");
  for (const [name, from] of entries) {
    if (!FIELD.test(name) || typeof from !== "string" || !FIELD.test(from)) {
      throw new InputError(
        `model3d.handoff.clipFields.${name} must map a field name to a clip field name`,
      );
    }
  }
  return {
    clipFields: Object.fromEntries(entries) as Record<string, string>,
    ...base,
  };
}

/** One 3D output on its way to the target, as `pick` reads it from the run. */
export interface ModelHandoff {
  bytes: Uint8Array;
  fields: Record<string, unknown>;
  sidecars: NonNullable<TargetWrite["output"]["sidecars"]>;
}

/** Each clip with the declared fields, under the declared names, in the declared order. */
function shapeClips(clipList: unknown, fields: Record<string, string>): unknown {
  if (!Array.isArray(clipList)) return clipList;
  return clipList.map((clip: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(fields).flatMap(([name, from]) =>
        clip[from] === undefined ? [] : [[name, clip[from]]],
      ),
    ),
  );
}

/** Embeds every side image `bytes` references by `uri`, from `byName`; returns the new bytes. */
function embedInto(bytes: Uint8Array, byName: Map<string, ModelHandoff["sidecars"][number]>) {
  const glb = parseGlb(bytes);
  for (const image of glb.json.images ?? []) {
    if (image.uri === undefined || image.uri.startsWith("data:")) continue;
    const sidecar = byName.get(decodeURIComponent(image.uri));
    if (!sidecar) {
      throw new InputError(`the model's image "${image.uri}" is not one of its side files`);
    }
    image.bufferView = appendBufferView(glb, sidecar.bytes);
    image.mimeType = sidecar.mediaType;
    delete image.uri;
  }
  const extras = glb.json.asset.extras as
    { lookdev?: { images?: Record<string, Record<string, unknown>> } } | undefined;
  for (const entry of Object.values(extras?.lookdev?.images ?? {})) delete entry["uri"];
  return writeGlb(glb);
}

/**
 * Embeds every side image the `.glb` references by `uri` into its binary chunk, and drops every
 * side file: the ones it references are now inside it, and the others (the base colour) already
 * were. `asset.extras.lookdev.images` keeps each field's image index, without the `uri`. The
 * chain's other `.glb` files (detail levels and tiers, assetgrove#136) are kept beside it, each
 * with its own side images embedded the same way.
 */
function embedSideImages(output: ModelHandoff): ModelHandoff {
  const byName = new Map(output.sidecars.map((s) => [s.name, s]));
  const models = output.sidecars
    .filter((s) => s.mediaType === GLB_MEDIA_TYPE)
    .map((s) => ({ ...s, bytes: embedInto(s.bytes, byName) }));
  return { bytes: embedInto(output.bytes, byName), fields: output.fields, sidecars: models };
}

/**
 * Each clip's `durationMs` as the file has it: the last key time of its animation, in
 * milliseconds, unrounded, so a target that measures the `.glb` finds the manifest's value.
 */
function measuredDurations(glb: Glb, clipList: unknown): unknown {
  if (!Array.isArray(clipList)) return clipList;
  const measured = new Map(clips(glb).map((c) => [c.name, c.durationS * 1000]));
  return clipList.map((clip: Record<string, unknown>) => {
    const durationMs = measured.get(clip["name"] as string);
    return durationMs === undefined || clip["durationMs"] === undefined
      ? clip
      : { ...clip, durationMs };
  });
}

/**
 * The output as the target declares it (see `handoffSettings`). Every clip's `durationMs` and the
 * `bounds` are measured on the file handed off, unrounded (the rest-pose bounds, as at staging);
 * nothing else changes without a declaration.
 */
export function shapeModelHandoff(profile: TargetProfile, output: ModelHandoff): ModelHandoff {
  const settings = handoffSettings(profile);
  const shaped =
    settings.sideImages === "embedded" &&
    output.sidecars.some((s) => s.mediaType !== GLB_MEDIA_TYPE)
      ? embedSideImages(output)
      : output;
  const glb = parseGlb(shaped.bytes);
  const fields = { ...shaped.fields };
  if (fields["bounds"] !== undefined) {
    const bounds = boundsOf(posedPrimitives(glb));
    if (bounds) fields["bounds"] = { min: [...bounds.min], max: [...bounds.max] };
  }
  if (fields["clips"] !== undefined) {
    const measured = measuredDurations(glb, fields["clips"]);
    fields["clips"] =
      settings.clipFields === undefined ? measured : shapeClips(measured, settings.clipFields);
  }
  return { ...shaped, fields };
}
