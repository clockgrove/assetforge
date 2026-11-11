/**
 * `assetforge rig`: re-rigs an existing character model (a picked candidate such as a wave 0 pick)
 * on the target's shared rig with generated clips, and stages the result as a one-candidate run
 * that `pick` hands off unchanged. No provider call is made and nothing is spent.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { InputError } from "../../errors.ts";
import {
  DIGITAL_SOURCE_TYPES,
  embedDigitalSourceType,
  metadataStep,
  readDigitalSourceType,
} from "../../metadata.ts";
import type { DigitalSourceType } from "../../metadata.ts";
import { writeRun } from "../../loop.ts";
import type { RunRecord, StagedCandidate } from "../../loop.ts";
import { sha256 } from "../../request.ts";
import type { AssetSpec, Provenance, TargetProfile } from "../../types.ts";
import { GLB_MEDIA_TYPE, parseGlb } from "../glb.ts";
import { CHARACTER_3D_KIND, characterSpec, model3dSettings } from "../profile.ts";
import { qaPassed } from "../qa.ts";
import { profileSha256, riggedCandidate } from "./candidate.ts";
import { declaresRig, loadRig } from "./template.ts";

export interface RerigOptions {
  /** The source `.glb` and the provenance it was handed off with. */
  model: { bytes: Uint8Array; path: string };
  provenance: Provenance;
  spec: AssetSpec;
  specDir: string;
  profile: TargetProfile;
  profileDir: string;
  runsDir: string;
  runId?: string;
  now?: () => Date;
}

export const RIG_STEP = "rig-generated-gait";

export async function rerig(
  options: RerigOptions,
): Promise<{ run: RunRecord; runDir: string; passed: boolean }> {
  const { spec, profile, provenance } = options;
  if (spec.kind !== CHARACTER_3D_KIND) {
    throw new InputError(`rig needs a ${CHARACTER_3D_KIND} spec, not "${spec.kind}"`);
  }
  const character = characterSpec(spec);
  const settings = model3dSettings(profile);
  if (!declaresRig(profile)) {
    throw new InputError(
      `the target profile "${profile.name}" declares no rig template (model3d.rig)`,
    );
  }
  if (!provenance || typeof provenance !== "object" || !Array.isArray(provenance.calls)) {
    throw new InputError("the provenance file is not an Assetforge provenance record");
  }
  const rig = await loadRig(profile, options.profileDir);
  const sourceSha256 = sha256(options.model.bytes);
  const source = parseGlb(options.model.bytes);
  const candidate = await riggedCandidate({
    source,
    sourceSha256,
    // A handed-off model already faces the target's forward.
    sourceForward: settings.forward,
    settings,
    character,
    rig,
  });

  const now = options.now ?? (() => new Date());
  const runId =
    options.runId ??
    `${now().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = resolve(options.runsDir, runId);
  await mkdir(runDir, { recursive: true });
  const id = "c1";
  const artifacts: string[] = [];
  for (const artifact of candidate.artifacts) {
    const name = join(`${id}-${CHARACTER_3D_KIND}`, basename(artifact.name));
    await mkdir(join(runDir, `${id}-${CHARACTER_3D_KIND}`), { recursive: true });
    await writeFile(join(runDir, name), artifact.bytes);
    artifacts.push(name);
  }

  const digitalSourceType: DigitalSourceType =
    provenance.digitalSourceType && provenance.digitalSourceType !== "undeclared"
      ? provenance.digitalSourceType
      : (readDigitalSourceType(options.model.bytes, GLB_MEDIA_TYPE) ??
        DIGITAL_SOURCE_TYPES.generated);
  const bytes = embedDigitalSourceType(candidate.bytes, GLB_MEDIA_TYPE, digitalSourceType);
  const parameters = {
    ...provenance.parameters,
    ...candidate.parameters,
    targetProfileSha256: profileSha256(profile),
    // The file name only: a local absolute path would leak into the target's public provenance,
    // and the hash already identifies the model.
    rerig: { sourceModel: basename(options.model.path), sourceModelSha256: sourceSha256 },
  };
  delete (parameters as Record<string, unknown>)["rigType"];
  delete (parameters as Record<string, unknown>)["loopClosedChannels"];
  const rigStep = {
    op: RIG_STEP,
    params: {
      template: rig.templatePath,
      templateSha256: rig.templateSha256,
      gaitSha256: rig.gaitSha256,
      targetProfileSha256: profileSha256(profile),
    },
    engine: { name: "assetforge-rig", version: "1" },
    inputs: [sourceSha256],
    outputs: [sha256(candidate.bytes)],
  };
  const record: Provenance = {
    ...provenance,
    parameters,
    digitalSourceType,
    steps: [...(provenance.steps ?? []), rigStep, metadataStep(digitalSourceType, [])],
  };
  const { measures } = candidate;
  const fields = {
    triangles: measures.triangles,
    textureMaxPx: measures.textureMaxPx,
    materials: measures.materials,
    bones: measures.bones,
    lods: measures.lods,
    ...candidate.fields,
    gait: character.gait,
    ...(provenance.identity && { identity: provenance.identity }),
  };
  const passed = qaPassed(candidate.reasons);
  const run: RunRecord = {
    runId,
    createdAt: now().toISOString(),
    spec,
    specDir: resolve(options.specDir),
    profile,
    bibleVersion: provenance.bibleVersion,
    capUsd: 0,
    estimateUsd: 0,
    spentUsd: 0,
    requested: 1,
    candidates: [],
    filtered: passed ? 0 : 1,
    errors: [],
  };
  if (passed) {
    const file = `${id}.glb`;
    await writeFile(join(runDir, file), bytes);
    const staged: StagedCandidate = {
      id,
      file,
      mediaType: GLB_MEDIA_TYPE,
      extension: "glb",
      sha256: sha256(bytes),
      reasons: candidate.reasons,
      fields,
      provenance: record,
      artifacts,
    };
    run.candidates.push(staged);
  } else {
    run.rejections = [{ candidate: 1, reasons: candidate.reasons, costUsd: 0, artifacts }];
  }
  await writeRun(runDir, run);
  return { run, runDir, passed };
}

/** Reads a provenance record from a file. */
export async function readProvenance(path: string): Promise<Provenance> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new InputError(`the provenance file ${path} cannot be read as JSON`);
  }
  return value as Provenance;
}
