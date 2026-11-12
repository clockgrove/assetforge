/**
 * The sheet import path: a raw contact sheet (from Assetforge's own sheet generation, another tool
 * or hand work) becomes cleaned frames and a grouping proposal; an author-confirmed grouping then
 * becomes one strip, manifest and provenance per family in the target, with review pending.
 */
import {
  DIGITAL_SOURCE_TYPES,
  embedDigitalSourceType,
  readDigitalSourceType,
  metadataStep,
  sourceDeclaration,
  requireDeclared,
} from "../metadata.ts";
import type { DigitalSourceType } from "../metadata.ts";
import { InputError } from "../errors.ts";
import { licenseFields } from "../license.ts";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Caller } from "../calls.ts";
import { writeToTarget } from "../handoff.ts";
import type { TargetWriteResult } from "../handoff.ts";
import { drawDigits, textWidth } from "../image/digits.ts";
import {
  createRaster,
  decodeImage,
  encodePng,
  getPixel,
  parseHex,
  setPixel,
  toHex,
} from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { applyStyle } from "../image/apply-style.ts";
import { pixelHash, runOperation, runRecipe } from "../transform/run.ts";
import type { ImageItem, Recipe, TransformStep } from "../transform/types.ts";
import { sha256, sniffMediaType } from "../request.ts";
import { resolveStyle } from "../style.ts";
import type { ResolvedStyle } from "../style.ts";
import type {
  AssetSpec,
  Box,
  CallRecord,
  FrameProvenance,
  Point,
  Provenance,
  Reason,
  SheetSource,
  Size,
  TargetProfile,
  Transform,
} from "../types.ts";
import { checkConfirmed, familyFrames, proposeGrouping } from "./group.ts";
import { SliceError } from "./slice.ts";
import { animationQa } from "../animation/qa.ts";
import { DEFAULT_DURATION_MS, familyLoops, renderPreviews } from "../animation/run.ts";
import { splitStrip } from "../animation/strip.ts";
import { templatesFor, thresholdsFor } from "../animation/templates.ts";
import type { AnimationReport } from "../animation/types.ts";
import type { Grouping, MatteQuality, SliceOptions } from "./types.ts";
import type { LoadedReference } from "../types.ts";
import { scoreIdentity } from "../identity.ts";
import type { CastMember, IdentityRecord, IdentityScore, IdentitySettings } from "../identity.ts";

export const IMPORT_FILE = "import.json";
export const GROUPING_FILE = "grouping.json";
export const CONTACT_FILE = "contact.png";
export const PREVIEW_FILE = "preview.html";
/** Default bound on registration jitter, in frame pixels. */
export const DEFAULT_JITTER_BOUND_PX = 1;

export { applyStyle };

/**
 * The import half of the sheet path as a recipe over the transformation core: slice the sheet into
 * figures, then remove each figure's background to the style profile.
 */
export function sheetImportRecipe(slice: SliceOptions = {}): Recipe {
  const params = JSON.parse(JSON.stringify(slice)) as Record<string, unknown>;
  return { name: "sheet-import", steps: [{ op: "slice", params }, { op: "matte" }] };
}

export interface ImportedFrame {
  /** 1-based frame number, reading order on the sheet. */
  id: number;
  /** The cleaned figure at sheet resolution, inside the import directory. */
  file: string;
  cell: FrameProvenance["cell"];
  /** The crop's box on the sheet. */
  box: Box;
  background: string;
  transforms: Transform[];
  quality: MatteQuality;
  /** The halo and leftover-background checks. */
  checks: Reason[];
}

