import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  combineDigitalSourceTypes,
  embedDigitalSourceType,
  readDigitalSourceType,
  metadataStep,
  requireDeclared,
} from "./metadata.ts";
import { decodeImage } from "./image/raster.ts";
import { pixelHash } from "./transform/run.ts";
import { InputError } from "./errors.ts";
import { requireLicensable } from "./license.ts";
import { GLB_MEDIA_TYPE } from "./model3d/glb.ts";
import { shapeModelHandoff } from "./model3d/handoff.ts";
import { readRun, writeRun } from "./loop.ts";
import type { StagedCandidate } from "./loop.ts";
import { sha256 } from "./request.ts";
import { render, renderString, setPath } from "./template.ts";
import type { AssetSpec, Provenance, TargetProfile } from "./types.ts";

const run = promisify(execFile);

export interface PickOptions {
  runDir: string;
  candidateId: string;
  /** The target repository (or directory) the pick is written into. */
  targetDir: string;
  now?: () => Date;
}

export interface PickResult {
  candidate: StagedCandidate;
  mediaPath: string;
  manifestPath: string;
  provenancePath?: string;
  validator?: { accepted: boolean; command: string[]; output: string };
}

function inside(root: string, path: string): string {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new InputError(`profile layout path "${path}" leaves the target directory`);
  }
  return full;
}

/** Whether the manifest template embeds the whole provenance record as `"{{provenance}}"`. */
function embedsProvenance(template: unknown): boolean {
  if (typeof template === "string") return /^\{\{\s*provenance\s*\}\}$/.test(template);
  if (Array.isArray(template)) return template.some(embedsProvenance);
  if (template !== null && typeof template === "object") {
    return Object.values(template).some(embedsProvenance);
  }
  return false;
}

/** What a hand-off writes: one media file with its fields and provenance. */
export interface TargetWrite {
  profile: TargetProfile;
  spec: AssetSpec;
  bibleVersion: string;
  output: {
    bytes: Uint8Array;
    mediaType: string;
    extension: string;
    fields: Record<string, unknown>;
    /** Files written beside the media; each is exposed to the templates as `output.<field>`. */
    sidecars?: Array<{
      name: string;
      bytes: Uint8Array;
      mediaType: string;
      field: string;
      extra?: Record<string, unknown>;
    }>;
  };
  provenance: Provenance;
  /** Values the templates read as `{{run.*}}`. */
  run: Record<string, unknown>;
  targetDir: string;
}

export interface TargetWriteResult {
  mediaPath: string;
  manifestPath: string;
  provenancePath?: string;
  /** Every written file, relative to the target directory. */
  files: string[];
  validator?: { accepted: boolean; command: string[]; output: string };
}

/**
 * Writes one output into the target in the profile's format: the media, the manifest rendered from
 * the profile's template with the review field set to the profile's pending value, and the
 * provenance. Then runs the target's validator, when the profile declares one. Assetgrove never
 * writes any review value other than pending. Refuses with a LicenseError, before writing, an
 * output whose provider grant the target cannot declare (src/license.ts); `{{profile.license}}`
 * renders the licence the output is declared under.
 */
