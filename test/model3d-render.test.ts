import assert from "node:assert/strict";
import { test } from "node:test";
import validator from "gltf-validator";
import { parseGlb } from "../src/model3d/glb.ts";
import { framedCamera, renderTurntable, renderView, viewCamera } from "../src/model3d/render.ts";
import {
  boundsOf,
  closeLoop,
  loopError,
  measure,
  normalize,
  posedPrimitives,
  sceneRoots,
  transformDirection,
  worldMatrices,
} from "../src/model3d/scene.ts";
import { syntheticCharacter } from "./fixtures/glb.ts";

const CLIPS = [
  { name: "Walk Cycle", durationS: 1, loopClosed: true },
  { name: "idle", durationS: 2, loopClosed: false },
];

test("the synthetic character is a valid glb", async () => {
  for (const options of [
    {},
    { triangles: 300, materials: 3, joints: 4, clips: CLIPS, textureSize: 16 },
    { joints: 1, materials: 2 },
  ]) {
    const report = await validator.validateBytes(syntheticCharacter(options));
    assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages));
  }
});

test("measure reports what the options asked for", () => {
  const glb = parseGlb(
    syntheticCharacter({ triangles: 300, materials: 3, joints: 4, textureSize: 16 }),
  );
  const m = measure(glb);
  assert.equal(m.triangles, 300);
  assert.equal(m.materials, 3);
  assert.equal(m.bones, 4);
  assert.equal(m.textureMaxPx, 16);
  assert.equal(measure(parseGlb(syntheticCharacter())).triangles, 12);
});

test("renderView is deterministic and draws the model", () => {
  const glb = parseGlb(syntheticCharacter({ clips: CLIPS }));
  const framing = boundsOf(posedPrimitives(glb))!;
  const a = renderView(glb, { sizePx: 64, yawDeg: 45, framing });
  const b = renderView(glb, { sizePx: 64, yawDeg: 45, framing });
  assert.deepEqual(a.data, b.data);
  let drawn = 0;
  for (let i = 0; i < a.data.length; i += 4)
    if (a.data[i] !== 0xd8 || a.data[i + 2] !== 0xd8) drawn++;
  assert.ok(drawn > 200, `drew ${drawn} pixels`);
  const front = renderView(glb, { sizePx: 64, yawDeg: 0, framing });
  const back = renderView(glb, { sizePx: 64, yawDeg: 180, framing });
  assert.notDeepEqual(front.data, back.data);
});

test("framedCamera fills the asked share of the view with the figure's outline, centred", () => {
  const glb = parseGlb(syntheticCharacter({ heightUnits: 3 }));
  const prims = posedPrimitives(glb);
  const framing = boundsOf(prims)!;
  const positions = prims.map((p) => p.positions);
  const extent = (camera: ReturnType<typeof viewCamera>) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of positions)
      for (let v = 0; v < p.length; v += 3) {
        const [x, y] = camera.project(p[v]!, p[v + 1]!, p[v + 2]!);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    return { x0, y0, x1, y1, side: Math.max(x1 - x0, y1 - y0) / camera.sizePx };
  };
  for (const fill of [0.5, 0.8]) {
    const framed = extent(framedCamera({ sizePx: 256, yawDeg: 30, framing, positions, fill }));
    assert.ok(Math.abs(framed.side - fill) < 0.03, `asked ${fill}, fills ${framed.side}`);
  }
  const framed = extent(framedCamera({ sizePx: 256, yawDeg: 30, framing, positions, fill: 0.8 }));
  // Centred.
  assert.ok(Math.abs((framed.x0 + framed.x1) / 2 - 128) < 4);
  assert.ok(Math.abs((framed.y0 + framed.y1) / 2 - 128) < 4);
});

test("renderTurntable returns four views and the clip frames", () => {
  const glb = parseGlb(syntheticCharacter({ clips: CLIPS }));
  const frames = renderTurntable(glb, { sizePx: 32, framesPerClip: 3 });
  assert.equal(frames.length, 4 + 3 * 2);
  assert.deepEqual(
    frames.slice(0, 4).map((f) => f.name),
    ["front.png", "three-quarter.png", "side.png", "back.png"],
  );
  assert.equal(frames[4]!.name, "clip-walk-cycle-0.png");
  assert.equal(frames[4]!.clip, "Walk Cycle");
  assert.equal(frames[9]!.timeS, (2 * 2) / 3);
  assert.ok(frames.every((f) => f.png.byteLength > 0));
});

test("a 512 px render of about 30K triangles is fast", () => {
  const glb = parseGlb(syntheticCharacter({ triangles: 30000, joints: 5 }));
  const framing = boundsOf(posedPrimitives(glb))!;
  const start = performance.now();
  renderView(glb, { sizePx: 512, yawDeg: 45, framing });
  assert.ok(performance.now() - start < 2000);
});

test("closeLoop closes an unclosed clip", () => {
  const glb = parseGlb(syntheticCharacter({ clips: CLIPS }));
  assert.ok(loopError(glb, 0).rotationDeg < 1e-6);
  assert.ok(loopError(glb, 1).rotationDeg > 10);
  assert.ok(closeLoop(glb, 1) > 0);
  assert.ok(loopError(glb, 1).rotationDeg < 1e-3);
});

test("normalize grounds the model and centres it", () => {
  const glb = parseGlb(syntheticCharacter());
  const before = measure(glb).bounds!;
  assert.ok(before.min[1] > 0.4);
  const after = normalize(glb, { sourceForward: "+z", forward: "+z", heightM: 1.8 });
  assert.ok(Math.abs(after.min[1]) < 1e-9);
  assert.ok(Math.abs(after.max[1] - 1.8) < 1e-9);
  assert.ok(Math.abs(after.min[0] + after.max[0]) < 1e-9);
  assert.ok(Math.abs(after.min[2] + after.max[2]) < 1e-9);
});

test("normalize turns a model that faces +x (Tripo's output) to the profile's forward", () => {
  for (const [forward, expected] of [
    ["+z", [0, 0, 1]],
    ["-z", [0, 0, -1]],
    ["+x", [1, 0, 0]],
  ] as const) {
    const glb = parseGlb(syntheticCharacter());
    normalize(glb, { sourceForward: "+x", forward });
    const [root] = sceneRoots(glb.json);
    const facing = transformDirection(worldMatrices(glb.json).get(root!)!, 1, 0, 0);
    facing.forEach((v, i) => assert.ok(Math.abs(v - expected[i]!) < 1e-9, `${forward}: ${facing}`));
  }
});
