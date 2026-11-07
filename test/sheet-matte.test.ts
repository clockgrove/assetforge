import assert from "node:assert/strict";
import { test } from "node:test";
import { createRaster, getPixel, parseHex, setPixel } from "../src/image/raster.ts";
import { matteChecks, matteFigure, matteQuality } from "../src/sheet/matte.ts";
import { sliceSheet } from "../src/sheet/slice.ts";
import type { SlicedFigure } from "../src/sheet/types.ts";
import { resolveStyle } from "../src/style.ts";
import { LABEL_COLOUR, SHEET_BACKGROUND, syntheticSheet, truthAlpha } from "./fixtures/sheet.ts";

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

/** Sheet coordinates of figure 0's rightmost masked pixel and a solid interior pixel, after slicing. */
function sliceFirst(sheet: ReturnType<typeof syntheticSheet>) {
  const figure = sliceSheet(sheet.raster).figures[0]!;
  const { box, mask } = figure;
  let right = { x: -1, y: -1 };
  let solid = { x: -1, y: -1 };
  for (let y = 3; y < box.height - 3; y++) {
    for (let x = 3; x < box.width - 3; x++) {
      if (mask[y * box.width + x] !== 1) continue;
      if (x > right.x) right = { x, y };
      let inside = true;
      for (let dy = -3; dy <= 3 && inside; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (mask[(y + dy) * box.width + x + dx] !== 1) inside = false;
        }
      }
      if (inside && solid.x < 0) solid = { x, y };
    }
  }
  return {
    figure,
    right: { x: box.x + right.x, y: box.y + right.y },
    solid: { x: box.x + solid.x, y: box.y + solid.y },
  };
}

test("a dropped speck beside the figure and background enclosed by it never reach the matte", () => {
  const sheet = syntheticSheet();
  const before = sliceFirst(sheet);
  // A dark speck 2 px right of the figure's rightmost pixel: inside the unmixing band, outside the
  // figure's box, so slicing drops it. A background hole inside the figure's solid interior.
  const speck = [0, 1].flatMap((dx) =>
    [0, 1].map((dy) => ({ x: before.right.x + 2 + dx, y: before.right.y + dy })),
  );
  for (const p of speck) setPixel(sheet.raster, p.x, p.y, [...LABEL_COLOUR, 255]);
  const hole = [0, 1, 2].flatMap((dx) =>
    [0, 1, 2].map((dy) => ({ x: before.solid.x + dx - 1, y: before.solid.y + dy - 1 })),
  );
  for (const p of hole) setPixel(sheet.raster, p.x, p.y, [...SHEET_BACKGROUND, 255]);

  const figure = sliceSheet(sheet.raster).figures[0]!;
  const matted = matteFigure(figure, resolveStyle(undefined));
  const at = (p: { x: number; y: number }) =>
    (p.y - figure.box.y) * figure.box.width + p.x - figure.box.x;
  for (const p of speck) {
    assert.equal(figure.mask[at(p)], 0, "the speck is not the figure's");
    assert.equal(
      matted.image.data[at(p) * 4 + 3],
      0,
      `speck pixel ${p.x},${p.y} reached the frame`,
    );
  }
  for (const p of hole) {
    assert.equal(figure.mask[at(p)], 0, "enclosed background is not masked");
    assert.ok(
      matted.image.data[at(p) * 4 + 3]! < 32,
      `enclosed background ${p.x},${p.y} is opaque (${matted.image.data[at(p) * 4 + 3]})`,
    );
  }
  assert.ok(matteChecks(matted.quality).every((r) => r.passed));
});

test("opaque background colour inside a figure fails the background check, not the halo check", () => {
  const { figure } = figureOf(0);
  const matted = matteFigure(figure, resolveStyle(undefined));
  const image = matted.image;
  // Paint a 12 x 12 block of opaque background colour in the middle of the solid interior.
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (let p = 0; p < figure.mask.length; p++) {
    if (figure.mask[p] !== 1) continue;
    cx += p % image.width;
    cy += Math.floor(p / image.width);
    n++;
  }
  cx = Math.round(cx / n);
  cy = Math.round(cy / n);
  for (let y = cy - 6; y < cy + 6; y++) {
    for (let x = cx - 6; x < cx + 6; x++) {
      if (getPixel(image, x, y)[3] === 255) setPixel(image, x, y, [...SHEET_BACKGROUND, 255]);
    }
  }
  const quality = matteQuality(image, SHEET_BACKGROUND);
  assert.ok(quality.backgroundPixels > 0, "interior background is measured");
  const [halo, background] = matteChecks(quality);
  assert.equal(halo!.passed, true);
  assert.equal(background!.passed, false);
  assert.match(
    background!.reason,
    /opaque background colour inside the figure; the limit is 0\.50%/,
  );
});
