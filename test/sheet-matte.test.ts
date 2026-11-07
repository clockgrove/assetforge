import assert from "node:assert/strict";
import { test } from "node:test";
import { createRaster, getPixel, parseHex, setPixel } from "../src/image/raster.ts";
import { matteChecks, matteFigure, matteQuality } from "../src/sheet/matte.ts";
import type { SlicedFigure } from "../src/sheet/types.ts";
import { resolveStyle } from "../src/style.ts";
import { SHEET_BACKGROUND, syntheticSheet, truthAlpha } from "./fixtures/sheet.ts";

function figureOf(index: number): { figure: SlicedFigure; truth: Uint8Array } {
  const sheet = syntheticSheet();
  const f = sheet.figures[index]!;
  const y = f.labelBox.y + f.labelBox.height + 2;
  const box = {
    x: f.cellBox.x,
    y,
    width: f.cellBox.width,
    height: f.cellBox.y + f.cellBox.height - y,
  };
  const crop = createRaster(box.width, box.height);
  for (let yy = 0; yy < box.height; yy++) {
    for (let xx = 0; xx < box.width; xx++) {
      setPixel(crop, xx, yy, getPixel(sheet.raster, box.x + xx, box.y + yy));
    }
  }
  const truth = truthAlpha(sheet, box);
  const mask = Uint8Array.from(truth, (a) => (a >= 64 ? 1 : 0));
  return {
    figure: {
      id: f.id,
      cell: { row: f.row, column: f.column, box: f.cellBox },
      box,
      crop,
      mask,
      background: SHEET_BACKGROUND,
      transforms: [{ op: "crop", box }],
    },
    truth,
  };
}

const alphas = (data: Uint8Array) =>
  Array.from({ length: data.length / 4 }, (_, i) => data[i * 4 + 3]!);

test("soft alpha and full colour keep fur edges, with no halo or leftover background", () => {
  const { figure, truth } = figureOf(0);
  const matted = matteFigure(figure, resolveStyle(undefined));
  const a = alphas(matted.image.data);
  const soft = a.filter((v) => v > 0 && v < 255).length;
  assert.ok(soft > 20, `soft pixels ${soft}`);
  let err = 0;
  a.forEach((v, i) => (err += Math.abs(v - truth[i]!)));
  const mae = err / a.length;
  assert.ok(mae <= 8, `mean absolute alpha error ${mae}`);
  // At the edge itself: fully covered fur stays (nearly) opaque, partial coverage stays partial.
  let edgeErr = 0;
  let edgeCount = 0;
  let solidAlpha = 0;
  let solidCount = 0;
  a.forEach((v, i) => {
    const t = truth[i]!;
    if (t > 0 && t < 255) {
      edgeErr += Math.abs(v - t);
      edgeCount++;
    }
    if (t === 255 && figure.mask[i] === 1) {
      solidAlpha += v;
      solidCount++;
    }
  });
  assert.ok(edgeErr / edgeCount <= 40, `edge alpha error ${edgeErr / edgeCount}`);
  assert.ok(solidAlpha / solidCount >= 245, `solid alpha ${solidAlpha / solidCount}`);
  assert.ok(matted.quality.haloFraction <= 0.005, `halo ${matted.quality.haloFraction}`);
  assert.ok(matteChecks(matted.quality).every((r) => r.passed));
  const colours = new Set<string>();
  for (let i = 0; i < matted.image.data.length; i += 4) {
    if (matted.image.data[i + 3]) colours.add(matted.image.data.slice(i, i + 3).join());
  }
  assert.ok(colours.size > 12, `distinct colours ${colours.size}`);
  assert.deepEqual(matted.transforms.at(-1), {
    op: "matte",
    mode: "unmix",
    background: "#ece6d8",
    band: 2,
  });
});

test("a matte that leaves the background around the figure fails the checks", () => {
  const { figure } = figureOf(0);
  const bad = createRaster(figure.crop.width, figure.crop.height);
  for (let i = 0; i < bad.data.length; i += 4) {
    bad.data.set(figure.crop.data.subarray(i, i + 3), i);
    bad.data[i + 3] = 255;
  }
  // zero a ring far outside so an edge exists, with background colour right at it
  for (let y = 0; y < bad.height; y++) bad.data[y * bad.width * 4 + 3] = 0;
  const quality = matteQuality(bad, SHEET_BACKGROUND);
  assert.ok(quality.haloFraction > 0.5);
  const checks = matteChecks(quality);
  assert.ok(checks.every((r) => !r.passed));
  assert.match(checks[0]!.reason, /edge pixels/);
});

test("binary style gives only alpha 0 and 255", () => {
  const { figure } = figureOf(1);
  const m = matteFigure(figure, resolveStyle({ alpha: { mode: "binary", threshold: 128 } }));
  assert.ok(alphas(m.image.data).every((v) => v === 0 || v === 255));
  assert.ok(m.transforms.some((t) => t.op === "binarize" && t.threshold === 128));
});

test("palette rule gives only palette colours", () => {
  const { figure } = figureOf(2);
  const palette = ["#282430", "#6c6e7a", "#c4beb2", "#42404a"];
  const m = matteFigure(figure, resolveStyle({ color: { rule: "palette", palette } }));
  const allowed = new Set(palette.map((h) => parseHex(h).join()));
  for (let i = 0; i < m.image.data.length; i += 4) {
    if (m.image.data[i + 3]) assert.ok(allowed.has(m.image.data.slice(i, i + 3).join()));
  }
  assert.ok(m.transforms.some((t) => t.op === "quantize"));
});

// Belly pixels on the figure's own outline are indistinguishable from an edge blend; interior ones are not.
test("pale interior pixels stay opaque", () => {
  const { figure } = figureOf(0);
  const m = matteFigure(figure, resolveStyle(undefined));
  let belly = 0;
  for (let p = 0; p < figure.mask.length; p++) {
    const i = p * 4;
    const c = figure.crop.data;
    const w = figure.crop.width;
    const x = p % w;
    const y = Math.floor(p / w);
    let inside = true;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (figure.mask[(y + dy) * w + x + dx] !== 1) inside = false;
      }
    }
    if (c[i] === 196 && c[i + 1] === 190 && c[i + 2] === 178 && inside) {
      belly++;
      assert.equal(m.image.data[i + 3], 255);
    }
  }
  assert.ok(belly > 0);
});
