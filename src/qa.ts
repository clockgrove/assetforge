import { getPixel, toHex } from "./image/raster.ts";
import type { Raster } from "./image/raster.ts";
import type { QaResult, Reason, Size } from "./types.ts";

export interface SpecExpectation {
  frame: Size;
  frameCount: number;
  /** Allowed colours as "#rrggbb". */
  palette: string[];
  /** Default true. */
  requireTransparentPixel?: boolean;
}

function det(check: string, passed: boolean, reason: string): Reason {
  return { check, passed, reason, source: "deterministic" };
}

export function deterministicChecks(strip: Raster, expected: SpecExpectation): Reason[] {
  const { frame, frameCount } = expected;
  const total = strip.width * strip.height;
  let transparent = 0;
  let soft = 0;
  for (let i = 0; i < total; i++) {
    const a = strip.data[i * 4 + 3] ?? 0;
    if (a === 0) transparent++;
    else if (a !== 255) soft++;
  }
  const needTransparent = expected.requireTransparentPixel ?? true;
  let transparency: Reason;
  if (soft > 0) {
    transparency = det("transparency", false, `${soft} of ${total} pixels have partial alpha`);
  } else if (needTransparent && transparent === 0) {
    transparency = det("transparency", false, "no pixel is transparent");
  } else {
    transparency = det(
      "transparency",
      true,
      `all ${total} pixels have alpha 0 or 255; ${transparent} transparent`,
    );
  }

  const wantWidth = frame.width * frameCount;
  let frames: Reason;
  if (strip.width !== wantWidth || strip.height !== frame.height) {
    frames = det(
      "frame-count",
      false,
      `strip is ${strip.width}x${strip.height}, expected ${wantWidth}x${frame.height} (${frameCount} frames of ${frame.width}x${frame.height})`,
    );
  } else {
    let empty = 0;
    for (let f = 0; f < frameCount && empty === 0; f++) {
      let any = false;
      for (let y = 0; y < frame.height && !any; y++) {
        for (let x = 0; x < frame.width; x++) {
          if (getPixel(strip, f * frame.width + x, y)[3] > 0) {
            any = true;
            break;
          }
        }
      }
      if (!any) empty = f + 1;
    }
    frames =
      empty > 0
        ? det("frame-count", false, `frame ${empty} of ${frameCount} is empty`)
        : det(
            "frame-count",
            true,
            `${frameCount} frames of ${frame.width}x${frame.height}, none empty`,
          );
  }

  const allowed = new Set(expected.palette.map((c) => c.trim().toLowerCase()));
  const used = new Set<string>();
  const bad = new Set<string>();
  for (let y = 0; y < strip.height; y++) {
    for (let x = 0; x < strip.width; x++) {
      const [r, g, b, a] = getPixel(strip, x, y);
      if (a === 0) continue;
      const hex = toHex([r, g, b]);
      used.add(hex);
      if (!allowed.has(hex)) bad.add(hex);
    }
  }
  const palette =
    bad.size > 0
      ? det(
          "palette",
          false,
          `${bad.size} colours outside the palette, for example ${[...bad].slice(0, 3).join(", ")}`,
        )
      : det("palette", true, `all ${used.size} opaque colours are in the palette`);

  return [transparency, frames, palette];
}

export const VISION_CHECKS = ["transparency", "frame-count", "identity", "perspective"] as const;

export interface VisionPromptInput {
  subject: string;
  subjectDescription?: string;
  frameCount: number;
  frame: Size;
  animationFamily?: string;
  /** Roles of the reference images, in the order attached after the candidate. */
  referenceRoles: string[];
}

export function buildVisionPrompt(input: VisionPromptInput): string {
  const { frame, frameCount } = input;
  const lines = [
    `You are reviewing a candidate sprite strip of "${input.subject}".`,
    ...(input.subjectDescription ? [`Subject: ${input.subjectDescription}`] : []),
    ...(input.animationFamily ? [`Animation: ${input.animationFamily}`] : []),
    `Image 1 is the candidate: a strip of ${frameCount} frames side by side, each ${frame.width} x ${frame.height} pixels, on a transparent background.`,
    ...input.referenceRoles.map((role, i) => `Image ${i + 2} is a reference with role "${role}".`),
    "Judge each check:",
    "- transparency: the background is fully transparent, with no halo, fringe or solid backdrop.",
    `- frame-count: the strip shows exactly ${frameCount} distinct frames, each fully inside its ${frame.width} x ${frame.height} cell.`,
    "- identity: the candidate shows the same character or object as the references.",
    "- perspective: the candidate matches the isometric perspective of the perspective sample.",
    'Reply with ONLY a JSON object, no other text: {"checks":[{"check":"identity","passed":true,"reason":"..."}, ...]} with one entry for each of: ' +
      VISION_CHECKS.join(", ") +
      ". Give a short, specific reason for each.",
  ];
  return lines.join("\n");
}

export function parseVisionVerdict(text: string): Reason[] {
  const found = new Map<string, { passed: boolean; reason: string }>();
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    const checks = (parsed as { checks?: unknown } | null)?.checks;
    if (Array.isArray(checks)) {
      for (const item of checks) {
        const c = item as { check?: unknown; passed?: unknown; reason?: unknown } | null;
        if (c && typeof c.check === "string" && typeof c.passed === "boolean") {
          found.set(c.check, {
            passed: c.passed,
            reason: typeof c.reason === "string" && c.reason ? c.reason : "no reason given",
          });
        }
      }
    }
  } catch {
    // unreadable text leaves every check missing
  }
  return VISION_CHECKS.map((check) => {
    const v = found.get(check);
    return v
      ? { check, passed: v.passed, reason: v.reason, source: "vision" as const }
      : {
          check,
          passed: false,
          reason: "the vision verdict was missing or unreadable for this check",
          source: "vision" as const,
        };
  });
}

export function combineQa(...groups: Reason[][]): QaResult {
  const reasons = groups.flat();
  return { passed: reasons.length > 0 && reasons.every((r) => r.passed), reasons };
}
