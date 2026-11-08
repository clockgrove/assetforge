import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DIGITAL_SOURCE_TYPES,
  embedDigitalSourceType,
  readDigitalSourceType,
  metadataStep,
} from "./metadata.ts";
import type { DigitalSourceType } from "./metadata.ts";
import { decodeImage } from "./image/raster.ts";
import { pixelHash } from "./transform/run.ts";
import { Budget, BudgetExceededError } from "./budget.ts";
import { Caller } from "./calls.ts";
import { InputError } from "./errors.ts";
import { parseJsonFile } from "./json.ts";
import type { IdentityAgreement } from "./identity.ts";
import type { GenerationProvider } from "./gateway/provider.ts";
import type { Generator, PlannedCall } from "./generators/generator.ts";
import { sha256, sniffMediaType } from "./request.ts";
import type { Routes } from "./routes.ts";
import type {
  AssetSpec,
  CallRecord,
  Provenance,
  Reason,
  StyleBible,
  TargetProfile,
} from "./types.ts";

export const DEFAULT_CANDIDATES = 4;
export const DEFAULT_CAP_USD = 5;

export interface StageOptions {
  spec: AssetSpec;
  specDir: string;
  bible: StyleBible;
  bibleDir: string;
  profile: TargetProfile;
  routes: Routes;
  provider: GenerationProvider;
  /** Recorded in each call's route, for example `vercel-ai-gateway`. */
  providerName: string;
  generators: Generator[];
  /** Directory runs are staged under; each run gets `<runsDir>/<runId>/`. */
  runsDir: string;
  candidates?: number;
  capUsd?: number;
  runId?: string;
  now?: () => Date;
  /** Receives one line per candidate outcome and one when the run stops early. */
  log?: (message: string) => void;
}

/** What a stage run would call and cost, computed without spending anything. */
export interface StagePlan {
  kind: string;
  requested: number;
  capUsd: number;
  /** The calls one candidate makes. */
  perCandidate: PlannedCall[];
  /** Calls across all candidates. */
  calls: number;
  estimateUsd: number;
  /** Whether the estimate fits the cap; a forecast over the cap is reported, not thrown. */
  withinCap: boolean;
}

export function planStage(options: {
  spec: AssetSpec;
  profile: TargetProfile;
  routes: Routes;
  generators: Generator[];
  candidates?: number;
  capUsd?: number;
}): StagePlan {
  const requested = options.candidates ?? DEFAULT_CANDIDATES;
  const capUsd = options.capUsd ?? DEFAULT_CAP_USD;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new InputError(`invalid candidate count: ${requested}`);
  }
  if (typeof capUsd !== "number" || !Number.isFinite(capUsd) || capUsd < 0) {
    throw new InputError(`invalid cost cap: ${capUsd}`);
  }
  const generator = options.generators.find((g) => g.kind === options.spec.kind);
  if (!generator) throw new InputError(`no generator handles asset kind "${options.spec.kind}"`);
  const perCandidate = generator.planCandidate(options.spec, options.profile, options.routes);
  const estimateUsd = perCandidate.reduce((sum, c) => sum + c.estimatedCostUsd, 0) * requested;
  return {
    kind: generator.kind,
    requested,
    capUsd,
    perCandidate,
    calls: perCandidate.length * requested,
    estimateUsd,
    withinCap: estimateUsd <= capUsd + 1e-9,
  };
}

/** A candidate that passed QA, as staged for the author. */
export interface StagedCandidate {
  id: string;
  /** File name inside the run directory. */
  file: string;
  mediaType: string;
  extension: string;
  sha256: string;
  /** Why it passed: one reason per check. */
  reasons: Reason[];
  fields: Record<string, unknown>;
  provenance: Provenance;
}

export interface RunRecord {
  runId: string;
  createdAt: string;
  spec: AssetSpec;
  /** Absolute directory the spec's relative paths resolved against. */
  specDir: string;
  profile: TargetProfile;
  bibleVersion: string;
  capUsd: number;
  estimateUsd: number;
  spentUsd: number;
  requested: number;
  /** Only candidates that passed QA. Failing candidates are never staged or shown. */
  candidates: StagedCandidate[];
  /** How many candidates were filtered out by QA or failed to generate. */
  filtered: number;
  /** Messages of candidates that failed to generate (no media is kept for them). */
  errors: string[];
  /** Why each filtered candidate was filtered (planned runs); `candidate` is the 1-based number. */
  rejections?: Array<{ candidate: number; reasons: Reason[] }>;
  /**
   * The identity lock check of a planned run: which lock version scored the candidates, the mode
   * and threshold, and how often the identity verdict agreed with the QA verdict (the shadow-mode
   * measurement). Absent when the character has no lock or scoring was off.
   */
  identity?: {
    subject: string;
    lockVersion: string;
    lockSha256: string;
    mode: "shadow" | "enforce";
    threshold: number;
    agreement: IdentityAgreement;
    /** How many candidates were scored. */
    scores: number;
  };
  /** Why candidate generation stopped early, when it did (for example the cost cap). */
  stopped?: string;
  picked?: { candidateId: string; at: string; target: string; files: string[] };
}

export const RUN_FILE = "run.json";

