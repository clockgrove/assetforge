/**
 * Running operations and recipes. `runOperation` and `runRecipe` work on items in memory;
 * `transformFiles` reads source files, runs a recipe and writes the outputs with their provenance
 * record. The CLI's `op` and `recipe` commands call `transformFiles`, and agents (MCP) and
 * campaigns call the same functions.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  DIGITAL_SOURCE_TYPES,
  combineDigitalSourceTypes,
  embedDigitalSourceType,
  readDigitalSourceType,
  metadataStep,
  sourceDeclaration,
} from "../metadata.ts";
import type { DigitalSourceType } from "../metadata.ts";
import { InputError } from "../errors.ts";
import type { Raster } from "../image/raster.ts";
import { sha256, sniffMediaType } from "../request.ts";
import { resolveStyle } from "../style.ts";
import type { ResolvedStyle } from "../style.ts";
import type { Size } from "../types.ts";
import { OPERATIONS, operationSpec } from "./operations.ts";
import { materialEngine } from "../material/engine.ts";
import { rasterEngine } from "./raster-engine.ts";
import { validate } from "./schema.ts";
import type {
  ImageEngine,
  ImageItem,
  OperationContext,
  Recipe,
  RecipeStep,
  TransformStep,
} from "./types.ts";

/** The engines available by default, in preference order. */
export const DEFAULT_ENGINES: ImageEngine[] = [rasterEngine, materialEngine];

export const RECIPE_FORMAT = "assetgrove-recipe/1";

/** SHA-256 over `rgba8 <width>x<height>\n` and the RGBA bytes: a hash of the pixels, not a file. */
export function pixelHash(r: Raster): string {
  return createHash("sha256").update(`rgba8 ${r.width}x${r.height}\n`).update(r.data).digest("hex");
}

export interface RunOptions {
  digitalSourceType?: DigitalSourceType;
  /** The style profile, defaults filled in; defaults to soft alpha, full colour, antialiased. */
  style?: ResolvedStyle;
  /** The target profile's frame size, which `register` defaults to. */
  frame?: Size;
  engines?: ImageEngine[];
  materialCall?: import("../calls.ts").Caller;
}

function contextOf(options: RunOptions): OperationContext {
  return {
    style: options.style ?? resolveStyle(undefined),
    ...(options.digitalSourceType !== undefined && {
      digitalSourceType: options.digitalSourceType,
    }),
    ...(options.materialCall && { materialCall: options.materialCall }),
    ...(options.frame !== undefined && { frame: options.frame }),
  };
}

function pickEngine(op: string, engines: ImageEngine[], name?: string): ImageEngine {
  if (name !== undefined) {
    const engine = engines.find((e) => e.name === name);
    if (!engine) throw new InputError(`unknown engine "${name}"`);
    if (!engine.operations[op] && !engine.asyncOperations?.[op])
      throw new InputError(`engine "${name}" does not implement ${op}`);
    return engine;
  }
  const engine = engines.find((e) => e.operations[op] || e.asyncOperations?.[op]);
  if (!engine) throw new InputError(`no engine implements ${op}`);
  return engine;
}

/** Validates a step's parameters against its operation's schema (defaults filled). */
export function checkStep(step: RecipeStep, path = "step"): Record<string, unknown> {
  const spec = operationSpec(step.op);
  if (!spec) {
    throw new InputError(
      `${path}: unknown operation "${step.op}" (known: ${OPERATIONS.map((o) => o.name).join(", ")})`,
    );
  }
  return validate(spec.params, step.params ?? {}, `${path}.params`) as Record<string, unknown>;
}

/**
 * Runs one operation over the items and returns the new items and its one provenance step. The
 * items given are not changed.
 */
