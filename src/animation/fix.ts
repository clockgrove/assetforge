/**
 * The per-frame fix: one bad frame of a strip is regenerated as a reference-guided edit from an
 * approved neighbour or the key pose, registered like every other frame and spliced back in. Only
 * that frame changes, and provenance records the call, the source and the pixels before and after.
 */
import { InputError } from "../errors.ts";
import type { Caller } from "../calls.ts";
import type { PlannedCall } from "../generators/generator.ts";
import { decodeImage, encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { DIGITAL_SOURCE_TYPES, combineDigitalSourceTypes } from "../metadata.ts";
import { sha256 } from "../request.ts";
import type { Routes } from "../routes.ts";
import { measureFrame } from "../sheet/register.ts";
import { sheetImportRecipe } from "../sheet/import.ts";
import type { ResolvedStyle } from "../style.ts";
import { pixelHash, runOperation, runRecipe } from "../transform/run.ts";
import type { TransformRecord } from "../transform/run.ts";
import type { ImageItem, TransformStep } from "../transform/types.ts";
import { grantOf, grantProblems } from "../license.ts";
import type {
  CallRecord,
  LoadedReference,
  OutputGrant,
  Point,
  Provenance,
  Size,
} from "../types.ts";
import { joinStrip, measureThreshold, splitStrip } from "./strip.ts";

export const DEFAULT_FIX_CAP_USD = 2;

export type FixSource = { neighbour: number } | { keyPose: { path: string; sha256: string } };

/** One recorded fix of one frame. */
export interface FrameFix {
  /** 1-based frame number. */
  frame: number;
  from: FixSource;
  prompt: string;
  model: string;
  requestId: string;
  seed?: number;
  costUsd: number;
  at: string;
  beforeHash: string;
  afterHash: string;
}

export function planFix(routes: Routes): PlannedCall[] {
  const route = routes["edit"];
  if (!route) throw new InputError('no model route for operation "edit"');
  return [{ operation: "edit", model: route.model, estimatedCostUsd: route.estimatedCostUsd }];
}

export function buildFixPrompt(input: {
  subject: string;
  family: string;
  frame: number;
  count: number;
  source: "neighbour" | "key pose";
  sourceFrame?: number;
  note?: string;
}): string {
  const first =
    input.source === "neighbour"
      ? `Reference image 1 is the approved frame ${input.sourceFrame ?? "?"} of the "${input.family}" cycle of ${input.subject}.`
      : `Reference image 1 is the approved key pose of ${input.subject}.`;
  return [
    first,
    "Reference image 2 is the frame to fix.",
    "Keep the identity, design, colours and scale of image 1 exactly.",
    `Keep the pose of image 2, which is frame ${input.frame} of ${input.count} of the "${input.family}" cycle.`,
    "Draw one whole figure on a plain flat light background or transparent, with the feet at the bottom, no text.",
    ...(input.note ? [`Author's note: ${input.note}`] : []),
  ].join("\n");
}

export interface FixFrameOptions {
  strip: Raster;
  frame: Size;
  anchor: Point;
  family: string;
  subject: string;
  /** 1-based frame to fix. */
  index: number;
  from: { neighbour: number } | { keyPose: LoadedReference };
  style: ResolvedStyle;
  call: Caller;
  note?: string;
  provenance?: Provenance;
  stripPath?: string;
  /** The license recorded when the strip has no provenance yet (the target profile's). */
  license?: string;
  /** The style bible version recorded when the strip has no provenance yet. */
  bibleVersion?: string;
  now?: () => Date;
}

type FixedProvenance = Provenance & { fixes?: FrameFix[] };

function pngReference(raster: Raster, role: string, path: string): LoadedReference {
  const bytes = encodePng(raster);
  return { role, path, mediaType: "image/png", bytes, sha256: sha256(bytes) };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

const EXTENDABLE =
  "fix-frame extends a strip's own provenance (from write-families, pick or an earlier fix-frame) " +
  "or the transform record of recipe or op that lists this strip as an output";

function refuseProvenance(source: string, problems: string[]): InputError {
  return new InputError(
    `cannot extend the provenance ${source}: ${problems.join("; ")}. ${EXTENDABLE}; ` +
      "give that file with --provenance. Nothing was spent",
  );
}

/**
 * What stops a record from being extended by a fix, one entry per field the fix reads or appends
 * to. Empty for a strip's provenance (write-families, stage and pick, an earlier fix).
 */
export function provenanceProblems(value: unknown): string[] {
  if (!isObject(value)) return ["it is not a JSON object"];
  const problems: string[] = [];
  if (typeof value["generator"] !== "string") problems.push("generator is not a string");
  for (const key of ["models", "requestIds", "referenceHashes", "providerTerms"]) {
    if (!isStrings(value[key])) problems.push(`${key} is not a list of strings`);
  }
  if (!Array.isArray(value["calls"])) problems.push("calls is not a list");
  else {
    value["calls"].forEach((call: unknown, i: number) => {
      const grant = isObject(call) ? call["outputGrant"] : undefined;
      if (grant === undefined) return;
      const bad = grantProblems(grant);
      if (bad.length > 0) problems.push(`call ${i + 1}'s outputGrant: ${bad.join("; ")}`);
    });
  }
  if (typeof value["costUsd"] !== "number" || !Number.isFinite(value["costUsd"])) {
    problems.push("costUsd is not a number");
  }
  if (value["digitalSourceType"] !== undefined && typeof value["digitalSourceType"] !== "string") {
    problems.push("digitalSourceType is not a string");
  }
  for (const key of ["steps", "fixes"]) {
    if (value[key] !== undefined && !Array.isArray(value[key]))
      problems.push(`${key} is not a list`);
  }
  const frames = value["frames"];
  if (
    frames !== undefined &&
    !(
      Array.isArray(frames) &&
      frames.every(
        (f) => isObject(f) && typeof f["index"] === "number" && Array.isArray(f["transforms"]),
      )
    )
  ) {
    problems.push("frames is not a list of frames with an index and transforms");
  }
  return problems;
}

/**
 * The record a fix extends, from a provenance file Assetgrove wrote. A strip's own provenance is
 * kept as it is. A transform record (`recipe`, `op`) that lists this strip among its outputs
 * becomes a provenance carrying the record's sources, steps and output. Anything else is refused
 * with an InputError, so it is caught before any call is made.
 */
export function fixBaseProvenance(
  value: unknown,
  input: { strip: Raster; source: string; license: string; bibleVersion?: string; at: string },
): Provenance {
  if (isObject(value) && value["generator"] === "transform") {
    const problems: string[] = [];
    for (const key of ["sources", "steps", "outputs"]) {
      if (!Array.isArray(value[key])) problems.push(`the transform record's ${key} is not a list`);
    }
    if (problems.length > 0) throw refuseProvenance(input.source, problems);
    const record = value as unknown as TransformRecord;
    const pixels = pixelHash(input.strip);
    const output = record.outputs.find((o) => isObject(o) && o.pixels === pixels);
    if (!output) {
      throw refuseProvenance(input.source, [
        "it is a transform record, but none of its outputs has this strip's pixels",
      ]);
    }
    return {
      ...(typeof output.digitalSourceType === "string" && {
        digitalSourceType: output.digitalSourceType,
      }),
      ...(record.sourceDeclaration && { sourceDeclaration: record.sourceDeclaration }),
      generator: "transform",
      route: "transform",
      models: [],
      prompt: "",
      parameters: {
        ...(record.recipe && { recipe: record.recipe }),
        sources: record.sources,
        output,
      },
      requestIds: [],
      referenceHashes: unique(
        record.sources.flatMap((s) =>
          isObject(s) && typeof s.sha256 === "string" ? [s.sha256] : [],
        ),
      ),
      bibleVersion: input.bibleVersion ?? "unknown",
      license: input.license,
      providerTerms: [],
      startedAt: input.at,
      finishedAt: input.at,
      costUsd: 0,
      calls: [],
      steps: record.steps,
    };
  }
  const problems = provenanceProblems(value);
  if (problems.length > 0) throw refuseProvenance(input.source, problems);
  return value as Provenance;
}

export async function fixFrame(
  options: FixFrameOptions,
): Promise<{ strip: Raster; frame: Raster; provenance: FixedProvenance; fix: FrameFix }> {
  const { style, call, index } = options;
  const now = options.now ?? (() => new Date());
  const frames = splitStrip(options.strip, options.frame);
  const count = frames.length;
  if (!Number.isInteger(index) || index < 1 || index > count) {
    throw new InputError(`frame ${index} is not in the strip, which has ${count} frames`);
  }
  const neighbour = "neighbour" in options.from ? options.from.neighbour : undefined;
  if (neighbour !== undefined) {
    if (!Number.isInteger(neighbour) || neighbour < 1 || neighbour > count) {
      throw new InputError(`neighbour frame ${neighbour} is not in the strip of ${count} frames`);
    }
    if (neighbour === index) throw new InputError("the neighbour must be a different frame");
  }

  const bad = frames[index - 1] as Raster;
  const stripName = options.stripPath ?? "(strip)";
  const first =
    "neighbour" in options.from
      ? pngReference(
          frames[options.from.neighbour - 1] as Raster,
          `approved neighbour frame ${options.from.neighbour}`,
          `${stripName}#frame-${options.from.neighbour}`,
        )
      : options.from.keyPose;
  const second = pngReference(bad, `frame ${index} to fix`, `${stripName}#frame-${index}`);
  const prompt = buildFixPrompt({
    subject: options.subject,
    family: options.family,
    frame: index,
    count,
    source: neighbour === undefined ? "key pose" : "neighbour",
    ...(neighbour !== undefined && { sourceFrame: neighbour }),
    ...(options.note !== undefined && { note: options.note }),
  });
  if (options.provenance !== undefined) {
    const problems = provenanceProblems(options.provenance);
    if (problems.length > 0) throw refuseProvenance("given", problems);
  }
  const seed = Number.parseInt(sha256(new TextEncoder().encode(prompt)).slice(0, 8), 16);
  const startedAt = now().toISOString();
  const returned = await call.image("edit", prompt, [first, second], seed);
  const record = call.records[call.records.length - 1];
  if (!record) throw new Error("the edit call left no record");

  const steps: TransformStep[] = [];
  const edited = decodeImage(returned.bytes);
  let item: ImageItem = {
    name: "fixed-frame",
    raster: edited,
    mediaType: "image/png",
    meta: {},
    digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
  };
  let transparent = false;
  for (let i = 3; i < edited.data.length; i += 4) {
    if ((edited.data[i] as number) < 255) {
      transparent = true;
      break;
    }
  }
  if (!transparent) {
    const matted = runRecipe(sheetImportRecipe({ components: true }), [item], { style });
    steps.push(...matted.steps);
    let largest: { item: ImageItem; area: number } | undefined;
    for (const figure of matted.items) {
      const area = measureFrame(figure.raster, 1)?.area ?? 0;
      if (!largest || area > largest.area) largest = { item: figure, area };
    }
    if (!largest || largest.area === 0) throw new InputError("the edited frame has no figure");
    item = largest.item;
  }

  const threshold = measureThreshold(style);
  const neighbourFrame = neighbour === undefined ? undefined : frames[neighbour - 1];
  const reference = measureFrame(neighbourFrame ?? bad, threshold);
  const figure = measureFrame(item.raster, threshold);
  if (!reference) throw new InputError("the reference frame is empty, so its size is unknown");
  if (!figure) throw new InputError("the edited frame has no visible figure");
  const scale = Math.sqrt(reference.area / figure.area);

  const registered = runOperation(
    [item],
    {
      op: "register",
      params: {
        frame: options.frame,
        anchor: options.anchor,
        scale,
        measureThreshold: threshold,
      },
    },
    { style },
  );
  const styled = runOperation(registered.items, { op: "apply-style" }, { style });
  steps.push(registered.step, styled.step);
  const fixed = (styled.items[0] as ImageItem).raster;

  const outFrames = frames.slice();
  outFrames[index - 1] = fixed;
  const strip = joinStrip(outFrames);

  const from: FixSource =
    neighbour !== undefined
      ? { neighbour }
      : {
          keyPose: {
            path: (first as LoadedReference).path,
            sha256: (first as LoadedReference).sha256,
          },
        };
  const at = now().toISOString();
  const fix: FrameFix = {
    frame: index,
    from,
    prompt,
    model: record.model,
    requestId: record.requestId,
    ...(record.seed !== undefined && { seed: record.seed }),
    costUsd: record.costUsd,
    at,
    beforeHash: pixelHash(bad),
    afterHash: pixelHash(fixed),
  };

  const base: FixedProvenance = options.provenance ?? {
    generator: "frame-fix",
    route: record.route,
    models: [],
    prompt,
    parameters: {},
    requestIds: [],
    referenceHashes: [],
    bibleVersion: options.bibleVersion ?? "unknown",
    license: options.license ?? "unspecified",
    providerTerms: [],
    startedAt,
    finishedAt: at,
    costUsd: 0,
    calls: [],
  };
  const provenance: FixedProvenance = {
    ...base,
    digitalSourceType: combineDigitalSourceTypes([
      base.digitalSourceType ?? DIGITAL_SOURCE_TYPES.undeclared,
      DIGITAL_SOURCE_TYPES.generated,
    ]),
    models: unique([...base.models, record.model]),
    requestIds: [...base.requestIds, record.requestId],
    referenceHashes: unique([...base.referenceHashes, first.sha256, second.sha256]),
    providerTerms: unique([...base.providerTerms, record.providerTerms]),
    finishedAt: at,
    costUsd: base.costUsd + record.costUsd,
    calls: [...base.calls, record],
    ...grantFields(base, [...base.calls, record]),
    steps: [...(base.steps ?? []), ...steps],
    fixes: [...(base.fixes ?? []), fix],
    ...(base.frames && {
      frames: base.frames.map((f) =>
        f.index === index - 1
          ? {
              ...f,
              transforms: [
                ...f.transforms,
                {
                  op: "edit-frame",
                  from,
                  model: record.model,
                  requestId: record.requestId,
                },
              ],
            }
          : f,
      ),
    }),
  };
  return { strip, frame: fixed, provenance, fix };
}

/**
 * The combined output grant of a fixed strip's calls, and its licence: the granted licence once a
 * grant does not allow relabelling, else the base record's (the target's) licence.
 */
function grantFields(
  base: Provenance,
  calls: CallRecord[],
): { license: string; outputGrant?: OutputGrant } {
  const outputGrant = grantOf(calls);
  if (!outputGrant) return { license: base.license };
  return { license: outputGrant.relabel ? base.license : outputGrant.license, outputGrant };
}
