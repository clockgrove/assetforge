/**
 * A small JSON-Schema subset for operation parameters: enough to validate recipes, list the
 * schemas for agents (`assetgrove ops`) and fill defaults, with no dependency. Objects reject
 * unknown keys.
 */
import { InputError } from "../errors.ts";

export type ParamSchema =
  | {
      type: "integer" | "number";
      minimum?: number;
      maximum?: number;
      exclusiveMinimum?: number;
      default?: number;
      description?: string;
    }
  | { type: "string"; enum?: string[]; default?: string; description?: string }
  | { type: "boolean"; default?: boolean; description?: string }
  | {
      type: "array";
      items: ParamSchema;
      minItems?: number;
      default?: unknown[];
      description?: string;
    }
  | {
      type: "object";
      properties: Record<string, ParamSchema>;
      required?: string[];
      description?: string;
    };

function fail(path: string, message: string): never {
  throw new InputError(`${path}: ${message}`);
}

/**
 * Validates `value` against `schema` and returns a copy with object defaults filled in. Throws an
 * InputError naming the offending path.
 */
export function validate(schema: ParamSchema, value: unknown, path = "params"): unknown {
  switch (schema.type) {
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        fail(path, `must be a ${schema.type}`);
      if (schema.type === "integer" && !Number.isInteger(value)) fail(path, "must be an integer");
      if (schema.minimum !== undefined && value < schema.minimum)
        fail(path, `must be at least ${schema.minimum}`);
      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
        fail(path, `must be greater than ${schema.exclusiveMinimum}`);
      if (schema.maximum !== undefined && value > schema.maximum)
        fail(path, `must be at most ${schema.maximum}`);
      return value;
    }
    case "string":
      if (typeof value !== "string") fail(path, "must be a string");
      if (schema.enum && !schema.enum.includes(value))
        fail(path, `must be one of ${schema.enum.map((e) => `"${e}"`).join(", ")}`);
      return value;
    case "boolean":
      if (typeof value !== "boolean") fail(path, "must be true or false");
      return value;
    case "array": {
      if (!Array.isArray(value)) fail(path, "must be an array");
      if (schema.minItems !== undefined && value.length < schema.minItems)
        fail(path, `must have at least ${schema.minItems} item(s)`);
      return value.map((v, i) => validate(schema.items, v, `${path}[${i}]`));
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        fail(path, "must be an object");
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) {
          const known = Object.keys(schema.properties);
          fail(
            path,
            `unknown parameter "${key}"` +
              (known.length > 0 ? ` (expected ${known.join(", ")})` : " (takes none)"),
          );
        }
      }
      const out: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(schema.properties)) {
        const v = record[key];
        if (v === undefined) {
          if (schema.required?.includes(key)) fail(`${path}.${key}`, "is required");
          if ("default" in sub && sub.default !== undefined)
            out[key] = structuredClone(sub.default);
          continue;
        }
        out[key] = validate(sub, v, `${path}.${key}`);
      }
      return out;
    }
  }
}