export function runOperation(
  items: ImageItem[],
  step: RecipeStep,
  options: RunOptions = {},
): { items: ImageItem[]; step: TransformStep } {
  const spec = operationSpec(step.op);
  const checked = checkStep(step);
  const engines = options.engines ?? DEFAULT_ENGINES;
  const engine = pickEngine(step.op, engines, step.engine);
  const impl = engine.operations[step.op];
  if (!spec || !impl) throw new Error(`operation ${step.op} vanished`);
  const context = contextOf(options);
  const params = spec.defaults ? spec.defaults(checked, context) : checked;
  const reports: Record<string, unknown>[] = [];
  let out: ImageItem[];
  if (spec.scope === "all") {
    const result = impl(items, params, context);
    out = result.items.map((item) => ({
      ...item,
      digitalSourceType:
        item.digitalSourceType ??
        combineDigitalSourceTypes(
          items.map((i) => i.digitalSourceType ?? DIGITAL_SOURCE_TYPES.undeclared),
        ),
    }));
    if (result.report) reports.push(result.report);
  } else {
    out = items.flatMap((item) => {
      const result = impl([item], params, context);
      if (result.report) reports.push(result.report);
      return result.items.map((output) => ({
        ...output,
        digitalSourceType:
          output.digitalSourceType ?? item.digitalSourceType ?? DIGITAL_SOURCE_TYPES.undeclared,
      }));
    });
  }
  const report =
    reports.length === 0 ? undefined : reports.length === 1 ? reports[0] : { perInput: reports };
  return {
    items: out,
    step: {
      op: step.op,
      params,
      engine: { name: engine.name, version: engine.version },
      inputs: items.map((i) => pixelHash(i.raster)),
      outputs: out.map((i) => pixelHash(i.raster)),
      ...(report !== undefined && { report }),
    },
  };
}

/** Parses and validates a recipe: its shape, every operation's name and parameters, and engines. */
export function parseRecipe(value: unknown, engines: ImageEngine[] = DEFAULT_ENGINES): Recipe {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError("a recipe must be a JSON object with a steps array");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["format", "name", "description", "steps"].includes(key)) {
      throw new InputError(`recipe: unknown field "${key}"`);
    }
  }
  if (raw["format"] !== undefined && raw["format"] !== RECIPE_FORMAT) {
    throw new InputError(`recipe: format must be "${RECIPE_FORMAT}"`);
  }
  for (const key of ["name", "description"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "string")
      throw new InputError(`recipe: ${key} must be a string`);
  }
  if (!Array.isArray(raw["steps"]) || raw["steps"].length === 0) {
    throw new InputError("recipe: steps must be a non-empty array");
  }
  const steps = (raw["steps"] as unknown[]).map((s, i): RecipeStep => {
    const path = `recipe.steps[${i}]`;
    if (typeof s !== "object" || s === null || Array.isArray(s))
      throw new InputError(`${path}: must be an object with an op`);
    const step = s as Record<string, unknown>;
    for (const key of Object.keys(step)) {
      if (!["op", "params", "engine"].includes(key))
        throw new InputError(`${path}: unknown field "${key}"`);
    }
    if (typeof step["op"] !== "string") throw new InputError(`${path}.op: must be a string`);
    if (step["engine"] !== undefined && typeof step["engine"] !== "string")
      throw new InputError(`${path}.engine: must be a string`);
    const parsed: RecipeStep = {
      op: step["op"],
      ...(step["params"] !== undefined && { params: step["params"] as Record<string, unknown> }),
      ...(step["engine"] !== undefined && { engine: step["engine"] as string }),
    };
    checkStep(parsed, path);
    pickEngine(parsed.op, engines, parsed.engine);
    return parsed;
  });
  return {
    ...(typeof raw["name"] === "string" && { name: raw["name"] }),
    ...(typeof raw["description"] === "string" && { description: raw["description"] }),
    steps,
  };
}

/** Runs a recipe's steps in order; deterministic for the same items, recipe and engine versions. */
export function runRecipe(
  recipe: Recipe,
  items: ImageItem[],
  options: RunOptions = {},
): { items: ImageItem[]; steps: TransformStep[] } {
  const steps: TransformStep[] = [];
  let current = items;
  for (const s of recipe.steps) {
    const result = runOperation(current, s, options);
    current = result.items;
    steps.push(result.step);
  }
  return { items: current, steps };
}

/** A source file as recorded in a transform provenance record. */
export interface SourceFile {
  digitalSourceType: DigitalSourceType;
  name: string;
  path: string;
  sha256: string;
  mediaType: string;
  pixels: string;
  /** The engine that decoded the file. */
  decodedBy: { name: string; version: string };
}

export interface OutputFile {
  digitalSourceType: DigitalSourceType;
  name: string;
  path: string;
  sha256: string;
  mediaType: string;
  width: number;
  height: number;
  pixels: string;
  /** The engine whose encoder wrote the file's bytes. */
  encodedBy: { name: string; version: string };
  /** What the operations measured for this output (matte checks, jitter, placement). */
  meta?: Record<string, unknown>;
}

