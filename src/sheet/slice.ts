/**
 * Slicing: finds each figure on a contact sheet, either from a grid (given or detected) or by
 * locating connected components, and keeps labels, specks, neighbours and background out of every
 * figure's mask.
 */
import type { Raster } from "../image/raster.ts";
import type { Box, Point, Rgb, Size, Transform } from "../types.ts";
import type { SliceOptions, SliceResult, SlicedFigure } from "./types.ts";

interface Component {
  /** Pixel indices in sheet coordinates. */
  pixels: number[];
  box: Box;
}

/** A figure's components, plus the dropped ones near it. */
interface Found {
  parts: Component[];
  removed: number;
}

const HOLE_FRACTION = 0.005;
/** Ratio between neighbouring areas (largest first) that separates figures from labels. */
const SIZE_DROP = 3;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function medianColour(
  sheet: Raster,
  hasAlpha: boolean,
  indices: Iterable<number>,
): { colour: Rgb; count: number } {
  const channels: number[][] = [[], [], []];
  const all: number[] = [];
  for (const i of indices) {
    all.push(i);
    if (hasAlpha && (sheet.data[i * 4 + 3] as number) < 128) continue;
    for (let k = 0; k < 3; k++) (channels[k] as number[]).push(sheet.data[i * 4 + k] as number);
  }
  const count = (channels[0] as number[]).length;
  const source =
    count > 0 ? channels : [0, 1, 2].map((k) => all.map((i) => sheet.data[i * 4 + k] as number));
  return {
    colour: [
      median(source[0] as number[]),
      median(source[1] as number[]),
      median(source[2] as number[]),
    ],
    count,
  };
}

function boxBorder(sheet: Raster, box: Box): number[] {
  const out: number[] = [];
  for (let x = box.x; x < box.x + box.width; x++) {
    out.push(box.y * sheet.width + x, (box.y + box.height - 1) * sheet.width + x);
  }
  for (let y = box.y + 1; y < box.y + box.height - 1; y++) {
    out.push(y * sheet.width + box.x, y * sheet.width + box.x + box.width - 1);
  }
  return out;
}

function ringAround(sheet: Raster, box: Box, thickness: number): number[] {
  const x0 = Math.max(0, box.x - thickness);
  const y0 = Math.max(0, box.y - thickness);
  const x1 = Math.min(sheet.width, box.x + box.width + thickness);
  const y1 = Math.min(sheet.height, box.y + box.height + thickness);
  const out: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const inside = x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
      if (!inside) out.push(y * sheet.width + x);
    }
  }
  return out;
}

interface Background {
  colour: Rgb;
  /** False when every sampled pixel was transparent: only alpha then separates the figure. */
  usesColour: boolean;
}

function estimate(sheet: Raster, hasAlpha: boolean, indices: number[]): Background {
  const { colour, count } = medianColour(sheet, hasAlpha, indices);
  return { colour, usesColour: count > 0 };
}

function foreground(
  sheet: Raster,
  hasAlpha: boolean,
  bg: Background,
  tolerance: number,
  box: Box,
): Uint8Array {
  const mask = new Uint8Array(box.width * box.height);
  const limit = tolerance * tolerance;
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const i = ((box.y + y) * sheet.width + box.x + x) * 4;
      const d = sheet.data;
      if (hasAlpha && (d[i + 3] as number) < 128) continue;
      if (!bg.usesColour) {
        mask[y * box.width + x] = 1;
        continue;
      }
      const dr = (d[i] as number) - bg.colour[0];
      const dg = (d[i + 1] as number) - bg.colour[1];
      const db = (d[i + 2] as number) - bg.colour[2];
      if (dr * dr + dg * dg + db * db > limit) mask[y * box.width + x] = 1;
    }
  }
  return mask;
}

