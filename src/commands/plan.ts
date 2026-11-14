import { generationTool } from "../mcp.ts";
import { planningContext } from "../providers/index.ts";
import { defineCommand } from "./types.ts";

interface PlanArgs {
  spec: string;
  bible: string;
  profile: string;
  out: string;
  brief?: string;
  settings?: string;
  template?: string;
  routes?: string;
  identityMode?: string;
  workItem?: string;
  providerScript?: string;
}

export const planCommand = defineCommand<PlanArgs>({
  name: "plan",
  tool: "plan",
  summary: "compile a reviewable generation plan; never generate images",
  details: `--identity-mode overrides the profile's identity.mode for a character with an identity lock:
shadow (the default) scores candidates beside QA without filtering, enforce filters those below
the threshold, off skips scoring. The forecast includes the scoring calls.
The configured compiler LLM writes prompt and negatives from repository templates.
Without an available LLM, a marked deterministic template fallback is recorded.
Review the saved plan before apply; this command never generates images.`,
  input: {
    type: "object",
    properties: {
      spec: { type: "string", description: "the asset spec", placeholder: "<spec.json>" },
      bible: { type: "string", description: "the art bible", placeholder: "<BIBLE.md>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      out: { type: "string", description: "where the plan is saved", placeholder: "<plan.json>" },
      brief: { type: "string", description: "the generation brief", placeholder: "<brief.json>" },
      settings: {
        type: "string",
        description: "the run settings",
        placeholder: "<settings.json>",
      },
      template: {
        type: "string",
        description: "the prompt template",
        placeholder: "<template.md>",
      },
      routes: { type: "string", description: "model routes", placeholder: "<routes.json>" },
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
    },
    required: ["spec", "bible", "profile", "out"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "out" },
  async run(args) {
    const result = await generationTool(
      "plan",
      {
        spec: args.spec,
        bible: args.bible,
        profile: args.profile,
        out: args.out,
        brief: args.brief,
        settings: args.settings,
        template: args.template,
        routes: args.routes,
        identityMode: args.identityMode,
      },
      await planningContext(args.providerScript, args.workItem),
    );
    return { exitCode: 0, fields: { ...result }, human: JSON.stringify(result, null, 2) };
  },
});
