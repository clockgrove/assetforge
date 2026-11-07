import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMaterialProfile } from "../src/material/profile.ts";

test("material profile schema fills standard defaults, supports disabled channels and target rig data", () => {
  assert.deepEqual(resolveMaterialProfile(undefined), {
    channels: ["normal", "height", "emissive", "roughness", "wind"],
    scales: [1, 2],
    flickerBound: 0.03,
  });
  const profile = resolveMaterialProfile({
    channels: [],
    scales: [1, 2, 4],
    lightRig: { night: { direction: [0, 0, 1], intensity: 0.2 } },
    compression: { command: ["encoder", "{{input}}"], version: "1" },
  });
  assert.deepEqual(profile.channels, []);
  assert.deepEqual(profile.lightRig, { night: { direction: [0, 0, 1], intensity: 0.2 } });
  assert.equal(profile.compression?.format, "ktx2");
});

test("material profile schema rejects invalid configuration before execution", () => {
  for (const value of [
    null,
    [],
    { unexpected: true },
    { channels: ["normal", "normal"] },
    { channels: ["depth"] },
    { scales: [1, 2, 3] },
    { scales: [1] },
    { flickerBound: NaN },
    { flickerBound: { normal: 2 } },
    { channels: ["normal"], flickerBound: {} },
    { encoding: { height: { range: [1, 0] } } },
    { encoding: { height: { range: [0, 0.5, 1] } } },
    { encoding: { normal: { encoding: "float" } } },
    { compression: { format: "png", command: ["x"], version: "1" } },
    { preview: { command: [""], version: "1" } },
    { lightRig: [] },
  ])
    assert.throws(() => resolveMaterialProfile(value));
});
