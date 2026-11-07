import assert from "node:assert/strict";
import { test } from "node:test";
import { createRaster } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { sliceSheet } from "../src/sheet/slice.ts";
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
