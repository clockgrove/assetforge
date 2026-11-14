import { resolve } from "node:path";
import { Budget } from "../budget.ts";
import { Caller } from "../calls.ts";
import { InputError } from "../errors.ts";
import { declarationOption, readJson } from "../inputs.ts";
import { DEFAULT_CAP_USD } from "../loop.ts";
import { runMaterials } from "../material/pipeline.ts";
import type { MaterialDerivation } from "../material/pipeline.ts";
import { resolveMaterialProfile } from "../material/profile.ts";
import { dryRunProvider, providerFor, spendLedger } from "../providers/index.ts";
import { loadRoutes } from "../routes.ts";
import { ledgerFor } from "../spend.ts";
import type { AssetSpec, TargetProfile } from "../types.ts";
import { dryRunOutcome, refusal, usd } from "./result.ts";
import { defineCommand } from "./types.ts";

interface MaterialsArgs {
  albedo: string;
  spec: string;
  profile: string;
  derivation: string;
  out: string;
  cap?: number;
  routes?: string;
  workItem?: string;
  digitalSourceType?: string;
  providerScript?: string;
  dryRun?: boolean;
}

export const materialsCommand = defineCommand<MaterialsArgs>({
  name: "materials",
  tool: null,
  summary: "derive and check material maps, native renditions and target lit previews",
  details: `Derives the channels requested by style.materials, checks alignment and temporal stability,
writes native-resolution renditions, runs target compression and dusk-rain/night previews,
and judges the flat and lit images with vision QA. Rejected materials exit 5 and remain
unapproved. Model calls reserve against --cap. See docs/materials.md.`,
  input: {
    type: "object",
    properties: {
      albedo: {
        type: "string",
        description: "the painted albedo image",
        placeholder: "<painted.png>",
      },
      spec: { type: "string", description: "the asset spec", placeholder: "<spec.json>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      derivation: {
        type: "string",
        description: "the declared method and version of every channel",
        placeholder: "<derivation.json>",
      },
      out: {
        type: "string",
        description: "where maps, renditions and the report are written",
        placeholder: "<directory>",
      },
      cap: { type: "number", description: "the run's cost cap in USD", default: DEFAULT_CAP_USD },
      routes: { type: "string", description: "model routes", placeholder: "<routes.json>" },
      workItem: {
        type: "string",
        description: "the work item the spend ledger counts against",
        placeholder: "<label>",
      },
      digitalSourceType: {
        type: "string",
        description: "the IPTC digital source type to declare",
        placeholder: "<IPTC code or URI>",
      },
      providerScript: {
        type: "string",
        description: "answer every model call from this module instead of a provider",
        placeholder: "<module>",
      },
      dryRun: { type: "boolean", description: "print the plan and forecast; spend nothing" },
    },
    required: ["albedo", "spec", "profile", "derivation", "out"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "out" },
  async run(args) {
    const spec = await readJson<AssetSpec>(args.spec);
    const profile = await readJson<TargetProfile>(args.profile);
    const derivation = await readJson<MaterialDerivation>(args.derivation);
    const routes = await loadRoutes(args.routes);
    routes["material-qa"] ??= routes.vision;
    const config = resolveMaterialProfile(profile.value.style?.materials);
    const capUsd = args.cap ?? DEFAULT_CAP_USD;
    const ledger = spendLedger(args.workItem).forProfile(profile.value);
    new Budget(capUsd);
    if (args.dryRun) {
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
      return dryRunOutcome(plan, human, ledger, await dryRunProvider(args.providerScript));
    }
    const { provider, name } = await providerFor(args.providerScript);
    const call = new Caller({
      provider,
      providerName: name,
      budget: new Budget(capUsd, ledgerFor(ledger, name)),
      routes,
    });
    const declared = declarationOption(args.digitalSourceType);
    const result = await runMaterials({
      albedoPath: resolve(args.albedo),
      ...(declared && { digitalSourceType: declared }),
      spec: spec.value,
      profile: profile.value,
      derivation: derivation.value,
      baseDir: derivation.dir,
      profileDir: profile.dir,
      outDir: resolve(args.out),
      call,
    });
    const fields = { ...result };
    const human = `materials ${result.passed ? "passed QA" : "failed QA"}: ${result.reportPath}`;
    if (!result.passed)
      return refusal("qa_found_nothing", "material maps failed QA", fields, human);
    return { exitCode: 0, fields, human };
  },
});
