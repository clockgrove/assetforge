import { createInterface } from "node:readline";
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

/** MCP stdio transport: one JSON-RPC message per line, with no logs on stdout. */
export async function serveMcp(
  context: ToolContext = {},
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const send = (value: unknown) => output.write(`${JSON.stringify(value)}\n`);
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      request = parsed as Record<string, unknown>;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const id = request["id"];
    const method = request["method"];
    if (request["jsonrpc"] !== "2.0" || typeof method !== "string") {
      send({ jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid Request" } });
      continue;
    }
    if (id === undefined) continue;
    try {
      let result: unknown;
      if (method === "initialize") {
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "assetforge", version: "0.0.0" },
        };
      } else if (method === "ping") result = {};
      else if (method === "tools/list") result = { tools };
      else if (method === "tools/call") {
        const params = request["params"] as { name?: unknown; arguments?: unknown } | undefined;
        try {
          if (typeof params?.name !== "string") throw new InputError("missing tool name");
          const args = params.arguments ?? {};
          if (typeof args !== "object" || args === null || Array.isArray(args))
            throw new InputError("tool arguments must be an object");
          const value = await generationTool(params.name, args as Arguments, context);
          result = { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
        } catch (error) {
          result = {
            content: [
              { type: "text", text: error instanceof Error ? error.message : String(error) },
            ],
            isError: true,
          };
        }
      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
        continue;
      }
      send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}
