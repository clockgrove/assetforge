import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRaster,
  getPixel,
  opaqueBox,
  parseHex,
  setPixel,
  toHex,
} from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { postprocessFrames } from "../src/postprocess.ts";

const palette = ["#202020", "#d03030", "#30a040", "#f0f0f0"];
const frame = { width: 16, height: 16 };
const anchor = { x: 8, y: 14 };

function blobFrame(opaque: boolean, offset = 0): Raster {
  const r = createRaster(40, 40);
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) setPixel(r, x, y, opaque ? [255, 255, 255, 255] : [0, 0, 0, 0]);
  }
  for (let y = 8; y < 32; y++) {
    for (let x = 10 + offset; x < 28 + offset; x++) {
      const edge = x === 10 + offset ? 100 : 255;
      setPixel(
        r,
        x,
        y,
        y < 20 ? [200, 50, 50, opaque ? 255 : edge] : [40, 160, 70, opaque ? 255 : edge],
      );
    }
  }
  return r;
}

const options = { frame, frameCount: 2, anchor, palette };

test("opaque background is keyed to true alpha", () => {
  const out = postprocessFrames([blobFrame(true), blobFrame(true, 2)], options);
  assert.equal(getPixel(out.strip, 0, 0)[3], 0);
  assert.ok(opaqueBox(out.strip, { x: 0, y: 0, ...frame }));
});

test("soft alpha comes out strictly 0 or 255, sized frame*count", () => {
  const out = postprocessFrames([blobFrame(false), blobFrame(false, 2)], options);
  assert.equal(out.strip.width, 32);
  assert.equal(out.strip.height, 16);
  for (let i = 3; i < out.strip.data.length; i += 4) {
    assert.ok(out.strip.data[i] === 0 || out.strip.data[i] === 255);
  }
});

test("opaque colours are palette colours and used palette is exact", () => {
  const out = postprocessFrames([blobFrame(true), blobFrame(true)], options);
  const seen = new Set<string>();
  for (let y = 0; y < out.strip.height; y++) {
    for (let x = 0; x < out.strip.width; x++) {
      const p = getPixel(out.strip, x, y);
      if (p[3] === 255) seen.add(toHex([p[0], p[1], p[2]]));
    }
  }
  for (const c of seen) assert.ok(palette.includes(c));
  assert.deepEqual(
    out.palette,
    palette.filter((c) => seen.has(toHex(parseHex(c)))),
  );
  assert.deepEqual(out.palette, ["#d03030", "#30a040"]);
});

test("bottom-centre sits on the anchor and bounds equal the union box", () => {
  const out = postprocessFrames([blobFrame(true), blobFrame(true, 2)], options);
  let x0 = 99;
  let y0 = 99;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < 2; i++) {
    const box = opaqueBox(out.strip, { x: i * 16, y: 0, ...frame });
    assert.ok(box);
    assert.equal(box.y + box.height, anchor.y);
    assert.ok(Math.abs(box.x + box.width / 2 - anchor.x) <= 0.5);
    x0 = Math.min(x0, box.x);
    y0 = Math.min(y0, box.y);
    x1 = Math.max(x1, box.x + box.width);
    y1 = Math.max(y1, box.y + box.height);
  }
  assert.deepEqual(out.bounds, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
});

test("wrong frame count throws", () => {
  assert.throws(() => postprocessFrames([blobFrame(true)], options), /frames/);
});
