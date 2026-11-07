#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";
import { Budget, BudgetExceededError } from "./budget.ts";
import { Caller } from "./calls.ts";
import { InputError, ProviderError } from "./errors.ts";
import { VercelGateway } from "./gateway/vercel.ts";
import { ScriptedProvider } from "./gateway/scripted.ts";
import type { Script } from "./gateway/scripted.ts";
import type { GenerationProvider } from "./gateway/provider.ts";
import { imageGenerators } from "./generators/image.ts";
import { pick } from "./handoff.ts";
import { DEFAULT_CANDIDATES, DEFAULT_CAP_USD, planStage, readJson, stage } from "./loop.ts";
import type { RunRecord, StagePlan } from "./loop.ts";
import { loadBibleInputs } from "./request.ts";
import { loadRoutes } from "./routes.ts";
import { generateSheet, planSheet } from "./sheet/generate.ts";
import {
  CONTACT_FILE,
  DEFAULT_JITTER_BOUND_PX,
  GROUPING_FILE,
  importSheet,
  writeFamilies,
} from "./sheet/import.ts";
import type { ImportOptions, ImportRecord } from "./sheet/import.ts";
import type { Grouping, SliceOptions } from "./sheet/types.ts";
import type { AssetSpec, StyleBible, TargetProfile } from "./types.ts";

type ErrorCode =
  | "invalid_input"
  | "cap_refused"
  | "provider_error"
  | "qa_found_nothing"
  | "validator_rejected"
  | "internal_error";

const EXIT: Record<ErrorCode, number> = {
  invalid_input: 2,
  cap_refused: 3,
  provider_error: 4,
  qa_found_nothing: 5,
  validator_rejected: 6,
  internal_error: 1,
};

/** What a command produced: the JSON fields, the human summary and an optional refusal. */
interface Outcome {
  exitCode: number;
  fields: Record<string, unknown>;
  human: string;
  error?: { code: ErrorCode; message: string };
}

type Values = Record<string, string | boolean | undefined>;

interface Command {
  name: string;
  summary: string;
  usage: string;
  options: ParseArgsOptionsConfig;
  run(values: Values): Promise<Outcome>;
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
    lines.push("", `${c.id}  ${join(runDir, c.file)}  (${c.mediaType})`);
    for (const r of c.reasons) lines.push(`    ${r.check} [${r.source}]: ${r.reason}`);
  }
  if (run.candidates.length > 0) {
    lines.push(
      "",
      `pick one with: assetforge pick --run ${runDir} --candidate <id> --target <dir>`,
    );
  }
  return lines.join("\n");
}

