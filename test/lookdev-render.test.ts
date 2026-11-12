import assert from "node:assert/strict";
import { test } from "node:test";
import { createRaster } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { parseGlb } from "../src/model3d/glb.ts";
import {
  closeUpCamera,
  renderView,
  renderViewWithDepth,
  viewCamera,
} from "../src/model3d/render.ts";
import type { FurMaps, RenderOptions } from "../src/model3d/render.ts";
import { boundsOf, posedPrimitives } from "../src/model3d/scene.ts";
import { syntheticCharacter } from "./fixtures/glb.ts";

function setup(triangles = 12 * 64) {
  const glb = parseGlb(syntheticCharacter({ triangles }));
  const framing = boundsOf(posedPrimitives(glb))!;
  const base: RenderOptions = { sizePx: 128, yawDeg: 30, framing };
  return { glb, base };
}

function solid(rgba: [number, number, number, number], size = 4): Raster {
  const r = createRaster(size, size);
  for (let i = 0; i < r.data.length; i += 4) r.data.set(rgba, i);
  return r;
}

function furMaps(length: number, extra: Partial<FurMaps> = {}): FurMaps {
  return {
    length: solid([length, 0, 0, 255]),
    direction: solid([128, 0, 128, 255]),
    density: solid([255, 0, 0, 255]),
    maxLengthM: 0.3,
    shells: 8,
    strandsPerUv: 24,
    ...extra,
  };
}

function covered(raster: Raster, background = 0xd8): number {
  let n = 0;
  for (let i = 0; i < raster.data.length; i += 4) {
    if (raster.data[i] !== background || raster.data[i + 1] !== background) n++;
  }
  return n;
}

function maxLuminance(raster: Raster): number {
  let max = 0;
  for (let i = 0; i < raster.data.length; i += 4) {
    max = Math.max(max, raster.data[i]! + raster.data[i + 1]! + raster.data[i + 2]!);
  }
  return max;
}

function differs(a: Raster, b: Raster): boolean {
  return Buffer.compare(a.data, b.data) !== 0;
}

test("fur with zero length changes nothing", () => {
  const { glb, base } = setup();
  assert.deepEqual(renderView(glb, { ...base, fur: furMaps(0) }).data, renderView(glb, base).data);
});

test("fur grows the silhouette and a tint changes its colour", () => {
  const { glb, base } = setup();
  const plain = renderView(glb, base);
  const furry = renderView(glb, { ...base, fur: furMaps(255) });
  assert.ok(covered(furry) > covered(plain));
  const tinted = renderView(glb, {
    ...base,
    fur: furMaps(255, { tint: solid([255, 0, 0, 255]) }),
  });
  assert.ok(differs(furry, tinted));
  assert.equal(covered(tinted), covered(furry));
});

test("fur is deterministic and writes depth", () => {
  const { glb, base } = setup();
  const options = { ...base, fur: furMaps(255) };
  const a = renderViewWithDepth(glb, options);
  assert.deepEqual(a.raster.data, renderView(glb, options).data);
  assert.ok(a.depth.some(Number.isFinite));
});

test("a glossy material gets a catch-light", () => {
  // A flat box face only reflects the sky when viewed from well above.
  const { glb, base: flat } = setup();
  const base = { ...flat, elevationDeg: 60 };
  const matte = renderView(glb, base);
  const material = glb.json.materials![0]!;
  (material.pbrMetallicRoughness as Record<string, unknown>).roughnessFactor = 1;
  assert.deepEqual(renderView(glb, base).data, matte.data);
  (material.pbrMetallicRoughness as Record<string, unknown>).roughnessFactor = 0.05;
  const glossy = renderView(glb, base);
  assert.ok(maxLuminance(glossy) > maxLuminance(matte));
});

test("closeUpCamera puts the focus at the centre at the requested scale", () => {
  const focus: [number, number, number] = [0.3, 1.2, 0.1];
  const camera = closeUpCamera({
    sizePx: 512,
    yawDeg: 40,
    focus,
    heightM: 1.8,
    screenHeightPx: 1000,
    characterScreenFraction: 0.5,
  });
  const [cx, cy, depth] = camera.project(...focus);
  assert.ok(Math.abs(cx - 256) < 1e-9 && Math.abs(cy - 256) < 1e-9);
  const up = camera.up;
  const [, top] = camera.project(focus[0] + up[0], focus[1] + up[1], focus[2] + up[2]);
  assert.ok(Math.abs((256 - top) * 1.8 - 500) < 1);
  assert.ok(depth > 0);
  const { glb, base } = setup();
  const close = renderView(glb, { ...base, camera });
  assert.ok(covered(close) > 0);
});

test("a baseColor override changes colours but not coverage", () => {
  const { glb, base } = setup();
  const before = renderView(glb, base);
  const after = renderView(glb, { ...base, baseColor: solid([0, 255, 0, 255]) });
  assert.ok(differs(before, after));
  assert.equal(covered(after), covered(before));
});

test("elevationDeg moves the camera, and defaults to 15", () => {
  const { glb, base } = setup();
  const same = viewCamera({ ...base, elevationDeg: 15 });
  const dflt = viewCamera(base);
  assert.deepEqual(same.eye, dflt.eye);
  const high = viewCamera({ ...base, elevationDeg: 60 });
  assert.ok(high.eye[1] > dflt.eye[1]);
  assert.ok(differs(renderView(glb, { ...base, elevationDeg: 60 }), renderView(glb, base)));
  assert.deepEqual(renderView(glb, { ...base, elevationDeg: 15 }).data, renderView(glb, base).data);
});

test("unlit renders pure albedo without specular or fur shadowing", () => {
  const { glb, base } = setup();
  const flat = solid([200, 100, 50, 255]);
  const unlit = renderView(glb, { ...base, baseColor: flat, unlit: true });
  const colours = new Set<string>();
  for (let i = 0; i < unlit.data.length; i += 4) {
    if (unlit.data[i] !== 0xd8) colours.add(`${unlit.data[i]},${unlit.data[i + 1]}`);
  }
  assert.ok(colours.size > 0 && colours.size <= 3);
  const furry = renderView(glb, { ...base, baseColor: flat, unlit: true, fur: furMaps(255) });
  const furColours = new Set<string>();
  for (let i = 0; i < furry.data.length; i += 4) {
    if (furry.data[i] !== 0xd8) furColours.add(`${furry.data[i]},${furry.data[i + 1]}`);
  }
  assert.equal(furColours.size, colours.size);
});

test("background replaces the grey", () => {
  const { glb, base } = setup();
  const out = renderView(glb, { ...base, background: [0, 0, 0] });
  assert.deepEqual([...out.data.subarray(0, 4)], [0, 0, 0, 255]);
  assert.ok(covered(out, 0) > 0);
});
