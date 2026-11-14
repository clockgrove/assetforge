import { resolve } from "node:path";
import { imageGenerators } from "../generators/image.ts";
import { readJson } from "../inputs.ts";
import { DEFAULT_CANDIDATES, DEFAULT_CAP_USD, planStage, stage } from "../loop.ts";
import { character3dGenerator } from "../model3d/generator.ts";
import { scriptedFrom, spendLedger, stageProvider } from "../providers/index.ts";
import { loadRoutes } from "../routes.ts";
import type { AssetSpec, StyleBible, TargetProfile } from "../types.ts";
import { dryRunOutcome, formatPlan, formatRun, refusal } from "./result.ts";
import { defineCommand } from "./types.ts";

/** Every generator `stage` runs: the image kinds and 3D characters. */
const stageGenerators = [...imageGenerators, character3dGenerator];

interface StageArgs {
  spec: string;
  bible: string;
  profile: string;
  candidates?: number;
  cap?: number;
  routes?: string;
  runs?: string;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
}

export const stageCommand = defineCommand<StageArgs>({
  name: "stage",
  tool: null,
  summary: "generate candidates within a cost cap and stage those that pass QA",
  details: `Generates candidates through the Vercel AI Gateway (AI_GATEWAY_API_KEY from the environment)
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
  input: {
    type: "object",
    properties: {
      spec: { type: "string", description: "the asset spec", placeholder: "<spec.json>" },
      bible: { type: "string", description: "the style bible", placeholder: "<bible.json>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      candidates: {
        type: "number",
        description: "how many candidates to generate",
        default: DEFAULT_CANDIDATES,
      },
      cap: { type: "number", description: "the run's cost cap in USD", default: DEFAULT_CAP_USD },
      routes: { type: "string", description: "model routes", placeholder: "<routes.json>" },
      runs: {
        type: "string",
        description: "where runs are staged",
        default: ".assetgrove/runs",
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
  async run(args, ctx) {
    const ledger = spendLedger(args.workItem);
    const candidates = args.candidates ?? DEFAULT_CANDIDATES;
    const capUsd = args.cap ?? DEFAULT_CAP_USD;
    const spec = await readJson<AssetSpec>(args.spec);
    const bible = await readJson<StyleBible>(args.bible);
    const profile = await readJson<TargetProfile>(args.profile);
    const routes = await loadRoutes(args.routes);
    const plan = planStage({
      spec: spec.value,
      profile: profile.value,
      routes,
      generators: stageGenerators,
      candidates,
      capUsd,
    });
    const scripted = await scriptedFrom(args.providerScript);

    if (args.dryRun) {
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
      runsDir: resolve(args.runs ?? ".assetgrove/runs"),
      candidates,
      capUsd,
      ledger,
      log: ctx.log,
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
});