export interface ImportRecord {
  digitalSourceType?: DigitalSourceType;
  sourceDeclaration?: import("../metadata.ts").SourceDeclaration;
  importId: string;
  createdAt: string;
  assetId: string;
  subject?: string;
  /** The asset spec's gait, for animation QA; the profile's `animation.gait` applies when unset. */
  gait?: string;
  /**
   * The asset spec's family and its target fields (`fields`), when a spec asked for the sheet. The family of that name
   * written by `writeFamilies` carries the fields to the target's templates, as a `pick` does.
   */
  spec?: { animationFamily: string; fields: Record<string, unknown> };
  sheet: SheetSource;
  profile: TargetProfile;
  bibleVersion: string;
  style: ResolvedStyle;
  frame: Size;
  anchor: Point;
  durationMs?: number;
  slice: { mode: "grid" | "components"; grid?: unknown; background: string };
  frames: ImportedFrame[];
  /** Set when Assetforge generated the sheet: the request that made it. */
  generation?: { prompt: string; parameters: Record<string, unknown>; calls: CallRecord[] };
  /**
   * The identity lock's score of the contact sheet, when scoring ran. `filtered` makes
   * `writeFamilies` refuse the sheet; the import itself is still written so the person sees why.
   */
  identity?: IdentityScore;
  /** The grouping proposal's and the identity score's calls. */
  calls: CallRecord[];
  /** The transformation steps (slice, matte) that made the frames from the sheet. */
  steps?: TransformStep[];
  written?: Array<{ at: string; target: string; families: string[]; files: string[] }>;
  /**
   * The common scale fitted on the first write, reused by every later write of this import so all
   * of an asset's families stay one size whatever grouping each write uses.
   */
  scale?: number;
}

/** Scoring a sheet's contact sheet against a character's identity record. */
export interface ImportIdentity {
  caller: Caller;
  record: IdentityRecord;
  references: LoadedReference[];
  settings: IdentitySettings;
  /** The whole cast, for the "cast" question. */
  cast?: CastMember[];
}

export interface ImportOptions {
  digitalSourceType?: DigitalSourceType;
  sheet: Uint8Array;
  /** Recorded as the sheet's path in provenance. */
  sheetPath: string;
  /** The model or tool that made the sheet, for example "ChatGPT image generation". */
  tool: string;
  assetId: string;
  subject?: string;
  /** The asset spec's gait, recorded for animation QA. */
  gait?: string;
  /** The asset spec's family and target fields, recorded for `writeFamilies`. */
  spec?: ImportRecord["spec"];
  profile: TargetProfile;
  /** The bible's palette backs a palette colour rule that names none; its version is recorded. */
  bible?: { version: string; palette?: string[] };
  importsDir: string;
  importId?: string;
  slice?: SliceOptions;
  /** Defaults to the profile's frame size. */
  frame?: Size;
  /** Defaults to the bottom centre of the frame. */
  anchor?: Point;
  /** When given, a vision model proposes the grouping through this caller. */
  propose?: {
    call: Caller;
    hints?: string[];
    subjectDescription?: string;
    references?: LoadedReference[];
  };
  generation?: ImportRecord["generation"];
  /** When given and its mode is not "off", the contact sheet is scored against the identity lock. */
  identity?: ImportIdentity;
  now?: () => Date;
}

/** The box of pixels with alpha >= threshold inside `within`, relative to it. */
function visibleBox(r: Raster, threshold: number, within: Box): Box | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = within.y; y < within.y + within.height; y++) {
    for (let x = within.x; x < within.x + within.width; x++) {
      if (getPixel(r, x, y)[3] >= threshold) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) return undefined;
  return {
    x: minX - within.x,
    y: minY - within.y,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function blit(dst: Raster, src: Raster, ox: number, oy: number): void {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const px = getPixel(src, x, y);
      if (px[3] === 0) continue;
      const a = px[3] / 255;
      const under = getPixel(dst, ox + x, oy + y);
      setPixel(dst, ox + x, oy + y, [
        Math.round(px[0] * a + under[0] * (1 - a)),
        Math.round(px[1] * a + under[1] * (1 - a)),
        Math.round(px[2] * a + under[2] * (1 - a)),
        255,
      ]);
    }
  }
}

/**
 * A numbered contact sheet of the registered frames on a neutral backdrop, for the author and the
 * grouping model: each frame in its own cell with its number under it.
 */
