import assert from "node:assert/strict";
import { test } from "node:test";
import { InputError } from "../src/errors.ts";
import { handoffSettings } from "../src/model3d/handoff.ts";
import { declaresLods, lodSettings } from "../src/model3d/lod/settings.ts";
import type { TargetProfile } from "../src/types.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const BUDGETS = { triangles: 60000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 3 };
const LODS = [
  { level: 0, triangleRatio: 1, minScreenHeight: 0.15 },
  { level: 1, triangleRatio: 0.33, minScreenHeight: 0.05 },
  { level: 2, triangleRatio: 0.1, minScreenHeight: 0 },
];

function profile(model3d: Record<string, unknown>): TargetProfile {
  return syntheticProfile({
    model3d: { format: "glb", units: "m", budgets: BUDGETS, lods: LODS, ...model3d },
  } as Partial<TargetProfile>);
}

const NESTED = {
  desktop: {
    status: "measured",
    character: { ...BUDGETS },
    prop: { ...BUDGETS, triangles: 30000, textureMaxPx: 1024 },
  },
  phone: {
    status: "pending",
    character: { ...BUDGETS, triangles: 20000, textureMaxPx: 1024 },
    prop: { ...BUDGETS, triangles: 10000, textureMaxPx: 512 },
  },
};

test("class-nested tiers resolve for the spec's tierClass", () => {
  const settings = lodSettings(profile({ tiers: NESTED }), "character");
  assert.deepEqual(settings.levels, LODS);
  assert.deepEqual(
    settings.tiers.map((t) => t.name),
    ["desktop", "phone"],
  );
  assert.equal(settings.tiers[1]?.triangles, 20000);
  assert.equal(settings.tiers[1]?.textureMaxPx, 1024);
  assert.equal(settings.tiers[1]?.fur, true);
  assert.equal(settings.packaging, "embedded");
  assert.equal(settings.silhouette, 0.06);
});

test("flat tiers need no class", () => {
  const settings = lodSettings(
    profile({ tiers: { phone: { triangles: 100, textureMaxPx: 64, fur: false } } }),
  );
  assert.deepEqual(settings.tiers, [
    { name: "phone", triangles: 100, textureMaxPx: 64, fur: false },
  ]);
});

test("class-nested tiers without a tierClass are refused, naming tierClass", () => {
  assert.throws(
    () => lodSettings(profile({ tiers: NESTED })),
    (e: unknown) =>
      e instanceof InputError &&
      e.message.includes("tierClass") &&
      e.message.includes("character, prop"),
  );
  assert.throws(() => lodSettings(profile({ tiers: NESTED }), "vehicle"), /tierClass/);
});

test("the chain is validated", () => {
  assert.equal(declaresLods(profile({})), true);
  assert.equal(declaresLods(profile({ lods: undefined })), false);
  assert.throws(() => lodSettings(profile({ lods: undefined })), /declares no detail levels/);
  assert.throws(() => lodSettings(profile({ lods: [] })), InputError);
  const [a, b, c] = LODS;
  assert.throws(() => lodSettings(profile({ lods: [a, c, b] })), /level/);
  assert.throws(
    () =>
      lodSettings(
        profile({ lods: [a, { ...b, triangleRatio: 0.5 }, { ...c, triangleRatio: 0.5 }] }),
      ),
    /triangleRatio/,
  );
  assert.throws(
    () => lodSettings(profile({ lods: [{ ...a, triangleRatio: 0.9 }, b] })),
    /must be 1/,
  );
  assert.throws(
    () => lodSettings(profile({ lods: [a, { ...b, minScreenHeight: 0.5 }] })),
    /minScreenHeight/,
  );
});

test("lodQa and tier values are validated", () => {
  assert.equal(lodSettings(profile({ lodQa: { silhouette: 0.1 } })).silhouette, 0.1);
  assert.throws(() => lodSettings(profile({ lodQa: { other: 1 } })), /unknown/);
  assert.throws(() => lodSettings(profile({ lodQa: { silhouette: 0 } })), /silhouette/);
  assert.throws(() => lodSettings(profile({ tiers: { phone: { triangles: 1.5 } } })), /triangles/);
});

test("handoff.lods picks the packaging", () => {
  assert.equal(lodSettings(profile({ handoff: { lods: "files" } })).packaging, "files");
  assert.throws(
    () => lodSettings(profile({ handoff: { lods: "bogus" } })),
    /model3d\.handoff\.lods must be embedded or files/,
  );
  assert.throws(() => handoffSettings(profile({ handoff: { other: 1 } })), /unknown field/);
});

test("a handoff without lods resolves as before", () => {
  assert.deepEqual(handoffSettings(profile({ handoff: { sideImages: "beside" } })), {
    sideImages: "beside",
  });
  assert.deepEqual(handoffSettings(profile({})), { sideImages: "beside" });
});
