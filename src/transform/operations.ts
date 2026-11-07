/**
 * The image operations: name, scope and parameter schema, independent of any engine. Engines
 * implement them (see `raster-engine.ts`); recipes name them.
 */
import { MATERIAL_OPERATIONS } from "../material/operations.ts";
import type { ParamSchema } from "./schema.ts";
import type { OperationContext, OperationSpec } from "./types.ts";

const int = (description: string, minimum = 0, extra: object = {}): ParamSchema => ({
  type: "integer",
  minimum,
  description,
  ...extra,
});
const point: ParamSchema = {
  type: "object",
  properties: { x: { type: "integer" }, y: { type: "integer" } },
  required: ["x", "y"],
};
const size: ParamSchema = {
  type: "object",
  properties: { width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 } },
  required: ["width", "height"],
};
const filter: ParamSchema = {
  type: "string",
  enum: ["antialiased", "crisp"],
  description:
    "resampling: antialiased (premultiplied filtering) or crisp (nearest neighbour); defaults to the style profile's edges",
};
const fill = (
  params: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> => {
  const out = { ...params };
  for (const [k, v] of Object.entries(values)) if (out[k] === undefined) out[k] = v;
  return out;
};
const styleFilter = (params: Record<string, unknown>, context: OperationContext) =>
  fill(params, { filter: context.style.edges });

export const OPERATIONS: OperationSpec[] = [
  ...MATERIAL_OPERATIONS,
  {
    name: "crop",
    summary: "cut a box out of each image",
    scope: "each",
    params: {
      type: "object",
      properties: {
        x: int("left edge, px"),
        y: int("top edge, px"),
        width: int("width, px", 1),
        height: int("height, px", 1),
      },
      required: ["x", "y", "width", "height"],
    },
  },
  {
    name: "trim",
    summary: "crop each image to its opaque bounds (alpha at or above the threshold)",
    scope: "each",
    params: {
      type: "object",
      properties: {
        threshold: {
          type: "integer",
          minimum: 1,
          maximum: 255,
          description: "alpha counted as opaque; defaults to the style profile's threshold",
        },
        margin: int("transparent px kept around the bounds", 0, { default: 0 }),
      },
    },
    defaults: (params, context) => fill(params, { threshold: context.style.alpha.threshold }),
  },
  {
    name: "pad",
    summary: "add transparent px around each image",
    scope: "each",
    params: {
      type: "object",
      properties: {
        top: int("px above", 0, { default: 0 }),
        right: int("px to the right", 0, { default: 0 }),
        bottom: int("px below", 0, { default: 0 }),
        left: int("px to the left", 0, { default: 0 }),
      },
    },
  },
  {
    name: "scale",
    summary: "resample each image by a factor, or to a width or height keeping its aspect",
    scope: "each",
    params: {
      type: "object",
      properties: {
        factor: { type: "number", exclusiveMinimum: 0, description: "output px per input px" },
        width: int("output width, px (height follows the aspect)", 1),
        height: int("output height, px (width follows the aspect)", 1),
        filter,
      },
    },
    defaults: styleFilter,
  },
  {
    name: "slice",
    summary: "split a sheet into one image per figure, dropping labels, specks and background",
    scope: "each",
    params: {
      type: "object",
      properties: {
        grid: {
          type: "object",
          description: "an explicit grid; when absent one is detected",
          properties: {
            columns: int("columns", 1),
            rows: int("rows", 1),
            cellWidth: int("cell width, px", 1),
            cellHeight: int("cell height, px", 1),
            origin: point,
          },
          required: ["columns"],
        },
        components: {
          type: "boolean",
          default: false,
          description: "skip grid detection and locate figures as connected components",
        },
        tolerance: {
          type: "number",
          minimum: 0,
          default: 40,
          description: "RGB distance from the background beyond which a pixel is foreground",
        },
        labelFraction: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: 0.04,
          description: "components smaller than this fraction of the largest figure are labels",
        },
        padding: int("px kept around each figure", 0, { default: 4 }),
      },
    },
  },
  {
    name: "matte",
    summary:
      "remove the background to the style profile, unmixing soft edges and removing halo and fringe",
    scope: "each",
    params: {
      type: "object",
      properties: {
        band: {
          type: "number",
          exclusiveMinimum: 0,
          default: 2,
          description: "width of the edge band unmixed into soft alpha, px",
        },
        tolerance: {
          type: "number",
          minimum: 0,
          default: 24,
          description: "RGB distance within which a pixel counts as background in the checks",
        },
        maxHaloFraction: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: 0.005,
          description: "limit of the halo and leftover-background checks",
        },
        sliceTolerance: {
          type: "number",
          minimum: 0,
          default: 40,
          description:
            "for an image that was not sliced: RGB distance from its border colour beyond which a pixel is kept",
        },
      },
    },
  },
  {
    name: "apply-style",
    summary:
      "re-apply the style profile's alpha and colour rule (binary alpha, palette snap) and clear transparent colour",
    scope: "each",
    params: { type: "object", properties: {} },
  },
  {
    name: "register",
    summary:
      "place every image in one frame size with the feet baseline and centre of mass on the anchor, at one common scale",
    scope: "all",
    params: {
      type: "object",
      properties: {
        frame: { ...size, description: "frame size; defaults to the target profile's frames" },
        anchor: { ...point, description: "pivot; defaults to the bottom centre of the frame" },
        families: {
          type: "array",
          items: { type: "string" },
          description: "one family key per image; normalises scale within each family",
        },
        measureThreshold: {
          type: "integer",
          minimum: 1,
          maximum: 255,
          default: 128,
          description: "alpha counted for the baseline",
        },
        margin: {
          type: "number",
          minimum: 0,
          default: 1,
          description: "px kept free at the frame edge",
        },
        clamp: {
          type: "array",
          items: { type: "number", exclusiveMinimum: 0 },
          minItems: 2,
          default: [0.8, 1.25],
          description: "bounds of the per-image family normalisation",
        },
        scale: {
          type: "number",
          exclusiveMinimum: 0,
          description: "use this common scale instead of fitting one",
        },
        filter,
      },
    },
    defaults: (params, context) => {
      const out = styleFilter(params, context);
      if (out["frame"] === undefined && context.frame) out["frame"] = { ...context.frame };
      const frame = out["frame"] as { width: number; height: number } | undefined;
      if (out["anchor"] === undefined && frame)
        out["anchor"] = { x: Math.floor(frame.width / 2), y: frame.height - 1 };
      return out;
    },
  },
  {
    name: "join",
    summary: "assemble the images into one strip or sheet, left to right then top to bottom",
    scope: "all",
    params: {
      type: "object",
      properties: {
        columns: int("columns; defaults to every image in one row (a strip)", 1),
        name: { type: "string", description: "the joined image's name" },
      },
    },
  },
  {
    name: "flip",
    summary: "mirror each image",
    scope: "each",
    params: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["horizontal", "vertical"],
          default: "horizontal",
          description: "horizontal swaps left and right; vertical swaps top and bottom",
        },
      },
    },
  },
  {
    name: "renditions",
    summary: "make one copy of each image per scale (the input is 1x), named <name>@<scale>x",
    scope: "each",
    params: {
      type: "object",
      properties: {
        scales: {
          type: "array",
          items: { type: "number", exclusiveMinimum: 0 },
          minItems: 1,
          default: [1, 2],
        },
        filter,
      },
    },
    defaults: styleFilter,
  },
  {
    name: "convert",
    summary: "set the format each image is written in, by extension or media type (png, webp)",
    scope: "each",
    params: {
      type: "object",
      properties: {
        format: { type: "string", description: "an extension or media type the engine encodes" },
      },
      required: ["format"],
    },
  },
];

export function operationSpec(name: string): OperationSpec | undefined {
  return OPERATIONS.find((o) => o.name === name);
}