export function contactSheet(frames: Raster[], ids: number[], frame: Size): Raster {
  const zoom = Math.max(1, Math.floor(128 / Math.max(frame.width, frame.height)));
  const cellW = frame.width * zoom + 8;
  const cellH = frame.height * zoom + 20;
  const columns = Math.min(8, Math.max(1, frames.length));
  const rows = Math.ceil(frames.length / columns);
  const out = createRaster(columns * cellW, rows * cellH);
  for (let i = 0; i < out.data.length; i += 4) out.data.set([236, 236, 236, 255], i);
  frames.forEach((f, i) => {
    const cx = (i % columns) * cellW;
    const cy = Math.floor(i / columns) * cellH;
    const scaled = createRaster(f.width * zoom, f.height * zoom);
    for (let y = 0; y < scaled.height; y++) {
      for (let x = 0; x < scaled.width; x++) {
        setPixel(scaled, x, y, getPixel(f, Math.floor(x / zoom), Math.floor(y / zoom)));
      }
    }
    blit(out, scaled, cx + 4, cy + 4);
    const label = String(ids[i]);
    drawDigits(
      out,
      label,
      cx + Math.floor((cellW - textWidth(label, 2)) / 2),
      cy + cellH - 14,
      2,
      [30, 30, 36, 255],
    );
  });
  return out;
}

function frameFile(id: number): string {
  return `frames/f${String(id).padStart(3, "0")}.png`;
}

function defaultAnchor(frame: Size): Point {
  return { x: Math.floor(frame.width / 2), y: frame.height - 1 };
}

/**
 * Imports a sheet: slices it, removes the background to the style profile, checks every frame
 * for halos and leftover background, writes the cleaned frames, a numbered contact sheet of the
 * registered frames and a grouping proposal (`status: "proposed"`) into the import directory.
 */