function provenanceOf(
  generator: Generator,
  calls: CallRecord[],
  prompt: string,
  parameters: Record<string, unknown>,
  bible: StyleBible,
  profile: TargetProfile,
  seed: number | undefined,
): Provenance {
  const unique = <T>(values: T[]) => [...new Set(values)];
  return {
    generator: generator.kind,
    route: unique(calls.map((c) => c.route)).join(" + "),
    models: unique(calls.map((c) => c.model)),
    prompt,
    parameters,
    ...(seed !== undefined && { seed }),
    requestIds: calls.map((c) => c.requestId),
    referenceHashes: unique(calls.flatMap((c) => c.referenceHashes)),
    bibleVersion: bible.version,
    license: profile.license,
    providerTerms: unique(calls.map((c) => c.providerTerms)),
    startedAt: calls[0]?.startedAt ?? "",
    finishedAt: calls[calls.length - 1]?.finishedAt ?? "",
    costUsd: calls.reduce((sum, c) => sum + c.costUsd, 0),
    calls,
  };
}

/**
 * Stages a run: reserves the whole run's estimate against the cap (refusing before any provider
 * call when it does not fit), generates candidates, keeps only the ones that pass QA, and writes
 * them with their reasons and provenance to the run directory for the author to pick from.
 */
export async function stage(options: StageOptions): Promise<{ run: RunRecord; runDir: string }> {
  const { spec, bible, profile, routes } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const plan = planStage(options);
  const { requested, capUsd, estimateUsd } = plan;
  const generator = options.generators.find((g) => g.kind === spec.kind) as Generator;

  const budget = new Budget(capUsd);
  // The run-level reservation: refuse the whole run, before any call, if it would exceed the cap.
  budget.settle(budget.reserve(estimateUsd, `a run of ${requested} candidates`), 0);

  const runId =
    options.runId ??
    `${now().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = resolve(options.runsDir, runId);
  await mkdir(runDir, { recursive: true });

  const run: RunRecord = {
    runId,
    createdAt: now().toISOString(),
    spec,
    specDir: resolve(options.specDir),
    profile,
    bibleVersion: bible.version,
    capUsd,
    estimateUsd,
    spentUsd: 0,
    requested,
    candidates: [],
    filtered: 0,
    errors: [],
  };

  for (let index = 0; index < requested; index++) {
    const call = new Caller({
      provider: options.provider,
      providerName: options.providerName,
      budget,
      routes,
      now,
    });
    const seed = Number.parseInt(
      sha256(new TextEncoder().encode(`${runId}:${index}`)).slice(0, 8),
      16,
    );
    try {
      const generated = await generator.generate({
        spec,
        specDir: options.specDir,
        bible,
        bibleDir: options.bibleDir,
        profile,
        call,
        index,
        seed,
      });
      if (!generated.qa.passed) {
        run.filtered++;
        log(`candidate ${index + 1}/${requested}: filtered by QA`);
        continue;
      }
      const id = `c${index + 1}`;
      const file = `${id}.${generated.output.extension}`;
      let digitalSourceType: DigitalSourceType = DIGITAL_SOURCE_TYPES.generated;
      if (spec.keyPose && call.records.some((record) => record.operation === "edit")) {
        const source = new Uint8Array(await readFile(resolve(options.specDir, spec.keyPose)));
        const sourceType = readDigitalSourceType(source, sniffMediaType(source));
        if (sourceType !== DIGITAL_SOURCE_TYPES.generated)
          digitalSourceType = DIGITAL_SOURCE_TYPES.composite;
      }
      const bytes = embedDigitalSourceType(
        generated.output.bytes,
        generated.output.mediaType,
        digitalSourceType,
      );
      const provenance = provenanceOf(
        generator,
        call.records,
        generated.prompt,
        generated.parameters,
        bible,
        profile,
        call.records.some((r) => r.seed !== undefined) ? seed : undefined,
      );
      provenance.digitalSourceType = digitalSourceType;
      const pixelHashes = ["image/png", "image/jpeg"].includes(generated.output.mediaType)
        ? [pixelHash(decodeImage(generated.output.bytes))]
        : [];
      provenance.steps = [metadataStep(digitalSourceType, pixelHashes)];
      await writeFile(join(runDir, file), bytes);
      run.candidates.push({
        id,
        file,
        mediaType: generated.output.mediaType,
        extension: generated.output.extension,
        sha256: sha256(bytes),
        reasons: generated.qa.reasons,
        fields: generated.output.fields,
        provenance,
      });
      log(`candidate ${index + 1}/${requested}: passed QA`);
    } catch (error) {
      run.filtered++;
      const message = error instanceof Error ? error.message : String(error);
      // Bad input fails every candidate the same way: refuse the run rather than go on, but
      // leave its record so the runs directory never holds a run without one.
      if (error instanceof InputError) {
        run.errors.push(`candidate ${index + 1}: ${message}`);
        run.stopped = `refused: ${message}`;
        run.spentUsd = budget.spentUsd;
        await writeRun(runDir, run);
        throw error;
      }
      if (error instanceof BudgetExceededError) {
        run.stopped = error.message;
        log(`stopped: ${message}`);
        break;
      }
      // A candidate that fails to generate is not shown; the run goes on with the next one.
      run.errors.push(`candidate ${index + 1}: ${message}`);
      log(`candidate ${index + 1}/${requested}: failed: ${message}`);
    } finally {
      run.spentUsd = budget.spentUsd;
    }
  }

  await writeRun(runDir, run);
  return { run, runDir };
}

export async function writeRun(runDir: string, run: RunRecord): Promise<void> {
  await writeFile(join(runDir, RUN_FILE), `${JSON.stringify(run, null, 2)}\n`);
}

export async function readRun(runDir: string): Promise<RunRecord> {
  return (await parseJsonFile(join(runDir, RUN_FILE), "run")) as RunRecord;
}

export { readJson } from "./json.ts";
