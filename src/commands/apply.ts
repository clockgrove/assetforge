import { InputError } from "../errors.ts";
import { generationTool } from "../mcp.ts";
import { planningContext } from "../providers/index.ts";
import { formatRun, refusal } from "./result.ts";
import { defineCommand } from "./types.ts";

interface ApplyArgs {
  plan?: string;
  autoApprove?: boolean;
  out?: string;
  workItem?: string;
  providerScript?: string;
}

export const applyCommand = defineCommand<ApplyArgs>({
  name: "apply",
  tool: "apply",
  summary: "generate exactly a saved plan after explicit spend approval",
  details: `Refuses stale bible, template and identity inputs before generation.
Set the plan's approved field to true after review, or use --auto-approve for unattended runs.
Approval authorizes this generation spend; resulting assets remain pending review. Never prompts.`,
  input: {
    type: "object",
    properties: {
      plan: { type: "string", description: "the saved plan", placeholder: "<plan.json>" },
      autoApprove: { type: "boolean", description: "approve the plan's spend without review" },
      out: {
        type: "string",
        description: "where runs are staged",
        placeholder: "<runs directory>",
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
    },
    additionalProperties: false,
  },
  positionals: [{ name: "plan" }],
  effect: { readOnly: false, spends: "always", writes: "runs" },
  async run(args, ctx) {
    if (args.plan === undefined) throw new InputError("apply requires exactly one plan file");
    const result = await generationTool(
      "apply",
      { plan: args.plan, autoApprove: args.autoApprove === true, out: args.out },
      { ...(await planningContext(args.providerScript, args.workItem)), log: ctx.log },
    );
    const fields = { ...result };
    const human = formatRun(result.run, result.runDir);
    if (result.run.candidates.length === 0)
      return refusal("qa_found_nothing", "no candidate passed QA", fields, human);
    return { exitCode: 0, fields, human };
  },
});