export async function importSheet(
  options: ImportOptions,
): Promise<{ record: ImportRecord; importDir: string; grouping: Grouping }> {
  const now = options.now ?? (() => new Date());
  const { profile } = options;
  const style = resolveStyle(profile.style, options.bible?.palette);
  const frame = options.frame ?? { width: profile.frames.width, height: profile.frames.height };
  const anchor = options.anchor ?? defaultAnchor(frame);
  let raster: Raster;
  try {
    raster = decodeImage(options.sheet);
  } catch (error) {
    throw new InputError(
      `cannot decode the sheet ${options.sheetPath}: ${(error as Error).message}`,
      {
        cause: error,
      },
    );
  }
  const embedded = readDigitalSourceType(options.sheet, sniffMediaType(options.sheet));
  const declaration =
    options.digitalSourceType === undefined
      ? undefined
      : sourceDeclaration(options.digitalSourceType);
  const digitalSourceType = options.generation?.calls.some((c) => c.operation !== "vision")
    ? DIGITAL_SOURCE_TYPES.generated
    : (embedded ?? declaration?.value ?? DIGITAL_SOURCE_TYPES.undeclared);
  const sheetItem: ImageItem = {
    name: "sheet",
    raster,
    mediaType: "image/png",
    meta: {},
    digitalSourceType,
  };
  const importId =
    options.importId ??
    `${now().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const importDir = resolve(options.importsDir, importId);
  let ran: ReturnType<typeof runRecipe>;
  try {
    ran = runRecipe(sheetImportRecipe(options.slice), [sheetItem], { style });
  } catch (error) {
    // A generated sheet was paid for: keep it and how it was made, so it can be imported by hand.
    if (error instanceof SliceError && options.generation) {
      await keepRefusedSheet(importDir, options, digitalSourceType, error, now);
    }
    throw error;
  }
  const slicing = ran.steps[0]?.report as {
    mode: "grid" | "components";
    grid?: unknown;
    background: string;
  };

  await mkdir(join(importDir, "frames"), { recursive: true });

  const sheetSha = sha256(options.sheet);
  const frames: ImportedFrame[] = [];
  const cleaned: ImageItem[] = [];
  for (const item of ran.items) {
    const meta = item.meta as Pick<ImportedFrame, "cell" | "box" | "background" | "transforms"> & {
      frame: number;
      quality: MatteQuality;
      checks: Reason[];
    };
    const file = frameFile(meta.frame);
    await writeFile(
      join(importDir, file),
      embedDigitalSourceType(encodePng(item.raster), "image/png", digitalSourceType),
    );
    cleaned.push(item);
    frames.push({
      id: meta.frame,
      file,
      cell: meta.cell,
      box: meta.box,
      background: meta.background,
      // The matte's transforms start with the slicing ones.
      transforms: meta.transforms,
      quality: meta.quality,
      checks: meta.checks,
    });
  }

  const preview = runOperation(cleaned, { op: "register", params: { frame, anchor } }, { style });
  const styled = runOperation(preview.items, { op: "apply-style" }, { style });
  const ids = frames.map((f) => f.id);
  const contactRaster = contactSheet(
    styled.items.map((i) => i.raster),
    ids,
    frame,
  );
  const contact = embedDigitalSourceType(encodePng(contactRaster), "image/png", digitalSourceType);
  await writeFile(join(importDir, CONTACT_FILE), contact);

  const record: ImportRecord = {
    digitalSourceType,
    ...(declaration && { sourceDeclaration: declaration }),
    importId,
    createdAt: now().toISOString(),
    assetId: options.assetId,
    ...(options.subject !== undefined && { subject: options.subject }),
    ...(options.gait !== undefined && { gait: options.gait }),
    ...(options.spec !== undefined && { spec: options.spec }),
    sheet: {
      path: options.sheetPath,
      sha256: sheetSha,
      mediaType: sniffMediaType(options.sheet),
      tool: options.tool,
    },
    profile,
    bibleVersion: options.bible?.version ?? "none",
    style,
    frame,
    anchor,
    ...(profile.frames.durationMs !== undefined && { durationMs: profile.frames.durationMs }),
    slice: {
      mode: slicing.mode,
      ...(slicing.grid !== undefined && { grid: slicing.grid }),
      background: slicing.background,
    },
    frames,
    steps: [
      ...ran.steps,
      ...cleaned.map((item) => metadataStep(digitalSourceType, [pixelHash(item.raster)])),
      metadataStep(digitalSourceType, [pixelHash(contactRaster)]),
    ],
    ...(options.generation !== undefined && { generation: options.generation }),
    calls: [],
  };

  const contactRef: LoadedReference = {
    role: "contact sheet",
    path: CONTACT_FILE,
    mediaType: "image/png",
    bytes: contact,
    sha256: sha256(contact),
  };
  // Each caller's records from the first call made here, so a shared caller counts once.
  const starts = new Map<Caller, number>();
  for (const c of [options.identity?.caller, options.propose?.call]) {
    if (c && !starts.has(c)) starts.set(c, c.records.length);
  }
  if (options.identity && options.identity.settings.mode !== "off") {
    const { caller, record: lock, references, settings, cast } = options.identity;
    record.identity = await scoreIdentity({
      caller,
      record: lock,
      references,
      candidate: contactRef,
      describe: `a numbered contact sheet of ${ids.length} frames of one character${options.spec?.animationFamily ? `, from its "${options.spec.animationFamily}" animation` : ""}`,
      settings,
      edges: style.edges,
      ...(cast && { cast }),
    });
  }

  let grouping: Grouping;
  if (options.propose) {
    const { call } = options.propose;
    grouping = await proposeGrouping(call, contactRef, options.propose.references ?? [], {
      frameIds: ids,
      subject: options.subject ?? options.assetId,
      ...(options.propose.subjectDescription !== undefined && {
        subjectDescription: options.propose.subjectDescription,
      }),
      ...(options.propose.hints !== undefined && { hints: options.propose.hints }),
      referenceRoles: (options.propose.references ?? []).map((r) => r.role),
    });
  } else {
    grouping = {
      status: "proposed",
      families: [],
      unassigned: ids,
      notes: "No vision proposal was made; group the frames by hand.",
    };
  }
  record.calls = [...starts].flatMap(([c, start]) => c.records.slice(start));
  await writeFile(join(importDir, GROUPING_FILE), `${JSON.stringify(grouping, null, 2)}\n`);
  await writeImport(importDir, record);
  return { record, importDir, grouping };
}

/** The generated sheet a slice refused, and its record, written beside the would-be import. */
export const REFUSED_SHEET_RECORD = "sheet.json";

async function keepRefusedSheet(
  importDir: string,
  options: ImportOptions,
  digitalSourceType: DigitalSourceType,
  error: SliceError,
  now: () => Date,
): Promise<void> {
  const mediaType = sniffMediaType(options.sheet);
  const file = `sheet.${mediaType.split("/")[1] ?? "bin"}`;
  await mkdir(importDir, { recursive: true });
  await writeFile(
    join(importDir, file),
    embedDigitalSourceType(options.sheet, mediaType, digitalSourceType),
  );
  const record = {
    createdAt: now().toISOString(),
    assetId: options.assetId,
    file,
    sheet: {
      path: options.sheetPath,
      sha256: sha256(options.sheet),
      mediaType,
      tool: options.tool,
    },
    digitalSourceType,
    generation: options.generation,
    slice: {
      params: options.slice ?? {},
      found: error.found,
      expected: error.expected,
      problems: error.problems,
    },
  };
  await writeFile(join(importDir, REFUSED_SHEET_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  error.kept = join(importDir, file);
  error.message += `. The generated sheet is kept at ${error.kept}, with its generation record in ${join(importDir, REFUSED_SHEET_RECORD)}`;
}

export async function writeImport(importDir: string, record: ImportRecord): Promise<void> {
  await writeFile(join(importDir, IMPORT_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

export async function readImport(importDir: string): Promise<ImportRecord> {
  return JSON.parse(await readFile(join(importDir, IMPORT_FILE), "utf8")) as ImportRecord;
}

export interface WriteFamiliesOptions {
  importDir: string;
  /** The author's confirmed grouping (the parsed `grouping.json`). */
  grouping: unknown;
  targetDir: string;
  jitterBoundPx?: number;
  now?: () => Date;
}

export interface WrittenFamily {
  name: string;
  frames: number[];
  mirrored: boolean;
  jitterPx: number;
  result: TargetWriteResult;
  /** The motion-template and loop and continuity checks on the written strip (pixels only). */
  animation: AnimationReport;
  /** The onion-skin sheet and the looping preview, in the import's preview directory. */
  onionPath: string;
  loopPreviewPath: string;
}

/**
 * Writes each family of an author-confirmed grouping into the target: frames registered to one
 * anchor and one common scale, checked against the jitter bound and the matte checks, as one strip
 * with its manifest and per-frame provenance, review pending. Refuses before writing anything when
 * the grouping is not confirmed or any family fails a check.
 */
export async function writeFamilies(
  options: WriteFamiliesOptions,
): Promise<{ families: WrittenFamily[]; previewPath: string }> {
  const now = options.now ?? (() => new Date());
  const bound = options.jitterBoundPx ?? DEFAULT_JITTER_BOUND_PX;
  const record = await readImport(options.importDir);
  if (record.identity?.filtered) {
    throw new InputError(
      `refused: the identity lock filtered this sheet: ${record.identity.reason}`,
    );
  }
  const ids = record.frames.map((f) => f.id);
  const grouping = checkConfirmed(options.grouping, ids);
  // The profile's motion templates and thresholds are checked before anything is written.
  templatesFor(record.profile);
  thresholdsFor(record.profile);
  const byId = new Map(record.frames.map((f) => [f.id, f]));

  const failedMatte = record.frames.filter((f) => f.checks.some((c) => !c.passed));
  const plan = grouping.families.map((family) => ({
    family,
    ...familyFrames(grouping, family.name),
  }));
  const used = new Set(plan.flatMap((p) => p.frames));
  const badUsed = failedMatte.filter((f) => used.has(f.id));
  if (badUsed.length > 0) {
    throw new InputError(
      `refused: frames ${badUsed.map((f) => f.id).join(", ")} failed the background checks: ` +
        badUsed
          .flatMap((f) => f.checks.filter((c) => !c.passed).map((c) => `${f.id}: ${c.reason}`))
          .join("; "),
    );
  }

  const images = new Map<number, Raster>();
  const frameOrigins = new Map<number, DigitalSourceType>();
  for (const id of used) {
    const f = byId.get(id) as ImportedFrame;
    const bytes = new Uint8Array(await readFile(join(options.importDir, f.file)));
    images.set(id, decodeImage(bytes));
    frameOrigins.set(
      id,
      readDigitalSourceType(bytes, "image/png") ??
        record.digitalSourceType ??
        DIGITAL_SOURCE_TYPES.undeclared,
    );
  }
  for (const origin of frameOrigins.values()) requireDeclared(origin);
  const style = record.style;
  const figures: ImageItem[] = [];
  const families: string[] = [];
  const flipSteps = new Map<string, TransformStep>();
  for (const p of plan) {
    let items = p.frames.map((id): ImageItem => ({
      name: `f${String(id).padStart(3, "0")}`,
      raster: images.get(id) as Raster,
      mediaType: "image/png",
      meta: {},
      digitalSourceType:
        frameOrigins.get(id) ?? record.digitalSourceType ?? DIGITAL_SOURCE_TYPES.undeclared,
    }));
    if (p.mirrored) {
      const flipped = runOperation(items, { op: "flip" }, { style });
      flipSteps.set(p.family.name, flipped.step);
      items = flipped.items;
    }
    figures.push(...items);
    families.push(...items.map(() => p.family.name));
  }
  const registration = runOperation(
    figures,
    {
      op: "register",
      params: {
        frame: record.frame,
        anchor: record.anchor,
        families,
        ...(record.scale !== undefined && { scale: record.scale }),
      },
    },
    { style },
  );
  const commonScale = (registration.step.report as { scale: number }).scale;

  let cursor = 0;
  const staged = plan.map((p) => {
    const registered = registration.items.slice(cursor, cursor + p.frames.length).map((item) => ({
      item,
      transforms: item.meta["transforms"] as Transform[],
      jitterPx: item.meta["jitterPx"] as number,
    }));
    cursor += p.frames.length;
    const jitterPx = Math.max(...registered.map((r) => r.jitterPx));
    return { ...p, registered, jitterPx };
  });
  const jittery = staged.filter((s) => s.jitterPx > bound);
  if (jittery.length > 0) {
    throw new InputError(
      `refused: registration jitter over the ${bound} px bound in ` +
        jittery.map((s) => `${s.family.name} (${s.jitterPx.toFixed(2)} px)`).join(", "),
    );
  }

  const { frame, anchor } = record;
  const generationCalls = record.generation?.calls ?? [];
  const calls = [...generationCalls, ...record.calls];
  const unique = <T>(values: T[]) => [...new Set(values)];
  const at = now().toISOString();
  const written: WrittenFamily[] = [];
  const previews: Array<{ name: string; file: string; count: number; jitterPx: number }> = [];
  await mkdir(join(options.importDir, "preview"), { recursive: true });

  for (const s of staged) {
    const count = s.registered.length;
    const styled = runOperation(
      s.registered.map((r) => r.item),
      { op: "apply-style" },
      { style },
    );
    const joined = runOperation(
      styled.items,
      { op: "join", params: { name: s.family.name } },
      {
        style,
      },
    );
    // This family's own flip only; register runs over every family's frames at once.
    const flip = flipSteps.get(s.family.name);
    const familySteps = [...(flip ? [flip] : []), registration.step, styled.step, joined.step];
    const strip = (joined.items[0] as ImageItem).raster;
    const frameProvenance: FrameProvenance[] = [];
    let union: Box | undefined;
    const usedColours = new Set<string>();
    s.registered.forEach((r, i) => {
      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          const px = getPixel(strip, i * frame.width + x, y);
          if (px[3] > 0) usedColours.add(toHex([px[0], px[1], px[2]]));
        }
      }
      const box = visibleBox(strip, style.alpha.threshold, {
        x: i * frame.width,
        y: 0,
        ...frame,
      });
      if (box) {
        if (!union) union = box;
        else {
          const x = Math.min(union.x, box.x);
          const y = Math.min(union.y, box.y);
          union = {
            x,
            y,
            width: Math.max(union.x + union.width, box.x + box.width) - x,
            height: Math.max(union.y + union.height, box.y + box.height) - y,
          };
        }
      }
      const id = s.frames[i] as number;
      const source = byId.get(id) as ImportedFrame;
      const styleSteps: Transform[] = [];
      if (style.alpha.mode === "binary") {
        styleSteps.push({ op: "binarize", threshold: style.alpha.threshold });
      }
      if (style.color.rule === "palette") {
        styleSteps.push({ op: "quantize", palette: style.color.palette });
      }
      frameProvenance.push({
        index: i,
        frame: id,
        cell: source.cell,
        tool: record.sheet.tool,
        sheetSha256: record.sheet.sha256,
        transforms: [
          ...source.transforms,
          ...(s.mirrored ? [{ op: "mirror", axis: "vertical", of: s.family.mirrorOf }] : []),
          ...r.transforms,
          ...styleSteps,
        ],
      });
    });
    if (!union) throw new InputError(`family ${s.family.name} has no visible pixel`);
    const digitalSourceType =
      joined.items[0]?.digitalSourceType ??
      record.digitalSourceType ??
      DIGITAL_SOURCE_TYPES.undeclared;
    const bytes = embedDigitalSourceType(encodePng(strip), "image/png", digitalSourceType);

    const spec: AssetSpec = {
      kind: "sprite-strip",
      assetId: record.assetId,
      ...(record.subject !== undefined && { subject: record.subject }),
      ...(record.gait !== undefined && { gait: record.gait }),
      animationFamily: s.family.name,
      // The requesting spec's target fields (atlas slot, labels, semantics) belong to the family it asked for.
      ...(record.spec?.animationFamily === s.family.name && { fields: record.spec.fields }),
      frames: {
        count,
        width: frame.width,
        height: frame.height,
        ...(record.durationMs !== undefined && { durationMs: record.durationMs }),
      },
      anchor,
    };
    const prompt =
      record.generation?.prompt ??
      `Imported from a contact sheet made with ${record.sheet.tool}; that tool's own prompt is not recorded.`;
    const provenance: Provenance = {
      digitalSourceType,
      ...(record.sourceDeclaration && { sourceDeclaration: record.sourceDeclaration }),
      generator: "sheet-import",
      route: unique(calls.map((c) => c.route)).join(" + ") || `import:${record.sheet.tool}`,
      models: unique([
        ...(record.generation ? [] : [record.sheet.tool]),
        ...calls.map((c) => c.model),
      ]),
      prompt,
      parameters: {
        ...(record.generation?.parameters ?? {}),
        frame,
        frameCount: count,
        anchor,
        style,
        frames: s.frames,
        ...(s.family.mirrorOf !== undefined && { mirrorOf: s.family.mirrorOf }),
        familyReason: s.family.reason,
        commonScale,
        jitterPx: s.jitterPx,
        jitterBoundPx: bound,
        importId: record.importId,
      },
      ...(calls.find((c) => c.seed !== undefined)?.seed !== undefined && {
        seed: calls.find((c) => c.seed !== undefined)?.seed as number,
      }),
      requestIds: calls.map((c) => c.requestId),
      referenceHashes: unique(calls.flatMap((c) => c.referenceHashes)),
      bibleVersion: record.bibleVersion,
      ...licenseFields(record.profile, calls),
      providerTerms: unique(calls.map((c) => c.providerTerms)),
      startedAt: calls[0]?.startedAt ?? record.createdAt,
      finishedAt: calls[calls.length - 1]?.finishedAt ?? record.createdAt,
      costUsd: calls.reduce((sum, c) => sum + c.costUsd, 0),
      calls,
      sheet: record.sheet,
      ...(record.identity && { identity: record.identity }),
      frames: frameProvenance,
      steps: [
        ...(record.steps ?? []),
        ...familySteps,
        metadataStep(digitalSourceType, [pixelHash(strip)]),
      ],
    };
    const result = await writeToTarget({
      profile: record.profile,
      spec,
      bibleVersion: record.bibleVersion,
      output: {
        bytes,
        mediaType: "image/png",
        extension: "png",
        fields: {
          frames: spec.frames,
          anchor,
          bounds: union,
          ...(style.color.rule === "palette" && {
            palette: style.color.palette.filter((hex) => usedColours.has(toHex(parseHex(hex)))),
          }),
          jitterPx: s.jitterPx,
        },
      },
      provenance,
      run: { runId: record.importId, candidateId: s.family.name, pickedAt: at },
      targetDir: options.targetDir,
    });
    const previewFile = `preview/${s.family.name}.png`;
    await writeFile(join(options.importDir, previewFile), bytes);
    const durationMs = record.durationMs ?? DEFAULT_DURATION_MS;
    const stripFrames = splitStrip(strip, frame);
    const animation = animationQa(
      {
        frames: stripFrames,
        frame,
        anchor,
        family: s.family.name,
        durationMs,
        ...(record.gait !== undefined && { gait: record.gait }),
      },
      record.profile,
      style,
    );
    const rendered = renderPreviews(stripFrames, {
      anchor,
      loop: familyLoops(s.family.name, record.profile),
      durationMs,
      report: animation,
      digitalSourceType,
    });
    const onionPath = join(options.importDir, "preview", `${s.family.name}.onion.png`);
    const loopPreviewPath = join(options.importDir, "preview", `${s.family.name}.webp`);
    await writeFile(onionPath, rendered.onion);
    await writeFile(loopPreviewPath, rendered.preview);
    previews.push({ name: s.family.name, file: previewFile, count, jitterPx: s.jitterPx });
    written.push({
      name: s.family.name,
      frames: s.frames,
      mirrored: s.mirrored,
      jitterPx: s.jitterPx,
      result,
      animation,
      onionPath,
      loopPreviewPath,
    });
  }

  const previewPath = join(options.importDir, PREVIEW_FILE);
  await writeFile(previewPath, previewHtml(previews, frame, record.durationMs ?? 120));
  record.scale ??= commonScale;
  record.written = [
    ...(record.written ?? []),
    {
      at,
      target: resolve(options.targetDir),
      families: written.map((w) => w.name),
      files: written.flatMap((w) => w.result.files),
    },
  ];
  await writeImport(options.importDir, record);
  return { families: written, previewPath };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A looping preview page: each strip animated with CSS steps at the frame duration. */
