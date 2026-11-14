/**
 * Format lines for shared files and settings: `format: "assetgrove-<kind>/<n>"`. `readFormat`
 * refuses a missing, newer or unknown format and moves an older one forward in memory through the
 * registered migrations.
 */
import { InputError } from "./errors.ts";

/** Every kind that carries a format line, with the version this build reads and writes. */
export const FORMAT_VERSIONS = {
  "target-profile": 1,
  "style-bible": 1,
  "style-preset": 1,
  recipe: 1,
  settings: 1,
  blocklist: 1,
} as const satisfies Record<string, number>;

export type FormatKind = keyof typeof FORMAT_VERSIONS;

/** Why a format line was refused. */
export type FormatReason = "missing" | "too_new" | "unknown";

/** A refused format line; the CLI exits 2 with code `format_unsupported`. */
export class FormatError extends InputError {
  readonly code = "format_unsupported";
  readonly reason: FormatReason;
  readonly source: string;

  constructor(reason: FormatReason, source: string, message: string) {
    super(message);
    this.name = "FormatError";
    this.reason = reason;
    this.source = source;
  }
}

/** Moves a value one version forward: from `n` to `n + 1`. */
export type Migration = (value: Record<string, unknown>) => Record<string, unknown>;

const migrations = new Map<string, Migration>();

/** Registers the step that moves `kind` from version `from` to `from + 1`. */
export function registerMigration(kind: string, from: number, migrate: Migration): void {
  migrations.set(`${kind}/${from}`, migrate);
}

/** Removes a registered step; for tests that register their own. */
export function unregisterMigration(kind: string, from: number): void {
  migrations.delete(`${kind}/${from}`);
}

/** The format line a current file of `kind` carries. */
export function formatLine(kind: FormatKind): string {
  return `assetgrove-${kind}/${FORMAT_VERSIONS[kind]}`;
}

export interface FormatResult {
  /** The value at the current version, the `format` field rewritten to match. */
  value: Record<string, unknown>;
  version: number;
  /** The version the source carried, when it was older and migrated in memory. */
  migratedFrom?: number;
}

/**
 * Checks `value.format` against `kind` and returns the value at the current version. `source`
 * names the file in messages. `current` overrides the version this build reads (tests only).
 */
export function readFormat(
  kind: string,
  value: unknown,
  source: string,
  current: number | undefined = (FORMAT_VERSIONS as Record<string, number>)[kind],
): FormatResult {
  if (current === undefined) {
    throw new FormatError("unknown", source, `${source}: unknown format kind "${kind}".`);
  }
  const expected = `assetgrove-${kind}/${current}`;
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const format = record?.["format"];
  if (record === undefined || format === undefined) {
    throw new FormatError(
      "missing",
      source,
      `${source} has no format line; add "format": "${expected}" (or run assetgrove migrate).`,
    );
  }
  const match = typeof format === "string" ? /^assetgrove-(.+)\/(\d+)$/.exec(format) : null;
  if (!match || match[1] !== kind) {
    throw new FormatError(
      "unknown",
      source,
      `${source}: unknown format ${JSON.stringify(format)}; expected "${expected}".`,
    );
  }
  const version = Number(match[2]);
  if (version > current) {
    throw new FormatError(
      "too_new",
      source,
      `${source} has format "${format}", newer than this Assetgrove reads ("${expected}"); upgrade Assetgrove.`,
    );
  }
  if (version === current) return { value: record, version };
  let migrated = record;
  for (let from = version; from < current; from++) {
    const step = migrations.get(`${kind}/${from}`);
    if (!step) {
      throw new FormatError(
        "unknown",
        source,
        `${source}: format "${format}" has no migration from version ${from}; expected "${expected}".`,
      );
    }
    migrated = step(migrated);
  }
  return { value: { ...migrated, format: expected }, version: current, migratedFrom: version };
}
