import assert from "node:assert/strict";
import { test } from "node:test";
import { createRaster } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { SliceError, sliceSheet } from "../src/sheet/slice.ts";
import type { SliceResult } from "../src/sheet/types.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import type { SyntheticSheet } from "./fixtures/sheet.ts";

function checkOrder(result: SliceResult, sheet: SyntheticSheet): void {
  assert.equal(result.figures.length, sheet.figures.length);
  result.figures.forEach((figure, i) => {
    const truth = sheet.figures[i];
    assert.ok(truth);
    assert.equal(figure.id, truth.id);
    assert.equal(figure.cell.row, truth.row);
    assert.equal(figure.cell.column, truth.column);
    // The figure sits where the fixture drew it: its box lies within the truth slot.
    const cx = figure.box.x + figure.box.width / 2;
    const cy = figure.box.y + figure.box.height / 2;
    assert.ok(cx > truth.cellBox.x && cx < truth.cellBox.x + truth.cellBox.width);
    assert.ok(cy > truth.cellBox.y && cy < truth.cellBox.y + truth.cellBox.height);
  });
}

function checkMasks(result: SliceResult, sheet: SyntheticSheet): void {
  const width = sheet.raster.width;
  const height = sheet.raster.height;
  const alphaNear = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && sheet.alpha[ny * width + nx]) {
          return true;
        }
      }
    }
    return false;
  };
  result.figures.forEach((figure, i) => {
    const truth = sheet.figures[i];
    assert.ok(truth);
    assert.equal(figure.mask.length, figure.crop.width * figure.crop.height);
    assert.deepEqual(figure.crop.width, figure.box.width);
    for (let y = 0; y < figure.box.height; y++) {
      for (let x = 0; x < figure.box.width; x++) {
        const sx = figure.box.x + x;
        const sy = figure.box.y + y;
        const masked = figure.mask[y * figure.box.width + x] === 1;
        const label = truth.labelBox;
        const inLabel =
          sx >= label.x &&
          sx < label.x + label.width &&
          sy >= label.y &&
          sy < label.y + label.height;
        if (inLabel) assert.equal(masked, false, `figure ${figure.id} masks a label pixel`);
        if (masked) assert.ok(alphaNear(sx, sy), `figure ${figure.id} masks background`);
      }
    }
    // Nothing of the figure is lost: every solid truth pixel is in the crop and masked. The palest
    // half-covered edge pixels (alpha 128..159) blend to within the colour tolerance of the
    // background, so up to 2% of the figure's solid pixels may miss there; none above that.
    const bx = truth.cellBox;
    let solid = 0;
    let missed = 0;
    for (let y = bx.y; y < bx.y + bx.height; y++) {
      for (let x = bx.x; x < bx.x + bx.width; x++) {
        const alpha = sheet.alpha[y * width + x] ?? 0;
        if (alpha < 128) continue;
        solid++;
        const cx = x - figure.box.x;
        const cy = y - figure.box.y;
        const inCrop = cx >= 0 && cy >= 0 && cx < figure.box.width && cy < figure.box.height;
        assert.ok(inCrop, `figure ${figure.id} extends outside its crop`);
        if (figure.mask[cy * figure.box.width + cx] !== 1) {
          missed++;
          assert.ok(alpha < 160, `figure ${figure.id} lost a solid pixel`);
        }
      }
    }
    assert.ok(missed <= 0.02 * solid, `figure ${figure.id} lost ${missed} of ${solid}`);
  });
}

test("a contiguous grid is detected and sliced in reading order", () => {
  const sheet = syntheticSheet();
  const result = sliceSheet(sheet.raster);
  assert.equal(result.mode, "grid");
  assert.equal(result.grid?.columns, 8);
  assert.equal(result.grid?.rows, 2);
  assert.deepEqual(result.grid?.cell, { width: 64, height: 64 });
  checkOrder(result, sheet);
  checkMasks(result, sheet);
});

test("an explicit grid gives the same slicing", () => {
  const sheet = syntheticSheet();
  const detected = sliceSheet(sheet.raster);
  const explicit = sliceSheet(sheet.raster, { grid: { columns: 8 } });
  assert.equal(explicit.mode, "grid");
  assert.equal(explicit.grid?.rows, 2);
  checkOrder(explicit, sheet);
  checkMasks(explicit, sheet);
  assert.deepEqual(
    explicit.figures.map((f) => [f.box, f.mask]),
    detected.figures.map((f) => [f.box, f.mask]),
  );
});

test("a scattered sheet is sliced by locating each figure", () => {
  const sheet = syntheticSheet({ layout: "scatter" });
  const result = sliceSheet(sheet.raster);
  assert.equal(result.mode, "components");
  assert.equal(result.grid, undefined);
  checkOrder(result, sheet);
  checkMasks(result, sheet);
  for (const figure of result.figures) {
    assert.ok(figure.transforms.some((t) => t.op === "crop"));
    assert.ok(figure.transforms.some((t) => t.op === "strip-labels"));
  }
});

test("components mode can be forced on a grid sheet", () => {
  const sheet = syntheticSheet();
  const result = sliceSheet(sheet.raster, { components: true });
  assert.equal(result.mode, "components");
  checkOrder(result, sheet);
  checkMasks(result, sheet);
});

