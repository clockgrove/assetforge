import assert from "node:assert/strict";
import { test } from "node:test";
import { createRaster } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { flipHorizontal } from "../src/image/resample.ts";
import { jitterOf, measureFrame, registerFrames } from "../src/sheet/register.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";

const sheet = syntheticSheet();
const crops: Raster[] = sheet.figures.map((f) => {
  const y0 = f.labelBox.y + f.labelBox.height + 2;
  const { x, width } = f.cellBox;
  const height = f.cellBox.y + f.cellBox.height - y0;
  const out = createRaster(width, height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const s = (y0 + j) * sheet.raster.width + x + i;
      const o = (j * width + i) * 4;
      for (let k = 0; k < 3; k++) out.data[o + k] = sheet.raster.data[s * 4 + k] as number;
      out.data[o + 3] = sheet.alpha[s] as number;
    }
  }
  return out;
});
const families = sheet.figures.map((f) => f.family);
const frame = { width: 32, height: 32 };
const anchor = { x: 16, y: 30 };

function spread(areas: number[], names: string[]): number {
  let worst = 0;
  for (const name of new Set(names)) {
    const v = areas.filter((_, i) => names[i] === name).map(Math.sqrt);
    worst = Math.max(worst, Math.max(...v) / Math.min(...v) - 1);
  }
  return worst;
}

test("all figures register within a pixel into the target frame", () => {
  for (const edges of ["antialiased", "crisp"] as const) {
    const reg = registerFrames(crops, { frame, anchor, edges });
    assert.equal(reg.frames.length, 16);
    for (const f of reg.frames) {
      assert.equal(f.image.width, 32);
      assert.equal(f.image.height, 32);
      assert.ok(f.jitterPx <= 1, `${edges} jitter ${f.jitterPx}`);
    }
    assert.ok(reg.jitterPx <= 1);
    assert.ok(
      jitterOf(
        reg.frames.map((f) => f.image),
        anchor,
      ).maxPx <= 1,
    );
  }
});

test("family normalisation evens out the figure size", () => {
  const plain = registerFrames(crops, { frame, anchor, edges: "antialiased" });
  const normal = registerFrames(crops, { frame, anchor, edges: "antialiased", families });
  const areas = (r: typeof plain) => r.frames.map((f) => f.measure.area);
  assert.ok(spread(areas(normal), families) <= 0.05, `${spread(areas(normal), families)}`);
  assert.ok(spread(areas(plain), families) > 0.05);
  assert.deepEqual(
    normal.frames[0]?.transforms.map((t) => t.op),
    ["normalize-scale", "scale", "place"],
  );
});

test("jitterOf catches the drift of unregistered crops", () => {
  const first = sheet.figures[0];
  assert.ok(first);
  const y0 = first.labelBox.y + first.labelBox.height + 2 - first.cellBox.y;
  const naive = jitterOf(crops, { x: 32, y: 58 - y0 });
  assert.ok(naive.maxPx > 1, `${naive.maxPx}`);
  assert.equal(naive.perFrame.length, 16);
});

test("crisp keeps the input's alpha values; antialiased makes soft alpha", () => {
  const input = new Set<number>();
  for (let i = 3; i < crops[0]!.data.length; i += 4) input.add(crops[0]!.data[i] as number);
  const crisp = registerFrames(crops, { frame, anchor, edges: "crisp" }).frames[0]!.image;
  for (let i = 3; i < crisp.data.length; i += 4) {
    assert.ok(input.has(crisp.data[i] as number));
  }
  const soft = registerFrames(crops, { frame, anchor, edges: "antialiased" }).frames[0]!.image;
  let intermediate = 0;
  for (let i = 3; i < soft.data.length; i += 4) {
    const a = soft.data[i] as number;
    if (a > 0 && a < 255) intermediate++;
  }
  assert.ok(intermediate > 0);
});

test("flipHorizontal mirrors and the flipped figure registers", () => {
  const src = crops[0] as Raster;
  const flipped = flipHorizontal(src);
  for (const [x, y] of [
    [0, 5],
    [10, 20],
    [src.width - 1, 30],
  ] as const) {
    const a = (y * src.width + x) * 4;
    const b = (y * src.width + (src.width - 1 - x)) * 4;
    assert.deepEqual(flipped.data.slice(b, b + 4), src.data.slice(a, a + 4));
  }
  const m = measureFrame(src);
  const mf = measureFrame(flipped);
  assert.ok(m && mf);
  assert.ok(Math.abs(m.centerX + mf.centerX - src.width) < 1e-6);
  const reg = registerFrames([flipped], { frame, anchor, edges: "antialiased" });
  assert.ok(reg.jitterPx <= 1);
});
