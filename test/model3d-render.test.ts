import assert from "node:assert/strict";
import { test } from "node:test";
import validator from "gltf-validator";
import { parseGlb } from "../src/model3d/glb.ts";
import { renderTurntable, renderView } from "../src/model3d/render.ts";
import {
  boundsOf,
  closeLoop,
  loopError,
  measure,
  normalize,
  posedPrimitives,
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
