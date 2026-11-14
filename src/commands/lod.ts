import { resolve } from "node:path";
import { InputError } from "../errors.ts";
import { readJson, readModel } from "../inputs.ts";
import { lodChain } from "../model3d/lod/command.ts";
import { readProvenance } from "../model3d/rig/command.ts";
import type { AssetSpec, TargetProfile } from "../types.ts";
import { formatRun, refusal } from "./result.ts";
import { defineCommand } from "./types.ts";

interface LodArgs {
  run?: string;
  candidate?: string;
  model?: string;
  provenance?: string;
  spec?: string;
  profile?: string;
  runs?: string;
}

/** The named options, each present or a refusal in the wording of a missing required option. */
function need<K extends keyof LodArgs>(args: LodArgs, flags: Record<K, string>): Record<K, string> {
  const names = Object.keys(flags) as K[];
  const missing = names.filter((n) => typeof args[n] !== "string" || args[n] === "");
  if (missing.length > 0) {
    throw new InputError(`missing required option ${missing.map((n) => flags[n]).join(", ")}`);
  }
  return Object.fromEntries(names.map((n) => [n, args[n] as string])) as Record<K, string>;
}

export const lodCommand = defineCommand<LodArgs>({
  name: "lod",
  tool: null,
  summary: "make a 3D model's detail levels and texture tiers within the target's budgets",
  details: `Two forms: --run and --candidate (with optional --profile) name a staged candidate;
--model, --provenance, --spec and --profile name a given .glb.

Makes the detail-level chain the target profile declares (model3d.lods) from a staged candidate
or a given .glb: each lower level simplifies the index lists only, so the skeleton, skin weights,
clips and UVs stay as they are. Then, per quality tier (model3d.tiers), a rendition with the levels
within its triangle budget, its textures and look-dev side maps within its size, or those maps
dropped where the tier draws no fur. Each level is checked against the full model (silhouette in
the turntable views and clip frames, skin, UVs, clips) and left out, with the reason, when it
fails. The levels are packaged as model3d.handoff.lods declares (embedded or files) and staged as
a one-candidate run that pick hands off. No model is called and nothing is spent
(docs/characters-3d.md).`,
  input: {
    type: "object",
    properties: {
      run: { type: "string", description: "the staged run directory", placeholder: "<run dir>" },
      candidate: { type: "string", description: "the candidate in that run", placeholder: "<id>" },
      model: { type: "string", description: "the character model", placeholder: "<model.glb>" },
      provenance: {
        type: "string",
        description: "the model's provenance",
        placeholder: "<provenance.json>",
      },
      spec: { type: "string", description: "the asset spec", placeholder: "<spec.json>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      runs: {
        type: "string",
        description: "where runs are staged",
        default: ".assetgrove/runs",
      },
    },
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "never", writes: "runs" },
  async run(args) {
    const runsDir = resolve(args.runs ?? ".assetgrove/runs");
    const profile =
      typeof args.profile === "string" ? await readJson<TargetProfile>(args.profile) : undefined;
    let result;
    if (typeof args.run === "string") {
      const files = need(args, { run: "--run", candidate: "--candidate" });
      result = await lodChain({
        run: { dir: resolve(files.run), candidate: files.candidate },
        ...(profile && { profile: profile.value }),
        runsDir,
      });
    } else {
      const files = need(args, {
        model: "--model",
        provenance: "--provenance",
        spec: "--spec",
        profile: "--profile",
      });
      const model = await readModel(files.model);
      const spec = await readJson<AssetSpec>(files.spec);
      result = await lodChain({
        model,
        provenance: await readProvenance(files.provenance),
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
});
