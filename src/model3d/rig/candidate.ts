/**
 * A 3D character candidate on the target's shared rig: the source model normalised, re-rigged with
 * generated clips, and checked (the wave 0 checks plus contact, joint limits and skinning per clip),
 * with its turntable and walk renders. Shared by `stage` and `assetgrove rig`.
 */
import type { Reason } from "../../types.ts";
import { sha256 } from "../../request.ts";
import type { Glb } from "../glb.ts";
import { FRAMES_PER_CLIP } from "../profile.ts";
import type { CharacterSpec, ResolvedModel3d } from "../profile.ts";
import { budgetChecks, clipChecks, hierarchyCheck, skeletonCheck, validatorCheck } from "../qa.ts";
import { endsCheck } from "./qa.ts";
import { renderTurntable } from "../render.ts";
import type { TurntableFrame } from "../render.ts";
import { boundsOf, imageSize, measure, normalize, posedPrimitives, yawBetween } from "../scene.ts";
import type { Axis, Bounds, Measures } from "../scene.ts";
import { rigCharacter } from "./rig.ts";
import { canonicalJson } from "./template.ts";
import type { LoadedRig } from "./template.ts";

export interface RiggedCandidate {
  bytes: Uint8Array;
  written: Glb;
  measures: Measures;
  bounds: Bounds;
  reasons: Reason[];
  /** Turntable views and clip frames, from the shared camera and light. */
  renders: TurntableFrame[];
  /** Every render for the person: the turntable, then the side-view walk frames and comparisons. */
  artifacts: Array<{ name: string; bytes: Uint8Array }>;
  /** Template output fields: clips (generated), rig, missing clips. */
  fields: Record<string, unknown>;
  /** Provenance parameters for the rig. */
  parameters: Record<string, unknown>;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

export async function riggedCandidate(options: {
  /** The source model as parsed; normalised here. */
  source: Glb;
  sourceSha256: string;
  sourceForward: Axis;
  settings: ResolvedModel3d;
  character: CharacterSpec;
  rig: LoadedRig;
  /**
   * The source's external images by `uri` (a look-dev'd model's groom maps, beside it), so the
   * validator can resolve them and the texture budget can measure them.
   */
  resources?: Record<string, Uint8Array>;
  /** Keep the source's `asset.extras`: `rig` re-rigging a handed-off model, never `stage`. */
  keepAssetExtras?: boolean;
}): Promise<RiggedCandidate> {
  const { source, settings, character, rig } = options;
  // Normalise first, so fitting sees the model facing the target's forward at its height.
  normalize(source, {
    sourceForward: options.sourceForward,
    forward: settings.forward,
    ...(character.heightM !== undefined && { heightM: character.heightM }),
  });
  const yaw = yawBetween("+z", settings.forward);
  const rigged = await rigCharacter({
    source,
    yaw,
    rig,
    families: character.clips,
    sizePx: settings.turntablePx,
    ...(options.keepAssetExtras && { keepAssetExtras: true }),
  });
  const written = rigged.glb;
  const measures = measure(written);
  // External images are measured from their files, when given.
  measures.unmeasuredImages = measures.unmeasuredImages.filter((index) => {
    const uri = written.json.images?.[index]?.uri;
    const bytes = uri === undefined ? undefined : options.resources?.[decodeURIComponent(uri)];
    const size = bytes && imageSize(bytes);
    if (!size) return true;
    measures.textureMaxPx = Math.max(measures.textureMaxPx, size.width, size.height);
    return false;
  });
  const bounds = measures.bounds ?? boundsOf(posedPrimitives(written))!;
  const height = bounds.max[1] - bounds.min[1];
  const planned = rigged.clips.map((c) => ({ family: c.family, loop: c.loop }));

  const reasons: Reason[] = [
    await validatorCheck(rigged.bytes, options.resources),
    hierarchyCheck(written, measures),
    ...budgetChecks(measures, settings),
    skeletonCheck(measures),
    ...clipChecks(written, planned, rigged.missing, settings, height),
    // A one-shot starts and ends on its idle's pose, held to the loop tolerance.
    ...rigged.clips.flatMap((clip, index) => {
      const reason = endsCheck(written, index, clip, rigged.skeleton, {
        rotationDeg: settings.loopTolerance.rotationDeg,
        translationM: settings.loopTolerance.translationFraction * height,
      });
      return reason ? [reason] : [];
    }),
    ...rigged.reasons,
  ];
  const renders = renderTurntable(written, {
    sizePx: settings.turntablePx,
    framesPerClip: FRAMES_PER_CLIP,
    forwardYawDeg: (yaw * 180) / Math.PI,
  });
  reasons.push({
    check: "turntable",
    passed: renders.length >= 4,
    reason:
      `${renders.length} render(s) from a fixed camera and light: ${renders.map((r) => r.name).join(", ")}; ` +
      `clip renders and previews: ${rigged.artifacts.map((a) => a.name).join(", ") || "none"}`,
    source: "deterministic",
  });

  const gaits = Object.fromEntries(
    rigged.clips
      .filter((c) => rig.gaits[c.family])
      .map((c) => [c.family, { sha256: rig.gaitSha256[c.family], profile: rig.gaits[c.family] }]),
  );
  const motions = Object.fromEntries(
    rigged.clips
      .filter((c) => rig.motions[c.family])
      .map((c) => [
        c.family,
        { sha256: rig.motionSha256[c.family], profile: rig.motions[c.family] },
      ]),
  );
  return {
    bytes: rigged.bytes,
    written,
    measures,
    bounds,
    reasons,
    renders,
    artifacts: [...renders.map((r) => ({ name: r.name, bytes: r.png })), ...rigged.artifacts],
    fields: {
      clips: rigged.clips.map((c) => ({
        name: c.family,
        durationMs: Math.round(c.durationS * 1000),
        loop: c.loop,
        generated: true,
        speedMps: round(c.speedMps),
      })),
      rig: { template: rig.templatePath, sha256: rig.templateSha256 },
      missingClips: rigged.missing,
      bounds: { min: bounds.min.map(round), max: bounds.max.map(round) },
    },
    parameters: {
      rig: {
        kind: rig.kind,
        template: rig.templatePath,
        templateSha256: rig.templateSha256,
        gaits,
        ...(Object.keys(motions).length > 0 && { motions }),
        sourceModelSha256: options.sourceSha256,
        qa: rig.qa,
        fit: {
          bodyLengthM: round(rigged.fit.bodyLengthM),
          joints: rigged.fit.joints,
          maxMovedBodyLengths: round(rigged.fit.maxMovedBodyLengths),
        },
      },
      clips: rigged.clips.map((c) => ({ family: c.family, generated: true, loop: c.loop })),
      missingClips: rigged.missing,
    },
  };
}

/** SHA-256 of a target profile's canonical JSON, recorded with the rig. */
export function profileSha256(profile: unknown): string {
  return sha256(Buffer.from(canonicalJson(profile)));
}
