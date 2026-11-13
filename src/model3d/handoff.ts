/**
 * The target-declared shape of a 3D hand-off (assetforge#137; docs/characters-3d.md, "Hand-off
 * shape"): how `output.clips` reaches the manifest, and whether look-dev's side images are written
 * beside the `.glb` or embedded in it. Without a declaration both go as produced.
 */
import { InputError } from "../errors.ts";
import type { TargetWrite } from "../handoff.ts";
import type { TargetProfile } from "../types.ts";
import { parseGlb, writeGlb } from "./glb.ts";
import { appendBufferView } from "./lookdev/edit.ts";
import { clips } from "./scene.ts";

export const SIDE_IMAGE_MODES = ["beside", "embedded"] as const;
export type SideImageMode = (typeof SIDE_IMAGE_MODES)[number];

/** The profile's `model3d.handoff` section. */
export interface Model3dHandoffProfile {
  /**
   * The fields each manifest clip carries: manifest field name → Assetforge's clip field. A clip
   * field not named is left out; a named field a clip lacks is left out of that clip.
   */
  clipFields?: Record<string, string>;
  /** `beside` (default): side images are files next to the `.glb`. `embedded`: inside it. */
  sideImages?: SideImageMode;
}

export interface ResolvedHandoff {
  clipFields?: Record<string, string>;
  sideImages: SideImageMode;
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The profile's `model3d.handoff` with defaults; throws an InputError naming what is wrong. */
export function handoffSettings(profile: TargetProfile): ResolvedHandoff {
  const section: unknown = profile.model3d?.handoff;
  if (section === undefined) return { sideImages: "beside" };
  if (section === null || typeof section !== "object" || Array.isArray(section)) {
    throw new InputError("model3d.handoff must be an object");
  }
  const { clipFields, sideImages = "beside", ...rest } = section as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) {
    throw new InputError(`model3d.handoff has unknown field(s): ${unknown.join(", ")}`);
  }
  if (!SIDE_IMAGE_MODES.includes(sideImages as SideImageMode)) {
    throw new InputError(`model3d.handoff.sideImages must be ${SIDE_IMAGE_MODES.join(" or ")}`);
  }
  if (clipFields === undefined) return { sideImages: sideImages as SideImageMode };
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
    sideImages: sideImages as SideImageMode,
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

/**
 * Embeds every side image the `.glb` references by `uri` into its binary chunk, and drops every
 * side file: the ones it references are now inside it, and the others (the base colour) already
 * were. `asset.extras.lookdev.images` keeps each field's image index, without the `uri`.
 */
function embedSideImages(output: ModelHandoff): ModelHandoff {
  const glb = parseGlb(output.bytes);
  const byName = new Map(output.sidecars.map((s) => [s.name, s]));
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
  return { bytes: writeGlb(glb), fields: output.fields, sidecars: [] };
}

/**
 * Each clip's `durationMs` as the file has it: the last key time of its animation, in
 * milliseconds, unrounded, so a target that measures the `.glb` finds the manifest's value.
 */
function measuredDurations(bytes: Uint8Array, clipList: unknown): unknown {
  if (!Array.isArray(clipList)) return clipList;
  const measured = new Map(clips(parseGlb(bytes)).map((c) => [c.name, c.durationS * 1000]));
  return clipList.map((clip: Record<string, unknown>) => {
    const durationMs = measured.get(clip["name"] as string);
    return durationMs === undefined || clip["durationMs"] === undefined
      ? clip
      : { ...clip, durationMs };
  });
}

/**
 * The output as the target declares it (see `handoffSettings`). Every clip's `durationMs` is
 * measured on the file handed off; nothing else changes without a declaration.
 */
export function shapeModelHandoff(profile: TargetProfile, output: ModelHandoff): ModelHandoff {
  const settings = handoffSettings(profile);
  const shaped =
    settings.sideImages === "embedded" && output.sidecars.length > 0
      ? embedSideImages(output)
      : output;
  if (shaped.fields["clips"] === undefined) return shaped;
  const measured = measuredDurations(shaped.bytes, shaped.fields["clips"]);
  return {
    ...shaped,
    fields: {
      ...shaped.fields,
      clips:
        settings.clipFields === undefined ? measured : shapeClips(measured, settings.clipFields),
    },
  };
}
