import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Caller } from "../calls.ts";
import { encodePng, type Raster } from "../image/raster.ts";
import { sha256 } from "../request.ts";
import type { Routes } from "../routes.ts";
import type { LoadedReference } from "../types.ts";
import { flattenFrame } from "./preview.ts";
import type { AnimationReason, FlickerDecision } from "./types.ts";

/** Consecutive 1-based frame pairs, plus the seam (last, first) for a loop of more than two frames. */
export function flickerPairs(count: number, loop: boolean): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 1; i < count; i++) pairs.push([i, i + 1]);
  if (loop && count > 2) pairs.push([count, 1]);
  return pairs;
}

export function buildFlickerPrompt(input: {
  subject: string;
  family: string;
  pair: [number, number];
  subjectDescription?: string;
}): string {
  const [a, b] = input.pair;
  return [
    `Image 1 is frame ${a} and image 2 is frame ${b} of the same "${input.family}" animation of ${input.subject}.`,
    ...(input.subjectDescription ? [`The character: ${input.subjectDescription}`] : []),
    "Both frames are shown over the same plain light grey backdrop. The pose is expected to change between frames. Ignore the pose.",
    "Each frame may be painted on its own, so brush strokes, fur strands, texture grain, single small strokes or specks, and the fine, ragged edges of markings can differ between frames. That is texture, not identity.",
    "Judge whether the character's identity stays the same: which markings it has, where they sit and their overall shape; its colours; its proportions; its accessories.",
    'Reply with ONLY JSON: {"label":"same"|"texture"|"flicker","confidence":0..1,"reason":"..."}',
    '"same": the identity and the texture match. "texture": the identity matches and only painterly texture or the fine edges of markings differ. "flicker": the identity changes: a marking appears, disappears, moves or takes a clearly different overall shape, a colour changes, the proportions change, or an accessory changes.',
    "Give your confidence in the label you chose.",
  ].join("\n");
}

export interface FlickerReply {
  label: "same" | "texture" | "flicker" | "unreadable";
  confidence: number;
  reason: string;
}

export function parseFlickerReply(text: string): FlickerReply {
  const unreadable = (reason: string): FlickerReply => ({
    label: "unreadable",
    confidence: 0,
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
  const { label, confidence, reason } = value as Record<string, unknown>;
  if (label !== "same" && label !== "texture" && label !== "flicker") {
    return unreadable("the reply had no valid label");
  }
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) {
    return unreadable("the reply had no confidence between 0 and 1");
  }
  return { label, confidence, reason: typeof reason === "string" ? reason : "" };
}

export function planFlicker(
  count: number,
  loop: boolean,
  routes: Routes,
): { calls: number; model: string; estimatedCostUsd: number } {
  const calls = flickerPairs(count, loop).length;
  return {
    calls,
    model: routes.flicker.model,
    estimatedCostUsd: calls * routes.flicker.estimatedCostUsd,
  };
}

/**
 * The frame as the model sees it: flattened over the loop preview's neutral backdrop, so how a
 * provider treats transparent pixels (often dropping alpha and showing the colour left under a
 * matte's holes) cannot pass for a marking.
 */
function frameReference(raster: Raster, n: number): LoadedReference {
  const bytes = encodePng(flattenFrame(raster));
  return {
    role: `frame ${n}`,
    path: `frame-${n}.png`,
    mediaType: "image/png",
    bytes,
    sha256: sha256(bytes),
  };
}

export async function checkFlicker(options: {
  frames: Raster[];
  family: string;
  subject: string;
  subjectDescription?: string;
  loop: boolean;
  cutoff: number;
  call: Caller;
  now?: () => Date;
}): Promise<{ reasons: AnimationReason[]; decisions: FlickerDecision[] }> {
  const now = options.now ?? (() => new Date());
  const reasons: AnimationReason[] = [];
  const decisions: FlickerDecision[] = [];
  for (const pair of flickerPairs(options.frames.length, options.loop)) {
    const [a, b] = pair;
    const first = options.frames[a - 1];
    const second = options.frames[b - 1];
    if (!first || !second) continue;
    const prompt = buildFlickerPrompt({
      subject: options.subject,
      family: options.family,
      pair,
      ...(options.subjectDescription !== undefined && {
        subjectDescription: options.subjectDescription,
      }),
    });
    const text = await options.call.vision("flicker", prompt, [
      frameReference(first, a),
      frameReference(second, b),
    ]);
    const record = options.call.records[options.call.records.length - 1];
    const parsed = parseFlickerReply(text);
    const flagged =
      parsed.label === "unreadable" ||
      (parsed.label === "flicker" && parsed.confidence >= options.cutoff);
    decisions.push({
      pair,
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
    const head = `frame ${a} → frame ${b}`;
    const detail =
      parsed.label === "unreadable"
        ? `${head}: the flicker reply was unreadable (${parsed.reason})`
        : parsed.label === "flicker"
          ? `${head}: flicker (confidence ${parsed.confidence} ${flagged ? "≥" : "<"} cutoff ${options.cutoff}): ${parsed.reason}`
          : parsed.label === "texture"
            ? `${head}: same identity, only painterly texture differs (${parsed.confidence}): ${parsed.reason}`
            : `${head}: same (${parsed.confidence})`;
    reasons.push({
      check: "identity-flicker",
      passed: !flagged,
      source: "vision",
      frames: [a, b],
      reason: detail,
    });
  }
  return { reasons, decisions };
}

/** Appends one JSON line per decision: the logged data a later cutoff is chosen from. */
export async function appendDecisionLog(path: string, decisions: FlickerDecision[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, decisions.map((d) => `${JSON.stringify(d)}\n`).join(""));
}
