import assert from "node:assert/strict";
import { test } from "node:test";
import { createRaster } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { parseGlb } from "../src/model3d/glb.ts";
import {
  closeUpCamera,
  renderView,
  renderViewWithDepth,
  speckle,
  strandCoverage,
  viewCamera,
} from "../src/model3d/render.ts";
import type { FurMaps, PreviewLighting, RenderOptions } from "../src/model3d/render.ts";
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
  // The tint changes colour where the fur is, never where it reaches.
  assert.ok(Math.abs(covered(tinted) - covered(furry)) <= covered(furry) * 0.01);
});

test("the fur preview is soft: no speckle on the body or at the silhouette", () => {
  const glb = parseGlb(syntheticCharacter({ triangles: 12 * 256 }));
  const framing = boundsOf(posedPrimitives(glb))!;
  for (const yawDeg of [0, 30, 90]) {
    const base: RenderOptions = { sizePx: 256, yawDeg, framing };
    const fur = furMaps(255, {
      density: solid([160, 0, 0, 255]),
      maxLengthM: 0.08,
      shells: 16,
      strandsPerUv: 512,
    });
    const bare = renderView(glb, base);
    const furry = renderView(glb, { ...base, fur });
    assert.ok(differs(bare, furry));
    assert.ok(speckle(furry) - speckle(bare) < 0.001, `yaw ${yawDeg}: ${speckle(furry)}`);
  }
});

test("speckle counts isolated pixels and ignores smooth shading", () => {
  const smooth = createRaster(32, 32);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) smooth.data.set([60 + x * 2, 60 + y, 50, 255], (y * 32 + x) * 4);
  assert.equal(speckle(smooth), 0);
  const noisy = createRaster(32, 32);
  noisy.data.set(smooth.data);
  for (let i = 0; i < 32 * 32; i += 7) noisy.data.set([250, 250, 250, 255], i * 4);
  assert.ok(speckle(noisy) > 0.05);
});

test("strand coverage thins toward the tips and scales with density", () => {
  assert.ok(strandCoverage(0.1, 1, 1) > strandCoverage(0.9, 1, 1));
  assert.equal(strandCoverage(1, 1, 1), 0);
  assert.ok(Math.abs(strandCoverage(0.2, 0.5, 1) * 2 - strandCoverage(0.2, 1, 1)) < 1e-12);
});

test("preview lighting is the same for every view and scales with exposure", () => {
  const { glb, base } = setup();
  const lighting: PreviewLighting = {
    ambient: 0.6,
    key: 0.4,
    keyDirection: [-0.4, 0.5, 0.75],
    exposure: 1,
  };
  const mean = (r: Raster) => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < r.data.length; i += 4) {
      if (r.data[i] === 0xd8 && r.data[i + 1] === 0xd8) continue;
      sum += r.data[i]!;
      n++;
    }
    return sum / n;
  };
  const flat = solid([128, 128, 128, 255]);
  const a = renderView(glb, { ...base, baseColor: flat, lighting });
  const brighter = renderView(glb, {
    ...base,
    baseColor: flat,
    lighting: { ...lighting, exposure: 1.2 },
  });
  assert.ok(mean(brighter) > mean(a) * 1.15);
  // The legacy turntable light is darker than neutral preview lighting.
  assert.ok(mean(renderView(glb, { ...base, baseColor: flat })) < mean(a));
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
  // Unlit fur over the surface keeps the albedo: no root shading (its fringe blends into the background).
  const furry = renderView(glb, { ...base, baseColor: flat, unlit: true, fur: furMaps(255) });
  for (let i = 0; i < furry.data.length; i += 4) {
    if (unlit.data[i] === 0xd8) continue;
    assert.ok(Math.abs(furry.data[i]! - unlit.data[i]!) <= 1, `pixel ${i / 4}`);
  }
});

test("background replaces the grey", () => {
  const { glb, base } = setup();
  const out = renderView(glb, { ...base, background: [0, 0, 0] });
  assert.deepEqual([...out.data.subarray(0, 4)], [0, 0, 0, 255]);
  assert.ok(covered(out, 0) > 0);
});

test("an emissive texture adds light to its material, and unlit renders leave it out", async () => {
  const { setEmissive } = await import("../src/model3d/lookdev/edit.ts");
  const { encodePng } = await import("../src/image/raster.ts");
  const { glb, base } = setup();
  glb.json.materials![0]!.name = "glow";
  const plain = renderView(glb, base);
  assert.equal(setEmissive(glb, "missing", encodePng(solid([255, 255, 255, 255])), "x"), -1);
  assert.ok(setEmissive(glb, "glow", encodePng(solid([255, 255, 255, 255])), "glow") >= 0);
  assert.ok(maxLuminance(renderView(glb, base)) > maxLuminance(plain));
  assert.deepEqual(
    renderView(glb, { ...base, unlit: true }).data,
    renderView(parseGlb(syntheticCharacter({ triangles: 12 * 64 })), { ...base, unlit: true }).data,
  );
});

test("catchLight needs a highlight in every located eye", async () => {
  const { catchLight } = await import("../src/model3d/lookdev/command.ts");
  const camera = viewCamera({ sizePx: 64, yawDeg: 0, framing: setup().base.framing });
  const eyeAt = (x: number, y: number) => {
    // A point on the view axis plane at the camera's focus distance, projected to (x, y).
    const depth = 1;
    const sx = ((x + 0.5 - 32) * depth) / camera.focal;
    const sy = (-(y + 0.5 - 32) * depth) / camera.focal;
    const point = [0, 1, 2].map(
      (k) =>
        camera.eye[k]! + camera.forward[k]! * depth + camera.right[k]! * sx + camera.up[k]! * sy,
    ) as [number, number, number];
    return { point, radius: (3 * depth) / camera.focal };
  };
  const eyes = [eyeAt(20, 30), eyeAt(44, 30)];
  const render = solid([40, 40, 40, 255], 64);
  const spot = (x: number, y: number) => render.data.set([255, 255, 255, 255], (y * 64 + x) * 4);
  spot(20, 30);
  const one = catchLight(render, camera, eyes);
  assert.equal(one.eyes, 1);
  assert.equal(one.found, false);
  spot(44, 30);
  const both = catchLight(render, camera, eyes);
  assert.equal(both.eyes, 2);
  assert.equal(both.found, true);
});
