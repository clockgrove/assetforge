import type { Caller } from "../calls.ts";
import type { Routes } from "../routes.ts";
import type { AssetSpec, MediaOutput, QaResult, StyleBible, TargetProfile } from "../types.ts";

/**
 * A generator turns one asset spec into one candidate: its model calls, post-processing and QA.
 * A new media type is a new generator registered with the loop; the loop itself does not change.
 */
export interface GeneratorContext {
  spec: AssetSpec;
  /** Directory the spec's relative paths (such as `keyPose`) resolve against. */
  specDir: string;
  bible: StyleBible;
  /** Directory the bible's relative paths resolve against. */
  bibleDir: string;
  profile: TargetProfile;
  /** Every provider call goes through this; it reserves against the cap and records provenance. */
  call: Caller;
  /** Zero-based candidate number within the run. */
  index: number;
  /** A per-candidate seed, sent to models whose route supports seeds. */
  seed: number;
}

export interface GeneratedCandidate {
  output: MediaOutput;
  qa: QaResult;
  /** The prompt that defines the candidate (for animation, the key-pose prompt). */
  prompt: string;
  parameters: Record<string, unknown>;
}

/** One model call a candidate makes, as forecast from the routes. */
export interface PlannedCall {
  operation: string;
  model: string;
  estimatedCostUsd: number;
}

export interface Generator {
  /** The `kind` of asset spec this generator handles. */
  kind: string;
  /**
   * The calls one candidate makes, from the routes; their estimates are reserved before the run
   * starts. Throws `InputError` for a spec that cannot be generated, before any spend.
   */
  planCandidate(spec: AssetSpec, profile: TargetProfile, routes: Routes): PlannedCall[];
  generate(context: GeneratorContext): Promise<GeneratedCandidate>;
}
