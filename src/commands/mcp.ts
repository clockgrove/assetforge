import { serveMcp } from "../mcp.ts";
import { planningContext } from "../providers/index.ts";
import { defineCommand } from "./types.ts";

interface McpArgs {
  workItem?: string;
  providerScript?: string;
}

export const mcpCommand = defineCommand<McpArgs>({
  name: "mcp",
  tool: null,
  summary: "serve bible, plan and apply tools over MCP stdio",
  details: `Serves MCP over stdio with the official MCP SDK. Model keys come from the environment.
Tools: bible_describe, bible_init, bible_preset, plan, apply. File paths are local to this server.`,
  json: false,
  input: {
    type: "object",
    properties: {
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
  effect: { readOnly: false, spends: "conditional", writes: "target" },
  async run(args, ctx) {
    // Decision-call log lines go to stderr; stdout carries only JSON-RPC.
    await serveMcp({
      ...(await planningContext(args.providerScript, args.workItem)),
      log: ctx.log,
    });
    return { exitCode: 0, fields: {}, human: "" };
  },
});