/** The provenance record of a transformation: sources, every step, outputs. No clock, no randomness. */
export interface TransformRecord {
  generator: "transform";
  sourceDeclaration?: import("../metadata.ts").SourceDeclaration;
  recipe?: { name?: string; description?: string };
  style: ResolvedStyle;
  sources: SourceFile[];
  steps: TransformStep[];
  outputs: OutputFile[];
}

export interface TransformFilesOptions extends RunOptions {
  recipe: Recipe;
  inputs: string[];
  /**
   * A file path when the recipe yields one output and the path has an extension; otherwise a
   * directory, which receives `<name>.<extension>` per output and `provenance.json`.
   */
  out: string;
}

/** Reads the inputs, runs the recipe, writes the outputs and the provenance record beside them. */
export async function transformFiles(
  options: TransformFilesOptions,
): Promise<{ record: TransformRecord; provenancePath: string }> {
  const engines = options.engines ?? DEFAULT_ENGINES;
  if (options.inputs.length === 0) throw new InputError("no input image given");
  const decoder = engines[0];
  if (!decoder) throw new InputError("no engine");
  const sources: SourceFile[] = [];
  const items: ImageItem[] = [];
  const seen = new Set<string>();
  for (const path of options.inputs) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch (error) {
      throw new InputError(`cannot read ${path}: ${(error as Error).message}`, { cause: error });
    }
    let raster: Raster;
    try {
      raster = decoder.decode(bytes);
    } catch (error) {
      throw new InputError(`cannot decode ${path}: ${(error as Error).message}`, { cause: error });
    }
    let name = basename(path, extname(path));
    for (let n = 2; seen.has(name); n++) name = `${basename(path, extname(path))}-${n}`;
    seen.add(name);
    const mediaType = sniffMediaType(bytes);
    sources.push({
      name,
      path,
      sha256: sha256(bytes),
      mediaType,
      pixels: pixelHash(raster),
      digitalSourceType:
        readDigitalSourceType(bytes, mediaType) ??
        options.digitalSourceType ??
        DIGITAL_SOURCE_TYPES.undeclared,
      decodedBy: { name: decoder.name, version: decoder.version },
    });
    // An item keeps its source's media type when an engine can encode it; otherwise (JPEG today)
    // it is written as PNG unless a `convert` step says otherwise.
    const encodable = engines.some((e) => e.encoders[mediaType] !== undefined);
    items.push({
      name,
      raster,
      mediaType: encodable ? mediaType : "image/png",
      meta: {},
      digitalSourceType:
        readDigitalSourceType(bytes, mediaType) ??
        options.digitalSourceType ??
        DIGITAL_SOURCE_TYPES.undeclared,
    });
  }

  const style = options.style ?? resolveStyle(undefined);
  const { items: results, steps } = await runRecipeAsync(options.recipe, items, {
    ...options,
    style,
  });
  if (results.length === 0) throw new InputError("the recipe produced no output");

  const out = resolve(options.out);
  const isDir = await stat(out).then(
    (s) => s.isDirectory(),
    () => false,
  );
  const single = results.length === 1 && extname(out) !== "" && !isDir;
  const dir = single ? dirname(out) : out;
  const inputs = new Set(options.inputs.map((p) => resolve(p)));
  const planned = results.map((item) => {
    const engine = engines.find((e) => e.encoders[item.mediaType] !== undefined);
    const encoder = engine?.encoders[item.mediaType];
    if (!engine || !encoder) throw new InputError(`no engine encodes ${item.mediaType}`);
    // The file's extension always matches the bytes written (.gitattributes routes by extension).
    if (single && extname(out).slice(1).toLowerCase() !== encoder.extension) {
      throw new InputError(
        `refused: ${out} names a .${extname(out).slice(1)} file but the output is ${item.mediaType}; ` +
          `use a .${encoder.extension} path, or add a convert step for that format`,
      );
    }
    const path = single ? out : join(dir, `${item.name}.${encoder.extension}`);
    if (inputs.has(path))
      throw new InputError(`refused: ${path} is an input; sources are never overwritten`);
    return { item, engine, encoder, path };
  });
  const paths = new Set(planned.map((p) => p.path));
  if (paths.size !== planned.length) throw new InputError("two outputs share a name");
  const provenancePath = single ? `${out}.provenance.json` : join(dir, "provenance.json");
  if (inputs.has(provenancePath)) throw new InputError(`refused: ${provenancePath} is an input`);

  await mkdir(dir, { recursive: true });
  const outputs: OutputFile[] = [];
  for (const { item, engine, encoder, path } of planned) {
    const digitalSourceType = item.digitalSourceType ?? DIGITAL_SOURCE_TYPES.undeclared;
    const bytes = embedDigitalSourceType(
      encoder.encode(item.raster),
      item.mediaType,
      digitalSourceType,
    );
    steps.push(metadataStep(digitalSourceType, [pixelHash(item.raster)]));
    await writeFile(path, bytes);
    const meta = jsonMeta(item.meta);
    outputs.push({
      name: item.name,
      digitalSourceType,
      path,
      sha256: sha256(bytes),
      mediaType: item.mediaType,
      width: item.raster.width,
      height: item.raster.height,
      pixels: pixelHash(item.raster),
      encodedBy: { name: engine.name, version: engine.version },
      ...(meta !== undefined && { meta }),
    });
  }
  const record: TransformRecord = {
    generator: "transform",
    ...(options.digitalSourceType !== undefined && {
      sourceDeclaration: sourceDeclaration(options.digitalSourceType),
    }),
    ...((options.recipe.name !== undefined || options.recipe.description !== undefined) && {
      recipe: {
        ...(options.recipe.name !== undefined && { name: options.recipe.name }),
        ...(options.recipe.description !== undefined && {
          description: options.recipe.description,
        }),
      },
    }),
    style,
    sources,
    steps,
    outputs,
  };
  await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`);
  return { record, provenancePath };
}

function jsonMeta(meta: Record<string, unknown>): Record<string, unknown> | undefined {
  if (Object.keys(meta).length === 0) return undefined;
  return JSON.parse(JSON.stringify(meta)) as Record<string, unknown>;
}

/** The operations with their schemas and the engines implementing each, for `assetgrove ops`. */
export function describeOperations(engines: ImageEngine[] = DEFAULT_ENGINES) {
  return {
    recipeFormat: RECIPE_FORMAT,
    engines: engines.map((e) => ({
      name: e.name,
      version: e.version,
      operations: [...Object.keys(e.operations), ...Object.keys(e.asyncOperations ?? {})],
      encodes: Object.entries(e.encoders).map(([mediaType, enc]) => ({
        mediaType,
        extension: enc?.extension,
      })),
    })),
    operations: OPERATIONS.map((o) => ({
      name: o.name,
      summary: o.summary,
      scope: o.scope,
      params: o.params,
      engines: engines
        .filter((e) => e.operations[o.name] || e.asyncOperations?.[o.name])
        .map((e) => e.name),
    })),
  };
}

/** Runs recipes that include bounded external or model-assisted material operations. */
export async function runRecipeAsync(
  recipe: Recipe,
  items: ImageItem[],
  options: RunOptions = {},
): Promise<{ items: ImageItem[]; steps: TransformStep[] }> {
  let current = items;
  const steps: TransformStep[] = [];
  for (const step of recipe.steps) {
    const checked = checkStep(step);
    const spec = operationSpec(step.op)!;
    const engine = pickEngine(step.op, options.engines ?? DEFAULT_ENGINES, step.engine);
    const impl = engine.asyncOperations?.[step.op];
    if (!impl) {
      const result = runOperation(current, step, options);
      current = result.items;
      steps.push(result.step);
      continue;
    }
    const context = contextOf(options);
    const params = spec.defaults ? spec.defaults(checked, context) : checked;
    const inputs = current.map((i) => pixelHash(i.raster));
    const results = [];
    if (spec.scope === "all") results.push(await impl(current, params, context));
    else for (const item of current) results.push(await impl([item], params, context));
    current = results.flatMap((r) => r.items);
    const reports = results.flatMap((r) => (r.report ? [r.report] : []));
    steps.push({
      op: step.op,
      params,
      engine: { name: engine.name, version: engine.version },
      inputs,
      outputs: current.map((i) => pixelHash(i.raster)),
      ...(reports.length
        ? { report: reports.length === 1 ? reports[0] : { perInput: reports } }
        : {}),
    });
  }
  return { items: current, steps };
}
