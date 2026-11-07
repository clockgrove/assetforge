import { InputError } from "../errors.ts";
import { validate } from "../transform/schema.ts";
import type { ParamSchema } from "../transform/schema.ts";
import type { MaterialChannel } from "./core.ts";

export const MATERIAL_CHANNELS: MaterialChannel[] = [
  "normal",
  "height",
  "emissive",
  "roughness",
  "wind",
];

export interface MaterialProfile {
  channels?: MaterialChannel[];
  scales?: (1 | 2 | 4)[];
  flickerBound?: number | Partial<Record<MaterialChannel, number>>;
  encoding?: Partial<Record<MaterialChannel, { range: [number, number]; encoding: "unorm8" }>>;
  compression?: { command: string[]; version: string; format?: "ktx2" | "basis" };
  preview?: { command: string[]; version: string };
  lightRig?: Record<string, unknown>;
}

export interface ResolvedMaterialProfile extends MaterialProfile {
  channels: MaterialChannel[];
  scales: (1 | 2 | 4)[];
  flickerBound: number | Partial<Record<MaterialChannel, number>>;
}

const bound: ParamSchema = { type: "number", minimum: 0, maximum: 1 };
const command: ParamSchema = {
  type: "object",
  properties: {
    command: { type: "array", items: { type: "string" }, minItems: 1 },
    version: { type: "string" },
  },
  required: ["command", "version"],
};
const encoding: ParamSchema = {
  type: "object",
  properties: {
    encoding: { type: "string", enum: ["unorm8"], default: "unorm8" },
    range: { type: "array", items: bound, minItems: 2, default: [0, 1] },
  },
};

export const MATERIAL_PROFILE_SCHEMA: ParamSchema = {
  type: "object",
  properties: {
    channels: {
      type: "array",
      items: { type: "string", enum: MATERIAL_CHANNELS },
      default: MATERIAL_CHANNELS,
    },
    scales: { type: "array", items: { type: "integer", minimum: 1, maximum: 4 }, default: [1, 2] },
    encoding: {
      type: "object",
      properties: Object.fromEntries(MATERIAL_CHANNELS.map((c) => [c, encoding])),
    },
    compression: {
      ...command,
      properties: {
        ...command.properties,
        format: { type: "string", enum: ["ktx2", "basis"], default: "ktx2" },
      },
    },
    preview: command,
  },
};

function jsonData(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonData);
  return typeof value === "object" && Object.values(value).every(jsonData);
}

export function resolveMaterialProfile(value: unknown): ResolvedMaterialProfile {
  if (value === undefined) value = {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new InputError("style.materials must be an object");
  const { flickerBound, lightRig, ...rest } = value as Record<string, unknown>;
  const resolved = validate(
    MATERIAL_PROFILE_SCHEMA,
    rest,
    "style.materials",
  ) as ResolvedMaterialProfile;
  if (new Set(resolved.channels).size !== resolved.channels.length)
    throw new InputError("material channels must be unique");
  if (
    !resolved.scales.includes(1) ||
    !resolved.scales.includes(2) ||
    resolved.scales.some((s) => ![1, 2, 4].includes(s)) ||
    new Set(resolved.scales).size !== resolved.scales.length
  )
    throw new InputError("material scales require 1 and 2, optionally 4");
  resolved.flickerBound =
    flickerBound === undefined
      ? 0.03
      : typeof flickerBound === "number"
        ? (validate(bound, flickerBound, "style.materials.flickerBound") as number)
        : (validate(
            {
              type: "object",
              properties: Object.fromEntries(MATERIAL_CHANNELS.map((c) => [c, bound])),
              required: resolved.channels,
            },
            flickerBound,
            "style.materials.flickerBound",
          ) as Partial<Record<MaterialChannel, number>>);
  for (const item of Object.values(resolved.encoding ?? {}))
    if (item.range.length !== 2 || item.range[0] > item.range[1])
      throw new InputError("material encoding range must be an ordered pair");
  for (const item of [resolved.compression, resolved.preview])
    if (item && (!item.version.trim() || item.command.some((arg) => !arg.trim())))
      throw new InputError("material command and version must be nonempty");
  if (lightRig !== undefined) {
    if (
      typeof lightRig !== "object" ||
      lightRig === null ||
      Array.isArray(lightRig) ||
      !jsonData(lightRig)
    )
      throw new InputError("style.materials.lightRig must be a JSON object");
    resolved.lightRig = structuredClone(lightRig) as Record<string, unknown>;
  }
  return resolved;
}