const stageCommand: Command = {
  name: "stage",
  summary: "generate candidates within a cost cap and stage those that pass QA",
  usage: `Usage: assetforge stage --spec <spec.json> --bible <bible.json> --profile <profile.json>
                       [--candidates ${DEFAULT_CANDIDATES}] [--cap ${DEFAULT_CAP_USD}] [--routes <routes.json>]
                       [--runs .assetforge/runs] [--provider-script <module>] [--dry-run] [--json]

Generates candidates through the Vercel AI Gateway (AI_GATEWAY_API_KEY from the environment)
within the cost cap in USD, and stages only the ones that pass QA.
--dry-run prints the planned calls and the cost forecast, writes nothing and needs no key.
--provider-script answers every model call from a module whose default export is
{ image, vision } instead of calling the gateway.
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
    "provider-script": { type: "string" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const files = required(values, ["spec", "bible", "profile"]);
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
      generators: imageGenerators,
      candidates,
      capUsd,
    });
    const scriptPath = values["provider-script"] as string | undefined;
    const script = scriptPath ? await loadScript(scriptPath) : undefined;

    if (values["dry-run"]) {
      const fields = { dryRun: true, plan };
      const human = formatPlan(plan);
      if (plan.withinCap) return { exitCode: 0, fields, human };
      return refusal(
        "cap_refused",
        `forecast ${usd(plan.estimateUsd)} exceeds the $${plan.capUsd.toFixed(2)} cap`,
        fields,
        human,
      );
    }

    const { run, runDir } = await stage({
      spec: spec.value,
      specDir: spec.dir,
      bible: bible.value,
      bibleDir: bible.dir,
      profile: profile.value,
      routes,
      provider: script ? new ScriptedProvider(script) : gatewayProvider(),
      providerName: script ? "scripted" : "vercel-ai-gateway",
      generators: imageGenerators,
      runsDir: resolve((values["runs"] as string | undefined) ?? ".assetforge/runs"),
      candidates,
      capUsd,
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
  usage: `Usage: assetforge pick --run <run directory> --candidate <id> --target <target directory> [--json]

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
  if (scriptPath)
    return { provider: new ScriptedProvider(await loadScript(scriptPath)), name: "scripted" };
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

function formatImport(record: ImportRecord, importDir: string, grouping: Grouping): string {
  const lines = [
    `import ${record.importId}: ${record.frames.length} frames (${record.slice.mode}) from ${record.sheet.path}`,
    `staged in ${importDir}; contact sheet ${join(importDir, CONTACT_FILE)}`,
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
    `  assetforge write-families --import ${importDir} --target <dir>`,
  );
  return lines.join("\n");
}

function parseSlice(grid: string | undefined, components: boolean | undefined): SliceOptions {
  if (components) return { components: true };
  if (grid === undefined) return {};
  const columns = Number(grid);
  if (!Number.isInteger(columns) || columns < 1) throw new InputError(`invalid --grid: ${grid}`);
  return { grid: { columns } };
}

const importCommand: Command = {
  name: "import",
  summary: "slice a contact sheet into frames and propose animation families",
  usage: `Usage: assetforge import --sheet <sheet.png> --profile <profile.json> --asset <id> --tool <name>
                        [--bible <bible.json>] [--subject <name>] [--hints idle,walk-right,...]
                        [--grid <columns>] [--components] [--no-propose] [--cap ${DEFAULT_CAP_USD}]
                        [--routes <routes.json>] [--imports .assetforge/imports]
                        [--provider-script <module>] [--json]

Slices a contact sheet (from any tool; --tool names it, for example "ChatGPT image
generation"), removes the background to the profile's style, and has a vision model propose
families in <import>/grouping.json with status "proposed" (--no-propose skips the model and
needs no key). A human reviews the proposal against contact.png, edits it and sets its status
to "confirmed" before write-families. See docs/sheet-import.md.`,
  options: {
    sheet: { type: "string" },
    profile: { type: "string" },
    asset: { type: "string" },
    tool: { type: "string" },
    bible: { type: "string" },
    subject: { type: "string" },
    hints: { type: "string" },
    grid: { type: "string" },
    components: { type: "boolean" },
    "no-propose": { type: "boolean" },
    cap: { type: "string" },
    routes: { type: "string" },
    imports: { type: "string" },
    "provider-script": { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const o = required(values, ["sheet", "profile", "asset", "tool"]);
    const sheetPath = o["sheet"] as string;
    const asset = o["asset"] as string;
    const capUsd = numberOption(values, "cap", DEFAULT_CAP_USD);
    const slice = parseSlice(values["grid"] as string | undefined, values["components"] as boolean);
    const profile = await readJson<TargetProfile>(o["profile"] as string);
    const biblePath = values["bible"] as string | undefined;
    const bible = biblePath ? await readJson<StyleBible>(biblePath) : undefined;
    const subjectOption = values["subject"] as string | undefined;
    const subject = subjectOption ?? asset;
    const sheet = await readBytes(sheetPath, "sheet");
    let propose: ImportOptions["propose"];
    if (!values["no-propose"]) {
      const routes = await loadRoutes(values["routes"] as string | undefined);
      const { provider, name } = await providerFor(values);
      const call = new Caller({ provider, providerName: name, budget: new Budget(capUsd), routes });
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
      assetId: asset,
      ...(subjectOption !== undefined && { subject: subjectOption }),
      profile: profile.value,
      ...(bible && { bible: { version: bible.value.version, palette: bible.value.palette } }),
      importsDir: resolve((values["imports"] as string | undefined) ?? ".assetforge/imports"),
      slice,
      ...(propose !== undefined && { propose }),
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
  usage: `Usage: assetforge generate-sheet --spec <spec.json> --bible <bible.json> --profile <profile.json>
                                [--cap ${DEFAULT_CAP_USD}] [--routes <routes.json>] [--imports .assetforge/imports]
                                [--provider-script <module>] [--dry-run] [--json]

Asks the model for a whole animation cycle as one sheet within the cost cap in USD, then
imports it as the import command does, with a proposed grouping for a human to confirm.
--dry-run prints the planned calls and the cost forecast, writes nothing and needs no key.`,
  options: {
    spec: { type: "string" },
    bible: { type: "string" },
    profile: { type: "string" },
    cap: { type: "string" },
    routes: { type: "string" },
    imports: { type: "string" },
    "provider-script": { type: "string" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  },
  async run(values) {
    const files = required(values, ["spec", "bible", "profile"]);
    const capUsd = numberOption(values, "cap", DEFAULT_CAP_USD);
    const spec = await readJson<AssetSpec>(files["spec"] as string);
    const bible = await readJson<StyleBible>(files["bible"] as string);
    const profile = await readJson<TargetProfile>(files["profile"] as string);
    const routes = await loadRoutes(values["routes"] as string | undefined);
    const perCall = planSheet(spec.value, profile.value, routes);
    if (values["dry-run"]) {
      if (values["provider-script"]) await loadScript(values["provider-script"] as string);
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
      const fields = { dryRun: true, plan };
      if (plan.withinCap) return { exitCode: 0, fields, human };
      return refusal(
        "cap_refused",
        `forecast ${usd(estimateUsd)} exceeds the $${capUsd.toFixed(2)} cap`,
        fields,
        human,
      );
    }
    const { provider, name } = await providerFor(values);
    const { record, importDir, grouping, spentUsd } = await generateSheet({
      spec: spec.value,
      specDir: spec.dir,
      bible: bible.value,
      bibleDir: bible.dir,
      profile: profile.value,
      routes,
      provider,
      providerName: name,
      importsDir: resolve((values["imports"] as string | undefined) ?? ".assetforge/imports"),
      capUsd,
    });
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
  usage: `Usage: assetforge write-families --import <import directory> --target <target directory>
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

const commands: Command[] = [
  stageCommand,
  pickCommand,
  importCommand,
  generateSheetCommand,
  writeFamiliesCommand,
];

function mainUsage(): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  return [
    "Usage: assetforge <command> [options]",
    "",
    "Commands:",
    ...commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    "Options:",
    "  --json       print exactly one JSON document on stdout (logs stay on stderr)",
    "  --help, -h   print usage; with a command, that command's usage",
    "  --version    print the version",
    "",
    "Exit codes: 0 success, 1 internal error, 2 invalid input, 3 cap refused,",
    "4 provider error, 5 QA found nothing, 6 validator rejected the write.",
    "Run `assetforge <command> --help` for a command's options.",
  ].join("\n");
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

function classify(error: unknown): { code: ErrorCode; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof InputError) return { code: "invalid_input", message };
  if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
    return { code: "invalid_input", message };
  }
  if (error instanceof BudgetExceededError) return { code: "cap_refused", message };
  if (error instanceof ProviderError) return { code: "provider_error", message };
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
    const { values } = parseArgs({ args: rest, options: command.options, strict: true });
    if (values["help"]) {
      return emit(json, name, {
        exitCode: 0,
        fields: { usage: command.usage },
        human: command.usage,
      });
    }
    return emit(json, name, await command.run(values as Values));
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
