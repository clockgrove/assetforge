import { resolve } from "node:path";
import { readJson, readModel } from "../inputs.ts";
import { lookDev, planLookdev } from "../model3d/lookdev/command.ts";
import { gatewayProvider, scriptedFrom, spendLedger } from "../providers/index.ts";
import { loadRoutes } from "../routes.ts";
import type { AssetSpec, StyleBible, TargetProfile } from "../types.ts";
import { readProvenance } from "../model3d/rig/command.ts";
import { dryRunOutcome, formatRun, refusal, usd } from "./result.ts";
import { defineCommand } from "./types.ts";

interface LookDevArgs {
  model: string;
  provenance: string;
  spec: string;
  bible: string;
  profile: string;
  cap?: number;
  routes?: string;
  runs?: string;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
}

export const lookDevCommand = defineCommand<LookDevArgs>({
  name: "look-dev",
  tool: null,
  summary: "give a picked 3D character its look: base colour, fur groom maps and eyes",
  details: `Repaints a picked character's base colour on its own UVs in the look the bible's approved
references define (restyled renders projected back onto the model), writes fur groom maps
(length, direction, density) and tint textures per season the profile declares
(model3d.groom), gives the eyes their own glossy material and mask, and checks them: the
maps' zero-length masks, map-driven shell-fur renders, UV seams, the eyes' catch-light at the
closest zoom and the identity lock. Before-and-after renders beside the approved turnaround
are written for the person who approves; pick hands the result off. The cap defaults to
model3d.lookdev.capUsd or $3 and is reserved before any call (docs/look-dev.md).`,
  input: {
    type: "object",
    properties: {
      model: { type: "string", description: "the character model", placeholder: "<model.glb>" },
      provenance: {
        type: "string",
        description: "the model's provenance",
        placeholder: "<provenance.json>",
      },
      spec: { type: "string", description: "the asset spec", placeholder: "<spec.json>" },
      bible: { type: "string", description: "the style bible", placeholder: "<bible.json>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      cap: {
        type: "number",
        description: "the run's cost cap in USD; defaults to the profile's look-dev cap",
        placeholder: "<usd>",
      },
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
    required: ["model", "provenance", "spec", "bible", "profile"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "runs" },
  async run(args, ctx) {
    const ledger = spendLedger(args.workItem);
    const spec = await readJson<AssetSpec>(args.spec);
    const bible = await readJson<StyleBible>(args.bible);
    const profile = await readJson<TargetProfile>(args.profile);
    const routes = await loadRoutes(args.routes);
    const capUsd = args.cap;
    const plan = planLookdev(profile.value, routes, capUsd);
    const scripted = await scriptedFrom(args.providerScript);
    if (args.dryRun) {
      const human = [
        `look-dev: ${plan.calls.length} call(s), forecast ${usd(plan.estimateUsd)} against the $${plan.capUsd.toFixed(2)} cap`,
        ...plan.calls.map((c) => `  ${c.operation}  ${c.model}  ${usd(c.estimatedCostUsd)}`),
        `  seasons: ${plan.seasons.join(", ")}`,
      ].join("\n");
      return dryRunOutcome(plan, human, ledger.forProfile(profile.value), scripted?.name);
    }
    const model = await readModel(args.model);
    const { run, runDir, passed } = await lookDev({
      model,
      provenance: await readProvenance(args.provenance),
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
      runsDir: resolve(args.runs ?? ".assetgrove/runs"),
      ...(capUsd !== undefined && { capUsd }),
      log: ctx.log,
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
});
