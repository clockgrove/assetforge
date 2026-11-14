import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { InputError } from "../errors.ts";
import { failureOutcome } from "./result.ts";
import type { CommandSpec, JsonSchemaProperty, Outcome, RunContext } from "./types.ts";

type Args = Record<string, unknown>;

/** The CLI flag of an input property: its kebab-case name (`identityMode` is `--identity-mode`). */
export function flagName(property: string): string {
  return property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** The input properties a command takes as flags: every property that is not a positional. */
export function flagProperties(spec: CommandSpec): [string, JsonSchemaProperty][] {
  const positional = new Set((spec.positionals ?? []).map((p) => p.name));
  return Object.entries(spec.input.properties).filter(([name]) => !positional.has(name));
}

/** Every flag a command accepts on the command line, `--help` and (unless it opts out) `--json`. */
export function cliFlags(spec: CommandSpec): string[] {
  return [
    ...flagProperties(spec).map(([name]) => flagName(name)),
    ...(spec.json === false ? [] : ["json"]),
    "help",
  ];
}

function parseOptions(spec: CommandSpec): ParseArgsOptionsConfig {
  const options: ParseArgsOptionsConfig = {};
  for (const [name, property] of flagProperties(spec)) {
    options[flagName(name)] =
      property.type === "boolean"
        ? { type: "boolean" }
        : property.type === "array"
          ? { type: "string", multiple: true }
          : { type: "string" };
  }
  if (spec.json !== false) options["json"] = { type: "boolean" };
  options["help"] = { type: "boolean" };
  return options;
}

/** A command-line string as the number its property declares. */
function coerce(flag: string, property: JsonSchemaProperty, raw: string): unknown {
  if (property.type !== "number" && property.type !== "integer") return raw;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) {
    throw new InputError(`--${flag} must be a number, got "${raw}"`);
  }
  if (property.type === "integer" && (!Number.isInteger(n) || n < (property.minimum ?? -Infinity)))
    throw new InputError(
      `--${flag} must be a whole number${property.minimum !== undefined ? ` of ${property.minimum} or more` : ""}, got "${raw}"`,
    );
  return n;
}

/** A command line's arguments as the command's input, and whether it asked for help. */
export function parseCommandLine(spec: CommandSpec, argv: string[]): { args: Args; help: boolean } {
  const positionals = spec.positionals ?? [];
  const parsed = parseArgs({
    args: argv,
    options: parseOptions(spec),
    strict: true,
    allowPositionals: positionals.length > 0,
  });
  const args: Args = {};
  for (const [name, property] of flagProperties(spec)) {
    const value = parsed.values[flagName(name)];
    if (value !== undefined)
      args[name] = typeof value === "string" ? coerce(flagName(name), property, value) : value;
  }
  const rest = [...parsed.positionals];
  for (const p of positionals) {
    if (rest.length === 0) break;
    args[p.name] = p.variadic ? rest.splice(0) : rest.shift();
  }
  if (rest.length > 0) throw new InputError(`unexpected argument "${rest[0]}"`);
  return { args, help: parsed.values["help"] === true };
}

/**
 * Checks a command's input: every required option present and not empty, then the whole object
 * against the spec's input schema through the MCP SDK's JSON Schema validator.
 */
export async function validateArgs(spec: CommandSpec, args: Args): Promise<void> {
  const missing = (spec.input.required ?? []).filter(
    (name) => args[name] === undefined || args[name] === "",
  );
  if (missing.length > 0) {
    throw new InputError(
      `missing required option ${missing.map((n) => `--${flagName(n)}`).join(", ")}`,
    );
  }
  const result = await fromJsonSchema<Args>(spec.input)["~standard"].validate(args);
  if (result.issues) {
    throw new InputError(
      `invalid ${spec.name} input: ${result.issues.map((i) => i.message).join("; ")}`,
    );
  }
}

/** Validates a command's input and runs it; a thrown error becomes its refusal outcome. */
export async function runCommand(spec: CommandSpec, args: Args, ctx: RunContext): Promise<Outcome> {
  try {
    await validateArgs(spec, args);
    return await spec.run(args, ctx);
  } catch (error) {
    return failureOutcome(error);
  }
}

function valueHint(name: string, property: JsonSchemaProperty): string {
  if (property.type === "boolean") return "";
  const hint =
    property.placeholder ??
    (property.default !== undefined ? String(property.default) : `<${flagName(name)}>`);
  return ` ${hint}${property.type === "array" ? "..." : ""}`;
}

/** A command's help, derived from its spec: the usage line, summary, details and every option. */
export function commandUsage(spec: CommandSpec): string {
  const required = new Set(spec.input.required ?? []);
  const flags = flagProperties(spec);
  const positionals = (spec.positionals ?? []).map((p) => {
    const property = spec.input.properties[p.name];
    return `${property?.placeholder ?? `<${p.name}>`}${p.variadic ? "..." : ""}`;
  });
  const usage = [
    `Usage: assetgrove ${spec.name}`,
    ...positionals,
    ...flags.filter(([n]) => required.has(n)).map(([n, p]) => `--${flagName(n)}${valueHint(n, p)}`),
    ...flags
      .filter(([n]) => !required.has(n))
      .map(([n, p]) => `[--${flagName(n)}${valueHint(n, p)}]`),
    ...(spec.json === false ? [] : ["[--json]"]),
  ].join(" ");
  const options = [
    ...flags.map(([n, p]) => [`--${flagName(n)}${valueHint(n, p)}`, p.description] as const),
    ...(spec.json === false
      ? []
      : ([["--json", "print exactly one JSON document on stdout"]] as const)),
    ["--help", "print this usage"] as const,
  ];
  const width = Math.max(...options.map(([flag]) => flag.length));
  return [
    usage,
    "",
    `${spec.summary[0]!.toUpperCase()}${spec.summary.slice(1)}.`,
    ...(spec.details ? ["", spec.details] : []),
    "",
    "Options:",
    ...options.map(([flag, text]) => `  ${flag.padEnd(width)}  ${text}`),
  ].join("\n");
}
