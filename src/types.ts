/** Core data types. Everything game-specific reaches Assetforge as one of these, as data. */

export type Rgb = readonly [number, number, number];

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point, Size {}

/** One requested asset. `kind` selects the generator; generators read the fields they need. */
export interface AssetSpec {
  kind: string;
  assetId: string;
  /** The bible subject (character, prop) this asset depicts; defaults to `assetId`. */
  subject?: string;
  animationFamily?: string;
  frames?: { count?: number; width?: number; height?: number; durationMs?: number };
  anchor?: Point;
  /** Path (relative to the spec file) of an author-approved key pose; frames are edits of it. */
  keyPose?: string;
  /** Extra values the target profile's manifest template may read, such as `semantic`. */
  fields?: Record<string, unknown>;
}

export interface BibleReference {
  /** Path relative to the bible file. */
  path: string;
  /** For example `character`, `turnaround`, `prop`, `perspective`. */
  role: string;
  /** The bible subject this reference shows, if any. */
  subject?: string;
}

export interface StyleBible {
  version: string;
  palette: string[];
  references: BibleReference[];
  /** Path (relative to the bible file) of the perspective sample. */
  perspective: string;
  subjects?: Record<string, { description: string }>;
  mood?: string[];
  notes?: string[];
}

/** A reference image loaded from disk and sent to a model as an image input. */
export interface LoadedReference {
  role: string;
  path: string;
  mediaType: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface TargetProfile {
  name: string;
  /** The license value the target accepts for generated output (Clockgrove: `MIT`). */
  license: string;
  /** Free values for the manifest template, for example `{ "creator": "Clockgrove" }`. */
  values?: Record<string, unknown>;
  frames: { width: number; height: number; maxEdge?: number; durationMs?: number };
  /** Path templates relative to the target directory, with `{placeholders}`. */
  layout: { media: string; manifest: string; provenance?: string };
  /** JSON manifest template: `"{{path}}"` inserts any value, `"a {{path}} b"` interpolates. */
  manifest: unknown;
  /** Where the review status sits in the manifest, and the only value Assetforge writes there. */
  review: { path: string; pending: string };
  /** Command run in the target directory after hand-off; `{{manifest}}` and `{{media}}` are replaced. */
  validator?: { command: string[] };
}

export interface Reason {
  check: string;
  passed: boolean;
  reason: string;
  source: "deterministic" | "vision";
}

export interface QaResult {
  passed: boolean;
  reasons: Reason[];
}

/** One provider call as recorded in provenance. */
export interface CallRecord {
  operation: string;
  model: string;
  route: string;
  prompt: string;
  parameters: Record<string, unknown>;
  referenceHashes: string[];
  seed?: number;
  requestId: string;
  startedAt: string;
  finishedAt: string;
  costUsd: number;
  costSource: "provider" | "estimate";
  providerTerms: string;
}

export interface Provenance {
  generator: string;
  route: string;
  models: string[];
  prompt: string;
  parameters: Record<string, unknown>;
  seed?: number;
  requestIds: string[];
  referenceHashes: string[];
  bibleVersion: string;
  license: string;
  providerTerms: string[];
  startedAt: string;
  finishedAt: string;
  costUsd: number;
  calls: CallRecord[];
}

/** A file a generator produced. Each output declares its own media type and extension. */
export interface MediaOutput {
  mediaType: string;
  extension: string;
  bytes: Uint8Array;
  /** Values the manifest template may read as `{{output.*}}`, for example `bounds` and `palette`. */
  fields: Record<string, unknown>;
}
