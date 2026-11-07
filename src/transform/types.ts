/**
 * The media transformation core (PRD §5.11), images first. An operation is declared once (name,
 * parameter schema) and implemented by one or more engines behind the `ImageEngine` adapter, so a
 * recipe names operations, never an engine's code. Every run of an operation appends one
 * provenance step.
 */
import type { Raster } from "../image/raster.ts";
import type { SlicedFigure } from "../sheet/types.ts";
import type { ResolvedStyle } from "../style.ts";
import type { Size } from "../types.ts";
import type { ParamSchema } from "./schema.ts";

/** One image flowing through a recipe. */
export interface ImageItem {
  /** Names the output file: the source's base name, then suffixes such as `-f001` or `@2x`. */
  name: string;
  raster: Raster;
  /** The media type this item is written as; `convert` changes it. Defaults to `image/png`. */
  mediaType: string;
  /** What operations measured or decided for this item (JSON values), for callers and reports. */
  meta: Record<string, unknown>;
  /** Set by `slice`: the figure's mask and background, which `matte` uses. Not serialised. */
  figure?: SlicedFigure;
}

/** What every operation can read besides its parameters. */
export interface OperationContext {
  /** The style profile with defaults filled in; trims, scales and mattes follow it. */
  style: ResolvedStyle;
  /** The target profile's frame size, when one is known; `register` defaults to it. */
  frame?: Size;
}

export interface OperationResult {
  items: ImageItem[];
  /** Operation-level findings recorded on the provenance step, for example a slice's grid. */
  report?: Record<string, unknown>;
}

/** An engine's implementation of one operation: parameters arrive validated with defaults filled. */
export type OperationImpl = (
  items: ImageItem[],
  params: Record<string, unknown>,
  context: OperationContext,
) => OperationResult;

/** The declaration of an operation, independent of any engine. */
export interface OperationSpec {
  name: string;
  summary: string;
  /**
   * `each`: applied to every item on its own. `all`: sees the whole list at once (register, join).
   * Either way it may return any number of items.
   */
  scope: "each" | "all";
  params: ParamSchema;
  /** Fills defaults that depend on the style profile; plain defaults live in the schema. */
  defaults?: (
    params: Record<string, unknown>,
    context: OperationContext,
  ) => Record<string, unknown>;
}

/**
 * An engine adapter. Today the in-house TypeScript raster engine; sharp/libvips, ImageMagick or a
 * model-based matte would be another adapter implementing some of the same operations, chosen per
 * step without touching a recipe.
 */
export interface ImageEngine {
  name: string;
  /** Bumped whenever any implementation's output bytes change, so provenance can be replayed. */
  version: string;
  operations: Partial<Record<string, OperationImpl>>;
  /** Encoders this engine has, by media type. */
  encoders: Partial<Record<string, { extension: string; encode(raster: Raster): Uint8Array }>>;
  decode(bytes: Uint8Array): Raster;
}

/** One operation's entry in a provenance record. */
export interface TransformStep {
  op: string;
  /** The parameters as run, defaults filled in. */
  params: Record<string, unknown>;
  engine: { name: string; version: string };
  /** Pixel hashes (see `pixelHash`) of the items the operation received, in order. */
  inputs: string[];
  /** Pixel hashes of the items it produced, in order. */
  outputs: string[];
  report?: Record<string, unknown>;
}

/** One step of a recipe as written in its file. */
export interface RecipeStep {
  op: string;
  params?: Record<string, unknown>;
  /** Run this step on the named engine instead of the first one implementing the operation. */
  engine?: string;
}

export interface Recipe {
  name?: string;
  description?: string;
  steps: RecipeStep[];
}
