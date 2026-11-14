import type { ErrorCode } from "../errors.ts";

/** What running a command can do: whether it only reads, whether it spends, and where it writes. */
export interface Effect {
  readOnly: boolean;
  spends: "never" | "always" | "conditional";
  writes: "none" | "runs" | "out" | "target" | "settings";
}

/** A JSON Schema for one property of a command's input. */
export interface JsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "array";
  description: string;
  items?: { type: "string" };
  /** The value the command uses when the option is absent; shown in help, applied by the command. */
  default?: string | number | boolean;
  minimum?: number;
  /** How help shows the value, for example `<spec.json>`; defaults to `<name>`. */
  placeholder?: string;
}

/** A command's input: an object schema whose properties are its options and positionals. */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties: false;
}

/** What a run of a command is given besides its arguments. */
export interface RunContext {
  /** Receives log lines; the CLI sends them to stderr. */
  log: (message: string) => void;
}

/** A refusal's code and message; a spend-limit refusal also names the limit and its numbers. */
export interface Failure {
  code: ErrorCode;
  message: string;
  limit?: {
    name: string;
    workItem?: string;
    limitUsd: number;
    spentUsd: number;
    requestedUsd: number;
    ledger: string;
  };
}

/** What a command produced: the JSON fields, the human summary and an optional refusal. */
export interface Outcome {
  exitCode: number;
  fields: Record<string, unknown>;
  human: string;
  error?: Failure;
}

/** The calls a paid command would make and what they would cost, against its cap. */
export interface WorkPlan {
  estimateUsd: number;
  capUsd: number;
  withinCap: boolean;
  [field: string]: unknown;
}

/** One command, declared once: its input schema and effect, and how it runs. */
export interface CommandSpec<A = Record<string, unknown>> {
  name: string;
  /** The MCP tool that serves this command, or null when no tool does. */
  tool: string | null;
  summary: string;
  details: string;
  input: JsonSchemaObject;
  positionals?: { name: string; variadic?: boolean }[];
  effect: Effect;
  confirm?: "spend" | "pick" | "write" | "settings";
  /** False when the command prints no JSON document (it takes no --json). Defaults to true. */
  json?: false;
  /** The free plan step of a paid command. */
  plan?(args: A, ctx: RunContext): Promise<WorkPlan>;
  run(args: A, ctx: RunContext): Promise<Outcome>;
}

/**
 * Declares a command with its typed arguments; the registry holds every command at one type. The
 * runner validates the arguments against `input` before `run` sees them.
 */
export function defineCommand<A>(spec: CommandSpec<A>): CommandSpec {
  return spec as unknown as CommandSpec;
}
