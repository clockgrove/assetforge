import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILTIN_TEMPLATES,
  DEFAULT_THRESHOLDS,
  parseTemplate,
  templateFor,
  templatesFor,
  thresholdsFor,
} from "../src/animation/templates.ts";
import { InputError } from "../src/errors.ts";

test("templates: the six built-in families ship as data", () => {
  assert.deepEqual(
    BUILTIN_TEMPLATES.map((t) => t.name),
    ["idle", "walk", "sniff", "eat", "play", "shelter"],
  );
  // Each built-in survives the same validation a target's template goes through.
  for (const t of BUILTIN_TEMPLATES) assert.deepEqual(parseTemplate(t), t);
  const walk = templateFor("walk", BUILTIN_TEMPLATES);
  assert.equal(walk?.loop, true);
  assert.equal(walk?.contact, "all");
});

test("templates: a target adds its own and overrides a built-in without code", () => {
  const sleep = {
    name: "sleep",
    loop: true,
    frames: { min: 2, max: 8 },
    beats: [{ name: "exhale", at: 0, contact: true }],
    contact: "all",
    silhouette: { min: 0, max: 0.1 },
  };
  const slowWalk = { ...BUILTIN_TEMPLATES[1], name: "walk", frames: { min: 8, max: 24 } };
  const templates = templatesFor({
    animation: { templates: [sleep, slowWalk] as never },
  });
  assert.equal(templateFor("sleep", templates)?.frames.max, 8);
  assert.equal(templateFor("walk-left", templates)?.frames.min, 8);
  assert.equal(templates.length, BUILTIN_TEMPLATES.length + 1);
});

test("templates: families match by name or by name-suffix, else none", () => {
  assert.equal(templateFor("walk-right", BUILTIN_TEMPLATES)?.name, "walk");
  assert.equal(templateFor("idle", BUILTIN_TEMPLATES)?.name, "idle");
  assert.equal(templateFor("crouch-hop", BUILTIN_TEMPLATES), undefined);
  assert.equal(templateFor("walker", BUILTIN_TEMPLATES), undefined);
});

test("templates: invalid data is refused with the field named", () => {
  assert.throws(
    () => templatesFor({ animation: { templates: [{ name: "x", loop: "yes" }] as never } }),
    (e: unknown) => e instanceof InputError && /loop/.test(e.message),
  );
  assert.throws(
    () =>
      parseTemplate({
        name: "climb",
        loop: false,
        frames: { min: 4, max: 2 },
        beats: [],
        contact: "none",
        silhouette: { min: 0, max: 1 },
      }),
    /frames.min is above frames.max/,
  );
  assert.throws(
    () =>
      parseTemplate({
        name: "climb",
        loop: false,
        frames: { min: 2, max: 4 },
        beats: [{ name: "grab", at: 1.2 }],
        contact: "none",
        silhouette: { min: 0, max: 1 },
      }),
    /beats\[0\]\.at/,
  );
});

test("thresholds: defaults, profile overrides and refusals", () => {
  assert.deepEqual(thresholdsFor({}), DEFAULT_THRESHOLDS);
  const t = thresholdsFor({ animation: { thresholds: { anchorDriftPx: 3, flickerCutoff: 0.8 } } });
  assert.equal(t.anchorDriftPx, 3);
  assert.equal(t.flickerCutoff, 0.8);
  assert.equal(t.groundTolerancePx, DEFAULT_THRESHOLDS.groundTolerancePx);
  assert.throws(() => thresholdsFor({ animation: { thresholds: { bogus: 1 } as never } }), /bogus/);
  assert.throws(
    () => thresholdsFor({ animation: { thresholds: { flickerCutoff: 2 } } }),
    /flickerCutoff/,
  );
});
