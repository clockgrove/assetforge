/**
 * The sheet import path: a raw contact sheet (from Assetforge's own sheet generation, another tool
 * or hand work) becomes cleaned frames and a grouping proposal; an author-confirmed grouping then
 * becomes one strip, manifest and provenance per family in the target, with review pending.
 */
import { InputError } from "../errors.ts";
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
import { flipHorizontal } from "../image/resample.ts";
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
  Rgb,
  SheetSource,
  Size,
  TargetProfile,
  Transform,
} from "../types.ts";
import { checkConfirmed, familyFrames, proposeGrouping } from "./group.ts";
import { matteChecks, matteFigure } from "./matte.ts";
import { registerFrames } from "./register.ts";
import { sliceSheet } from "./slice.ts";
import type { Grouping, MatteQuality, SliceOptions } from "./types.ts";
import type { LoadedReference } from "../types.ts";

export const IMPORT_FILE = "import.json";
export const GROUPING_FILE = "grouping.json";
export const CONTACT_FILE = "contact.png";
export const PREVIEW_FILE = "preview.html";
/** Default bound on registration jitter, in frame pixels. */
export const DEFAULT_JITTER_BOUND_PX = 1;

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
  importId: string;
  createdAt: string;
  assetId: string;
  subject?: string;
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
  /** The grouping proposal's calls. */
  calls: CallRecord[];
  written?: Array<{ at: string; target: string; families: string[]; files: string[] }>;
  /**
   * The common scale fitted on the first write, reused by every later write of this import so all
   * of an asset's families stay one size whatever grouping each write uses.
   */
  scale?: number;
}

export interface ImportOptions {
  sheet: Uint8Array;
  /** Recorded as the sheet's path in provenance. */
  sheetPath: string;
  /** The model or tool that made the sheet, for example "ChatGPT image generation". */
  tool: string;
  assetId: string;
  subject?: string;
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
  now?: () => Date;
}

