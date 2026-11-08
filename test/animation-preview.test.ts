import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAnimatedWebp, encodeWebpLossless } from "../src/image/webp.ts";
import {
  onionSkinSheet,
  loopPreview,
  previewZoom,
  PREVIEW_MEDIA_TYPES,
} from "../src/animation/preview.ts";
import { createRaster, getPixel, setPixel } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { decodeWebpLossless } from "./fixtures/webp-decode.ts";

/** A 12x12 transparent frame with one 2x2 block of `colour` at column `x`. */
function frameWith(x: number, colour: number[]): Raster {
  const r = createRaster(12, 12);
  for (let yy = 4; yy < 6; yy++) for (let xx = x; xx < x + 2; xx++) setPixel(r, xx, yy, colour);
  return r;
}

const RED = [200, 20, 20, 255];
const GREEN = [20, 200, 20, 255];
const BLUE = [20, 20, 200, 255];

function u32(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset).getUint32(o, true);
}
function u24(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
}
const tag = (b: Uint8Array, o: number) => String.fromCharCode(...b.subarray(o, o + 4));

function chunks(b: Uint8Array): { tag: string; start: number; size: number }[] {
  const list = [];
  for (let o = 12; o < b.length;) {
    const size = u32(b, o + 4);
    list.push({ tag: tag(b, o), start: o + 8, size });
    o += 8 + size + (size % 2);
  }
  return list;
}

function asSimpleWebp(vp8l: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + vp8l.length);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(out.buffer).setUint32(4, 4 + vp8l.length, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  out.set(vp8l, 12);
  return out;
}

test("encodeAnimatedWebp writes a valid extended file", () => {
  const frames = [frameWith(1, RED), frameWith(5, GREEN), frameWith(8, BLUE)];
  const bytes = encodeAnimatedWebp(frames, { durationMs: 120 });
  assert.equal(tag(bytes, 0), "RIFF");
  assert.equal(u32(bytes, 4), bytes.length - 8);
  assert.equal(tag(bytes, 8), "WEBP");
  const list = chunks(bytes);
  assert.deepEqual(
    list.map((c) => c.tag),
    ["VP8X", "ANIM", "ANMF", "ANMF", "ANMF"],
  );
  const vp8x = list[0]!;
  assert.equal(vp8x.size, 10);
  assert.equal((bytes[vp8x.start] ?? 0) & 0x02, 0x02);
  assert.equal((bytes[vp8x.start] ?? 0) & 0x10, 0x10, "alpha flag");
  assert.equal(u24(bytes, vp8x.start + 4), 11);
  assert.equal(u24(bytes, vp8x.start + 7), 11);
  const anim = list[1]!;
  assert.equal(anim.size, 6);
  assert.equal(
    (bytes[anim.start + 4] ?? 0) | ((bytes[anim.start + 5] ?? 0) << 8),
    0,
    "loops forever",
  );
  list.slice(2).forEach((c, i) => {
    assert.equal(u24(bytes, c.start), 0);
    assert.equal(u24(bytes, c.start + 3), 0);
    assert.equal(u24(bytes, c.start + 6), 11);
    assert.equal(u24(bytes, c.start + 9), 11);
    assert.equal(u24(bytes, c.start + 12), 120);
    assert.equal(bytes[c.start + 15], 0x02);
    assert.equal(tag(bytes, c.start + 16), "VP8L");
    const inner = bytes.subarray(c.start + 16, c.start + c.size);
    const back = decodeWebpLossless(asSimpleWebp(inner));
    assert.deepEqual(back.data, frames[i]!.data);
  });
  assert.deepEqual(encodeAnimatedWebp(frames, { durationMs: 120 }), bytes);
});

