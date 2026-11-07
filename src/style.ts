import type { StyleProfile } from "./types.ts";

/** A style profile with every default filled in. */
export interface ResolvedStyle {
  alpha: { mode: "soft" | "binary"; threshold: number };
  color: { rule: "full" | "palette"; palette: string[] };
  edges: "antialiased" | "crisp";
}

/**
 * Fills the style profile's defaults: soft alpha, full colour, antialiased edges. Binary alpha
 * thresholds at 128 unless told otherwise; soft alpha counts any non-zero alpha as visible. A
 * palette rule takes the profile's palette, else the bible's, and refuses when neither has one.
 */
export function resolveStyle(
  style: StyleProfile | undefined,
  biblePalette?: string[],
): ResolvedStyle {
  const mode = style?.alpha?.mode ?? "soft";
  if (mode !== "soft" && mode !== "binary") throw new Error(`unknown style alpha mode "${mode}"`);
  const threshold = style?.alpha?.threshold ?? (mode === "binary" ? 128 : 1);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 255) {
    throw new Error(`style alpha threshold must be an integer 1..255, not ${threshold}`);
  }
  const rule = style?.color?.rule ?? "full";
  if (rule !== "full" && rule !== "palette") throw new Error(`unknown style colour rule "${rule}"`);
  const palette = style?.color?.palette ?? biblePalette ?? [];
  if (rule === "palette" && palette.length === 0) {
    throw new Error(
      "the style profile's palette rule needs a palette (in the profile or the bible)",
    );
  }
  const edges = style?.edges ?? (mode === "binary" ? "crisp" : "antialiased");
  if (edges !== "antialiased" && edges !== "crisp")
    throw new Error(`unknown style edges "${edges}"`);
  return { alpha: { mode, threshold }, color: { rule, palette }, edges };
}
