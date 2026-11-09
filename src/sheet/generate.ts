/**
 * Sheet generation, the first animation technique (owner decision, 2026-11-07): one request asks
 * the model for a whole cycle as one contact sheet, which keeps identity consistent across frames,
 * and the sheet then goes through the same import path as a sheet made anywhere else.
 */
import { InputError } from "../errors.ts";
import type { PlannedCall } from "../generators/generator.ts";
import { Budget } from "../budget.ts";
import { Caller } from "../calls.ts";
import type { GenerationProvider } from "../gateway/provider.ts";
import { DEFAULT_CAP_USD } from "../loop.ts";
import { frameGrid, loadBibleInputs, loadReference, sha256, subjectOf } from "../request.ts";
import type { BibleInputs, FrameGrid } from "../request.ts";
import type { Routes } from "../routes.ts";
import type { AssetSpec, LoadedReference, StyleBible, TargetProfile } from "../types.ts";
import { importSheet } from "./import.ts";
import type { ImportIdentity } from "./import.ts";
import type { ImportRecord } from "./import.ts";
import type { Grouping, SliceOptions } from "./types.ts";

export interface GenerateSheetOptions {
  spec: AssetSpec;
  specDir: string;
  bible: StyleBible;
  bibleDir: string;
  profile: TargetProfile;
  routes: Routes;
  provider: GenerationProvider;
  /** Recorded in each call's route, for example `vercel-ai-gateway`. */
  providerName: string;
  importsDir: string;
  capUsd?: number;
  importId?: string;
  slice?: SliceOptions;
  /**
   * Scores the generated sheet against a character's identity lock (see `ImportOptions`), through
   * this run's own budgeted caller; the scoring call is part of the reserved estimate.
   */
  identity?: Omit<ImportIdentity, "caller">;
  now?: () => Date;
}

/** Columns of the requested sheet: a near-square grid, wider than tall. */
export function sheetColumns(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(count * 1.5)));
}

/** The sheet request, composed from the spec and the bible, never typed freehand. */
export function buildSheetPrompt(
  spec: AssetSpec,
  bible: StyleBible,
  grid: FrameGrid,
  inputs: BibleInputs,
  keyPose: boolean,
): string {
  const subject = subjectOf(spec);
  const description = bible.subjects?.[subject]?.description;
  const columns = sheetColumns(grid.count);
  const rows = Math.ceil(grid.count / columns);
  const roles = [
    ...(keyPose ? ["approved key pose"] : []),
    ...inputs.subject.map((r) => r.role),
    "perspective sample",
    "palette swatch",
  ];
  return [
    `Animation contact sheet for the style bible version ${bible.version}.`,
    description ? `Subject: ${subject}, ${description}.` : `Subject: ${subject}.`,
    `Draw one complete "${spec.animationFamily}" animation cycle of ${grid.count} frames, as a sprite sheet of ${columns} columns and ${rows} rows of equal cells, frames in reading order (left to right, then top to bottom); leave any cell after the last frame empty.`,
    "The same character in every frame: identical design, colours, proportions and scale. One whole, uncropped figure per cell, centred in its cell, with the feet on the same ground line in every cell. Consecutive frames change only the pose, so the last frame flows back into the first.",
    `Each frame will be scaled to a ${grid.frame.width}x${grid.frame.height} px game frame, so keep the silhouette readable.`,
    `Reference images, in order: ${roles.join(", ")}. Match the identity to the subject references and the camera angle to the perspective sample.`,
    `Palette: ${bible.palette.join(", ")}.`,
    "Paint albedo under a neutral key light, without baked directional shadows, highlights or emissive glow.",
    ...(bible.mood?.length ? [`Mood: ${bible.mood.join(", ")}.`] : []),
    ...(bible.notes ?? []).map((note) => `Style note: ${note}`),
    "Plain flat uniform light background across the whole sheet, no grid lines, no borders, no text, no numbers, no shadow on the ground.",
  ].join("\n");
}

