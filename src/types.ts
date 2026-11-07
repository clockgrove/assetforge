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
  /** How the perspective sample's view is described, for example `isometric, three-quarter view`. */
  perspectiveDescription?: string;
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

/**
 * The world's style profile, read as part of the target profile (clockgrove/clockgrove#61). It
 * decides post-processing: soft 8-bit alpha and full colour for a painterly world, binary alpha,
 * crisp edges or a fixed palette for a flat-cartoon or pixel-art one. Every field is optional.
 */
export interface StyleProfile {
  /** `soft` keeps 8-bit alpha; `binary` writes only 0 or 255. `threshold` is the opacity bounds use. */
  alpha?: { mode: "soft" | "binary"; threshold?: number };
  /** `full` keeps every colour; `palette` snaps to `palette` (or the bible's palette). */
  color?: { rule: "full" | "palette"; palette?: string[] };
  /** `crisp` resamples nearest-neighbour (pixel art); `antialiased` filters. */
  edges?: "antialiased" | "crisp";
}

export interface TargetProfile {
  name: string;
  /** The world's style profile; post-processing of imported sheets follows it. */
  style?: StyleProfile;
  /** The license value the target accepts for generated output (Clockgrove: `MIT`). */
  license: string;
  /** Free values for the manifest template, for example `{ "creator": "Clockgrove" }`. */
  values?: Record<string, unknown>;
  frames: { width: number; height: number; maxEdge?: number; durationMs?: number };
  /**
   * Path templates relative to the target directory, with `{{a.b}}` placeholders (the same values
   * as the manifest template, for example `{{spec.assetId}}` and `{{output.extension}}`).
   * `provenance` writes the full provenance record as its own file; when it is unset and the
   * manifest template does not embed `{{provenance}}`, the record goes beside the media file as
   * `<media path>.provenance.json`, so every picked file carries its provenance.
   */
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
  /** `provider` when the gateway reported the ID; `local` when Assetforge had to generate one. */
  requestIdSource: "provider" | "local";
  startedAt: string;
  finishedAt: string;
  costUsd: number;
  costSource: "provider" | "estimate";
  providerTerms: string;
}

/** One step applied to a frame on its way from the source sheet to the strip. */
export interface Transform {
  op: string;
  [parameter: string]: unknown;
}

/** Where a strip's frame came from and what was done to it. */
export interface FrameProvenance {
  /** Zero-based position in the written strip. */
  index: number;
  /** The frame's number in the import (1-based, reading order on the sheet). */
  frame: number;
  /** The grid cell (or, without a grid, the row and column in reading order) and its box. */
  cell: { row: number; column: number; box: Box };
  /** The model or tool that made the sheet, for example "ChatGPT image generation". */
  tool: string;
  sheetSha256: string;
  transforms: Transform[];
}

/** The source contact sheet of an imported strip. */
export interface SheetSource {
  path: string;
  sha256: string;
  mediaType: string;
  /** The model or tool that made the sheet. */
  tool: string;
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
  /** For strips imported from a contact sheet: the sheet, and each frame's cell and transforms. */
  sheet?: SheetSource;
  frames?: FrameProvenance[];
}

/** A file a generator produced. Each output declares its own media type and extension. */
export interface MediaOutput {
  mediaType: string;
  extension: string;
  bytes: Uint8Array;
  /** Values the manifest template may read as `{{output.*}}`, for example `bounds` and `palette`. */
  fields: Record<string, unknown>;
}