export async function writeToTarget(write: TargetWrite): Promise<TargetWriteResult> {
  const { profile, spec } = write;
  // Before anything is written: the output must be declarable under a licence the target takes.
  const licensed = requireLicensable(profile, write.provenance);
  if (write.provenance.digitalSourceType === "undeclared") requireDeclared("undeclared");
  const known = [
    write.provenance.digitalSourceType,
    readDigitalSourceType(write.output.bytes, write.output.mediaType),
  ].filter((value) => value !== undefined);
  const digitalSourceType = known.length ? combineDigitalSourceTypes(known) : "undeclared";
  requireDeclared(digitalSourceType);
  const output = {
    ...write.output,
    bytes: embedDigitalSourceType(write.output.bytes, write.output.mediaType, digitalSourceType),
  };
  const provenance = { ...licensed, digitalSourceType };
  const last = provenance.steps?.at(-1);
  if (
    last?.op !== "embed-digital-source-type" ||
    last.params["digitalSourceType"] !== digitalSourceType
  ) {
    const hashes = ["image/png", "image/jpeg"].includes(output.mediaType)
      ? [pixelHash(decodeImage(output.bytes))]
      : [];
    provenance.steps = [...(provenance.steps ?? []), metadataStep(digitalSourceType, hashes)];
  }
  const targetDir = resolve(write.targetDir);
  const context: Record<string, unknown> = {
    spec: { ...spec.fields, ...spec },
    profile: {
      ...profile.values,
      name: profile.name,
      // The licence this output is declared under, so a template never relabels it.
      license: provenance.license,
      ...(profile.style !== undefined && { style: profile.style }),
    },
    bible: { version: write.bibleVersion },
    output: {
      ...output.fields,
      mediaType: output.mediaType,
      extension: output.extension,
      sha256: sha256(output.bytes),
    },
    provenance,
    run: write.run,
  };
  const mediaRel = renderString(profile.layout.media, context);
  const manifestRel = renderString(profile.layout.manifest, context);
  const provenanceRel =
    profile.layout.provenance !== undefined
      ? renderString(profile.layout.provenance, context)
      : embedsProvenance(profile.manifest)
        ? undefined
        : `${mediaRel}.provenance.json`;
  (context["output"] as Record<string, unknown>)["path"] = mediaRel;
  const sidecarRels = (write.output.sidecars ?? []).map((sidecar) => {
    if (sidecar.name === "" || /[\\/]/.test(sidecar.name) || sidecar.name.includes("..")) {
      throw new InputError(`sidecar name "${sidecar.name}" must be a bare file name`);
    }
    const rel = posix.join(posix.dirname(mediaRel.replaceAll("\\", "/")), sidecar.name);
    setPath(context["output"] as Record<string, unknown>, sidecar.field, {
      ...sidecar.extra,
      path: rel,
      sha256: sha256(sidecar.bytes),
    });
    return rel;
  });
  if (provenanceRel !== undefined) context["provenancePath"] = provenanceRel;

  const manifest = render(profile.manifest, context);
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new InputError("the profile's manifest template must render to a JSON object");
  }
  setPath(manifest as Record<string, unknown>, profile.review.path, profile.review.pending);

  const mediaPath = inside(targetDir, mediaRel);
  const manifestPath = inside(targetDir, manifestRel);
  const provenancePath = provenanceRel === undefined ? undefined : inside(targetDir, provenanceRel);
  const writes: Array<[string, Uint8Array | string]> = [
    [mediaPath, output.bytes],
    [manifestPath, `${JSON.stringify(manifest, null, 2)}\n`],
  ];
  (write.output.sidecars ?? []).forEach((sidecar, i) => {
    writes.push([inside(targetDir, sidecarRels[i] as string), sidecar.bytes]);
  });
  if (provenancePath) {
    writes.push([provenancePath, `${JSON.stringify(provenance, null, 2)}\n`]);
  }
  for (const [path, content] of writes) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  const result: TargetWriteResult = {
    mediaPath,
    manifestPath,
    ...(provenancePath !== undefined && { provenancePath }),
    files: writes.map(([path]) => relative(targetDir, path)),
  };
  if (profile.validator) {
    const vars = { manifest: manifestRel, media: mediaRel };
    const command = profile.validator.command.map((part) => renderString(part, vars));
    const [file, ...args] = command;
    if (!file) throw new InputError("the profile's validator command is empty");
    try {
      const { stdout, stderr } = await run(file, args, { cwd: targetDir });
      result.validator = { accepted: true, command, output: `${stdout}${stderr}`.trim() };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message: string };
      const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message;
      result.validator = { accepted: false, command, output: out };
    }
  }
  return result;
}

/**
 * Writes the author's pick into the target (see `writeToTarget`) and records the pick in the run.
 */
export async function pick(options: PickOptions): Promise<PickResult> {
  const record = await readRun(options.runDir);
  const candidate = record.candidates.find((c) => c.id === options.candidateId);
  if (!candidate) {
    const ids = record.candidates.map((c) => c.id).join(", ") || "none";
    throw new InputError(
      `"${options.candidateId}" is not a QA-passing candidate of run ${record.runId} (passing: ${ids})`,
    );
  }
  const bytes = new Uint8Array(await readFile(join(options.runDir, candidate.file)));
  if (sha256(bytes) !== candidate.sha256) {
    throw new InputError(`staged file ${candidate.file} changed since it was staged`);
  }
  const sidecars = [];
  for (const staged of candidate.sidecars ?? []) {
    const sidecarBytes = new Uint8Array(await readFile(join(options.runDir, staged.file)));
    if (sha256(sidecarBytes) !== staged.sha256) {
      throw new InputError(`staged file ${staged.file} changed since it was staged`);
    }
    sidecars.push({
      name: staged.name,
      bytes: sidecarBytes,
      mediaType: staged.mediaType,
      field: staged.field,
      ...(staged.extra !== undefined && { extra: staged.extra }),
    });
  }
  // A 3D output takes the shape its target declares: clip fields, side images (assetgrove#137).
  const shaped =
    candidate.mediaType === GLB_MEDIA_TYPE && record.profile.model3d !== undefined
      ? shapeModelHandoff(record.profile, { bytes, fields: candidate.fields, sidecars })
      : { bytes, fields: candidate.fields, sidecars };
  const now = options.now ?? (() => new Date());
  const targetDir = resolve(options.targetDir);
  const written = await writeToTarget({
    profile: record.profile,
    spec: record.spec,
    bibleVersion: record.bibleVersion,
    output: {
      bytes: shaped.bytes,
      mediaType: candidate.mediaType,
      extension: candidate.extension,
      fields: shaped.fields,
      ...(shaped.sidecars.length > 0 && { sidecars: shaped.sidecars }),
    },
    provenance: candidate.provenance,
    run: { runId: record.runId, candidateId: candidate.id, pickedAt: now().toISOString() },
    targetDir,
  });
  const { files, ...rest } = written;
  record.picked = {
    candidateId: candidate.id,
    at: now().toISOString(),
    target: targetDir,
    files,
  };
  await writeRun(options.runDir, record);
  return { candidate, ...rest };
}