export function previewHtml(
  strips: Array<{ name: string; file: string; count: number; jitterPx: number }>,
  frame: Size,
  durationMs: number,
): string {
  const zoom = Math.max(1, Math.floor(192 / Math.max(frame.width, frame.height)));
  const w = frame.width * zoom;
  const h = frame.height * zoom;
  const rows = strips.map((s, i) => {
    const total = s.count * durationMs;
    return [
      `<figure>`,
      `<div class="sprite" style="width:${w}px;height:${h}px;background-image:url('${escapeHtml(s.file)}');background-size:${w * s.count}px ${h}px;animation:play${i} ${total}ms steps(${s.count}) infinite"></div>`,
      `<figcaption>${escapeHtml(s.name)}: ${s.count} frames, jitter ${s.jitterPx.toFixed(2)} px</figcaption>`,
      `<style>@keyframes play${i}{from{background-position:0 0}to{background-position:-${w * s.count}px 0}}</style>`,
      `</figure>`,
    ].join("");
  });
  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    "<title>Assetforge sheet import preview</title>",
    "<style>body{font-family:sans-serif;background:#888;display:flex;flex-wrap:wrap;gap:16px}.sprite{image-rendering:pixelated;background-repeat:no-repeat;background-color:#bbb}</style>",
    ...rows,
    "",
  ].join("\n");
}
