#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";
import { Budget, BudgetExceededError } from "./budget.ts";
import { Caller } from "./calls.ts";
import { loadBible } from "./bible.ts";
import { checkIdentityRecord, identitySettings, loadCast, loadIdentity } from "./identity.ts";
import type { IdentityRecordCheck } from "./identity.ts";
import { evaluateIdentity } from "./identity-eval.ts";
import { lookDev, planLookdev } from "./model3d/lookdev/command.ts";
import { DEFAULT_LOOKDEV_CAP_USD } from "./model3d/lookdev/settings.ts";
import type { Breakdown, MediumReport } from "./identity-eval.ts";
import { parseDigitalSourceType } from "./metadata.ts";
import type { DigitalSourceType } from "./metadata.ts";
import { InputError, ProviderError } from "./errors.ts";
import { LicenseError } from "./license.ts";
import { VercelGateway } from "./gateway/vercel.ts";
import { ScriptedProvider } from "./gateway/scripted.ts";
import type { Script } from "./gateway/scripted.ts";
import type { GenerationProvider } from "./gateway/provider.ts";
import { generationTool, serveMcp } from "./mcp.ts";
import type { ToolContext } from "./mcp.ts";
import { imageGenerators } from "./generators/image.ts";
import { character3dGenerator } from "./model3d/generator.ts";
import { CHARACTER_3D_KIND } from "./model3d/profile.ts";
import { RoutedProvider } from "./gateway/routed.ts";
import { TripoProvider } from "./gateway/tripo.ts";
import { pick } from "./handoff.ts";
import { DEFAULT_CANDIDATES, DEFAULT_CAP_USD, planStage, readJson, stage } from "./loop.ts";
import type { RunRecord, StagePlan } from "./loop.ts";
import { loadBibleInputs } from "./request.ts";
import { IDENTITY_CAST_OPERATION, IDENTITY_CHECK_OPERATION, loadRoutes } from "./routes.ts";
import type { Route } from "./routes.ts";
import {
  SPEND_ENV,
  SpendLedger,
  SpendLimitError,
  UNPAID_PROVIDER,
  isPaidProvider,
  ledgerFor,
  limitLabel,
} from "./spend.ts";
import type { SpendStatus } from "./spend.ts";
import { runMaterials } from "./material/pipeline.ts";
import { resolveMaterialProfile } from "./material/profile.ts";
import type { MaterialDerivation } from "./material/pipeline.ts";
import { resolveStyle } from "./style.ts";
import { describeOperations, parseRecipe, transformFiles } from "./transform/run.ts";
import type { TransformFilesOptions } from "./transform/run.ts";
import { generateSheet, planSheet, sheetBrief } from "./sheet/generate.ts";
import {
  CONTACT_FILE,
  DEFAULT_JITTER_BOUND_PX,
  GROUPING_FILE,
  importSheet,
  writeFamilies,
} from "./sheet/import.ts";
import type { ImportOptions, ImportRecord } from "./sheet/import.ts";
import { SliceError } from "./sheet/slice.ts";
import type { Grouping, SliceOptions } from "./sheet/types.ts";
import type { AssetSpec, StyleBible, TargetProfile } from "./types.ts";
import { readProvenance, rerig } from "./model3d/rig/command.ts";
import { lodChain } from "./model3d/lod/command.ts";
import {
  DEFAULT_FIX_CAP_USD,
  importTargets,
  parseAnchor,
  planAnimationQa,
  planFrameFix,
  runAnimationQa,
  runFixFrame,
  stripTarget,
} from "./animation/commands.ts";
import { formatReport } from "./animation/run.ts";

type ErrorCode =
  | "invalid_input"
  | "cap_refused"
  | "provider_error"
  | "qa_found_nothing"
  | "validator_rejected"
  | "license_refused"
  | "internal_error";

const EXIT: Record<ErrorCode, number> = {
  invalid_input: 2,
  cap_refused: 3,
  provider_error: 4,
  qa_found_nothing: 5,
  validator_rejected: 6,
  license_refused: 7,
  internal_error: 1,
};

/** What a command produced: the JSON fields, the human summary and an optional refusal. */
interface Outcome {
  exitCode: number;
  fields: Record<string, unknown>;
  human: string;
  error?: Failure;
}

/** A refusal's code and message; a spend-limit refusal also names the limit and its numbers. */
interface Failure {
  code: ErrorCode;
  message: string;
  limit?: {
    name: string;
    workItem?: string;
    limitUsd: number;
    spentUsd: number;
    requestedUsd: number;
    ledger: string;
  };
}

type Values = Record<string, string | boolean | undefined>;

interface Command {
  name: string;
  summary: string;
  usage: string;
  options: ParseArgsOptionsConfig;
  /** Accepts positional arguments, passed to `run` as its second argument. */
  positionals?: boolean;
  run(values: Values, positionals?: string[]): Promise<Outcome>;
}

function refusal(
  code: ErrorCode,
  message: string,
  fields: Record<string, unknown>,
  human: string,
): Outcome {
  return { exitCode: EXIT[code], fields, human, error: { code, message } };
}

function required(values: Values, names: string[]): Record<string, string> {
  const missing = names.filter((n) => typeof values[n] !== "string" || values[n] === "");
  if (missing.length > 0) {
    throw new InputError(`missing required option ${missing.map((n) => `--${n}`).join(", ")}`);
  }
  return Object.fromEntries(names.map((n) => [n, values[n] as string]));
}

function numberOption(values: Values, name: string, fallback: number): number {
  const raw = values[name];
  if (typeof raw !== "string") return fallback;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) {
    throw new InputError(`--${name} must be a number, got "${raw}"`);
  }
  return n;
}

