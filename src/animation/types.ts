/**
 * Shared types of animation QA (PRD §5.2): motion templates, thresholds, per-frame measures,
 * check results, flicker decisions and per-frame fixes. Templates and thresholds are data: a
 * target adds or overrides them in its target profile's `animation` field.
 */
import type { Point, Reason, Size } from "../types.ts";

/** A named moment of the cycle. */
export interface MotionBeat {
  /** For example "contact-left", "passing", "down", "up", "bite", "hold". */
  name: string;
  /** Where the beat falls in the cycle, 0 (first frame) to 1 (exclusive end); maps to frame round(at × count) mod count. */
  at: number;
  /** The feet touch the ground line on this beat. */
  contact?: boolean;
}

/** One family's motion template, as data. */
export interface MotionTemplate {
  /** The family name it serves; also matches `<name>-<suffix>` families (walk → walk-right). */
  name: string;
  description?: string;
  /** The cycle loops: the last frame must flow into the first. */
  loop: boolean;
  /** Allowed frame counts, inclusive. */
  frames: { min: number; max: number };
  /** Allowed cycle length in ms (frame count × frame duration), inclusive, when given. */
  cycleMs?: { min: number; max: number };
  beats: MotionBeat[];
  /**
   * Which frames must keep the feet on the ground line: every frame (`all`, a walk), the beats
   * marked `contact` (`beats`), or none (`none`, a jump or a climb).
   */
  contact: "all" | "beats" | "none";
  /** Allowed silhouette change between consecutive frames, as 1 − IoU of their alpha masks. */
  silhouette: { min: number; max: number };
  /**
   * How the footprint behaves. `planted` (the default): the feet stay put, so every planted
   * frame's footprint is checked against the first's. `moving`: the contacts move by design (a
   * walk's legs alternate, a hop crouches and lands), so each planted frame is checked against
   * its own phase: the same frame of the cycle's first stride when `strides` is 2 or more, else
   * the loop's mean footprint.
   */
  footprint?: "planted" | "moving";
  /**
   * How many times the contact pattern repeats in one cycle (a walk: 2, one stride per leg).
   * Frames a whole stride apart share a phase. Default 1. Used by `footprint: "moving"`.
   */
  strides?: number;
  /** Overrides the footprint drift bound for this family, in px. */
  footprintDriftPx?: number;
}

/** Bounds of the deterministic checks and the flicker cutoff. All optional in the profile. */
export interface AnimationThresholds {
  /** How far a contact frame's baseline may sit from the ground line (anchor.y), in px. Default 1. */
  groundTolerancePx: number;
  /** How far a frame's baseline or centre of mass may sit from the anchor, in px. Default 1. */
  anchorDriftPx: number;
  /** How far a planted footprint's centre may move from the first frame's (or, for a moving footprint, from its own phase's), in px. Default 2. */
  footprintDriftPx: number;
  /** The last→first frame distance may be at most this × the largest consecutive distance. Default 1.5. */
  loopSeamRatio: number;
  /**
   * The smallest "largest consecutive distance" the seam bound uses, so a strip that barely
   * moves (an idle hold) is not failed for a seam step of noise. Default 0.02.
   */
  loopSeamFloor: number;
  /** A flicker label at or above this confidence fails the pair. Default 0.7. */
  flickerCutoff: number;
}

/** The target profile's optional `animation` field. */
export interface AnimationProfile {
  /** Templates the target adds (sleep, groom, climb, converse) or overrides, by name. */
  templates?: MotionTemplate[];
  thresholds?: Partial<AnimationThresholds>;
}

/** What is measured on one frame of a strip. */
export interface AnimationFrameMeasure {
  /** 1-based position in the strip. */
  frame: number;
  /** Lowest row at or above the alpha threshold, or -1 for an empty frame. */
  baseline: number;
  centerX: number;
  centerY: number;
  /** Visible pixels at or above the alpha threshold. */
  area: number;
  /** Horizontal span of the bottom rows at the baseline, [left, right] inclusive, when any. */
  footprint?: [number, number];
}

/** A strip as animation QA sees it. */
export interface StripInput {
  /** RGBA strip, frames side by side. */
  frames: import("../image/raster.ts").Raster[];
  frame: Size;
  anchor: Point;
  family: string;
  /** Frame duration in ms, when known (the profile's `frames.durationMs`). */
  durationMs?: number;
}

/** The animation QA report of one strip. Each reason's text names the frame(s). */
export interface AnimationReport {
  family: string;
  /** The matched template's name, or undefined when none matched. */
  template?: string;
  frameCount: number;
  passed: boolean;
  reasons: AnimationReason[];
  measures: AnimationFrameMeasure[];
  /** Consecutive distances: distances[i] is between frame i+1 and i+2 (1-based); the seam last. */
  silhouetteChange: number[];
  thresholds: AnimationThresholds;
}

export interface AnimationReason extends Reason {
  /** The 1-based frames the reason is about. */
  frames?: number[];
}

/** One logged identity-flicker decision (one vision call). */
export interface FlickerDecision {
  /** 1-based frames compared, in order. */
  pair: [number, number];
  model: string;
  requestId: string;
  label: "same" | "flicker" | "unreadable";
  confidence: number;
  cutoff: number;
  /** True when the pair fails: label flicker at or above the cutoff, or unreadable. */
  flagged: boolean;
  reason: string;
  costUsd: number;
  at: string;
}
