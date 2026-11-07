/**
 * Synthetic contact sheets drawn in code, standing in for a model's or a person's sprite sheet:
 * soft-edged four-legged figures on a pale, slightly noisy background, each with a number label,
 * drifting and changing scale from cell to cell. The true coverage of every pixel is kept, so tests
 * can measure background removal against ground truth. Nothing here is real art.
 */
import { drawDigits, textWidth } from "../../src/image/digits.ts";
import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";
import type { Raster } from "../../src/image/raster.ts";
import type { Box, Rgb } from "../../src/types.ts";

export const SHEET_BACKGROUND: Rgb = [236, 230, 216];
export const LABEL_COLOUR: Rgb = [52, 50, 60];

export interface FamilySpec {
  name: string;
  count: number;
  /** 1 faces right, -1 faces left. */
  facing: 1 | -1;
  /** Whether the legs swing (a walk) or stay put (idle, sit). */
  walk: boolean;
}

export const DEFAULT_FAMILIES: FamilySpec[] = [
  { name: "idle", count: 4, facing: 1, walk: false },
  { name: "walk-right", count: 6, facing: 1, walk: true },
  { name: "walk-left", count: 6, facing: -1, walk: true },
];

export interface SheetFigure {
  /** 1-based, reading order. */
  id: number;
  family: string;
  /** Position within its family. */
  step: number;
  facing: 1 | -1;
  row: number;
  column: number;
  /** The cell (grid layout) or the figure's slot (scatter layout), in sheet px. */
  cellBox: Box;
  /** The figure's drawn scale relative to 1. */
  scale: number;
  /** Sheet row of the feet. */
  feetY: number;
  /** Where the number label was drawn. */
  labelBox: Box;
}

export interface SyntheticSheet {
  raster: Raster;
  png: Uint8Array;
  background: Rgb;
  cell: number;
  columns: number;
  rows: number;
  figures: SheetFigure[];
  /** True figure coverage (0..255) per sheet pixel. */
  alpha: Uint8Array;
}

