/**
 * A 3D character candidate on the target's shared rig: the source model normalised, re-rigged with
 * generated clips, and checked (the wave 0 checks plus contact, joint limits and skinning per clip),
 * with its turntable and walk renders. Shared by `stage` and `assetforge rig`.
 */
import type { Reason } from "../../types.ts";
import { sha256 } from "../../request.ts";
import type { Glb } from "../glb.ts";
import { FRAMES_PER_CLIP } from "../profile.ts";
import type { CharacterSpec, ResolvedModel3d } from "../profile.ts";
import { budgetChecks, clipChecks, hierarchyCheck, skeletonCheck, validatorCheck } from "../qa.ts";
import { renderTurntable } from "../render.ts";
import type { TurntableFrame } from "../render.ts";
import { boundsOf, measure, normalize, posedPrimitives, yawBetween } from "../scene.ts";
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
  });
  const written = rigged.glb;
  const measures = measure(written);
  const bounds = measures.bounds ?? boundsOf(posedPrimitives(written))!;
  const height = bounds.max[1] - bounds.min[1];
  const planned = rigged.clips.map((c) => ({ family: c.family, loop: c.loop }));

  const reasons: Reason[] = [
    await validatorCheck(rigged.bytes),
    hierarchyCheck(written, measures),
    ...budgetChecks(measures, settings),
    skeletonCheck(measures),
    ...clipChecks(written, planned, rigged.missing, settings, height),
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
      `walk renders: ${rigged.artifacts.map((a) => a.name).join(", ") || "none"}`,
    source: "deterministic",
  });

  const gaits = Object.fromEntries(
    rigged.clips.map((c) => [
      c.family,
      { sha256: rig.gaitSha256[c.family], profile: rig.gaits[c.family] },
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
