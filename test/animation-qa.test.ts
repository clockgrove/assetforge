import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAnimation, animationQa } from "../src/animation/qa.ts";
import { templateFor, templatesFor, thresholdsFor } from "../src/animation/templates.ts";
import { InputError } from "../src/errors.ts";
import type { ResolvedStyle } from "../src/style.ts";
import { syntheticStrip } from "./fixtures/strip.ts";
import type { StripOptions } from "./fixtures/strip.ts";

const STYLES = ["painterly", "flat", "pixel"] as const;
const style = (s: (typeof STYLES)[number]): ResolvedStyle => ({
  alpha: s === "painterly" ? { mode: "soft", threshold: 128 } : { mode: "binary", threshold: 128 },
  color: { rule: "full", palette: [] },
  edges: s === "painterly" ? "antialiased" : "crisp",
});

function run(opts: StripOptions, family: string, profile: Parameters<typeof animationQa>[1] = {}) {
  const { frames, anchor } = syntheticStrip(opts);
  const frame = { width: frames[0]!.width, height: frames[0]!.height };
  return animationQa({ frames, frame, anchor, family }, profile, style(opts.style));
}

const failed = (r: ReturnType<typeof run>, check: string) =>
  r.reasons.filter((x) => x.check === check && !x.passed);

for (const s of STYLES) {
  test(`a clean ${s} walk passes every check`, () => {
    const r = run({ count: 8, style: s, motion: "walk" }, "walk-right");
    assert.deepEqual(
      r.reasons.filter((x) => !x.passed),
      [],
    );
    assert.equal(r.passed, true);
    assert.equal(r.template, "walk");
    for (const check of [
      "template",
      "beats",
      "ground-contact",
      "anchor-drift",
      "footprint-drift",
      "silhouette",
      "loop-seam",
    ]) {
      assert.ok(
        r.reasons.some((x) => x.check === check),
        check,
      );
    }
    assert.equal(r.silhouetteChange.length, 8);
  });
}

test("horizontal drift fails anchor-drift naming the frames", () => {
  const r = run({ count: 8, style: "flat", motion: "walk", drift: 2 }, "walk");
  const bad = failed(r, "anchor-drift");
  assert.ok(bad.length > 0);
  assert.match(bad[0]!.reason, /^frame \d+:/);
  assert.ok(bad.every((x) => x.frames?.length === 1));
  assert.ok(bad.some((x) => x.frames?.[0] === 8));
});

test("a floating frame fails ground-contact naming that frame", () => {
  const r = run({ count: 8, style: "pixel", motion: "walk", floatFrame: 3 }, "walk");
  const bad = failed(r, "ground-contact");
  assert.equal(bad.length, 1);
  assert.deepEqual(bad[0]!.frames, [3]);
  assert.match(bad[0]!.reason, /frame 3: baseline at row \d+, \d+ px above the ground line 63/);
});

test("a strip that does not close fails loop-seam naming the seam", () => {
  const r = run({ count: 8, style: "painterly", motion: "walk", seamBreak: true }, "walk");
  const bad = failed(r, "loop-seam");
  assert.equal(bad.length, 1);
  assert.match(bad[0]!.reason, /frame 8 → frame 1/);
  assert.deepEqual(bad[0]!.frames, [8, 1]);
});

test("walk-like variation fails the silhouette bound of the idle template", () => {
  const r = run({ count: 8, style: "flat", motion: "walk" }, "idle");
  const bad = failed(r, "silhouette");
  assert.ok(bad.length > 0);
  assert.match(bad[0]!.reason, /frame \d+ → frame \d+/);
  assert.equal(
    failed(run({ count: 4, style: "flat", motion: "idle" }, "idle"), "silhouette").length,
    0,
  );
});

test("a hop passes ground-contact under play and fails it under walk", () => {
  const play = run({ count: 5, style: "flat", motion: "hop" }, "play");
  assert.deepEqual(failed(play, "ground-contact"), []);
  const walk = run({ count: 5, style: "flat", motion: "hop" }, "walk");
  assert.ok(failed(walk, "ground-contact").length > 0);
});

test("a profile-added template matches its family, and walk-right matches walk", () => {
  const sleep = {
    name: "sleep",
    loop: true,
    frames: { min: 2, max: 6 },
    beats: [{ name: "curl", at: 0, contact: true }],
    contact: "all",
    silhouette: { min: 0, max: 0.2 },
  } as const;
  const profile = { animation: { templates: [{ ...sleep, beats: [...sleep.beats] }] } };
  const templates = templatesFor(profile);
  assert.equal(templateFor("sleep", templates)?.name, "sleep");
  assert.equal(templateFor("walk-right", templates)?.name, "walk");
  assert.equal(templateFor("fly", templates), undefined);
  const r = run({ count: 4, style: "flat", motion: "idle" }, "sleep", profile);
  assert.equal(r.template, "sleep");
  const none = run({ count: 4, style: "flat", motion: "idle" }, "fly");
  assert.equal(none.template, undefined);
  assert.match(none.reasons[0]!.reason, /no motion template matches family fly/);
  assert.equal(none.reasons[0]!.passed, true);
});

test("a frame count outside the template range fails template", () => {
  const r = run({ count: 3, style: "flat", motion: "walk" }, "walk");
  assert.equal(failed(r, "template").length, 1);
  const beats = failed(r, "beats");
  assert.match(beats[0]?.reason ?? "", /3 frames cannot hold 4 beats/);
});

test("cycle timing outside the template fails timing", () => {
  const { frames, anchor } = syntheticStrip({ count: 8, style: "flat", motion: "walk" });
  const input = { frames, frame: { width: 64, height: 64 }, anchor, family: "walk" };
  const template = templateFor("walk", templatesFor());
  const options = { template, thresholds: thresholdsFor(), threshold: 128 };
  assert.equal(checkAnimation({ ...input, durationMs: 100 }, options).passed, true);
  const slow = checkAnimation({ ...input, durationMs: 500 }, options);
  assert.equal(failed(slow, "timing" as never).length, 1);
});

test("profile thresholds override the defaults", () => {
  const opts: StripOptions = { count: 8, style: "flat", motion: "walk", drift: 2 };
  assert.ok(failed(run(opts, "walk"), "anchor-drift").length > 0);
  const loose = { animation: { thresholds: { anchorDriftPx: 20 } } };
  assert.deepEqual(failed(run(opts, "walk", loose), "anchor-drift"), []);
});

test("templatesFor rejects an invalid template", () => {
  assert.throws(
    () => templatesFor({ animation: { templates: [{ name: "bad" } as never] } }),
    InputError,
  );
});