export interface SheetOptions {
  /** Cell size in px. Default 64. */
  cell?: number;
  /** Columns of the grid layout. Default 8. */
  columns?: number;
  families?: FamilySpec[];
  /** `grid`: contiguous cells, no gutters. `scatter`: uneven rows at uneven spacing. */
  layout?: "grid" | "scatter";
  /** Peak per-channel background noise. Default 3. */
  noise?: number;
  /** Drift of position (px) and scale (fraction) between frames. Default true. */
  drift?: boolean;
  seed?: number;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type Shade = Rgb | undefined;

/** The figure's colour at local (u, v): u across (facing direction positive), v up from the feet. */
function shape(u: number, v: number, walk: boolean, phase: number): Shade {
  const inEllipse = (cu: number, cv: number, ru: number, rv: number) =>
    ((u - cu) / ru) ** 2 + ((v - cv) / rv) ** 2 <= 1;
  // ears, head and mask
  if (inEllipse(1.3, 3.0, 0.2, 0.25) || inEllipse(1.8, 3.0, 0.2, 0.25)) return [70, 68, 78];
  if (inEllipse(1.55, 2.4, 0.65, 0.6)) return v > 2.3 && v < 2.6 ? [40, 36, 44] : [134, 136, 146];
  // tail, striped
  if (inEllipse(-1.9, 2.0, 0.75, 0.3)) {
    return Math.floor((u + 3) / 0.3) % 2 === 0 ? [48, 46, 54] : [120, 122, 132];
  }
  // body with a paler belly
  if (inEllipse(0, 1.6, 1.5, 0.8)) {
    return v < 1.25 && Math.abs(u) < 0.8 ? [196, 190, 178] : [108, 110, 122];
  }
  // legs: feet stay on v = 0, a walk swings them about the hip
  const bases = [-1.0, -0.45, 0.45, 1.0];
  for (let k = 0; k < bases.length; k++) {
    if (v < 0 || v > 1.1) continue;
    const swing = walk ? 0.4 * Math.sin(phase + (k % 2) * Math.PI) : 0;
    const centre = (bases[k] as number) + swing * (1.1 - v);
    if (Math.abs(u - centre) <= 0.16) return [66, 64, 74];
  }
  return undefined;
}

export function syntheticSheet(options: SheetOptions = {}): SyntheticSheet {
  const cell = options.cell ?? 64;
  const columns = options.columns ?? 8;
  const families = options.families ?? DEFAULT_FAMILIES;
  const layout = options.layout ?? "grid";
  const noise = options.noise ?? 3;
  const drift = options.drift ?? true;
  const random = rng(options.seed ?? 7);

  const plan: Array<{ family: FamilySpec; step: number }> = [];
  for (const family of families) {
    for (let step = 0; step < family.count; step++) plan.push({ family, step });
  }

  // Slots: a contiguous grid, or uneven rows (3, 5, 4, ...) at uneven spacing.
  const slots: Box[] = [];
  const positions: Array<{ row: number; column: number }> = [];
  if (layout === "grid") {
    plan.forEach((_, i) => {
      const row = Math.floor(i / columns);
      const column = i % columns;
      slots.push({ x: column * cell, y: row * cell, width: cell, height: cell });
      positions.push({ row, column });
    });
  } else {
    const rowLengths = [3, 5, 4, 6, 2];
    let i = 0;
    let y = 6;
    for (let row = 0; i < plan.length; row++) {
      const length = rowLengths[row % rowLengths.length] as number;
      let x = 4 + Math.round(random() * 20);
      for (let column = 0; column < length && i < plan.length; column++, i++) {
        slots.push({ x, y, width: cell, height: cell });
        positions.push({ row, column });
        x += cell + 6 + Math.round(random() * 26);
      }
      y += cell + 10 + Math.round(random() * 16);
    }
  }
  const width = Math.max(...slots.map((s) => s.x + s.width)) + (layout === "grid" ? 0 : 8);
  const height = Math.max(...slots.map((s) => s.y + s.height)) + (layout === "grid" ? 0 : 8);

  const raster = createRaster(width, height);
  const alpha = new Uint8Array(width * height);
  const colour = new Float64Array(width * height * 3);
  const figures: SheetFigure[] = [];

  plan.forEach(({ family, step }, i) => {
    const slot = slots[i] as Box;
    const { row, column } = positions[i] as { row: number; column: number };
    const scale = drift ? 0.86 + random() * 0.22 : 1;
    const dx = drift ? Math.round((random() - 0.5) * 6) : 0;
    const dy = drift ? -Math.round(random() * 3) : 0;
    const s = cell * 0.14 * scale;
    const facing = family.facing;
    const cx = slot.x + cell / 2 + 0.225 * s * facing + dx;
    const feetY = slot.y + cell - 6 + dy;
    const phase = (2 * Math.PI * step) / family.count;
    const SS = 4;
    for (
      let y = Math.max(0, Math.floor(feetY - 3.4 * s));
      y <= Math.min(height - 1, feetY + 1);
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(cx - 3 * s));
        x <= Math.min(width - 1, Math.ceil(cx + 3 * s));
        x++
      ) {
        let hits = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const u = ((x + (sx + 0.5) / SS - cx) / s) * facing;
            const v = (feetY + 1 - (y + (sy + 0.5) / SS)) / s;
            const c = shape(u, v, family.walk, phase);
            if (!c) continue;
            hits++;
            r += c[0];
            g += c[1];
            b += c[2];
          }
        }
        if (hits === 0) continue;
        const idx = y * width + x;
        alpha[idx] = Math.round((255 * hits) / (SS * SS));
        colour[idx * 3] = r / hits;
        colour[idx * 3 + 1] = g / hits;
        colour[idx * 3 + 2] = b / hits;
      }
    }
    const label = String(i + 1);
    const labelBox: Box =
      layout === "grid"
        ? { x: slot.x + 2, y: slot.y + 2, width: textWidth(label, 2), height: 10 }
        : { x: slot.x + 1, y: slot.y + 1, width: textWidth(label, 2), height: 10 };
    figures.push({
      id: i + 1,
      family: family.name,
      step,
      facing,
      row,
      column,
      cellBox: slot,
      scale,
      feetY,
      labelBox,
    });
  });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const a = (alpha[idx] ?? 0) / 255;
      const px = [0, 1, 2].map((k) => {
        const bg = (SHEET_BACKGROUND[k] as number) + Math.round((random() * 2 - 1) * noise);
        return Math.max(
          0,
          Math.min(255, Math.round(a * (colour[idx * 3 + k] ?? 0) + (1 - a) * bg)),
        );
      });
      setPixel(raster, x, y, [...px, 255]);
    }
  }
  for (const f of figures) {
    drawDigits(raster, String(f.id), f.labelBox.x, f.labelBox.y, 2, [...LABEL_COLOUR, 255]);
  }

  return {
    raster,
    png: encodePng(raster),
    background: SHEET_BACKGROUND,
    cell,
    columns,
    rows: Math.max(...positions.map((p) => p.row)) + 1,
    figures,
    alpha,
  };
}

/** The figure's true coverage cropped to a box of the sheet, as a raster's alpha would be. */
export function truthAlpha(sheet: SyntheticSheet, box: Box): Uint8Array {
  const out = new Uint8Array(box.width * box.height);
  const width = sheet.raster.width;
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      out[y * box.width + x] = sheet.alpha[(box.y + y) * width + box.x + x] ?? 0;
    }
  }
  return out;
}
