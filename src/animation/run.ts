/**
 * Animation QA of one strip, end to end: the deterministic pixel checks against the family's
 * motion template, the optional identity-flicker vision check, and the onion-skin sheet and
 * looping preview the person picking looks at.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Caller } from "../calls.ts";
import { InputError } from "../errors.ts";
import { encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { DIGITAL_SOURCE_TYPES, embedDigitalSourceType } from "../metadata.ts";
import type { DigitalSourceType } from "../metadata.ts";
import type { ResolvedStyle } from "../style.ts";
import type { Point, Size, TargetProfile } from "../types.ts";
import { appendDecisionLog, checkFlicker } from "./flicker.ts";
import { loopPreview, onionSkinSheet, PREVIEW_MEDIA_TYPES } from "./preview.ts";
import { animationQa } from "./qa.ts";
import { splitStrip } from "./strip.ts";
import { templateFor, templatesFor, thresholdsFor } from "./templates.ts";
import type { AnimationReport, FlickerDecision } from "./types.ts";

export const DEFAULT_DURATION_MS = 120;
export const FLICKER_LOG = "flicker.jsonl";

/** The bottom centre of the frame, as the sheet import's default anchor. */
export function defaultAnchor(frame: Size): Point {
  return { x: Math.floor(frame.width / 2), y: frame.height - 1 };
}

/** The profile's frame size. */
export function profileFrame(profile: TargetProfile): Size {
  return { width: profile.frames.width, height: profile.frames.height };
}

/** Whether the family's cycle loops: its template's say, or a loop when no template matches. */
export function familyLoops(family: string, profile: TargetProfile): boolean {
  return templateFor(family, templatesFor(profile))?.loop ?? true;
}

export interface Previews {
  onion: Uint8Array;
  preview: Uint8Array;
}

/** The onion-skin sheet (PNG) and the looping preview (animated WebP) of a strip's frames. */
export function renderPreviews(
  frames: Raster[],
  options: {
    anchor: Point;
    loop: boolean;
    durationMs: number;
    report?: AnimationReport;
    digitalSourceType?: DigitalSourceType;
  },
): Previews {
  const flagged = [
    ...new Set(
      (options.report?.reasons ?? []).filter((r) => !r.passed).flatMap((r) => r.frames ?? []),
    ),
  ].sort((a, b) => a - b);
  const origin = options.digitalSourceType ?? DIGITAL_SOURCE_TYPES.undeclared;
  const onion = encodePng(
    onionSkinSheet(frames, { anchor: options.anchor, loop: options.loop, flagged }),
  );
  return {
    onion: embedDigitalSourceType(onion, PREVIEW_MEDIA_TYPES.onion, origin),
    preview: embedDigitalSourceType(
      loopPreview(frames, { durationMs: options.durationMs }),
      PREVIEW_MEDIA_TYPES.preview,
      origin,
    ),
  };
}

export interface StripQaOptions {
  strip: Raster;
  family: string;
  profile: TargetProfile;
  style: ResolvedStyle;
  /** Defaults to the profile's frame size. */
  frame?: Size;
  /** Defaults to the bottom centre of the frame. */
  anchor?: Point;
  /** Defaults to the profile's frame duration, else 120 ms. */
  durationMs?: number;
  /** The subject's gait from its asset spec; defaults to the profile's `animation.gait`. */
  gait?: string;
  /** Where the report, the previews and the flicker log are written. */
  outDir: string;
  /** Embedded in the previews when known. */
  digitalSourceType?: DigitalSourceType;
  /** Runs the identity-flicker check through this caller; omitted, the check is skipped. */
  flicker?: { call: Caller; subject: string; subjectDescription?: string; now?: () => Date };
}

export interface StripQaResult {
  report: AnimationReport & { identityFlicker: "checked" | "skipped" };
  decisions: FlickerDecision[];
  files: { report: string; onion: string; preview: string; flickerLog?: string };
}

/**
 * Runs the deterministic checks, then (when a caller is given) the identity-flicker check, and
 * writes `<family>.qa.json`, `<family>.onion.png` and `<family>.webp` into the output directory.
 */
export async function qaStrip(options: StripQaOptions): Promise<StripQaResult> {
  const { profile, style, family } = options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(family)) {
    throw new InputError(`invalid family name "${family}"`);
  }
  const frame = options.frame ?? profileFrame(profile);
  const anchor = options.anchor ?? defaultAnchor(frame);
  if (anchor.x < 0 || anchor.x >= frame.width || anchor.y < 0 || anchor.y >= frame.height) {
    throw new InputError(`anchor ${anchor.x},${anchor.y} lies outside the frame`);
  }
  const durationMs = options.durationMs ?? profile.frames.durationMs ?? DEFAULT_DURATION_MS;
  const frames = splitStrip(options.strip, frame);
  // Validate templates and thresholds before any spend.
  thresholdsFor(profile);
  const base = animationQa(
    {
      frames,
      frame,
      anchor,
      family,
      durationMs,
      ...(options.gait !== undefined && { gait: options.gait }),
    },
    profile,
    style,
  );
  const loop = familyLoops(family, profile);

  let decisions: FlickerDecision[] = [];
  let report: StripQaResult["report"] = { ...base, identityFlicker: "skipped" };
  if (options.flicker) {
    const flicker = await checkFlicker({
      frames,
      family,
      subject: options.flicker.subject,
      ...(options.flicker.subjectDescription !== undefined && {
        subjectDescription: options.flicker.subjectDescription,
      }),
      loop,
      cutoff: base.thresholds.flickerCutoff,
      call: options.flicker.call,
      ...(options.flicker.now !== undefined && { now: options.flicker.now }),
    });
    decisions = flicker.decisions;
    const reasons = [...base.reasons, ...flicker.reasons];
    report = {
      ...base,
      reasons,
      passed: reasons.every((r) => r.passed),
      identityFlicker: "checked",
    };
  }

  await mkdir(options.outDir, { recursive: true });
  const previews = renderPreviews(frames, {
    anchor,
    loop,
    durationMs,
    report,
    ...(options.digitalSourceType !== undefined && {
      digitalSourceType: options.digitalSourceType,
    }),
  });
  const files: StripQaResult["files"] = {
    report: join(options.outDir, `${family}.qa.json`),
    onion: join(options.outDir, `${family}.onion.png`),
    preview: join(options.outDir, `${family}.webp`),
  };
  await writeFile(files.onion, previews.onion);
  await writeFile(files.preview, previews.preview);
  await writeFile(files.report, `${JSON.stringify({ ...report, decisions }, null, 2)}\n`);
  if (decisions.length > 0) {
    files.flickerLog = join(options.outDir, FLICKER_LOG);
    await appendDecisionLog(files.flickerLog, decisions);
  }
  return { report, decisions, files };
}

/** The human lines of a report: the verdict, then each failed check (each names its frames). */
export function formatReport(report: StripQaResult["report"]): string[] {
  const failed = report.reasons.filter((r) => !r.passed);
  const lines = [
    `${report.family}: ${report.frameCount} frames, template ${report.template ?? "none"}` +
      (report.gait !== undefined ? `, gait ${report.gait}` : "") +
      ", " +
      (report.passed ? "all checks passed" : `${failed.length} check(s) failed`) +
      (report.identityFlicker === "skipped" ? " (identity flicker not checked)" : ""),
  ];
  for (const r of failed) lines.push(`  ${r.check} [${r.source}]: ${r.reason}`);
  return lines;
}
