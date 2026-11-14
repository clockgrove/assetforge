import { InputError } from "../errors.ts";
import { generationTool } from "../mcp.ts";
import { defineCommand } from "./types.ts";

interface BibleArgs {
  action?: string;
  bible?: string;
  directory?: string;
  world?: string;
  preset?: string;
}

export const bibleCommand = defineCommand<BibleArgs>({
  name: "bible",
  tool: null,
  summary: "describe a world's art constitution or initialize a repository preset",
  details: `Actions, each served over MCP as a tool of its own:
  describe  needs --bible; the tool is bible_describe
  init      needs --directory, --world and --preset; the tool is bible_init
  preset    needs --bible and --preset; the tool is bible_preset

Presets: cozy-storybook, flat-cartoon-kids, dark-gritty-isometric.
Initialization explicitly writes a bible, Agent Skill and repository-owned prompt template.`,
  input: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "describe, init or preset",
        placeholder: "<describe|init|preset>",
      },
      bible: { type: "string", description: "the art bible", placeholder: "<BIBLE.md>" },
      directory: {
        type: "string",
        description: "the target repository to initialize",
        placeholder: "<target repository>",
      },
      world: { type: "string", description: "the world's name", placeholder: "<name>" },
      preset: { type: "string", description: "the preset to apply", placeholder: "<preset>" },
    },
    additionalProperties: false,
  },
  positionals: [{ name: "action" }],
  effect: { readOnly: false, spends: "never", writes: "target" },
  async run(args) {
    if (!args.action || !["describe", "init", "preset"].includes(args.action))
      throw new InputError("bible requires describe, init or preset");
    const result = await generationTool(`bible_${args.action}`, {
      bible: args.bible,
      directory: args.directory,
      world: args.world,
      preset: args.preset,
    });
    return { exitCode: 0, fields: { ...result }, human: JSON.stringify(result, null, 2) };
  },
});
