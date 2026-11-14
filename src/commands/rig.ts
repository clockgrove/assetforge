import { resolve } from "node:path";
import { readJson, readModel } from "../inputs.ts";
import { readProvenance, rerig } from "../model3d/rig/command.ts";
import type { AssetSpec, TargetProfile } from "../types.ts";
import { formatRun, refusal } from "./result.ts";
import { defineCommand } from "./types.ts";

interface RigArgs {
  model: string;
  provenance: string;
  spec: string;
  profile: string;
  runs?: string;
}

export const rigCommand = defineCommand<RigArgs>({
  name: "rig",
  tool: null,
  summary: "re-rig a 3D character on the target's shared rig with generated gaits and motions",
  details: `Fits the target profile's skeleton template (model3d.rig) to an existing character model, such
as a picked candidate, skins it, generates the clips its gait profiles (model3d.gaits) and
motions (model3d.motions) declare for the spec's clips, and checks foot contact, joint limits,
skinning, loops and one-shot ends per clip. The result is staged as a one-candidate run, with
turntable renders, side views and a looping preview per clip, that pick hands off
as for stage. The source's provenance is carried over with the rig's hashes. No model is called
and nothing is spent (docs/characters-3d.md).`,
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
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      runs: {
        type: "string",
        description: "where runs are staged",
        default: ".assetgrove/runs",
      },
    },
    required: ["model", "provenance", "spec", "profile"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "never", writes: "runs" },
  async run(args) {
    const model = await readModel(args.model);
    const spec = await readJson<AssetSpec>(args.spec);
    const profile = await readJson<TargetProfile>(args.profile);
    const { run, runDir, passed } = await rerig({
      model,
      provenance: await readProvenance(args.provenance),
      spec: spec.value,
      specDir: spec.dir,
      profile: profile.value,
      profileDir: profile.dir,
      runsDir: resolve(args.runs ?? ".assetgrove/runs"),
    });
    const fields = { runDir, ...run };
    const human = formatRun(run, runDir);
    if (passed) return { exitCode: 0, fields, human };
    return refusal("qa_found_nothing", "the re-rigged model did not pass QA", fields, human);
  },
});
