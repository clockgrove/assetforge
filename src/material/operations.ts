import type { OperationSpec } from "../transform/types.ts";
import type { ParamSchema } from "../transform/schema.ts";
const grid: ParamSchema = {
  type: "object",
  properties: {
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
    count: { type: "integer", minimum: 1 },
  },
  required: ["width", "height", "count"],
};
const string: ParamSchema = { type: "string" };
const argv: ParamSchema = { type: "array", items: string, minItems: 1 };
export const MATERIAL_OPERATIONS: OperationSpec[] = [
  ...["normal", "height", "emissive", "roughness", "wind"].map((channel) => ({
    name: `material-${channel}`,
    summary: `derive ${channel} using a declared versioned method`,
    scope: "each" as const,
    params: {
      type: "object" as const,
      properties: {
        grid,
        method: {
          type: "string" as const,
          enum: ["mask-extraction", "model-assisted-painting", "height-derived-normal"],
        },
        version: string,
        path: string,
        component: { type: "string" as const, enum: ["red", "alpha", "luminance"], default: "red" },
        strength: { type: "number" as const, minimum: 0, default: 1 },
        lightSources: { type: "array" as const, items: string, default: [] },
      },
      required: ["grid", "method", "version"],
    },
  })),
  {
    name: "material-rendition",
    summary: "resample native material pixels with normal renormalization",
    scope: "each",
    params: {
      type: "object",
      properties: {
        grid,
        scale: { type: "integer", minimum: 1, maximum: 4 },
        native: { type: "number", minimum: 1 },
        normal: { type: "boolean", default: false },
      },
      required: ["grid", "scale", "native"],
    },
  },
  {
    name: "material-encode",
    summary: "encode a material with a bounded target GPU command",
    scope: "each",
    params: {
      type: "object",
      properties: { command: argv, version: string, input: string, output: string, cwd: string },
      required: ["command", "version", "input", "output", "cwd"],
    },
  },
];
