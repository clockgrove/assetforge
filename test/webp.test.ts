import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWebpLossless } from "../src/image/webp.ts";
import type { Raster } from "../src/image/raster.ts";
import { decodeWebpLossless } from "./fixtures/webp-decode.ts";

function make(width: number, height: number, pixel: (x: number, y: number) => number[]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return { width, height, data };
}

function roundTrip(r: Raster): Uint8Array {
  const bytes = encodeWebpLossless(r);
  const back = decodeWebpLossless(bytes);
  assert.equal(back.width, r.width);
  assert.equal(back.height, r.height);
  assert.deepEqual(back.data, r.data);
  assert.deepEqual(encodeWebpLossless(r), bytes);
  return bytes;
}

test("round trips a gradient with varied alpha and writes a valid header", () => {
  const r = make(40, 30, (x, y) => [x * 6, y * 8, (x * y) % 256, 255 - (((x + y) * 3) % 256)]);
  const bytes = roundTrip(r);
  const text = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(text(0), "RIFF");
  assert.equal(view.getUint32(4, true), bytes.length - 8);
  assert.equal(text(8), "WEBP");
  assert.equal(text(12), "VP8L");
  assert.equal(bytes.length % 2, 0);
  assert.equal(bytes[20], 0x2f);
  const bits = view.getUint32(21, true);
  assert.equal(bits & 0x3fff, r.width - 1);
  assert.equal((bits >>> 14) & 0x3fff, r.height - 1);
  assert.equal((bits >>> 28) & 1, 1);
});

test("round trips a 1x1 image", () => {
  roundTrip(make(1, 1, () => [10, 200, 30, 128]));
});

test("round trips a single-colour image and leaves alpha unused when opaque", () => {
  const bytes = roundTrip(make(9, 7, () => [1, 2, 3, 255]));
  assert.equal((new DataView(bytes.buffer, bytes.byteOffset).getUint32(21, true) >>> 28) & 1, 0);
});

test("round trips a fully transparent image", () => {
  roundTrip(make(16, 16, () => [0, 0, 0, 0]));
});

test("round trips an image with exactly two colours", () => {
  roundTrip(make(13, 11, (x, y) => ((x + y) % 3 === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255])));
});

test("round trips a seeded pseudo-random image", () => {
  let s = 12345;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24;
  };
  roundTrip(make(37, 23, () => [next(), next(), next() & 0x0f, next()]));
});

test("rejects dimensions outside 1..16384", () => {
  assert.throws(() => encodeWebpLossless({ width: 0, height: 1, data: new Uint8Array(0) }));
  assert.throws(() => encodeWebpLossless({ width: 16385, height: 1, data: new Uint8Array(0) }));
});