/** Re-applies the style's alpha and colour rule after resampling, which softens both. */
export function applyStyle(image: Raster, style: ResolvedStyle): Raster {
  const out = createRaster(image.width, image.height);
  out.data.set(image.data);
  const palette = style.color.rule === "palette" ? style.color.palette.map(parseHex) : [];
  for (let i = 0; i < out.data.length; i += 4) {
    let a = out.data[i + 3] ?? 0;
    if (style.alpha.mode === "binary") a = a >= style.alpha.threshold ? 255 : 0;
    out.data[i + 3] = a;
    if (a === 0) {
      out.data[i] = 0;
      out.data[i + 1] = 0;
      out.data[i + 2] = 0;
      continue;
    }
    if (palette.length > 0) {
      const px = [out.data[i] ?? 0, out.data[i + 1] ?? 0, out.data[i + 2] ?? 0];
      let best = palette[0] as Rgb;
      let bestDist = Infinity;
      for (const p of palette) {
        const d =
          2 * ((px[0] as number) - p[0]) ** 2 +
          4 * ((px[1] as number) - p[1]) ** 2 +
          3 * ((px[2] as number) - p[2]) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      out.data[i] = best[0];
      out.data[i + 1] = best[1];
      out.data[i + 2] = best[2];
    }
  }
  return out;
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
  const raster = decodeImage(options.sheet);
  const sliced = sliceSheet(raster, options.slice);
  if (sliced.figures.length === 0) throw new InputError("no figures found on the sheet");

  const importId =
    options.importId ??
    `${now().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const importDir = resolve(options.importsDir, importId);
  await mkdir(join(importDir, "frames"), { recursive: true });

  const sheetSha = sha256(options.sheet);
  const frames: ImportedFrame[] = [];
  const cleaned: Raster[] = [];
  for (const figure of sliced.figures) {
    const matted = matteFigure(figure, style);
    const file = frameFile(figure.id);
    await writeFile(join(importDir, file), encodePng(matted.image));
    cleaned.push(matted.image);
    frames.push({
      id: figure.id,
      file,
      cell: figure.cell,
      box: figure.box,
      background: toHex(figure.background),
      // The matte's transforms start with the slicing ones.
      transforms: matted.transforms,
      quality: matted.quality,
      checks: matteChecks(matted.quality),
    });
  }

  const preview = registerFrames(cleaned, { frame, anchor, edges: style.edges });
  const ids = frames.map((f) => f.id);
  const contact = encodePng(
    contactSheet(
      preview.frames.map((f) => applyStyle(f.image, style)),
      ids,
      frame,
    ),
  );
  await writeFile(join(importDir, CONTACT_FILE), contact);

  const record: ImportRecord = {
    importId,
    createdAt: now().toISOString(),
    assetId: options.assetId,
    ...(options.subject !== undefined && { subject: options.subject }),
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
      mode: sliced.mode,
      ...(sliced.grid !== undefined && { grid: sliced.grid }),
      background: toHex(sliced.background),
    },
    frames,
    ...(options.generation !== undefined && { generation: options.generation }),
    calls: [],
  };

  let grouping: Grouping;
  if (options.propose) {
    const { call } = options.propose;
    const before = call.records.length;
    grouping = await proposeGrouping(
      call,
      {
        role: "contact sheet",
        path: CONTACT_FILE,
        mediaType: "image/png",
        bytes: contact,
        sha256: sha256(contact),
      },
      options.propose.references ?? [],
      {
        frameIds: ids,
        subject: options.subject ?? options.assetId,
        ...(options.propose.subjectDescription !== undefined && {
          subjectDescription: options.propose.subjectDescription,
        }),
        ...(options.propose.hints !== undefined && { hints: options.propose.hints }),
        referenceRoles: (options.propose.references ?? []).map((r) => r.role),
      },
    );
    record.calls = call.records.slice(before);
  } else {
    grouping = {
      status: "proposed",
      families: [],
      unassigned: ids,
      notes: "No vision proposal was made; group the frames by hand.",
    };
  }
  await writeFile(join(importDir, GROUPING_FILE), `${JSON.stringify(grouping, null, 2)}\n`);
  await writeImport(importDir, record);
  return { record, importDir, grouping };
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
  const ids = record.frames.map((f) => f.id);
  const grouping = checkConfirmed(options.grouping, ids);
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
  for (const id of used) {
    const f = byId.get(id) as ImportedFrame;
    images.set(id, decodeImage(new Uint8Array(await readFile(join(options.importDir, f.file)))));
  }
  const figures: Raster[] = [];
  const families: string[] = [];
  for (const p of plan) {
    for (const id of p.frames) {
      const image = images.get(id) as Raster;
      figures.push(p.mirrored ? flipHorizontal(image) : image);
      families.push(p.family.name);
    }
  }
  const style = record.style;
  const registration = registerFrames(figures, {
    frame: record.frame,
    anchor: record.anchor,
    edges: style.edges,
    families,
    ...(record.scale !== undefined && { scale: record.scale }),
  });

  let cursor = 0;
  const staged = plan.map((p) => {
    const registered = registration.frames.slice(cursor, cursor + p.frames.length);
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
    const strip = createRaster(frame.width * count, frame.height);
    const frameProvenance: FrameProvenance[] = [];
    let union: Box | undefined;
    const usedColours = new Set<string>();
    s.registered.forEach((r, i) => {
      const styled = applyStyle(r.image, style);
      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          const px = getPixel(styled, x, y);
          setPixel(strip, i * frame.width + x, y, px);
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
    if (!union) throw new Error(`family ${s.family.name} has no visible pixel`);
    const bytes = encodePng(strip);

    const spec: AssetSpec = {
      kind: "sprite-strip",
      assetId: record.assetId,
      ...(record.subject !== undefined && { subject: record.subject }),
      animationFamily: s.family.name,
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
        commonScale: registration.scale,
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
      license: record.profile.license,
      providerTerms: unique(calls.map((c) => c.providerTerms)),
      startedAt: calls[0]?.startedAt ?? record.createdAt,
      finishedAt: calls[calls.length - 1]?.finishedAt ?? record.createdAt,
      costUsd: calls.reduce((sum, c) => sum + c.costUsd, 0),
      calls,
      sheet: record.sheet,
      frames: frameProvenance,
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
    previews.push({ name: s.family.name, file: previewFile, count, jitterPx: s.jitterPx });
    written.push({
      name: s.family.name,
      frames: s.frames,
      mirrored: s.mirrored,
      jitterPx: s.jitterPx,
      result,
    });
  }

  const previewPath = join(options.importDir, PREVIEW_FILE);
  await writeFile(previewPath, previewHtml(previews, frame, record.durationMs ?? 120));
  record.scale ??= registration.scale;
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
