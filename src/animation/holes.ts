/**
 * The holes check of a strip: a background removal that took part of the figure for background
 * leaves see-through holes inside it (a pale blaze, a facial marking, a tail ring). Pixels find
 * every see-through area the figure's outline encloses; whether one is a hole or a natural opening
 * between two parts (between the legs, between an arm and the body) is a judgement pixels cannot
 * make, since both are transparent and ringed by the figure's soft edge. A vision model makes it,
 * one call per frame that has such an area, with the areas marked on the frame.
 */
import type { Caller } from "../calls.ts";
import { createRaster, encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { sha256 } from "../request.ts";
import type { Routes } from "../routes.ts";
import type { LoadedReference } from "../types.ts";
import type { AnimationReason, HoleDecision } from "./types.ts";

/** The backdrop the frame is shown over, and the colour that marks each enclosed area. */
const BACKDROP = [46, 120, 52] as const;
const MARK = [255, 0, 255] as const;
/** The judged image's longer side is at least this many px. */
const VIEW_PX = 384;

export interface EnclosedArea {
  /** Pixels below the alpha cut. */
  area: number;
  /** Bounding box, in frame px. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The see-through areas the figure's outline encloses: runs of pixels below the alpha cut
 * (8-connected) that do not reach the frame's edge, each at least `minPx` big. `marked` is 1 on
 * every pixel of those areas.
 */
export function enclosedAreas(
  frame: Raster,
  options: { threshold: number; minPx: number },
): { areas: EnclosedArea[]; marked: Uint8Array } {
  const { width, height, data } = frame;
  const n = width * height;
  const open = (p: number) => (data[p * 4 + 3] ?? 0) < options.threshold;
  const label = new Int32Array(n).fill(-1);
  const marked = new Uint8Array(n);
  const flood = (start: number, id: number): number[] => {
    const members: number[] = [];
    const stack = [start];
    label[start] = id;
    while (stack.length > 0) {
      const p = stack.pop() as number;
      members.push(p);
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const q = yy * width + xx;
          if (label[q] !== -1 || !open(q)) continue;
          label[q] = id;
          stack.push(q);
        }
      }
    }
    return members;
  };
  for (let x = 0; x < width; x++) {
    for (const p of [x, (height - 1) * width + x]) if (open(p) && label[p] === -1) flood(p, 0);
  }
  for (let y = 0; y < height; y++) {
    for (const p of [y * width, y * width + width - 1]) if (open(p) && label[p] === -1) flood(p, 0);
  }
  const areas: EnclosedArea[] = [];
  let next = 1;
  for (let start = 0; start < n; start++) {
    if (label[start] !== -1 || !open(start)) continue;
    const members = flood(start, next++);
    if (members.length < options.minPx) continue;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (const p of members) {
      marked[p] = 1;
      const x = p % width;
      const y = (p - x) / width;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    areas.push({
      area: members.length,
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    });
  }
  return { areas, marked };
}

/** The frame as the model sees it: enlarged over a green backdrop, enclosed areas in magenta. */
export function holeView(frame: Raster, marked: Uint8Array): Raster {
  const zoom = Math.max(1, Math.ceil(VIEW_PX / Math.max(frame.width, frame.height)));
  const out = createRaster(frame.width * zoom, frame.height * zoom);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const p = Math.floor(y / zoom) * frame.width + Math.floor(x / zoom);
      const a = (frame.data[p * 4 + 3] ?? 0) / 255;
      const under = marked[p] ? MARK : BACKDROP;
      const o = (y * out.width + x) * 4;
      for (let k = 0; k < 3; k++) {
        out.data[o + k] = Math.round((frame.data[p * 4 + k] ?? 0) * a + (under[k] ?? 0) * (1 - a));
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

export function buildHolesPrompt(input: {
  subject: string;
  family: string;
  frame: number;
  areas: number;
}): string {
  return [
    `This is frame ${input.frame} of a "${input.family}" animation of ${input.subject}, enlarged, over a plain green backdrop. A program removed the character's original background.`,
    `Magenta marks the ${input.areas === 1 ? "place" : `${input.areas} places`} where the picture is see-through although the character's outline surrounds it.`,
    "For each magenta area decide: is it a natural opening between separate parts (between two legs, between a leg or an arm and the body, between the tail and the body), where the backdrop really shows through; or a hole in the middle of one part (the face, a marking, an eye, the torso, the tail, a stripe), where the removal wrongly cut the character away?",
    'Reply with ONLY JSON: {"holes":true|false,"areas":[{"where":"...","kind":"opening"|"hole"}],"confidence":0..1}',
    '"holes" is true when any area is a hole. Give your confidence in that answer.',
  ].join("\n");
}

export interface HolesReply {
  label: "holes" | "openings" | "unreadable";
  confidence: number;
  /** Where the model saw each hole. */
  where: string[];
  reason: string;
}

export function parseHolesReply(text: string): HolesReply {
  const unreadable = (reason: string): HolesReply => ({
    label: "unreadable",
    confidence: 0,
    where: [],
    reason,
  });
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return unreadable("the reply was not valid JSON");
  }
  if (typeof value !== "object" || value === null) return unreadable("the reply was not an object");
  const { holes, confidence, areas } = value as Record<string, unknown>;
  if (typeof holes !== "boolean") return unreadable("the reply had no holes true or false");
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) {
    return unreadable("the reply had no confidence between 0 and 1");
  }
  const listed = Array.isArray(areas) ? areas : [];
  const where = listed.flatMap((a) => {
    if (typeof a !== "object" || a === null) return [];
    const { where: w, kind } = a as Record<string, unknown>;
    return kind === "hole" ? [typeof w === "string" && w !== "" ? w : "unnamed"] : [];
  });
  const openings = listed.filter(
    (a) => typeof a === "object" && a !== null && (a as { kind?: unknown }).kind === "opening",
  ).length;
  return {
    label: holes ? "holes" : "openings",
    confidence,
    where,
    reason: holes
      ? `hole(s): ${where.join("; ") || "unnamed"}`
      : `${openings || "every"} area(s) an opening between parts`,
  };
}

/** The frames (1-based) a holes check would send to the model, and their areas. */
export function holeCandidates(
  frames: Raster[],
  options: { threshold: number; minPx: number },
): Array<{ frame: number; areas: EnclosedArea[]; marked: Uint8Array }> {
  return frames.flatMap((f, i) => {
    const found = enclosedAreas(f, options);
    return found.areas.length === 0 ? [] : [{ frame: i + 1, ...found }];
  });
}

export function planHoles(
  frames: Raster[],
  options: { threshold: number; minPx: number },
  routes: Routes,
): { calls: number; model: string; estimatedCostUsd: number } {
  const calls = holeCandidates(frames, options).length;
  return {
    calls,
    model: routes.holes.model,
    estimatedCostUsd: calls * routes.holes.estimatedCostUsd,
  };
}

function viewReference(view: Raster, frame: number): LoadedReference {
  const bytes = encodePng(view);
  return {
    role: `frame ${frame}, enclosed see-through areas in magenta`,
    path: `holes-frame-${frame}.png`,
    mediaType: "image/png",
    bytes,
    sha256: sha256(bytes),
  };
}

export async function checkHoles(options: {
  frames: Raster[];
  family: string;
  subject: string;
  threshold: number;
  minPx: number;
  cutoff: number;
  call: Caller;
  now?: () => Date;
}): Promise<{ reasons: AnimationReason[]; decisions: HoleDecision[] }> {
  const now = options.now ?? (() => new Date());
  const reasons: AnimationReason[] = [];
  const decisions: HoleDecision[] = [];
  const candidates = holeCandidates(options.frames, options);
  for (const c of candidates) {
    const frame = options.frames[c.frame - 1] as Raster;
    const prompt = buildHolesPrompt({
      subject: options.subject,
      family: options.family,
      frame: c.frame,
      areas: c.areas.length,
    });
    const text = await options.call.vision("holes", prompt, [
      viewReference(holeView(frame, c.marked), c.frame),
    ]);
    const record = options.call.records[options.call.records.length - 1];
    const parsed = parseHolesReply(text);
    const flagged =
      parsed.label === "unreadable" ||
      (parsed.label === "holes" && parsed.confidence >= options.cutoff);
    const area = c.areas.reduce((s, a) => s + a.area, 0);
    decisions.push({
      frame: c.frame,
      areas: c.areas,
      model: record?.model ?? "",
      requestId: record?.requestId ?? "",
      label: parsed.label,
      confidence: parsed.confidence,
      cutoff: options.cutoff,
      flagged,
      reason: parsed.reason,
      costUsd: record?.costUsd ?? 0,
      at: now().toISOString(),
    });
    const head = `frame ${c.frame}: ${c.areas.length} see-through area(s) inside the outline, ${area} px`;
    reasons.push({
      check: "holes",
      passed: !flagged,
      source: "vision",
      frames: [c.frame],
      reason:
        parsed.label === "unreadable"
          ? `${head}; the holes reply was unreadable (${parsed.reason})`
          : parsed.label === "holes"
            ? `${head}; ${parsed.reason} (confidence ${parsed.confidence} ${flagged ? "≥" : "<"} cutoff ${options.cutoff})`
            : `${head}; ${parsed.reason} (${parsed.confidence})`,
    });
  }
  if (candidates.length === 0) {
    reasons.push({
      check: "holes",
      passed: true,
      source: "deterministic",
      reason: `no frame has a see-through area of ${options.minPx} px or more inside the figure's outline`,
    });
  }
  return { reasons, decisions };
}
