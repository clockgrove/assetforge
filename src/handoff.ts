import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { readRun, writeRun } from "./loop.ts";
import type { StagedCandidate } from "./loop.ts";
import { sha256 } from "./request.ts";
import { render, renderString, setPath } from "./template.ts";

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
    throw new Error(`profile layout path "${path}" leaves the target directory`);
  }
  return full;
}

/**
 * Writes the author's pick into the target in the profile's format: the media, the manifest
 * rendered from the profile's template with the review field set to the profile's pending value,
 * and the provenance. Then runs the target's validator, when the profile declares one. Assetforge
 * never writes any review value other than pending.
 */
export async function pick(options: PickOptions): Promise<PickResult> {
  const record = await readRun(options.runDir);
  const candidate = record.candidates.find((c) => c.id === options.candidateId);
  if (!candidate) {
    const ids = record.candidates.map((c) => c.id).join(", ") || "none";
    throw new Error(
      `"${options.candidateId}" is not a QA-passing candidate of run ${record.runId} (passing: ${ids})`,
    );
  }
  const bytes = new Uint8Array(await readFile(join(options.runDir, candidate.file)));
  if (sha256(bytes) !== candidate.sha256) {
    throw new Error(`staged file ${candidate.file} changed since it was staged`);
  }
  const { profile, spec } = record;
  const targetDir = resolve(options.targetDir);
  const now = options.now ?? (() => new Date());

  const context: Record<string, unknown> = {
    spec: { ...spec.fields, ...spec },
    profile: { ...profile.values, name: profile.name, license: profile.license },
    bible: { version: record.bibleVersion },
    output: {
      ...candidate.fields,
      mediaType: candidate.mediaType,
      extension: candidate.extension,
      sha256: candidate.sha256,
    },
    provenance: candidate.provenance,
    run: { runId: record.runId, candidateId: candidate.id, pickedAt: now().toISOString() },
  };
  const mediaRel = renderString(profile.layout.media, context);
  const manifestRel = renderString(profile.layout.manifest, context);
  const provenanceRel =
    profile.layout.provenance === undefined
      ? undefined
      : renderString(profile.layout.provenance, context);
  (context["output"] as Record<string, unknown>)["path"] = mediaRel;
  if (provenanceRel !== undefined) context["provenancePath"] = provenanceRel;

  const manifest = render(profile.manifest, context);
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("the profile's manifest template must render to a JSON object");
  }
  setPath(manifest as Record<string, unknown>, profile.review.path, profile.review.pending);

  const mediaPath = inside(targetDir, mediaRel);
  const manifestPath = inside(targetDir, manifestRel);
  const provenancePath = provenanceRel === undefined ? undefined : inside(targetDir, provenanceRel);
  const writes: Array<[string, Uint8Array | string]> = [
    [mediaPath, bytes],
    [manifestPath, `${JSON.stringify(manifest, null, 2)}\n`],
  ];
  if (provenancePath) {
    writes.push([provenancePath, `${JSON.stringify(candidate.provenance, null, 2)}\n`]);
  }
  for (const [path, content] of writes) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  const result: PickResult = {
    candidate,
    mediaPath,
    manifestPath,
    ...(provenancePath !== undefined && { provenancePath }),
  };
  if (profile.validator) {
    const vars = { manifest: manifestRel, media: mediaRel };
    const command = profile.validator.command.map((part) => renderString(part, vars));
    const [file, ...args] = command;
    if (!file) throw new Error("the profile's validator command is empty");
    try {
      const { stdout, stderr } = await run(file, args, { cwd: targetDir });
      result.validator = { accepted: true, command, output: `${stdout}${stderr}`.trim() };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message: string };
      const output = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message;
      result.validator = { accepted: false, command, output };
    }
  }

  record.picked = {
    candidateId: candidate.id,
    at: now().toISOString(),
    target: targetDir,
    files: writes.map(([path]) => relative(targetDir, path)),
  };
  await writeRun(options.runDir, record);
  return result;
}