/** The calls one generated sheet makes: the sheet itself, then the grouping proposal. */
export function planSheet(spec: AssetSpec, profile: TargetProfile, routes: Routes): PlannedCall[] {
  if (!spec.animationFamily) throw new InputError("a sheet spec needs an animationFamily");
  const grid = frameGrid(spec, profile, 1);
  if (grid.count < 2) throw new InputError("a sheet spec needs frames.count of at least 2");
  return ["sheet", "vision"].map((operation) => {
    const route = routes[operation];
    if (!route) throw new InputError(`no model route for operation "${operation}"`);
    return { operation, model: route.model, estimatedCostUsd: route.estimatedCostUsd };
  });
}

/**
 * Generates one sheet and imports it. The run reserves the sheet call and the grouping call
 * against the cap before any provider call, and refuses when they would exceed it.
 */
export async function generateSheet(
  options: GenerateSheetOptions,
): Promise<{ record: ImportRecord; importDir: string; grouping: Grouping; spentUsd: number }> {
  const { spec, bible, profile, routes } = options;
  // planSheet refuses a spec without an animationFamily, so it is set below.
  const plan = planSheet(spec, profile, routes);
  const grid = frameGrid(spec, profile, 1);
  const capUsd = options.capUsd ?? DEFAULT_CAP_USD;
  const budget = new Budget(capUsd);
  const scoring = options.identity !== undefined && options.identity.settings.mode !== "off";
  const estimate =
    plan.reduce((sum, c) => sum + c.estimatedCostUsd, 0) +
    (scoring ? routes.identity.estimatedCostUsd : 0);
  budget.settle(budget.reserve(estimate, "a sheet and its grouping proposal"), 0);

  const call = new Caller({
    provider: options.provider,
    providerName: options.providerName,
    budget,
    routes,
    ...(options.now !== undefined && { now: options.now }),
  });
  const inputs = await loadBibleInputs(spec, bible, options.bibleDir);
  const keyPose: LoadedReference[] = spec.keyPose
    ? [await loadReference(spec.keyPose, "key pose (approved)", options.specDir)]
    : [];
  const prompt = buildSheetPrompt(spec, bible, grid, inputs, keyPose.length > 0);
  const seed = Number.parseInt(sha256(new TextEncoder().encode(prompt)).slice(0, 8), 16);
  const refs = [...keyPose, ...inputs.subject, inputs.perspective, inputs.palette];
  const image = await call.image("sheet", prompt, refs, seed);
  const generationCalls = [...call.records];
  const description = bible.subjects?.[subjectOf(spec)]?.description;

  const imported = await importSheet({
    sheet: image.bytes,
    sheetPath: `(generated by ${routes.sheet.model})`,
    tool: routes.sheet.model,
    assetId: spec.assetId,
    ...(spec.subject !== undefined && { subject: spec.subject }),
    ...(spec.gait !== undefined && { gait: spec.gait }),
    profile,
    bible: { version: bible.version, palette: bible.palette },
    importsDir: options.importsDir,
    ...(options.importId !== undefined && { importId: options.importId }),
    ...(options.slice !== undefined && { slice: options.slice }),
    ...(options.identity !== undefined && { identity: { ...options.identity, caller: call } }),
    frame: grid.frame,
    ...(spec.anchor !== undefined && { anchor: spec.anchor }),
    propose: {
      call,
      hints: [spec.animationFamily as string],
      ...(description !== undefined && { subjectDescription: description }),
      references: inputs.subject,
    },
    generation: {
      prompt,
      parameters: {
        animationFamily: spec.animationFamily,
        requestedFrames: grid.count,
        columns: sheetColumns(grid.count),
        ...(keyPose[0] && { keyPose: { path: keyPose[0].path, sha256: keyPose[0].sha256 } }),
      },
      calls: generationCalls,
    },
    ...(options.now !== undefined && { now: options.now }),
  });
  return { ...imported, spentUsd: budget.spentUsd };
}