async function loadScript(path: string): Promise<Script> {
  let mod: { default?: Partial<Script> };
  try {
    mod = (await import(pathToFileURL(resolve(path)).href)) as typeof mod;
  } catch (error) {
    throw new InputError(`cannot load provider script ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const script = mod.default;
  if (typeof script?.image !== "function" || typeof script.vision !== "function") {
    throw new InputError(`provider script ${path} must default-export { image, vision } functions`);
  }
  return script as Script;
}

function gatewayProvider(): GenerationProvider {
  try {
    return VercelGateway.fromEnv();
  } catch (error) {
    throw new ProviderError((error as Error).message, { cause: error });
  }
}

/** The `--work-item` option every paid command takes. */
const workItemOption = { "work-item": { type: "string" } } as const;

/**
 * The cross-run spend ledger of this invocation (src/spend.ts): its path and limits from the
 * environment, the work item from --work-item or ASSETGROVE_WORK_ITEM.
 */
function spendLedger(values: Values): SpendLedger {
  const workItem = values["work-item"] as string | undefined;
  return SpendLedger.fromEnv(process.env, workItem !== undefined ? { workItem } : {});
}

function formatSpend(spend: SpendStatus, counted: boolean): string[] {
  return [
    `spend ledger ${spend.ledger}` + (counted ? "" : " (scripted provider: not counted)"),
    ...spend.limits.map(
      (l) =>
        `  ${limitLabel(l)} (${l.source}): ${usd(l.spentUsd)} spent, ${usd(l.remainingUsd)} left`,
    ),
    ...(spend.workItem === null
      ? [`  no work item named (--work-item or ${SPEND_ENV.workItem}); the daily limit applies`]
      : []),
  ];
}

/**
 * The outcome of a dry run: the plan, the spend left under each ledger limit, and a refusal (exit
 * 3) when the forecast is over the run's cap or, for a paid provider, over what is left under a
 * limit. A scripted run's calls are not counted (`spend.counted` false), so the limits never
 * refuse it.
 */
function dryRunOutcome(
  plan: { estimateUsd: number; capUsd: number; withinCap: boolean },
  human: string,
  ledger: SpendLedger,
  providerName: string | undefined,
): Outcome {
  const counted = isPaidProvider(providerName);
  const spend = { ...ledger.status(), counted };
  const over = counted
    ? spend.limits.find((l) => plan.estimateUsd > l.remainingUsd + 1e-9)
    : undefined;
  const fields = { dryRun: true, plan, spend, withinLimits: over === undefined };
  const text = [human, ...formatSpend(spend, counted)].join("\n");
  if (!plan.withinCap)
    return refusal(
      "cap_refused",
      `forecast ${usd(plan.estimateUsd)} exceeds the $${plan.capUsd.toFixed(2)} cap`,
      fields,
      text,
    );
  if (over)
    return refusal(
      "cap_refused",
      `forecast ${usd(plan.estimateUsd)} exceeds the ${usd(over.remainingUsd)} left under the ${limitLabel(over)}`,
      fields,
      text,
    );
  return { exitCode: 0, fields, human: text };
}

/**
 * The scripted provider of --provider-script, under its unpaid name; a script that declares
 * `paid: true` (tests only) runs as `scripted-paid`, whose calls the spend ledger counts.
 */
function scriptedProvider(script: Script): { provider: GenerationProvider; name: string } {
  return {
    provider: new ScriptedProvider(script),
    name: script.paid === true ? `${UNPAID_PROVIDER}-paid` : UNPAID_PROVIDER,
  };
}

/**
 * The provider name a dry run would use, loading (and so checking) --provider-script when given:
 * undefined, a real paid provider, without one.
 */
async function dryRunProvider(values: Values): Promise<string | undefined> {
  const path = values["provider-script"] as string | undefined;
  return path === undefined ? undefined : scriptedProvider(await loadScript(path)).name;
}

/** Every generator `stage` runs: the image kinds and 3D characters. */
const stageGenerators = [...imageGenerators, character3dGenerator];

/**
 * The real provider of a stage run: 3D characters make their 3D calls on Tripo (TRIPO_API_KEY)
 * and their identity calls on the gateway; other kinds use the gateway alone.
 */
function stageProvider(spec: AssetSpec): { provider: GenerationProvider; providerName: string } {
  if (spec.kind !== CHARACTER_3D_KIND) {
    return { provider: gatewayProvider(), providerName: "vercel-ai-gateway" };
  }
  return {
    provider: new RoutedProvider({
      gateway: () => VercelGateway.fromEnv(),
      models: () => TripoProvider.fromEnv(),
    }),
    providerName: "tripo+vercel-ai-gateway",
  };
}

const usd = (n: number) => `$${n.toFixed(4)}`;

function formatPlan(plan: StagePlan): string {
  const lines = [
    `dry run: ${plan.requested} ${plan.kind} candidate(s), ${plan.calls} planned call(s), nothing spent`,
  ];
  for (const c of plan.perCandidate) {
    lines.push(`  ${c.operation}  ${c.model}  ~${usd(c.estimatedCostUsd)} per call`);
  }
  lines.push(
    `per candidate: ${plan.perCandidate.length} call(s)`,
    `forecast ${usd(plan.estimateUsd)} against a $${plan.capUsd.toFixed(2)} cap` +
      (plan.withinCap ? "" : " (over the cap)"),
  );
  return lines.join("\n");
}

function formatRun(run: RunRecord, runDir: string): string {
  const lines = [
    `run ${run.runId}: ${run.candidates.length} of ${run.requested} candidates passed QA` +
      ` ($${run.spentUsd.toFixed(4)} spent of a $${run.capUsd.toFixed(2)} cap)`,
    `staged in ${runDir}`,
  ];
  if (run.stopped) lines.push(`stopped early: ${run.stopped}`);
  for (const c of run.candidates) {
    lines.push(
      "",
      `${c.id}  ${join(runDir, c.file)}  (${c.mediaType}, ${usd(c.provenance.costUsd)})`,
    );
    for (const r of c.reasons) {
      // A shadow check is recorded beside QA: its verdict is shown, but it filtered nothing.
      const tag = r.shadow
        ? `${r.source}; ${r.passed ? "passed" : "failed"}, not filtered`
        : r.source;
      lines.push(`    ${r.check} [${tag}]: ${r.reason}`);
    }
    if (c.artifacts?.length) lines.push(`    renders: ${join(runDir, dirname(c.artifacts[0]!))}`);
  }
  for (const rejection of run.rejections ?? []) {
    for (const r of rejection.reasons.filter((reason) => !reason.passed && !reason.shadow))
      lines.push(`candidate ${rejection.candidate} filtered: ${r.check}: ${r.reason}`);
    for (const r of rejection.reasons.filter((reason) => !reason.passed && reason.shadow))
      lines.push(
        `candidate ${rejection.candidate} also failed, not filtered: ${r.check}: ${r.reason}`,
      );
    if (rejection.costUsd !== undefined)
      lines.push(`candidate ${rejection.candidate} cost ${usd(rejection.costUsd)}`);
    if (rejection.artifacts?.length)
      lines.push(
        `candidate ${rejection.candidate} renders: ${join(runDir, dirname(rejection.artifacts[0]!))}`,
      );
  }
  if (run.identity) {
    const a = run.identity.agreement;
    lines.push(
      `identity ${run.identity.mode} against "${run.identity.subject}" lock ${run.identity.lockVersion}` +
        ` (threshold ${run.identity.threshold}): ${run.identity.scores} scored,` +
        ` agrees with QA on ${a.agree} of ${a.scored} (${(a.rate * 100).toFixed(0)}%),` +
        ` identity-only failures ${a.identityOnlyFailed}, QA-only failures ${a.qaOnlyFailed}`,
    );
  }
  if (run.candidates.length > 0) {
    lines.push(
      "",
      `pick one with: assetgrove pick --run ${runDir} --candidate <id> --target <dir>`,
    );
  }
  return lines.join("\n");
}

const stageCommand: Command = {
  name: "stage",
  summary: "generate candidates within a cost cap and stage those that pass QA",
  usage: `Usage: assetgrove stage --spec <spec.json> --bible <bible.json> --profile <profile.json>
                       [--candidates ${DEFAULT_CANDIDATES}] [--cap ${DEFAULT_CAP_USD}] [--routes <routes.json>]
                       [--runs .assetgrove/runs] [--work-item <label>] [--provider-script <module>]
                       [--dry-run] [--json]

Generates candidates through the Vercel AI Gateway (AI_GATEWAY_API_KEY from the environment)
within the cost cap in USD, and stages only the ones that pass QA.
--dry-run prints the planned calls, the cost forecast and the spend left under the daily and
work-item limits, writes nothing and needs no key.
--provider-script answers every model call from a module whose default export is
{ image, vision } instead of calling the gateway.
A character-3d spec makes rigged, animated .glb candidates from the subject's approved
turnaround: its 3D calls go to Tripo (TRIPO_API_KEY from the environment) and its identity call to
the gateway; turntable renders are written beside each candidate (docs/characters-3d.md).
A sprite-strip spec needs an approved keyPose: stage a still of the pose first, choose one
of its staged candidates, and name that file as keyPose in the strip spec.`,
  options: {
    spec: { type: "string" },
    bible: { type: "string" },
    profile: { type: "string" },
    candidates: { type: "string" },
    cap: { type: "string" },
    routes: { type: "string" },
    runs: { type: "string" },
    ...workItemOption,
    "provider-script": { type: "string" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const files = required(values, ["spec", "bible", "profile"]);
    const ledger = spendLedger(values);
    const candidates = numberOption(values, "candidates", DEFAULT_CANDIDATES);
    const capUsd = numberOption(values, "cap", DEFAULT_CAP_USD);
    const spec = await readJson<AssetSpec>(files["spec"] as string);
    const bible = await readJson<StyleBible>(files["bible"] as string);
    const profile = await readJson<TargetProfile>(files["profile"] as string);
    const routes = await loadRoutes(values["routes"] as string | undefined);
    const plan = planStage({
      spec: spec.value,
      profile: profile.value,
      routes,
      generators: stageGenerators,
      candidates,
      capUsd,
    });
    const scriptPath = values["provider-script"] as string | undefined;
    const scripted = scriptPath ? scriptedProvider(await loadScript(scriptPath)) : undefined;

    if (values["dry-run"]) {
      return dryRunOutcome(
        plan,
        formatPlan(plan),
        ledger.forProfile(profile.value),
        scripted?.name,
      );
    }

    const { run, runDir } = await stage({
      spec: spec.value,
      specDir: spec.dir,
      bible: bible.value,
      bibleDir: bible.dir,
      profile: profile.value,
      profileDir: profile.dir,
      routes,
      ...(scripted
        ? { provider: scripted.provider, providerName: scripted.name }
        : stageProvider(spec.value)),
      generators: stageGenerators,
      runsDir: resolve((values["runs"] as string | undefined) ?? ".assetgrove/runs"),
      candidates,
      capUsd,
      ledger,
      log: (m) => console.error(m),
    });
    const fields = { runDir, ...run };
    const human = formatRun(run, runDir);
    if (run.candidates.length > 0) return { exitCode: 0, fields, human };
    if (run.stopped) return refusal("cap_refused", run.stopped, fields, human);
    if (run.errors.length > 0 && run.errors.length === run.filtered) {
      return refusal(
        "provider_error",
        `every candidate failed to generate: ${run.errors[0]}`,
        fields,
        human,
      );
    }
    return refusal("qa_found_nothing", "no candidate passed QA", fields, human);
  },
};

const pickCommand: Command = {
  name: "pick",
  summary: "write a chosen candidate and its manifest into the target, review pending",
  usage: `Usage: assetgrove pick --run <run directory> --candidate <id> --target <target directory> [--json]

Writes the chosen candidate and its manifest into the target with review pending, then runs
the target profile's validator when it declares one. A human runs pick; agents never do.`,
  options: {
    run: { type: "string" },
    candidate: { type: "string" },
    target: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const o = required(values, ["run", "candidate", "target"]);
    const result = await pick({
      runDir: o["run"] as string,
      candidateId: o["candidate"] as string,
      targetDir: o["target"] as string,
    });
    const lines = [`wrote ${result.mediaPath}`, `wrote ${result.manifestPath}`];
    if (result.provenancePath) lines.push(`wrote ${result.provenancePath}`);
    if (result.validator) {
      lines.push(
        `target validator ${result.validator.accepted ? "accepted" : "REJECTED"} the pick` +
          (result.validator.output ? `:\n${result.validator.output}` : ""),
      );
    }
    const human = lines.join("\n");
    const fields = { ...result };
    if (result.validator?.accepted === false) {
      return refusal(
        "validator_rejected",
        "the target's validator rejected the pick",
        fields,
        human,
      );
    }
    return { exitCode: 0, fields, human };
  },
};

async function providerFor(
  values: Values,
): Promise<{ provider: GenerationProvider; name: string }> {
  const scriptPath = values["provider-script"] as string | undefined;
  if (scriptPath) return scriptedProvider(await loadScript(scriptPath));
  return { provider: gatewayProvider(), name: "vercel-ai-gateway" };
}

async function readBytes(path: string, what: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    throw new InputError(`cannot read ${what} ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/**
 * The identity lock of `subject` from `--lock-bible`, with the run's identity settings
 * (`--identity-mode` over the profile's). Undefined when the subject has no lock or scoring is off.
 */
async function lockFor(values: Values, subject: string, profile: TargetProfile) {
  const path = values["lock-bible"] as string | undefined;
  const mode = values["identity-mode"] as string | undefined;
  const settings = identitySettings(profile, mode);
  if (path === undefined) {
    if (mode !== undefined) throw new InputError("--identity-mode needs --lock-bible <BIBLE.md>");
    return undefined;
  }
  const doc = await loadBible(path);
  const loaded = await loadIdentity(doc, subject);
  if (!loaded || settings.mode === "off") return undefined;
  return {
    ...loaded,
    settings,
    ...(settings.question === "cast" && { cast: await loadCast(doc) }),
  };
}

function formatIdentity(record: ImportRecord): string[] {
  const score = record.identity;
  if (!score) return [];
  return [
    `identity ${score.mode} (${score.model}): ${score.reason}`,
    ...(score.filtered ? ["  write-families will refuse this sheet"] : []),
  ];
}

function formatImport(record: ImportRecord, importDir: string, grouping: Grouping): string {
  const lines = [
    `import ${record.importId}: ${record.frames.length} frames (${record.slice.mode}) from ${record.sheet.path}`,
    `staged in ${importDir}; contact sheet ${join(importDir, CONTACT_FILE)}`,
    ...formatIdentity(record),
  ];
  for (const f of record.frames) {
    for (const c of f.checks.filter((c) => !c.passed)) {
      lines.push(`  frame ${f.id} ${c.check}: ${c.reason}`);
    }
  }
  lines.push("", `proposed grouping (${join(importDir, GROUPING_FILE)}):`);
  for (const f of grouping.families) {
    const frames = f.mirrorOf ? `mirror of ${f.mirrorOf}` : (f.frames ?? []).join(" ");
    lines.push(`  ${f.name}: ${frames}  (${f.reason})`);
  }
  if (grouping.unassigned.length > 0) lines.push(`  unassigned: ${grouping.unassigned.join(" ")}`);
  if (grouping.notes) lines.push(`  notes: ${grouping.notes}`);
  lines.push(
    "",
    'review it, edit it, set "status": "confirmed", then run:',
    `  assetgrove write-families --import ${importDir} --target <dir>`,
  );
  return lines.join("\n");
}

function parseSlice(
  grid: string | undefined,
  components: boolean | undefined,
  frames: string | undefined,
): SliceOptions {
  let count: number | undefined;
  if (frames !== undefined) {
    count = Number(frames);
    if (!Number.isInteger(count) || count < 1) throw new InputError(`invalid --frames: ${frames}`);
  }
  const counted = count !== undefined ? { count } : {};
  if (components) return { components: true, ...counted };
  if (grid === undefined) return counted;
  const columns = Number(grid);
  if (!Number.isInteger(columns) || columns < 1) throw new InputError(`invalid --grid: ${grid}`);
  return { grid: { columns }, ...counted };
}

function declarationOption(values: Values): DigitalSourceType | undefined {
  const code = values["digital-source-type"] as string | undefined;
  if (code === undefined) return undefined;
  const value = parseDigitalSourceType(code);
  if (!value) throw new InputError(`invalid --digital-source-type: ${code}`);
  return value;
}

const importCommand: Command = {
  name: "import",
  summary: "slice a contact sheet into frames and propose animation families",
  usage: `Usage: assetgrove import --sheet <sheet.png> --profile <profile.json> --asset <id> --tool <name>
                        [--bible <bible.json>] [--subject <name>] [--hints idle,walk-right,...]
                        [--frames <count>] [--grid <columns>] [--components] [--no-propose]
                        [--cap ${DEFAULT_CAP_USD}] [--work-item <label>]
                        [--routes <routes.json>] [--imports .assetgrove/imports]
                        [--digital-source-type <IPTC code or URI>] [--provider-script <module>]
                        [--lock-bible <BIBLE.md>] [--identity-mode <off|shadow|enforce>] [--json]

Slices a contact sheet (from any tool; --tool names it, for example "ChatGPT image
generation"), removes the background to the profile's style, and has a vision model propose
families in <import>/grouping.json with status "proposed" (--no-propose skips the grouping
model; it needs no key unless --lock-bible names a locked subject, whose identity score is a
model call in shadow and enforce modes: add --identity-mode off to skip it). A human reviews the proposal against contact.png, edits it and sets its status
to "confirmed" before write-families. See docs/sheet-import.md.

With --frames, the sheet must hold exactly that many figures: slicing another number is refused
(exit 2) before any model call, naming the cells or figures behind the difference.

With --lock-bible, a subject with an identity lock in that art bible has its contact sheet scored
against the lock by the identity decision model. --identity-mode overrides the profile's
identity.mode: shadow (default) records the score, enforce makes write-families refuse a sheet
below the threshold, off skips scoring.`,
  options: {
    sheet: { type: "string" },
    profile: { type: "string" },
    asset: { type: "string" },
    tool: { type: "string" },
    "digital-source-type": { type: "string" },
    bible: { type: "string" },
    subject: { type: "string" },
    hints: { type: "string" },
    frames: { type: "string" },
    grid: { type: "string" },
    components: { type: "boolean" },
    "no-propose": { type: "boolean" },
    "lock-bible": { type: "string" },
    "identity-mode": { type: "string" },
    cap: { type: "string" },
    routes: { type: "string" },
    imports: { type: "string" },
    ...workItemOption,
    "provider-script": { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const o = required(values, ["sheet", "profile", "asset", "tool"]);
    const sheetPath = o["sheet"] as string;
    const asset = o["asset"] as string;
    const capUsd = numberOption(values, "cap", DEFAULT_CAP_USD);
    const slice = parseSlice(
      values["grid"] as string | undefined,
      values["components"] as boolean,
      values["frames"] as string | undefined,
    );
    const profile = await readJson<TargetProfile>(o["profile"] as string);
    const biblePath = values["bible"] as string | undefined;
    const bible = biblePath ? await readJson<StyleBible>(biblePath) : undefined;
    const subjectOption = values["subject"] as string | undefined;
    const subject = subjectOption ?? asset;
    const sheet = await readBytes(sheetPath, "sheet");
    const digitalSourceType = declarationOption(values);
    const lock = await lockFor(values, subject, profile.value);
    let shared: Caller | undefined;
    const caller = async (): Promise<Caller> => {
      if (!shared) {
        const routes = await loadRoutes(values["routes"] as string | undefined);
        const { provider, name } = await providerFor(values);
        shared = new Caller({
          provider,
          providerName: name,
          budget: new Budget(capUsd, ledgerFor(spendLedger(values), name, profile.value)),
          routes,
          log: (m) => console.error(m),
        });
      }
      return shared;
    };
    let propose: ImportOptions["propose"];
    if (!values["no-propose"]) {
      const call = await caller();
      const description = bible?.value.subjects?.[subject]?.description;
      const spec: AssetSpec = { kind: "sprite-sheet", assetId: asset, subject };
      const references = bible ? (await loadBibleInputs(spec, bible.value, bible.dir)).subject : [];
      const hints = values["hints"] as string | undefined;
      propose = {
        call,
        references,
        ...(hints !== undefined && { hints: hints.split(",").map((h) => h.trim()) }),
        ...(description !== undefined && { subjectDescription: description }),
      };
    }
    const { record, importDir, grouping } = await importSheet({
      sheet,
      sheetPath,
      tool: o["tool"] as string,
      ...(digitalSourceType !== undefined && {
        digitalSourceType: digitalSourceType as DigitalSourceType,
      }),
      assetId: asset,
      ...(subjectOption !== undefined && { subject: subjectOption }),
      profile: profile.value,
      ...(bible && { bible: { version: bible.value.version, palette: bible.value.palette } }),
      importsDir: resolve((values["imports"] as string | undefined) ?? ".assetgrove/imports"),
      slice,
      ...(propose !== undefined && { propose }),
      ...(lock && {
        identity: {
          caller: await caller(),
          record: lock.record,
          references: lock.references,
          settings: lock.settings,
          ...(lock.cast && { cast: lock.cast }),
        },
      }),
    });
    return {
      exitCode: 0,
      fields: { importDir, ...record, grouping },
      human: formatImport(record, importDir, grouping),
    };
  },
};

const generateSheetCommand: Command = {
  name: "generate-sheet",
  summary: "have the model draw a whole cycle as one sheet within a cost cap, then import it",
  usage: `Usage: assetgrove generate-sheet --spec <spec.json> --bible <bible.json> --profile <profile.json>
                                [--cap ${DEFAULT_CAP_USD}] [--routes <routes.json>] [--imports .assetgrove/imports]
                                [--lock-bible <BIBLE.md>] [--identity-mode <off|shadow|enforce>]
                                [--brief <brief.json>] [--work-item <label>] [--provider-script <module>]
                                [--dry-run] [--json]

Asks the model for a whole animation cycle as one sheet within the cost cap in USD, then
imports it as the import command does, with a proposed grouping for a human to confirm.
A sheet that does not slice into exactly the spec's frames.count figures fails QA (exit 5),
naming the cells or figures behind the difference; the sheet and its generation record are
kept in the import directory.
--dry-run prints the planned calls, the cost forecast and the spend left under the daily and
work-item limits, writes nothing and needs no key.
--lock-bible and --identity-mode score the generated sheet against the subject's identity lock
as the import command does; the scoring call is part of the forecast and the cap.
The prompt states the family's motion template (its beats, a held pose, the loop). --brief adds
the author's brief (purpose, setting, what happens), checked as plan checks it.`,
  options: {
    spec: { type: "string" },
    bible: { type: "string" },
    profile: { type: "string" },
    brief: { type: "string" },
    cap: { type: "string" },
    routes: { type: "string" },
    imports: { type: "string" },
    "lock-bible": { type: "string" },
    "identity-mode": { type: "string" },
    ...workItemOption,
    "provider-script": { type: "string" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const files = required(values, ["spec", "bible", "profile"]);
    const ledger = spendLedger(values);
    const capUsd = numberOption(values, "cap", DEFAULT_CAP_USD);
    const spec = await readJson<AssetSpec>(files["spec"] as string);
    const bible = await readJson<StyleBible>(files["bible"] as string);
    const profile = await readJson<TargetProfile>(files["profile"] as string);
    const brief =
      values["brief"] === undefined
        ? undefined
        : sheetBrief((await readJson<unknown>(values["brief"] as string)).value);
    const routes = await loadRoutes(values["routes"] as string | undefined);
    const lock = await lockFor(values, spec.value.subject ?? spec.value.assetId, profile.value);
    const perCall = [
      ...planSheet(spec.value, profile.value, routes),
      ...(lock
        ? [
            lock.settings.question === "cast" ? IDENTITY_CAST_OPERATION : "identity",
            ...(lock.settings.mode === "enforce" ? [IDENTITY_CHECK_OPERATION] : []),
          ].map((operation) => ({
            operation,
            model: (routes[operation] as Route).model,
            estimatedCostUsd: (routes[operation] as Route).estimatedCostUsd,
          }))
        : []),
    ];
    if (values["dry-run"]) {
      const providerName = await dryRunProvider(values);
      const estimateUsd = perCall.reduce((sum, c) => sum + c.estimatedCostUsd, 0);
      const plan = {
        kind: "sheet",
        calls: perCall.length,
        perCall,
        estimateUsd,
        capUsd,
        withinCap: estimateUsd <= capUsd + 1e-9,
      };
      const human = [
        `dry run: one generated sheet, ${perCall.length} planned call(s), nothing spent`,
        ...perCall.map((c) => `  ${c.operation}  ${c.model}  ~${usd(c.estimatedCostUsd)}`),
        `forecast ${usd(estimateUsd)} against a $${capUsd.toFixed(2)} cap` +
          (plan.withinCap ? "" : " (over the cap)"),
      ].join("\n");
      return dryRunOutcome(plan, human, ledger.forProfile(profile.value), providerName);
    }
    const { provider, name } = await providerFor(values);
    let generated: Awaited<ReturnType<typeof generateSheet>>;
    try {
      generated = await generateSheet({
        spec: spec.value,
        ...(brief !== undefined && { brief }),
        specDir: spec.dir,
        bible: bible.value,
        bibleDir: bible.dir,
        profile: profile.value,
        routes,
        provider,
        providerName: name,
        importsDir: resolve((values["imports"] as string | undefined) ?? ".assetgrove/imports"),
        capUsd,
        ledger,
        ...(lock && {
          identity: {
            record: lock.record,
            references: lock.references,
            settings: lock.settings,
            ...(lock.cast && { cast: lock.cast }),
          },
        }),
      });
    } catch (error) {
      // The model drew another number of figures than the spec asks for: the sheet failed QA.
      if (!(error instanceof SliceError)) throw error;
      const fields = {
        spentUsd: error.spentUsd,
        found: error.found,
        expected: error.expected,
        problems: error.problems,
        ...(error.kept !== undefined && { kept: error.kept }),
      };
      return refusal("qa_found_nothing", error.message, fields, "");
    }
    const { record, importDir, grouping, spentUsd } = generated;
    return {
      exitCode: 0,
      fields: { importDir, spentUsd, ...record, grouping },
      human: `$${spentUsd.toFixed(4)} spent\n${formatImport(record, importDir, grouping)}`,
    };
  },
};

const writeFamiliesCommand: Command = {
  name: "write-families",
  summary: "write the strips of a human-confirmed grouping into the target, review pending",
  usage: `Usage: assetgrove write-families --import <import directory> --target <target directory>
                                [--grouping <import>/grouping.json] [--jitter-bound ${DEFAULT_JITTER_BOUND_PX}] [--json]

Writes one strip and manifest per family of a grouping whose status a human set to
"confirmed" into the target with review pending, registered within the jitter bound in pixels.
Agents never confirm a grouping.`,
  options: {
    import: { type: "string" },
    target: { type: "string" },
    grouping: { type: "string" },
    "jitter-bound": { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const o = required(values, ["import", "target"]);
    const importDir = o["import"] as string;
    const groupingPath =
      (values["grouping"] as string | undefined) ?? join(importDir, GROUPING_FILE);
    const result = await writeFamilies({
      importDir,
      grouping: (await readJson<unknown>(groupingPath)).value,
      targetDir: o["target"] as string,
      jitterBoundPx: numberOption(values, "jitter-bound", DEFAULT_JITTER_BOUND_PX),
    });
    const lines: string[] = [];
    for (const f of result.families) {
      lines.push(
        `${f.name}: ${f.frames.length} frames${f.mirrored ? " (mirrored)" : ""}, jitter ${f.jitterPx.toFixed(2)} px`,
        `  wrote ${f.result.mediaPath}`,
        `  wrote ${f.result.manifestPath}`,
      );
      if (f.result.provenancePath) lines.push(`  wrote ${f.result.provenancePath}`);
      lines.push(
        ...formatReport({ ...f.animation, identityFlicker: "skipped", holes: "skipped" }).map(
          (l) => `  ${l}`,
        ),
      );
      lines.push(`  onion skin ${f.onionPath}`, `  loop preview ${f.loopPreviewPath}`);
      if (f.result.validator) {
        lines.push(
          `  target validator ${f.result.validator.accepted ? "accepted" : "REJECTED"} it` +
            (f.result.validator.output ? `: ${f.result.validator.output}` : ""),
        );
      }
    }
    lines.push(`preview loop: ${result.previewPath}`);
    const fields = { ...result };
    const human = lines.join("\n");
    if (result.families.some((f) => f.result.validator?.accepted === false)) {
      return refusal(
        "validator_rejected",
        "the target's validator rejected a written family",
        fields,
        human,
      );
    }
    return { exitCode: 0, fields, human };
  },
};

/** The style and frame size a target profile supplies to a transformation, when it has them. */
async function profileContext(path: string | undefined) {
  if (path === undefined) return {};
  const profile = (await readJson<TargetProfile>(path)).value;
  const frames = profile.frames as Partial<TargetProfile["frames"]> | undefined;
  return {
    ...(profile.style !== undefined && { style: resolveStyle(profile.style) }),
    ...(frames?.width !== undefined &&
      frames.height !== undefined && { frame: { width: frames.width, height: frames.height } }),
  };
}

async function runTransform(
  options: Pick<TransformFilesOptions, "recipe" | "inputs" | "out" | "digitalSourceType">,
  profilePath: string | undefined,
): Promise<Outcome> {
  const { record, provenancePath } = await transformFiles({
    ...options,
    ...(await profileContext(profilePath)),
  });
  const lines = record.outputs.map((o) => `wrote ${o.path}`);
  lines.push(`provenance ${provenancePath}`);
  for (const o of record.outputs) {
    const checks = (o.meta?.["checks"] ?? []) as {
      check: string;
      passed: boolean;
      reason: string;
    }[];
    for (const c of checks.filter((c) => !c.passed)) {
      lines.push(`${o.name} ${c.check}: ${c.reason}`);
    }
  }
  return { exitCode: 0, fields: { provenancePath, ...record }, human: lines.join("\n") };
}

function positiveInteger(values: Values, name: string): number | undefined {
  const raw = values[name];
  if (typeof raw !== "string") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new InputError(`--${name} must be a frame number (1 or more), got "${raw}"`);
  }
  return n;
}

/**
 * The subject and gait an asset spec given with `--spec` declares, for animation QA. The gait
 * picks each motion template's rule for it (the spec's over the profile's `animation.gait`).
 */
async function specForQa(values: Values): Promise<{ subject?: string; gait?: string }> {
  if (typeof values["spec"] !== "string") return {};
  const spec = (await readJson<AssetSpec>(values["spec"])).value;
  if (spec.gait !== undefined && typeof spec.gait !== "string") {
    throw new InputError(`the spec's gait must be text, for example "quadruped"`);
  }
  return {
    ...(typeof spec.subject === "string" && { subject: spec.subject }),
    ...(spec.gait !== undefined && { gait: spec.gait }),
  };
}

const animationQaCommand: Command = {
  name: "animation-qa",
  summary: "check strips against motion templates and for loop and continuity; write previews",
  usage: `Usage: assetgrove animation-qa (--strip <strip.png> --family <name> --profile <profile.json>
                              | --import <import directory>)
                              [--out .assetgrove/animation] [--subject <name>] [--spec <spec.json>]
                              [--anchor x,y]
                              [--no-vision] [--cap ${DEFAULT_CAP_USD}] [--routes <routes.json>]
                              [--work-item <label>] [--provider-script <module>] [--dry-run] [--json]

Checks each strip against its family's motion template (beats, timing, contact frames,
silhouette variation) and runs loop and continuity QA on pixels (loop seam, ground line,
anchor and footprint drift, a colour halo at the edge). Two checks need vision, within the
cost cap in USD: identity flicker, one call per pair of consecutive frames, each label and
confidence appended to flicker.jsonl; and holes, one call per frame with a see-through area
inside the figure's outline, which the model judges a hole or a natural opening between
parts. --no-vision skips both. Writes <family>.qa.json, the onion-skin
sheet <family>.onion.png and the looping preview <family>.webp into --out.
--import checks every family write-families wrote from that import.
--spec reads the asset spec's gait (and its subject, unless --subject is given); the gait
picks the motion template's footprint rule for it, over the profile's animation.gait.
--dry-run prints the planned calls, the cost forecast and the spend left under the daily and
work-item limits, writes nothing and needs no key.
Exits 5 when any check fails; every failed check names its frame.`,
  options: {
    strip: { type: "string" },
    family: { type: "string" },
    profile: { type: "string" },
    import: { type: "string" },
    out: { type: "string" },
    subject: { type: "string" },
    spec: { type: "string" },
    anchor: { type: "string" },
    "no-vision": { type: "boolean" },
    cap: { type: "string" },
    routes: { type: "string" },
    ...workItemOption,
    "provider-script": { type: "string" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const capUsd = numberOption(values, "cap", DEFAULT_CAP_USD);
    const routes = await loadRoutes(values["routes"] as string | undefined);
    const vision = !values["no-vision"];
    const spec = await specForQa(values);
    let targets;
    if (typeof values["import"] === "string") {
      if (values["strip"] !== undefined) throw new InputError("give --strip or --import, not both");
      targets = await importTargets(values["import"]);
    } else {
      const o = required(values, ["strip", "family", "profile"]);
      const profile = await readJson<TargetProfile>(o["profile"] as string);
      const anchor = parseAnchor(values["anchor"] as string | undefined);
      targets = [
        stripTarget({
          path: o["strip"] as string,
          family: o["family"] as string,
          profile: profile.value,
          ...(typeof values["subject"] === "string" && { subject: values["subject"] }),
          ...(anchor !== undefined && { anchor }),
        }),
      ];
    }
    const subject = typeof values["subject"] === "string" ? values["subject"] : spec.subject;
    for (const t of targets) {
      if (subject !== undefined) t.subject = subject;
      if (spec.gait !== undefined) t.gait = spec.gait;
    }
    if (values["dry-run"]) {
      const providerName = await dryRunProvider(values);
      const plan = await planAnimationQa(targets, routes, capUsd, vision);
      const human = [
        `dry run: ${targets.length} strip(s), ${plan.calls} planned vision call(s), nothing spent`,
        ...plan.perFamily.map(
          (f) =>
            `  ${f.family}: ${f.flickerCalls} flicker call(s)  ${plan.model}; ${f.holeCalls} holes call(s)  ${plan.holesModel}`,
        ),
        `forecast ${usd(plan.estimateUsd)} against a $${capUsd.toFixed(2)} cap` +
          (plan.withinCap ? "" : " (over the cap)"),
      ].join("\n");
      const ledger = targets.reduce((l, t) => l.forProfile(t.profile), spendLedger(values));
      return dryRunOutcome(plan, human, ledger, providerName);
    }
    const outDir = resolve((values["out"] as string | undefined) ?? ".assetgrove/animation");
    const { results, spentUsd } = await runAnimationQa({
      targets,
      outDir,
      routes,
      capUsd,
      ledger: spendLedger(values),
      ...(vision && { provider: await providerFor(values) }),
    });
    const lines: string[] = [];
    for (const r of results) {
      lines.push(...formatReport(r.report));
      lines.push(`  onion skin ${r.files.onion}`, `  preview ${r.files.preview}`);
    }
    if (vision)
      lines.push(`$${spentUsd.toFixed(4)} spent; decisions in ${join(outDir, "flicker.jsonl")}`);
    const fields = {
      outDir,
      spentUsd,
      families: results.map((r) => ({
        ...r.report,
        decisions: r.decisions,
        holeDecisions: r.holeDecisions,
        files: r.files,
      })),
    };
    const human = lines.join("\n");
    const failed = results.filter((r) => !r.report.passed).map((r) => r.report.family);
    if (failed.length > 0) {
      return refusal(
        "qa_found_nothing",
        `animation QA failed for ${failed.join(", ")}`,
        fields,
        human,
      );
    }
    return { exitCode: 0, fields, human };
  },
};

const fixFrameCommand: Command = {
  name: "fix-frame",
  summary: "regenerate one bad frame of a strip by a reference-guided edit within a cost cap",
  usage: `Usage: assetgrove fix-frame --strip <strip.png> --family <name> --profile <profile.json>
                           --frame <n> (--from <n> | --key-pose <image>) --out <directory>
                           [--subject <name>] [--spec <spec.json>] [--note <text>]
                           [--provenance <strip>.provenance.json]
                           [--bible <bible.json>] [--anchor x,y] [--cap ${DEFAULT_FIX_CAP_USD}] [--routes <routes.json>]
                           [--work-item <label>] [--provider-script <module>] [--dry-run] [--json]

Edits frame <n> (1-based) with one reference-guided edit call, from an approved neighbour
frame (--from) or the approved key pose (--key-pose), within the cost cap in USD. Only that
frame changes. Writes the fixed strip, its provenance (the strip's own, with the call and a
fixes entry added) and its QA report and previews into --out. --provenance (default
<strip>.provenance.json when it exists) is the strip's own provenance or the record recipe or op
wrote for it; any other file is refused (exit 2) before the call. Never writes into a target and
never sets a review value. --spec reads the asset spec's gait (and subject) for that QA.
--dry-run prints the planned call, the forecast and the spend left under the daily and work-item
limits, and needs no key.`,
  options: {
    strip: { type: "string" },
    family: { type: "string" },
    profile: { type: "string" },
    frame: { type: "string" },
    from: { type: "string" },
    "key-pose": { type: "string" },
    out: { type: "string" },
    subject: { type: "string" },
    spec: { type: "string" },
    note: { type: "string" },
    provenance: { type: "string" },
    bible: { type: "string" },
    anchor: { type: "string" },
    cap: { type: "string" },
    routes: { type: "string" },
    ...workItemOption,
    "provider-script": { type: "string" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const o = required(values, ["strip", "family", "profile", "frame", "out"]);
    const index = positiveInteger(values, "frame") as number;
    const neighbour = positiveInteger(values, "from");
    const keyPose = values["key-pose"] as string | undefined;
    if ((neighbour === undefined) === (keyPose === undefined)) {
      throw new InputError("give exactly one of --from <frame> or --key-pose <image>");
    }
    const capUsd = numberOption(values, "cap", DEFAULT_FIX_CAP_USD);
    const routes = await loadRoutes(values["routes"] as string | undefined);
    const profile = await readJson<TargetProfile>(o["profile"] as string);
    const anchor = parseAnchor(values["anchor"] as string | undefined);
    const spec = await specForQa(values);
    const subject = typeof values["subject"] === "string" ? values["subject"] : spec.subject;
    const target = stripTarget({
      path: o["strip"] as string,
      family: o["family"] as string,
      profile: profile.value,
      ...(subject !== undefined && { subject }),
      ...(anchor !== undefined && { anchor }),
      ...(spec.gait !== undefined && { gait: spec.gait }),
    });
    if (values["dry-run"]) {
      const providerName = await dryRunProvider(values);
      const plan = planFrameFix(routes, capUsd);
      const human = [
        `dry run: fix frame ${index}, ${plan.calls} planned call(s), nothing spent`,
        ...plan.perCall.map((c) => `  ${c.operation}  ${c.model}  ~${usd(c.estimatedCostUsd)}`),
        `forecast ${usd(plan.estimateUsd)} against a $${capUsd.toFixed(2)} cap` +
          (plan.withinCap ? "" : " (over the cap)"),
      ].join("\n");
      return dryRunOutcome(
        plan,
        human,
        spendLedger(values).forProfile(profile.value),
        providerName,
      );
    }
    const bible =
      typeof values["bible"] === "string"
        ? (await readJson<StyleBible>(values["bible"])).value
        : undefined;
    const result = await runFixFrame({
      target,
      index,
      from: keyPose !== undefined ? { keyPose } : { neighbour: neighbour as number },
      ...(typeof values["note"] === "string" && { note: values["note"] }),
      ...(typeof values["provenance"] === "string" && { provenancePath: values["provenance"] }),
      ...(bible !== undefined && { bible: { version: bible.version, palette: bible.palette } }),
      outDir: resolve(o["out"] as string),
      routes,
      capUsd,
      ledger: spendLedger(values),
      provider: await providerFor(values),
    });
    const human = [
      `fixed frame ${index} of ${target.family} with ${result.fix.model} (request ${result.fix.requestId}), $${result.spentUsd.toFixed(4)} spent`,
      `wrote ${result.stripPath}`,
      `wrote ${result.provenancePath}`,
      ...formatReport(result.qa.report),
      `  onion skin ${result.qa.files.onion}`,
      `  preview ${result.qa.files.preview}`,
    ].join("\n");
    return {
      exitCode: 0,
      fields: {
        stripPath: result.stripPath,
        provenancePath: result.provenancePath,
        fix: result.fix,
        spentUsd: result.spentUsd,
        qa: { ...result.qa.report, files: result.qa.files },
      },
      human,
    };
  },
};

const opCommand: Command = {
  name: "op",
  summary: "run one media operation over images (matte, trim, scale, convert, ...)",
  positionals: true,
  usage: `Usage: assetgrove op <operation> <input...> --out <path> [--params <json object>]
                     [--profile <profile.json>] [--digital-source-type <IPTC code or URI>] [--json]

Runs one operation (see \`assetgrove ops\`) over the input images and writes the outputs and a
provenance record. --out is a file for a single output, otherwise a directory.
--profile supplies the style and frame size. Example: assetgrove op matte in.png --out out.png`,
  options: {
    "digital-source-type": { type: "string" },
    out: { type: "string" },
    params: { type: "string" },
    profile: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values, positionals = []) {
    const [operation, ...inputs] = positionals;
    if (operation === undefined) throw new InputError("missing the operation name");
    if (inputs.length === 0) throw new InputError("missing input image(s)");
    const o = required(values, ["out"]);
    let params: unknown = {};
    const raw = values["params"];
    if (typeof raw === "string") {
      try {
        params = JSON.parse(raw);
      } catch (error) {
        throw new InputError(`--params is not valid JSON: ${(error as Error).message}`, {
          cause: error,
        });
      }
      if (typeof params !== "object" || params === null || Array.isArray(params)) {
        throw new InputError("--params must be a JSON object");
      }
    }
    const recipe = parseRecipe({ steps: [{ op: operation, params }] });
    return runTransform(
      {
        recipe,
        inputs,
        out: o["out"] as string,
        ...(declarationOption(values) && { digitalSourceType: declarationOption(values)! }),
      },
      values["profile"] as string | undefined,
    );
  },
};

const recipeCommand: Command = {
  name: "recipe",
  summary: "run a recipe file (a sequence of operations) over images",
  positionals: true,
  usage: `Usage: assetgrove recipe <recipe.json> <input...> --out <path> [--profile <profile.json>] [--digital-source-type <IPTC code or URI>] [--json]

Runs the steps of a recipe file in order over the input images and writes the outputs and a
provenance record. --out is a file for a single output, otherwise a directory.`,
  options: {
    "digital-source-type": { type: "string" },
    out: { type: "string" },
    profile: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values, positionals = []) {
    const [recipePath, ...inputs] = positionals;
    if (recipePath === undefined) throw new InputError("missing the recipe file");
    if (inputs.length === 0) throw new InputError("missing input image(s)");
    const o = required(values, ["out"]);
    const recipe = parseRecipe((await readJson<unknown>(recipePath)).value);
    return runTransform(
      {
        recipe,
        inputs,
        out: o["out"] as string,
        ...(declarationOption(values) && { digitalSourceType: declarationOption(values)! }),
      },
      values["profile"] as string | undefined,
    );
  },
};

const opsCommand: Command = {
  name: "ops",
  summary: "list the media operations and the engines that implement them",
  usage: `Usage: assetgrove ops [--json]

Lists every operation with its summary, parameters and engines.`,
  options: {
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run() {
    const described = describeOperations();
    const width = Math.max(...described.operations.map((o) => o.name.length));
    const lines = described.operations.map((o) => `${o.name.padEnd(width)}  ${o.summary}`);
    lines.push("", ...described.engines.map((e) => `engine ${e.name} ${e.version}`));
    return { exitCode: 0, fields: { ...described }, human: lines.join("\n") };
  },
};

const materialsCommand: Command = {
  name: "materials",
  summary: "derive and check material maps, native renditions and target lit previews",
  usage: `Usage: assetgrove materials --albedo <painted.png> --spec <spec.json> --profile <profile.json>
                           --derivation <derivation.json> --out <directory>
                           [--cap ${DEFAULT_CAP_USD}] [--routes <routes.json>] [--work-item <label>]
                           [--digital-source-type <IPTC code or URI>] [--provider-script <module>] [--dry-run] [--json]

Derives the channels requested by style.materials, checks alignment and temporal stability,
writes native-resolution renditions, runs target compression and dusk-rain/night previews,
and judges the flat and lit images with vision QA. Rejected materials exit 5 and remain
unapproved. Model calls reserve against --cap. See docs/materials.md.`,
  options: {
    "digital-source-type": { type: "string" },
    albedo: { type: "string" },
    spec: { type: "string" },
    profile: { type: "string" },
    derivation: { type: "string" },
    out: { type: "string" },
    cap: { type: "string" },
    routes: { type: "string" },
    ...workItemOption,
    "provider-script": { type: "string" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const files = required(values, ["albedo", "spec", "profile", "derivation", "out"]);
    const spec = await readJson<AssetSpec>(files["spec"] as string);
    const profile = await readJson<TargetProfile>(files["profile"] as string);
    const derivation = await readJson<MaterialDerivation>(files["derivation"] as string);
    const routes = await loadRoutes(values["routes"] as string | undefined);
    routes["material-qa"] ??= routes.vision;
    const config = resolveMaterialProfile(profile.value.style?.materials);
    const capUsd = numberOption(values, "cap", DEFAULT_CAP_USD);
    const ledger = spendLedger(values).forProfile(profile.value);
    new Budget(capUsd);
    if (values["dry-run"]) {
      const needed = new Set(config.channels);
      if (needed.has("normal") && derivation.value.maps?.normal?.method === "height-derived-normal")
        needed.add("height");
      const operations = [...needed].flatMap((channel) => {
        const input = derivation.value.maps?.[channel];
        if (!input?.version?.trim())
          throw new InputError(`missing declared method/version for ${channel}`);
        return input.method === "model-assisted-painting" ? [`material-${channel}`] : [];
      });
      operations.push("material-qa");
      const perCall = operations.map((operation) => {
        const route = routes[operation];
        if (!route || !Number.isFinite(route.estimatedCostUsd) || route.estimatedCostUsd < 0)
          throw new InputError(`missing or invalid route for ${operation}`);
        return { operation, model: route.model, estimatedCostUsd: route.estimatedCostUsd };
      });
      const estimateUsd = perCall.reduce((sum, call) => sum + call.estimatedCostUsd, 0);
      const plan = {
        kind: "materials",
        channels: config.channels,
        scales: config.scales,
        calls: perCall.length,
        perCall,
        estimateUsd,
        capUsd,
        withinCap: estimateUsd <= capUsd + 1e-9,
      };
      const human = `dry run: materials, ${plan.calls} planned call(s), nothing spent\nforecast ${usd(estimateUsd)} against a $${capUsd.toFixed(2)} cap`;
      return dryRunOutcome(plan, human, ledger, await dryRunProvider(values));
    }
    const { provider, name } = await providerFor(values);
    const call = new Caller({
      provider,
      providerName: name,
      budget: new Budget(capUsd, ledgerFor(ledger, name)),
      routes,
    });
    const result = await runMaterials({
      albedoPath: resolve(files["albedo"] as string),
      ...(declarationOption(values) && { digitalSourceType: declarationOption(values)! }),
      spec: spec.value,
      profile: profile.value,
      derivation: derivation.value,
      baseDir: derivation.dir,
      profileDir: profile.dir,
      outDir: resolve(files["out"] as string),
      call,
    });
    const fields = { ...result };
    const human = `materials ${result.passed ? "passed QA" : "failed QA"}: ${result.reportPath}`;
    if (!result.passed)
      return refusal("qa_found_nothing", "material maps failed QA", fields, human);
    return { exitCode: 0, fields, human };
  },
};

async function planningContext(values: Values): Promise<ToolContext> {
  const ledger = spendLedger(values);
  const scriptPath = values["provider-script"] as string | undefined;
  if (scriptPath) {
    const { provider, name } = scriptedProvider(await loadScript(scriptPath));
    return { provider, providerName: name, ledger };
  }
  if (process.env["AI_GATEWAY_API_KEY"])
    return { provider: gatewayProvider(), providerName: "vercel-ai-gateway", ledger };
  return { ledger };
}

const bibleCommand: Command = {
  name: "bible",
  summary: "describe a world's art constitution or initialize a repository preset",
  positionals: true,
  usage: `Usage: assetgrove bible describe --bible <BIBLE.md> [--json]
       assetgrove bible init --directory <target repository> --world <name> --preset <preset> [--json]
       assetgrove bible preset --bible <BIBLE.md> --preset <preset> [--json]

Presets: cozy-storybook, flat-cartoon-kids, dark-gritty-isometric.
Initialization explicitly writes a bible, Agent Skill and repository-owned prompt template.`,
  options: {
    bible: { type: "string" },
    directory: { type: "string" },
    world: { type: "string" },
    preset: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values, positionals = []) {
    if (positionals.length !== 1 || !["describe", "init", "preset"].includes(positionals[0]!))
      throw new InputError("bible requires describe, init or preset");
    const result = await generationTool(`bible_${positionals[0]}`, values);
    return { exitCode: 0, fields: { ...result }, human: JSON.stringify(result, null, 2) };
  },
};

const planCommand: Command = {
  name: "plan",
  summary: "compile a reviewable generation plan; never generate images",
  usage: `Usage: assetgrove plan --spec <spec.json> --bible <BIBLE.md> --profile <profile.json>
                       --out <plan.json> [--brief <brief.json>] [--settings <settings.json>]
                       [--template <template.md>] [--routes <routes.json>]
                       [--identity-mode <off|shadow|enforce>] [--work-item <label>]
                       [--provider-script <module>] [--json]

--identity-mode overrides the profile's identity.mode for a character with an identity lock:
shadow (the default) scores candidates beside QA without filtering, enforce filters those below
the threshold, off skips scoring. The forecast includes the scoring calls.
The configured compiler LLM writes prompt and negatives from repository templates.
Without an available LLM, a marked deterministic template fallback is recorded.
Review the saved plan before apply; this command never generates images.`,
  options: {
    spec: { type: "string" },
    bible: { type: "string" },
    profile: { type: "string" },
    out: { type: "string" },
    brief: { type: "string" },
    settings: { type: "string" },
    template: { type: "string" },
    routes: { type: "string" },
    "identity-mode": { type: "string" },
    ...workItemOption,
    "provider-script": { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const { "identity-mode": identityMode, ...rest } = values;
    const result = await generationTool(
      "plan",
      { ...rest, identityMode },
      await planningContext(values),
    );
    return { exitCode: 0, fields: { ...result }, human: JSON.stringify(result, null, 2) };
  },
};

const applyCommand: Command = {
  name: "apply",
  summary: "generate exactly a saved plan after explicit spend approval",
  positionals: true,
  usage: `Usage: assetgrove apply <plan.json> [--auto-approve] [--out <runs directory>]
                        [--work-item <label>] [--provider-script <module>] [--json]

Refuses stale bible, template and identity inputs before generation.
Set the plan's approved field to true after review, or use --auto-approve for unattended runs.
Approval authorizes this generation spend; resulting assets remain pending review. Never prompts.`,
  options: {
    "auto-approve": { type: "boolean" },
    out: { type: "string" },
    ...workItemOption,
    "provider-script": { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values, positionals = []) {
    if (positionals.length !== 1) throw new InputError("apply requires exactly one plan file");
    const result = await generationTool(
      "apply",
      {
        plan: positionals[0],
        autoApprove: values["auto-approve"] === true,
        out: values["out"],
      },
      { ...(await planningContext(values)), log: (m) => console.error(m) },
    );
    const fields = { ...result };
    const human = formatRun(result.run, result.runDir);
    if (result.run.candidates.length === 0)
      return refusal("qa_found_nothing", "no candidate passed QA", fields, human);
    return { exitCode: 0, fields, human };
  },
};

const mcpCommand: Command = {
  name: "mcp",
  summary: "serve bible, plan and apply tools over MCP stdio",
  usage: `Usage: assetgrove mcp [--work-item <label>] [--provider-script <module>]

Serves MCP over stdio with the official MCP SDK. Model keys come from the environment.
Tools: bible_describe, bible_init, bible_preset, plan, apply. File paths are local to this server.`,
  options: { ...workItemOption, "provider-script": { type: "string" }, help: { type: "boolean" } },
  async run(values) {
    // Decision-call log lines go to stderr; stdout carries only JSON-RPC.
    await serveMcp({ ...(await planningContext(values)), log: (m) => console.error(m) });
    return { exitCode: 0, fields: {}, human: "" };
  },
};

function formatMedium(medium: string, m: MediumReport, threshold: number): string[] {
  const pct = (n: number) => `${Number((n * 100).toFixed(1))}%`;
  const line = (label: string, g: Breakdown["byKind"][string]) =>
    `  ${label}: ${g.cases} cases${g.auc !== undefined ? `, AUC ${g.auc.toFixed(3)}` : ""}, false accepts ${pct(g.falseAcceptRate)}, false rejects ${pct(g.falseRejectRate)}`;
  const b = m.configured;
  return [
    `${medium.toUpperCase()}${m.provisional ? " (provisional, no threshold rests on it)" : ""} at threshold ${threshold}:`,
    line("overall", b),
    ...Object.entries(b.byKind).map(([k, g]) => line(`kind ${k}`, g)),
    ...Object.entries(b.byCast).map(([c, g]) => line(`cast ${c}`, g)),
    m.provisional
      ? "  enforce bar: not judged on provisional 3D"
      : b.bar.met
        ? "  enforce bar (provisional): met"
        : `  enforce bar (provisional): not met: ${b.bar.failures.join("; ")}`,
  ];
}

const identityEvalCommand: Command = {
  name: "identity-eval",
  summary: "score a local labelled image set against identity locks and recommend a threshold",
  usage: `Usage: assetgrove identity-eval [--bible <BIBLE.md>] --cases <cases.json> [--profile <profile.json>]
                              [--log <identity-eval.jsonl>] [--cap ${DEFAULT_CAP_USD}] [--routes <routes.json>]
                              [--work-item <label>] [--provider-script <module>] [--json]

Scores every case of a labelled set against its subject's identity lock through the identity
route. cases.json is a list (or {"cases": [...]}) of {"image", "subject", "same": true|false,
"qa": true|false (optional), "kind": same|drift|generic|lookalike, "cast", "medium": 2d|3d,
"bible": path relative to the file}, image paths relative to the file. --bible is optional when
every case names its bible. With identity.question "cast" each candidate is judged against the whole
cast of its bible; every subject's record is first checked against its own references. Each call's label, confidence,
latency and cost are logged on stderr, and one JSON line per case goes to --log. Reports accuracy
for every threshold, the recommended threshold, accuracy at the profile's threshold and agreement
with the cases' QA verdicts. Never filters or approves. Keep the set and the log local; they may
hold a game's private art. See docs/generation-knobs.md.`,
  options: {
    bible: { type: "string" },
    cases: { type: "string" },
    profile: { type: "string" },
    log: { type: "string" },
    cap: { type: "string" },
    routes: { type: "string" },
    ...workItemOption,
    "provider-script": { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const o = required(values, ["cases"]);
    const profilePath = values["profile"] as string | undefined;
    const profile = profilePath ? (await readJson<TargetProfile>(profilePath)).value : {};
    const { provider, name } = await providerFor(values);
    const report = await evaluateIdentity({
      ...(typeof values["bible"] === "string" && { biblePath: values["bible"] }),
      casesPath: o["cases"] as string,
      profile,
      routes: await loadRoutes(values["routes"] as string | undefined),
      provider,
      providerName: name,
      capUsd: numberOption(values, "cap", DEFAULT_CAP_USD),
      ledger: spendLedger(values),
      ...(values["log"] !== undefined && { logPath: values["log"] as string }),
      log: (m) => console.error(m),
    });
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    const lines = [
      `${report.scored} of ${report.cases} cases scored by ${report.model} (${report.question}), ${report.failed} failed, $${report.spentUsd.toFixed(6)} spent`,
      ...report.sweep.map(
        (r) =>
          `  threshold ${r.threshold.toFixed(3)}: ${r.correct} correct (${pct(r.accuracy)}), ${r.falseRejects} false rejects, ${r.falseAccepts} false accepts`,
      ),
      report.recommended
        ? `recommended threshold ${report.recommended.threshold.toFixed(3)} (${pct(report.recommended.accuracy)})`
        : "no threshold recommended: no 2D case of a trusted record was scored",
      `configured threshold ${report.configured.threshold}: ${pct(report.configured.accuracy)}`,
      ...(report.qaAgreement
        ? [
            `agreement with QA: ${report.qaAgreement.agree}/${report.qaAgreement.scored} (${pct(report.qaAgreement.rate)}), identity-only failures ${report.qaAgreement.identityOnlyFailed}, QA-only failures ${report.qaAgreement.qaOnlyFailed}`,
          ]
        : []),
      ...(["2d", "3d"] as const).flatMap((medium) => {
        const m = report.media[medium];
        return m ? formatMedium(medium, m, report.configured.threshold) : [];
      }),
      ...(report.untrusted
        ? [
            `untrusted records (kept out of the threshold and the bar): ${report.untrusted.cases} cases at threshold ${report.configured.threshold}, false accepts ${pct(report.untrusted.falseAcceptRate)}, false rejects ${pct(report.untrusted.falseRejectRate)}`,
          ]
        : []),
      ...report.recordChecks.map((c) => `record check: ${c.reason}`),
    ];
    return { exitCode: 0, fields: { ...report }, human: lines.join("\n") };
  },
};

const identityCheckCommand: Command = {
  name: "identity-check",
  summary: "check that identity records agree with their own approved references",
  usage: `Usage: assetgrove identity-check --bible <BIBLE.md> [--subject <name>]... [--routes <routes.json>]
                              [--cap ${DEFAULT_CAP_USD}] [--work-item <label>] [--provider-script <module>] [--json]

Asks the identity-check route whether each identity record's written signature features,
proportions and palette agree with the record's approved reference images (the source of truth).
Checks every identity in the bible, or the named subjects. Exits 1 when any record disagrees or
could not be checked: identity enforce mode does not filter with such a record until a person
fixes its text or its references. See docs/generation-knobs.md.`,
  options: {
    bible: { type: "string" },
    subject: { type: "string", multiple: true },
    routes: { type: "string" },
    cap: { type: "string" },
    ...workItemOption,
    "provider-script": { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const o = required(values, ["bible"]);
    const doc = await loadBible(o["bible"] as string);
    const named = (values["subject"] as unknown as string[] | undefined) ?? [];
    const subjects = named.length > 0 ? named : Object.keys(doc.data.identities).sort();
    const loaded = await Promise.all(
      subjects.map(async (subject) => {
        const identity = await loadIdentity(doc, subject);
        if (!identity) throw new InputError(`"${subject}" has no identity lock in ${doc.path}`);
        return identity;
      }),
    );
    if (loaded.length === 0) throw new InputError(`${doc.path} has no identity locks`);
    const routes = await loadRoutes(values["routes"] as string | undefined);
    const { provider, name } = await providerFor(values);
    const budget = new Budget(
      numberOption(values, "cap", DEFAULT_CAP_USD),
      ledgerFor(spendLedger(values), name, {}),
    );
    budget.check(
      loaded.length * (routes[IDENTITY_CHECK_OPERATION] as Route).estimatedCostUsd,
      `${loaded.length} identity record checks`,
    );
    const caller = new Caller({
      provider,
      providerName: name,
      budget,
      routes,
      log: (m) => console.error(m),
    });
    const checks: IdentityRecordCheck[] = [];
    for (const identity of loaded) checks.push(await checkIdentityRecord({ caller, ...identity }));
    const ok = checks.every((c) => c.checked && c.consistent);
    const fields = { checks, spentUsd: budget.spentUsd };
    const human = checks.map((c) => c.reason).join("\n");
    return { exitCode: ok ? 0 : 1, fields, human };
  },
};

const rigCommand: Command = {
  name: "rig",
  summary: "re-rig a 3D character on the target's shared rig with generated gaits and motions",
  usage: `Usage: assetgrove rig --model <model.glb> --provenance <provenance.json> --spec <spec.json>
                     --profile <profile.json> [--runs .assetgrove/runs] [--json]

Fits the target profile's skeleton template (model3d.rig) to an existing character model, such
as a picked candidate, skins it, generates the clips its gait profiles (model3d.gaits) and
motions (model3d.motions) declare for the spec's clips, and checks foot contact, joint limits,
skinning, loops and one-shot ends per clip. The result is staged as a one-candidate run, with
turntable renders, side views and a looping preview per clip, that pick hands off
as for stage. The source's provenance is carried over with the rig's hashes. No model is called
and nothing is spent (docs/characters-3d.md).`,
  options: {
    model: { type: "string" },
    provenance: { type: "string" },
    spec: { type: "string" },
    profile: { type: "string" },
    runs: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const files = required(values, ["model", "provenance", "spec", "profile"]);
    const modelPath = files["model"] as string;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(modelPath));
    } catch {
      throw new InputError(`cannot read the model ${modelPath}`);
    }
    const spec = await readJson<AssetSpec>(files["spec"] as string);
    const profile = await readJson<TargetProfile>(files["profile"] as string);
    const { run, runDir, passed } = await rerig({
      model: { bytes, path: modelPath },
      provenance: await readProvenance(files["provenance"] as string),
      spec: spec.value,
      specDir: spec.dir,
      profile: profile.value,
      profileDir: profile.dir,
      runsDir: resolve((values["runs"] as string | undefined) ?? ".assetgrove/runs"),
    });
    const fields = { runDir, ...run };
    const human = formatRun(run, runDir);
    if (passed) return { exitCode: 0, fields, human };
    return refusal("qa_found_nothing", "the re-rigged model did not pass QA", fields, human);
  },
};

const lodCommand: Command = {
  name: "lod",
  summary: "make a 3D model's detail levels and texture tiers within the target's budgets",
  usage: `Usage: assetgrove lod --run <run dir> --candidate <id> [--profile <profile.json>]
                     [--runs .assetgrove/runs] [--json]
       assetgrove lod --model <model.glb> --provenance <provenance.json> --spec <spec.json>
                     --profile <profile.json> [--runs .assetgrove/runs] [--json]

Makes the detail-level chain the target profile declares (model3d.lods) from a staged candidate
or a given .glb: each lower level simplifies the index lists only, so the skeleton, skin weights,
clips and UVs stay as they are. Then, per quality tier (model3d.tiers), a rendition with the levels
within its triangle budget, its textures and look-dev side maps within its size, or those maps
dropped where the tier draws no fur. Each level is checked against the full model (silhouette in
the turntable views and clip frames, skin, UVs, clips) and left out, with the reason, when it
fails. The levels are packaged as model3d.handoff.lods declares (embedded or files) and staged as
a one-candidate run that pick hands off. No model is called and nothing is spent
(docs/characters-3d.md).`,
  options: {
    run: { type: "string" },
    candidate: { type: "string" },
    model: { type: "string" },
    provenance: { type: "string" },
    spec: { type: "string" },
    profile: { type: "string" },
    runs: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const runsDir = resolve((values["runs"] as string | undefined) ?? ".assetgrove/runs");
    const profile =
      typeof values["profile"] === "string"
        ? await readJson<TargetProfile>(values["profile"])
        : undefined;
    let result;
    if (typeof values["run"] === "string") {
      const files = required(values, ["run", "candidate"]);
      result = await lodChain({
        run: { dir: resolve(files["run"] as string), candidate: files["candidate"] as string },
        ...(profile && { profile: profile.value }),
        runsDir,
      });
    } else {
      const files = required(values, ["model", "provenance", "spec", "profile"]);
      const modelPath = files["model"] as string;
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(modelPath));
      } catch {
        throw new InputError(`cannot read the model ${modelPath}`);
      }
      const spec = await readJson<AssetSpec>(files["spec"] as string);
      result = await lodChain({
        model: { bytes, path: modelPath },
        provenance: await readProvenance(files["provenance"] as string),
        spec: spec.value,
        specDir: spec.dir,
        profile: profile!.value,
        runsDir,
      });
    }
    const { run, runDir, passed } = result;
    const fields = { runDir, ...run };
    const human = formatRun(run, runDir);
    if (passed) return { exitCode: 0, fields, human };
    return refusal("qa_found_nothing", "the detail-level chain did not pass QA", fields, human);
  },
};

const lookDevCommand: Command = {
  name: "look-dev",
  summary: "give a picked 3D character its look: base colour, fur groom maps and eyes",
  usage: `Usage: assetgrove look-dev --model <model.glb> --provenance <provenance.json> --spec <spec.json>
                          --bible <bible.json> --profile <profile.json> [--cap <usd>] [--routes <routes.json>]
                          [--runs .assetgrove/runs] [--work-item <label>] [--provider-script <module>]
                          [--dry-run] [--json]

Repaints a picked character's base colour on its own UVs in the look the bible's approved
references define (restyled renders projected back onto the model), writes fur groom maps
(length, direction, density) and tint textures per season the profile declares
(model3d.groom), gives the eyes their own glossy material and mask, and checks them: the
maps' zero-length masks, map-driven shell-fur renders, UV seams, the eyes' catch-light at the
closest zoom and the identity lock. Before-and-after renders beside the approved turnaround
are written for the person who approves; pick hands the result off. The cap defaults to
model3d.lookdev.capUsd or $3 and is reserved before any call (docs/look-dev.md).`,
  options: {
    model: { type: "string" },
    provenance: { type: "string" },
    spec: { type: "string" },
    bible: { type: "string" },
    profile: { type: "string" },
    cap: { type: "string" },
    routes: { type: "string" },
    runs: { type: "string" },
    ...workItemOption,
    "provider-script": { type: "string" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const files = required(values, ["model", "provenance", "spec", "bible", "profile"]);
    const ledger = spendLedger(values);
    const spec = await readJson<AssetSpec>(files["spec"] as string);
    const bible = await readJson<StyleBible>(files["bible"] as string);
    const profile = await readJson<TargetProfile>(files["profile"] as string);
    const routes = await loadRoutes(values["routes"] as string | undefined);
    const capUsd =
      values["cap"] === undefined
        ? undefined
        : numberOption(values, "cap", DEFAULT_LOOKDEV_CAP_USD);
    const plan = planLookdev(profile.value, routes, capUsd);
    const scriptPath = values["provider-script"] as string | undefined;
    const scripted = scriptPath ? scriptedProvider(await loadScript(scriptPath)) : undefined;
    if (values["dry-run"]) {
      const human = [
        `look-dev: ${plan.calls.length} call(s), forecast ${usd(plan.estimateUsd)} against the $${plan.capUsd.toFixed(2)} cap`,
        ...plan.calls.map((c) => `  ${c.operation}  ${c.model}  ${usd(c.estimatedCostUsd)}`),
        `  seasons: ${plan.seasons.join(", ")}`,
      ].join("\n");
      return dryRunOutcome(plan, human, ledger.forProfile(profile.value), scripted?.name);
    }
    const modelPath = files["model"] as string;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(modelPath));
    } catch {
      throw new InputError(`cannot read the model ${modelPath}`);
    }
    const { run, runDir, passed } = await lookDev({
      model: { bytes, path: modelPath },
      provenance: await readProvenance(files["provenance"] as string),
      spec: spec.value,
      specDir: spec.dir,
      bible: bible.value,
      bibleDir: bible.dir,
      profile: profile.value,
      profileDir: profile.dir,
      routes,
      ...(scripted
        ? { provider: scripted.provider, providerName: scripted.name }
        : { provider: gatewayProvider(), providerName: "vercel-ai-gateway" }),
      ledger,
      runsDir: resolve((values["runs"] as string | undefined) ?? ".assetgrove/runs"),
      ...(capUsd !== undefined && { capUsd }),
      log: (m) => console.error(m),
    });
    const fields = { runDir, ...run };
    const human = formatRun(run, runDir);
    if (passed) return { exitCode: 0, fields, human };
    return refusal(
      "qa_found_nothing",
      "the looked-dev model did not pass its checks",
      fields,
      human,
    );
  },
};

const commands: Command[] = [
  bibleCommand,
  planCommand,
  applyCommand,
  mcpCommand,
  materialsCommand,
  stageCommand,
  pickCommand,
  rigCommand,
  lodCommand,
  lookDevCommand,
  importCommand,
  generateSheetCommand,
  writeFamiliesCommand,
  identityEvalCommand,
  identityCheckCommand,
  animationQaCommand,
  fixFrameCommand,
  opCommand,
  recipeCommand,
  opsCommand,
];

function mainUsage(): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  return [
    "Usage: assetgrove <command> [options]",
    "",
    "Commands:",
    ...commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    "Options:",
    "  --json       print exactly one JSON document on stdout (logs stay on stderr)",
    "  --help, -h   print usage; with a command, that command's usage",
    "  --version    print the version",
    "",
    "Spend: every paid call also reserves against a ledger shared by every run on this machine",
    `(${SPEND_ENV.ledger}): a daily limit (${SPEND_ENV.dailyLimit}, default $10) and,`,
    `with --work-item or ${SPEND_ENV.workItem}, a work-item limit (${SPEND_ENV.workItemLimit},`,
    "default $5). A call that would cross either is refused with exit 3.",
    "",
    "Exit codes: 0 success, 1 internal error, 2 invalid input, 3 cap refused,",
    "4 provider error, 5 QA found nothing, 6 validator rejected the write,",
    "7 licence refused (provider grant does not allow the target's licence).",
    "Run `assetgrove <command> --help` for a command's options.",
  ].join("\n");
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

function classify(error: unknown): Failure {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof InputError) return { code: "invalid_input", message };
  if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
    return { code: "invalid_input", message };
  }
  if (error instanceof SpendLimitError) {
    const limit = {
      name: error.limit,
      ...(error.workItem !== undefined && { workItem: error.workItem }),
      limitUsd: error.limitUsd,
      spentUsd: error.spentUsd,
      requestedUsd: error.requestedUsd,
      ledger: error.ledger,
    };
    return { code: "cap_refused", message, limit };
  }
  if (error instanceof BudgetExceededError) return { code: "cap_refused", message };
  if (error instanceof ProviderError) return { code: "provider_error", message };
  if (error instanceof LicenseError) return { code: "license_refused", message };
  return { code: "internal_error", message };
}

function emit(json: boolean, command: string | null, outcome: Outcome): number {
  const { exitCode, fields, human, error } = outcome;
  if (error) console.error(error.message);
  if (json) {
    // The contract fields come last so a command's own fields can never shadow them.
    const doc = {
      ...fields,
      ok: exitCode === 0,
      exitCode,
      command,
      ...(error && { error }),
    };
    console.log(JSON.stringify(doc, null, 2));
  } else if (human) {
    console.log(human);
  }
  return exitCode;
}

async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const [first, ...rest] = argv;
  if (first === undefined) {
    console.error(mainUsage());
    return EXIT.invalid_input;
  }
  if (first === "--help" || first === "-h" || first === "help") {
    return emit(json, null, { exitCode: 0, fields: { usage: mainUsage() }, human: mainUsage() });
  }
  if (first === "--version") {
    console.log(version());
    return 0;
  }
  const command = commands.find((c) => c.name === first);
  const name = command?.name ?? null;
  try {
    if (!command) {
      throw new InputError(`unknown command "${first}"\n${mainUsage()}`);
    }
    const { values, positionals } = parseArgs({
      args: rest,
      options: command.options,
      strict: true,
      allowPositionals: command.positionals === true,
    });
    if (values["help"]) {
      return emit(json, name, {
        exitCode: 0,
        fields: { usage: command.usage },
        human: command.usage,
      });
    }
    return emit(json, name, await command.run(values as Values, positionals));
  } catch (error) {
    const failure = classify(error);
    return emit(json, name, {
      exitCode: EXIT[failure.code],
      fields: {},
      human: "",
      error: failure,
    });
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT.internal_error;
  },
);
