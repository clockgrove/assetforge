import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Budget, BudgetExceededError } from "./budget.ts";
import { Caller } from "./calls.ts";
import type { GenerationProvider } from "./gateway/provider.ts";
import type { Generator } from "./generators/generator.ts";
import { sha256 } from "./request.ts";
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
  const requested = options.candidates ?? DEFAULT_CANDIDATES;
  const capUsd = options.capUsd ?? DEFAULT_CAP_USD;
  const now = options.now ?? (() => new Date());
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`invalid candidate count: ${requested}`);
  }
  const generator = options.generators.find((g) => g.kind === spec.kind);
  if (!generator) throw new Error(`no generator handles asset kind "${spec.kind}"`);

  const budget = new Budget(capUsd);
  const estimateUsd = generator.estimateCandidateUsd(spec, profile, routes) * requested;
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
        continue;
      }
      const id = `c${index + 1}`;
      const file = `${id}.${generated.output.extension}`;
      await writeFile(join(runDir, file), generated.output.bytes);
      const seeded = call.records.some((r) => r.seed !== undefined);
      run.candidates.push({
        id,
        file,
        mediaType: generated.output.mediaType,
        extension: generated.output.extension,
        sha256: sha256(generated.output.bytes),
        reasons: generated.qa.reasons,
        fields: generated.output.fields,
        provenance: provenanceOf(
          generator,
          call.records,
          generated.prompt,
          generated.parameters,
          bible,
          profile,
          seeded ? seed : undefined,
        ),
      });
    } catch (error) {
      run.filtered++;
      if (error instanceof BudgetExceededError) {
        run.stopped = error.message;
        break;
      }
      // A candidate that fails to generate is not shown; the run goes on with the next one.
      run.errors.push(
        `candidate ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
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
  return JSON.parse(await readFile(join(runDir, RUN_FILE), "utf8")) as RunRecord;
}

/** Reads a JSON data file and returns it with the directory its relative paths resolve against. */
export async function readJson<T>(path: string): Promise<{ value: T; dir: string }> {
  const full = resolve(path);
  return { value: JSON.parse(await readFile(full, "utf8")) as T, dir: dirname(full) };
}
