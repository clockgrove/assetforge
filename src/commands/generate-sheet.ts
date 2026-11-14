import { resolve } from "node:path";
import { readJson, lockFor } from "../inputs.ts";
import { DEFAULT_CAP_USD } from "../loop.ts";
import { dryRunProvider, providerFor, spendLedger } from "../providers/index.ts";
import { IDENTITY_CAST_OPERATION, IDENTITY_CHECK_OPERATION, loadRoutes } from "../routes.ts";
import type { Route } from "../routes.ts";
import { generateSheet, planSheet, sheetBrief } from "../sheet/generate.ts";
import { SliceError } from "../sheet/slice.ts";
import type { AssetSpec, StyleBible, TargetProfile } from "../types.ts";
import { formatImport } from "./import.ts";
import { dryRunOutcome, refusal, usd } from "./result.ts";
import { defineCommand } from "./types.ts";

interface GenerateSheetArgs {
  spec: string;
  bible: string;
  profile: string;
  brief?: string;
  cap?: number;
  routes?: string;
  imports?: string;
  lockBible?: string;
  identityMode?: string;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
}

export const generateSheetCommand = defineCommand<GenerateSheetArgs>({
  name: "generate-sheet",
  tool: null,
  summary: "have the model draw a whole cycle as one sheet within a cost cap, then import it",
  details: `Asks the model for a whole animation cycle as one sheet within the cost cap in USD, then
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
  input: {
    type: "object",
    properties: {
      spec: { type: "string", description: "the asset spec", placeholder: "<spec.json>" },
      bible: { type: "string", description: "the style bible", placeholder: "<bible.json>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      brief: {
        type: "string",
        description: "the author's brief: purpose, setting, what happens",
        placeholder: "<brief.json>",
      },
      cap: { type: "number", description: "the run's cost cap in USD", default: DEFAULT_CAP_USD },
      routes: { type: "string", description: "model routes", placeholder: "<routes.json>" },
      imports: {
        type: "string",
        description: "where imports are staged",
        default: ".assetgrove/imports",
      },
      lockBible: {
        type: "string",
        description: "score the sheet against the subject's identity lock in this art bible",
        placeholder: "<BIBLE.md>",
      },
      identityMode: {
        type: "string",
        description: "override the profile's identity mode",
        placeholder: "<off|shadow|enforce>",
      },
      workItem: {
        type: "string",
        description: "the work item the spend ledger counts against",
        placeholder: "<label>",
      },
      providerScript: {
        type: "string",
        description: "answer every model call from this module instead of a provider",
        placeholder: "<module>",
      },
      dryRun: { type: "boolean", description: "print the plan and forecast; spend nothing" },
    },
    required: ["spec", "bible", "profile"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "runs" },
  async run(args) {
    const ledger = spendLedger(args.workItem);
    const capUsd = args.cap ?? DEFAULT_CAP_USD;
    const spec = await readJson<AssetSpec>(args.spec);
    const bible = await readJson<StyleBible>(args.bible);
    const profile = await readJson<TargetProfile>(args.profile);
    const brief =
      args.brief === undefined
        ? undefined
        : sheetBrief((await readJson<unknown>(args.brief)).value);
    const routes = await loadRoutes(args.routes);
    const lock = await lockFor(
      args.lockBible,
      args.identityMode,
      spec.value.subject ?? spec.value.assetId,
      profile.value,
    );
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
    if (args.dryRun) {
      const providerName = await dryRunProvider(args.providerScript);
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
    const { provider, name } = await providerFor(args.providerScript);
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
        importsDir: resolve(args.imports ?? ".assetgrove/imports"),
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
});