test("encodeAnimatedWebp omits the alpha flag for opaque frames and keeps the simple encoder unchanged", () => {
  const opaque = createRaster(3, 3);
  for (let i = 3; i < opaque.data.length; i += 4) opaque.data[i] = 255;
  const bytes = encodeAnimatedWebp([opaque], { durationMs: 40, loopCount: 3 });
  const [vp8x, anim] = chunks(bytes);
  assert.equal((bytes[vp8x!.start] ?? 0) & 0x10, 0);
  assert.equal(bytes[anim!.start + 4], 3);
  const simple = encodeWebpLossless(opaque);
  assert.deepEqual(decodeWebpLossless(simple).data, opaque.data);
});

test("loopPreview zooms, flattens over an opaque backdrop and loops", () => {
  const frames = [frameWith(1, RED), frameWith(5, GREEN)];
  const bytes = loopPreview(frames, { durationMs: 100 });
  assert.equal(previewZoom({ width: 12, height: 12 }), 16);
  const list = chunks(bytes);
  assert.equal(list.filter((c) => c.tag === "ANMF").length, 2);
  assert.equal((bytes[list[0]!.start] ?? 0) & 0x10, 0, "opaque");
  const c = list[2]!;
  assert.equal(u24(bytes, c.start + 6), 12 * 16 - 1);
  assert.equal(u24(bytes, c.start + 12), 100);
  const back = decodeWebpLossless(asSimpleWebp(bytes.subarray(c.start + 16, c.start + c.size)));
  assert.equal(back.width, 192);
  assert.deepEqual(getPixel(back, 1 * 16 + 3, 4 * 16 + 3), RED);
  assert.deepEqual(getPixel(back, 0, 0), [236, 236, 236, 255]);
  assert.deepEqual(loopPreview(frames, { durationMs: 100 }), bytes);
  assert.equal(PREVIEW_MEDIA_TYPES.preview, "image/webp");
});

function sheet(loop: boolean, flagged?: number[]) {
  const frames = [frameWith(1, RED), frameWith(5, GREEN), frameWith(8, BLUE)];
  return onionSkinSheet(frames, { anchor: { x: 6, y: 11 }, loop, ...(flagged && { flagged }) });
}

test("onionSkinSheet lays out cells and shows the frame opaque in its cell", () => {
  const s = sheet(true);
  const cellW = 12 * 16 + 8;
  const cellH = 12 * 16 + 24;
  assert.equal(s.width, 3 * cellW);
  assert.equal(s.height, 2 * cellH);
  assert.deepEqual(getPixel(s, 4 + 5 * 16 + 4 + cellW, 4 + 4 * 16 + 4), GREEN);
  assert.deepEqual(sheet(true).data, s.data);
});

test("onionSkinSheet tints the wrapped previous frame in cell 1 only for a loop", () => {
  // Frame 3 (blue block at x 8..9) is the previous of frame 1; its tint is red-ward.
  const probe = (s: Raster) => getPixel(s, 4 + 8 * 16 + 4, 4 + 4 * 16 + 4);
  const looped = probe(sheet(true));
  assert.ok(looped[0] > 236 - 40 && looped[0] > looped[1] + 20, `tinted toward red: ${looped}`);
  assert.deepEqual(probe(sheet(false)), [236, 236, 236, 255]);
  // Frame 2 (green at x 5) is the next of frame 1 in both modes.
  const next = getPixel(sheet(false), 4 + 5 * 16 + 4, 4 + 4 * 16 + 4);
  assert.ok(next[2] > next[0], `tinted toward blue: ${next}`);
});

test("onionSkinSheet marks flagged frames with a red border", () => {
  const plain = sheet(true);
  const flagged = sheet(true, [2]);
  const cellW = 12 * 16 + 8;
  assert.deepEqual(getPixel(flagged, cellW, 0), [220, 0, 0, 255]);
  assert.deepEqual(getPixel(plain, cellW, 0), [236, 236, 236, 255]);
  assert.deepEqual(getPixel(flagged, 0, 0), [236, 236, 236, 255]);
});