test("a sheet with a transparent background slices too", () => {
  const sheet = syntheticSheet();
  const raster: Raster = createRaster(sheet.raster.width, sheet.raster.height);
  raster.data.set(sheet.raster.data);
  const width = raster.width;
  for (const figure of sheet.figures) {
    const l = figure.labelBox;
    for (let y = l.y; y < l.y + l.height; y++) {
      for (let x = l.x; x < l.x + l.width; x++) {
        const i = (y * width + x) * 4;
        const d = Math.hypot(
          (raster.data[i] as number) - sheet.background[0],
          (raster.data[i + 1] as number) - sheet.background[1],
          (raster.data[i + 2] as number) - sheet.background[2],
        );
        if (d > 40) raster.data[i + 3] = 255;
        else raster.data[i + 3] = sheet.alpha[y * width + x] ?? 0;
      }
    }
  }
  for (let p = 0; p < width * raster.height; p++) {
    const inLabel = raster.data[p * 4 + 3] === 255 && sheet.alpha[p] === 0;
    if (!inLabel) raster.data[p * 4 + 3] = sheet.alpha[p] ?? 0;
  }
  const result = sliceSheet(raster);
  assert.equal(result.mode, "grid");
  checkOrder(result, sheet);
  checkMasks(result, sheet);
});

/** A flat sheet of hard-edged ellipse figures, each with an optional tail bar to its right. */
function ellipseSheet(
  width: number,
  height: number,
  figures: Array<{ cx: number; cy: number; rx: number; ry: number; tailTo?: number }>,
): Raster {
  const raster = createRaster(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = figures.some(
        (f) =>
          ((x - f.cx) / f.rx) ** 2 + ((y - f.cy) / f.ry) ** 2 <= 1 ||
          (f.tailTo !== undefined && x >= f.cx && x < f.tailTo && Math.abs(y - f.cy) <= 3),
      );
      raster.data.set(inside ? [70, 60, 50, 255] : [230, 228, 226, 255], (y * width + x) * 4);
    }
  }
  return raster;
}

function maskArea(mask: Uint8Array): number {
  return mask.reduce((sum, v) => sum + v, 0);
}

test("a detected grid keeps the smallest figure whose tail reaches past its cell", () => {
  // 3 × 2 cells of 64 px. Figure 1 is the smallest, and its tail ends 3 px into the next cell's
  // gutter, as a painted tail does on a real sheet. Segmenting the cell again cut the tail off at
  // the cell's edge, so the figure came out under the sheet's smallest figure area, the cutoff
  // that sheet-wide segmentation had set from this same figure, and it was dropped without a word.
  type Figure = { cx: number; cy: number; rx: number; ry: number; tailTo?: number };
  const cells = [0, 1, 2, 3, 4, 5].map((k): Figure => ({
    cx: (k % 3) * 64 + 32,
    cy: Math.floor(k / 3) * 64 + 32,
    rx: 20,
    ry: 12,
  }));
  cells[0] = { cx: 40, cy: 32, rx: 16, ry: 10, tailTo: 67 };
  const result = sliceSheet(ellipseSheet(192, 128, cells));
  assert.equal(result.mode, "grid");
  assert.deepEqual(
    result.figures.map((f) => [f.cell.row, f.cell.column]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
    ],
  );
  const first = result.figures[0] as SliceResult["figures"][number];
  // The whole tail is in the crop and the mask, past the cell's edge at x = 64.
  assert.ok(first.box.x + first.box.width >= 67);
  const tailTip = (32 - first.box.y) * first.box.width + (66 - first.box.x);
  assert.equal(first.mask[tailTip], 1);
  // Nothing of the neighbour enters it.
  assert.equal(maskArea(first.mask) < maskArea((result.figures[1] as typeof first).mask), true);
});

test("a sheet that does not hold the count asked for is refused, naming the empty cell", () => {
  const sheet = syntheticSheet();
  // Paint out figure 11 (row 2, column 3), leaving its number label.
  const raster = createRaster(sheet.raster.width, sheet.raster.height);
  raster.data.set(sheet.raster.data);
  const gone = sheet.figures[10] as SyntheticSheet["figures"][number];
  for (let y = gone.cellBox.y + 12; y < gone.cellBox.y + gone.cellBox.height; y++) {
    for (let x = gone.cellBox.x; x < gone.cellBox.x + gone.cellBox.width; x++) {
      raster.data.set([...sheet.background, 255], (y * raster.width + x) * 4);
    }
  }
  assert.equal(sliceSheet(sheet.raster, { count: 16 }).figures.length, 16);
  assert.throws(
    () => sliceSheet(raster, { count: 16 }),
    (error: unknown) => {
      assert.ok(error instanceof SliceError);
      assert.equal(error.found, 15);
      assert.equal(error.expected, 16);
      assert.equal(error.problems.length, 1);
      assert.match(error.problems[0] as string, /row 2, column 3: its largest part is \d+ px/);
      assert.match(error.message, /found 15 figures on the sheet where 16 are asked for/);
      return true;
    },
  );
  // Without a count the same sheet still slices, into 15 frames.
  assert.equal(sliceSheet(raster).figures.length, 15);
});

test("touching figures that merged into one are named when too few are found", () => {
  // Five figures in a row, the last two touching: four components, no clean grid.
  const figures = [20, 70, 120, 170, 202].map((cx) => ({ cx, cy: 30, rx: 16, ry: 12 }));
  const raster = ellipseSheet(240, 60, figures);
  assert.throws(
    () => sliceSheet(raster, { components: true, count: 5 }),
    (error: unknown) => {
      assert.ok(error instanceof SliceError);
      assert.equal(error.found, 4);
      assert.deepEqual(error.problems.length, 1);
      assert.match(
        error.problems[0] as string,
        /figure 4 \(row 1, column 4\) is \d\.\d× the median figure's area: touching figures may have merged/,
      );
      return true;
    },
  );
});
