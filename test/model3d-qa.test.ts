import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGlb } from "../src/model3d/glb.ts";
import type { ResolvedModel3d } from "../src/model3d/profile.ts";
import { budgetChecks, clipChecks } from "../src/model3d/qa.ts";
import { measure, normalize } from "../src/model3d/scene.ts";
import type { Reason } from "../src/types.ts";
import { syntheticCharacter } from "./fixtures/glb.ts";

const SETTINGS: ResolvedModel3d = {
  budgets: { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 },
  forward: "+z",
  turntablePx: 64,
  loopTolerance: { rotationDeg: 2, translationFraction: 0.1 },
};

const reason = (reasons: Reason[], check: string): Reason => {
  const found = reasons.find((r) => r.check === check);
  assert.ok(found, `no ${check} reason`);
  return found;
};

test("a library clip the provider did not return fails its clip check; a missing family does not", () => {
  const glb = parseGlb(
    syntheticCharacter({ clips: [{ name: "idle", durationS: 1, loopClosed: true }] }),
  );
  const reasons = clipChecks(
    glb,
    [
      { family: "idle", loop: true },
      { family: "walk", loop: true },
    ],
    [{ family: "run", why: "the library has no close clip" }],
    SETTINGS,
    1,
    [{ family: "walk", why: "the provider returned no animation for library clip walk" }],
  );
  assert.equal(reason(reasons, "clip-idle").passed, true);
  const walk = reason(reasons, "clip-walk");
  assert.equal(walk.passed, false);
  assert.match(walk.reason, /no clip named "walk".*returned no animation/);
  const run = reason(reasons, "clip-run");
  assert.equal(run.passed, true);
  assert.match(run.reason, /missing, not faked/);
});

test("loop translation error is compared in metres, after the root's scale", () => {
  // 2 local units tall with a 0.1-unit drift, scaled to 0.5 m: the drift is 0.025 m,
  // within 10% of 0.5 m (0.05 m); compared unscaled it would be 0.1 and fail.
  const glb = parseGlb(
    syntheticCharacter({
      heightUnits: 2,
      translationDrift: 0.1,
      clips: [{ name: "idle", durationS: 1, loopClosed: true }],
    }),
  );
  const bounds = normalize(glb, { sourceForward: "+z", forward: "+z", heightM: 0.5 });
  const height = bounds.max[1] - bounds.min[1];
  const loop = reason(
    clipChecks(glb, [{ family: "idle", loop: true }], [], SETTINGS, height),
    "loop-idle",
  );
  assert.equal(loop.passed, true, loop.reason);
  assert.match(loop.reason, /0\.0250 m \(tolerance 0\.0500 m\)/);
});

test("an image whose size cannot be read fails the texture budget instead of passing as 0", () => {
  const byUri = parseGlb(syntheticCharacter());
  byUri.json.images = [{ uri: "texture.png" }];
  const uriCheck = reason(budgetChecks(measure(byUri), SETTINGS), "budget-textureMaxPx");
  assert.equal(uriCheck.passed, false);
  assert.match(uriCheck.reason, /not measured.*image\(s\) 0/);

  const unknown = parseGlb(syntheticCharacter());
  unknown.json.images = [{ bufferView: 0, mimeType: "image/ktx2" }];
  assert.equal(
    reason(budgetChecks(measure(unknown), SETTINGS), "budget-textureMaxPx").passed,
    false,
  );

  const measured = reason(
    budgetChecks(measure(parseGlb(syntheticCharacter({ textureSize: 16 }))), SETTINGS),
    "budget-textureMaxPx",
  );
  assert.equal(measured.passed, true, measured.reason);
  assert.equal(measured.reason, "textureMaxPx 16 within 2048");
});
