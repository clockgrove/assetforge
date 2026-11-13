import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import { describeBible, initBible, useBiblePreset } from "./bible.ts";
import { InputError, ProviderError } from "./errors.ts";
import type { GenerationProvider } from "./gateway/provider.ts";
import { readJson } from "./loop.ts";
import { applyPlan, createPlan, savePlan } from "./planning.ts";
import type { GenerationBrief, RunSettings } from "./planning.ts";
import { loadRoutes } from "./routes.ts";
import type { SpendLedger } from "./spend.ts";
import type { AssetSpec, TargetProfile } from "./types.ts";

export interface ToolContext {
  provider?: GenerationProvider;
  providerName?: string;
  /** The cross-run spend ledger every paid call also reserves against (src/spend.ts). */
  ledger?: SpendLedger;
  /** Receives one line per provider decision call during apply. */
  log?: (message: string) => void;
}

type Arguments = Record<string, unknown>;

function stringArg(args: Arguments, key: string, required = true): string | undefined {
  const value = args[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim() === "")
    throw new InputError(`missing or invalid ${key}`);
  return value;
}

/** CLI and MCP share the same file loading and generation entry points. */
export function generationTool(
  name: "apply",
  args: Arguments,
  context?: ToolContext,
): ReturnType<typeof applyPlan>;
export function generationTool(
  name: string,
  args: Arguments,
  context?: ToolContext,
): Promise<Record<string, unknown>>;
export async function generationTool(
  name: string,
  args: Arguments,
  context: ToolContext = {},
): Promise<Record<string, unknown>> {
  if (name === "bible_describe") return describeBible(stringArg(args, "bible")!);
  if (name === "bible_preset") {
    return useBiblePreset({
      biblePath: stringArg(args, "bible")!,
      preset: stringArg(args, "preset")!,
    });
  }
  if (name === "bible_init") {
    return initBible({
      directory: stringArg(args, "directory")!,
      world: stringArg(args, "world")!,
      preset: stringArg(args, "preset")! as Parameters<typeof initBible>[0]["preset"],
    });
  }
  if (name === "plan") {
    const spec = await readJson<AssetSpec>(stringArg(args, "spec")!);
    const profile = await readJson<TargetProfile>(stringArg(args, "profile")!);
    const briefPath = stringArg(args, "brief", false);
    const settingsPath = stringArg(args, "settings", false);
    const plan = await createPlan({
      biblePath: stringArg(args, "bible")!,
      spec: spec.value,
      specDir: spec.dir,
      profile: profile.value,
      ...(briefPath && { brief: (await readJson<GenerationBrief>(briefPath)).value }),
      ...(settingsPath && { settings: (await readJson<Partial<RunSettings>>(settingsPath)).value }),
      ...(stringArg(args, "template", false) && { templatePath: args["template"] as string }),
      routes: await loadRoutes(stringArg(args, "routes", false)),
      ...(stringArg(args, "identityMode", false) && {
        identityMode: args["identityMode"] as string,
      }),
      ...context,
    });
    const planPath = resolve(stringArg(args, "out")!);
    await savePlan(plan, planPath);
    return { planPath, plan };
  }
  if (name === "apply") {
    if (args["autoApprove"] !== undefined && typeof args["autoApprove"] !== "boolean")
      throw new InputError("autoApprove must be a boolean");
    if (!context.provider) throw new ProviderError("apply requires a generation provider");
    const result = await applyPlan(stringArg(args, "plan")!, {
      provider: context.provider,
      providerName: context.providerName,
      ...(context.ledger && { ledger: context.ledger }),
      ...(context.log && { log: context.log }),
      autoApprove: args["autoApprove"] === true,
      ...(stringArg(args, "out", false) && { outDir: args["out"] as string }),
    });
    return result;
  }
  throw new InputError(`unknown generation tool ${name}`);
}

const stringProperty = { type: "string", minLength: 1 };
const tools = [
  {
    name: "bible_describe",
    description: "Read art direction, bounds, anchors, presets and identity locks as JSON.",
    inputSchema: {
      type: "object",
      properties: { bible: stringProperty },
      required: ["bible"],
      additionalProperties: false,
    },
  },
  {
    name: "bible_init",
    description:
      "Explicitly install a bible preset, Agent Skill and prompt template in a target repository.",
    inputSchema: {
      type: "object",
      properties: { directory: stringProperty, world: stringProperty, preset: stringProperty },
      required: ["directory", "world", "preset"],
      additionalProperties: false,
    },
  },
  {
    name: "bible_preset",
    description:
      "Switch a repository-owned art preset while preserving the world's palette, anchors and identity locks.",
    inputSchema: {
      type: "object",
      properties: { bible: stringProperty, preset: stringProperty },
      required: ["bible", "preset"],
      additionalProperties: false,
    },
  },
  {
    name: "plan",
    description:
      "Compile a reviewable generation plan without generating images; paths are server-local.",
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        [
          "spec",
          "profile",
          "bible",
          "brief",
          "settings",
          "template",
          "routes",
          "out",
          "identityMode",
        ].map((k) => [k, stringProperty]),
      ),
      required: ["spec", "profile", "bible", "out"],
      additionalProperties: false,
    },
  },
  {
    name: "apply",
    description:
      "Generate precisely a saved plan, refusing stale inputs; approval authorizes spend, never asset approval.",
    inputSchema: {
      type: "object",
      properties: { plan: stringProperty, autoApprove: { type: "boolean" }, out: stringProperty },
      required: ["plan"],
      additionalProperties: false,
    },
  },
];

/** One MCP server instance with the five tools, each calling generationTool with the shared context. */
function createServer(context: ToolContext): McpServer {
  // The tool list is fixed, so the server never sends list-changed notifications.
  const server = new McpServer(
    { name: "assetforge", version: "0.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: fromJsonSchema<Arguments>(tool.inputSchema) },
      // The SDK turns a thrown error into the tool error result { content: [text], isError: true }.
      async (args) => ({
        content: [
          { type: "text", text: JSON.stringify(await generationTool(tool.name, args, context)) },
        ],
        isError: false,
      }),
    );
  }
  return server;
}

/** Serves the tools over MCP stdio with the official SDK until the input closes; no logs on stdout. */
export async function serveMcp(
  context: ToolContext = {},
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const ended = new Promise<void>((done) => {
    input.once("end", done);
    input.once("close", done);
  });
  const handle = serveStdio(() => createServer(context), {
    transport: new StdioServerTransport(input, output),
    onerror: (error) => context.log?.(`mcp: ${error.message}`),
  });
  await ended;
  await handle.close();
}