/** 8-connected components of a mask over `box`; pixel indices and boxes in sheet coordinates. */
function components(mask: Uint8Array, box: Box, sheetWidth: number): Component[] {
  const seen = new Uint8Array(mask.length);
  const out: Component[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    const pixels: number[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    while (stack.length > 0) {
      const p = stack.pop() as number;
      const x = p % box.width;
      const y = (p - x) / box.width;
      pixels.push((box.y + y) * sheetWidth + box.x + x);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= box.width || ny >= box.height) continue;
          const q = ny * box.width + nx;
          if (!mask[q] || seen[q]) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    out.push({
      pixels,
      box: {
        x: box.x + minX,
        y: box.y + minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      },
    });
  }
  return out;
}

function unionBox(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function inside(inner: Box, outer: Box, slack: number): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

function centre(b: Box): Point {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/**
 * The smallest area that still counts as a figure. Components under `labelFraction` of the largest
 * are labels or specks; among the rest, a drop of SIZE_DROP or more between neighbouring areas
 * separates figures from the labels that are big next to a small figure.
 */
function figureCutoff(components: Component[], labelFraction: number): number {
  const areas = components.map((c) => c.pixels.length).sort((a, b) => b - a);
  const largest = areas[0] ?? 0;
  const candidates = areas.filter((a) => a >= labelFraction * largest);
  let cutoff = candidates[candidates.length - 1] ?? 0;
  let bestRatio = SIZE_DROP;
  for (let i = 0; i + 1 < candidates.length; i++) {
    const ratio = (candidates[i] as number) / (candidates[i + 1] as number);
    if (ratio >= bestRatio) {
      bestRatio = ratio;
      cutoff = candidates[i] as number;
    }
  }
  return cutoff;
}

/** Splits components into figures, their merged detached bits, and dropped ones. */
function assign(
  all: Component[],
  cutoff: number,
): { figures: Component[]; merged: Map<Component, Component[]>; dropped: Component[] } {
  const figures = all.filter((c) => c.pixels.length >= cutoff);
  const merged = new Map<Component, Component[]>(figures.map((f) => [f, []]));
  const dropped: Component[] = [];
  for (const c of all) {
    if (c.pixels.length >= cutoff) continue;
    const host = figures.find((f) => inside(c.box, f.box, 2));
    if (host) (merged.get(host) as Component[]).push(c);
    else dropped.push(c);
  }
  return { figures, merged, dropped };
}

function cluster(values: number[], gap: number): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ids = new Array<number>(values.length).fill(0);
  let current = 0;
  order.forEach(([v, i], k) => {
    if (k > 0 && v - (order[k - 1] as readonly [number, number])[0] > gap) current++;
    ids[i] = current;
  });
  return ids;
}

interface GridSpec {
  columns: number;
  rows: number;
  cell: Size;
  origin: Point;
}

function detectGrid(sheet: Raster, figures: Component[]): GridSpec | undefined {
  if (figures.length < 2) return undefined;
  const boxes = figures.map((f) => f.box);
  const cx = boxes.map((b) => centre(b).x);
  const cy = boxes.map((b) => centre(b).y);
  const columns = Math.max(...cluster(cx, 0.5 * median(boxes.map((b) => b.width)))) + 1;
  const rows = Math.max(...cluster(cy, 0.5 * median(boxes.map((b) => b.height)))) + 1;
  if (columns * rows < 2) return undefined;
  const cell = {
    width: Math.round(sheet.width / columns),
    height: Math.round(sheet.height / rows),
  };
  if (Math.abs(cell.width * columns - sheet.width) > columns) return undefined;
  if (Math.abs(cell.height * rows - sheet.height) > rows) return undefined;
  const taken = new Set<number>();
  for (const b of boxes) {
    const c = centre(b);
    const column = Math.floor(c.x / cell.width);
    const row = Math.floor(c.y / cell.height);
    if (column >= columns || row >= rows || taken.has(row * columns + column)) return undefined;
    taken.add(row * columns + column);
    const slot = { x: column * cell.width, y: row * cell.height, ...cell };
    if (!inside(b, slot, Math.round(0.1 * Math.min(cell.width, cell.height)))) return undefined;
  }
  return { columns, rows, cell, origin: { x: 0, y: 0 } };
}

/** The figure's crop mask: its pixels, plus small enclosed holes. */
function cropMask(parts: Component[], crop: Box, sheetWidth: number): Uint8Array {
  const mask = new Uint8Array(crop.width * crop.height);
  let area = 0;
  for (const part of parts) {
    for (const p of part.pixels) {
      const x = (p % sheetWidth) - crop.x;
      const y = Math.floor(p / sheetWidth) - crop.y;
      mask[y * crop.width + x] = 1;
      area++;
    }
  }
  const limit = HOLE_FRACTION * area;
  const seen = new Uint8Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    const hole: number[] = [];
    let open = false;
    while (stack.length > 0) {
      const p = stack.pop() as number;
      hole.push(p);
      const x = p % crop.width;
      const y = (p - x) / crop.width;
      if (x === 0 || y === 0 || x === crop.width - 1 || y === crop.height - 1) open = true;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= crop.width || ny >= crop.height) continue;
        const q = ny * crop.width + nx;
        if (mask[q] || seen[q]) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (!open && hole.length < limit) for (const p of hole) mask[p] = 1;
  }
  return mask;
}

function clipBox(box: Box, within: Box): Box {
  const x0 = Math.max(box.x, within.x);
  const y0 = Math.max(box.y, within.y);
  const x1 = Math.min(box.x + box.width, within.x + within.width);
  const y1 = Math.min(box.y + box.height, within.y + within.height);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

function build(
  sheet: Raster,
  found: Found,
  limit: Box,
  cellBox: Box,
  padding: number,
  background: Rgb,
): Omit<SlicedFigure, "id" | "cell"> {
  const extent = unionBox(found.parts.map((p) => p.box));
  const box = clipBox(
    {
      x: extent.x - padding,
      y: extent.y - padding,
      width: extent.width + 2 * padding,
      height: extent.height + 2 * padding,
    },
    limit,
  );
  const crop = {
    width: box.width,
    height: box.height,
    data: new Uint8Array(box.width * box.height * 4),
  };
  for (let y = 0; y < box.height; y++) {
    const from = ((box.y + y) * sheet.width + box.x) * 4;
    crop.data.set(sheet.data.subarray(from, from + box.width * 4), y * box.width * 4);
  }
  const transforms: Transform[] = [
    { op: "crop", box, cell: cellBox },
    { op: "strip-labels", removed: found.removed },
  ];
  return {
    box,
    crop,
    mask: cropMask(found.parts, box, sheet.width),
    background,
    transforms,
  };
}

export function sliceSheet(sheet: Raster, options: SliceOptions = {}): SliceResult {
  const tolerance = options.tolerance ?? 40;
  const labelFraction = options.labelFraction ?? 0.04;
  const padding = options.padding ?? 4;
  const whole: Box = { x: 0, y: 0, width: sheet.width, height: sheet.height };
  const hasAlpha = sheet.data.some((_, i) => i % 4 === 3 && sheet.data[i] !== 255);
  const sheetBg = estimate(sheet, hasAlpha, boxBorder(sheet, whole));

  const sheetComponents = components(
    foreground(sheet, hasAlpha, sheetBg, tolerance, whole),
    whole,
    sheet.width,
  );
  const cutoff = figureCutoff(sheetComponents, labelFraction);

  let grid: GridSpec | undefined;
  if (options.grid) {
    const cellWidth = options.grid.cellWidth ?? Math.floor(sheet.width / options.grid.columns);
    const cellHeight = options.grid.cellHeight ?? cellWidth;
    const origin = options.grid.origin ?? { x: 0, y: 0 };
    grid = {
      columns: options.grid.columns,
      rows: options.grid.rows ?? Math.ceil((sheet.height - origin.y) / cellHeight),
      cell: { width: cellWidth, height: cellHeight },
      origin,
    };
  } else if (!options.components) {
    grid = detectGrid(
      sheet,
      sheetComponents.filter((c) => c.pixels.length >= cutoff),
    );
  }

  const figures: SlicedFigure[] = [];
  if (grid) {
    for (let row = 0; row < grid.rows; row++) {
      for (let column = 0; column < grid.columns; column++) {
        const cell = clipBox(
          {
            x: grid.origin.x + column * grid.cell.width,
            y: grid.origin.y + row * grid.cell.height,
            ...grid.cell,
          },
          whole,
        );
        if (cell.width === 0 || cell.height === 0) continue;
        const bg = estimate(sheet, hasAlpha, boxBorder(sheet, cell));
        const parts = components(
          foreground(sheet, hasAlpha, bg, tolerance, cell),
          cell,
          sheet.width,
        );
        const { figures: big, merged } = assign(parts, cutoff);
        const main = big.sort((a, b) => b.pixels.length - a.pixels.length)[0];
        if (!main) continue;
        // Anything else in the cell that is figure-sized is dropped, as another figure is not ours.
        const own = [main, ...(merged.get(main) as Component[])];
        const removed = parts.length - own.length;
        figures.push({
          id: 0,
          cell: { row, column, box: cell },
          ...build(sheet, { parts: own, removed }, cell, cell, padding, bg.colour),
        });
      }
    }
    figures.forEach((f, i) => (f.id = i + 1));
    return { mode: "grid", grid, background: sheetBg.colour, figures };
  }

  const { figures: big, merged, dropped } = assign(sheetComponents, cutoff);
  const ownership = new Map<Component, number>(big.map((f) => [f, 0]));
  for (const d of dropped) {
    const c = centre(d.box);
    let best: Component | undefined;
    let bestDistance = Infinity;
    for (const f of big) {
      const fc = centre(f.box);
      const distance = (fc.x - c.x) ** 2 + (fc.y - c.y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = f;
      }
    }
    if (best) ownership.set(best, (ownership.get(best) as number) + 1);
  }
  const placed = big.map((f) => {
    const parts = [f, ...(merged.get(f) as Component[])];
    const extent = unionBox(parts.map((p) => p.box));
    const bg = estimate(sheet, hasAlpha, ringAround(sheet, extent, 3));
    return { parts, extent, bg, removed: ownership.get(f) as number };
  });

  // Rows by vertical overlap of boxes; columns by x within a row.
  placed.sort((a, b) => centre(a.extent).y - centre(b.extent).y);
  const rowsOf: Array<{ top: number; bottom: number; members: typeof placed }> = [];
  for (const p of placed) {
    const top = p.extent.y;
    const bottom = p.extent.y + p.extent.height;
    const row = rowsOf.find(
      (r) => Math.min(r.bottom, bottom) - Math.max(r.top, top) >= 0.5 * p.extent.height,
    );
    if (row) {
      row.top = Math.min(row.top, top);
      row.bottom = Math.max(row.bottom, bottom);
      row.members.push(p);
    } else rowsOf.push({ top, bottom, members: [p] });
  }
  rowsOf.sort((a, b) => a.top - b.top);
  rowsOf.forEach((r, rowIndex) => {
    r.members.sort((a, b) => a.extent.x - b.extent.x);
    r.members.forEach((p, column) => {
      const built = build(
        sheet,
        { parts: p.parts, removed: p.removed },
        whole,
        whole,
        padding,
        p.bg.colour,
      );
      figures.push({ id: 0, cell: { row: rowIndex, column, box: built.box }, ...built });
    });
  });
  figures.forEach((f, i) => (f.id = i + 1));
  return { mode: "components", background: sheetBg.colour, figures };
}
