import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import {
  IDENTITY_ENFORCE_BAR,
  breakdown,
  evaluateIdentity,
  readEvalCases,
} from "../src/identity-eval.ts";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";
import { defaultRoutes } from "../src/routes.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function png(): Uint8Array {
  const r = createRaster(16, 16);
  setPixel(r, 0, 0, [200, 100, 50, 255]);
  return encodePng(r);
}

/** A bible of the given world with two look-alike characters, `fox` and `kit`. */
async function bibleIn(root: string, folder: string, world: string): Promise<string> {
  const dir = join(root, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "fox.png"), png());
  await writeFile(join(dir, "kit.png"), png());
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  data.world = world;
  const lock = (name: string, scarf: string) => ({
    version: `${name}-1`,
    approved: true as const,
    turnaround: `${name}.png`,
    signatureFeatures: [scarf],
    proportions: "two heads tall",
    palette: ["#c86432"],
  });
  data.identities = { fox: lock("fox", "green scarf"), kit: lock("kit", "blue scarf") };
  const path = join(dir, "BIBLE.md");
  await writeFile(path, serializeBible(data, "# Synthetic\n\n## Do's and Don'ts\nDo.\n"));
  return path;
}

async function fixture(cases: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "identity-eval-"));
  roots.push(root);
  await bibleIn(root, "woodland", "Woodland");
  await bibleIn(root, "reef", "Reef");
  for (const name of ["a", "b", "c", "d", "e"]) await writeFile(join(root, `${name}.png`), png());
  const casesPath = join(root, "cases.json");
  await writeFile(casesPath, JSON.stringify({ cases }));
  return { root, casesPath, woodland: join(root, "woodland", "BIBLE.md") };
}

/** Cast answers in call order (the foxes' probability each); the record check answers by prompt. */
function provider(foxProbabilities: number[], check: string) {
  let cast = 0;
  return new ScriptedProvider({
    image: () => {
      throw new Error("no images");
    },
    vision: (request) => {
      if (request.prompt.includes("source of truth")) return { text: check };
      const p = foxProbabilities[cast++]!;
      return {
        text: JSON.stringify({ probabilities: { fox: p, kit: 1 - p, neither: 0 }, choice: "fox" }),
      };
    },
  });
}

const CONSISTENT = '{"consistent": true, "conflicts": []}';
const castProfile = syntheticProfile({ identity: { question: "cast" } });

test("eval by kind, cast and medium: per-group breakdown, 2D-only recommendation, one record check each", async () => {
  const f = await fixture([
    { image: "a.png", subject: "fox", same: true, bible: "woodland/BIBLE.md" },
    { image: "b.png", subject: "fox", same: false, kind: "drift", bible: "woodland/BIBLE.md" },
    { image: "c.png", subject: "fox", same: false, kind: "lookalike", bible: "woodland/BIBLE.md" },
    { image: "d.png", subject: "fox", same: true, bible: "woodland/BIBLE.md" },
    { image: "e.png", subject: "fox", same: true, medium: "3d", bible: "reef/BIBLE.md" },
  ]);
  const logPath = join(f.root, "identity.jsonl");
  const report = await evaluateIdentity({
    casesPath: f.casesPath,
    profile: castProfile,
    routes: defaultRoutes,
    provider: provider([0.9, 0.3, 0.8, 0.7, 0.1], CONSISTENT),
    providerName: "scripted",
    capUsd: 5,
    logPath,
  });
  assert.equal(report.question, "cast");
  assert.equal(report.model, "openai/gpt-6.1-terra");
  assert.equal(report.scored, 5);
  // Thresholds rest on the four 2D cases; the 3D miss does not move them.
  assert.equal(report.recommended?.threshold, 0.5);
  assert.equal(report.auc, 0.75);
  assert.equal(report.recordChecks.length, 2);
  assert.ok(report.recordChecks.every((c) => c.checked && c.consistent));
  assert.ok(report.results.every((r) => r.untrustedRecord === undefined));
  assert.deepEqual(
    report.results.map((r) => [r.kind, r.cast, r.medium]),
    [
      ["same", "Woodland", "2d"],
      ["drift", "Woodland", "2d"],
      ["lookalike", "Woodland", "2d"],
      ["same", "Woodland", "2d"],
      ["same", "Reef", "3d"],
    ],
  );
  const two = report.media["2d"]!;
  assert.equal(two.provisional, false);
  assert.equal(two.configured.byKind["lookalike"]?.falseAcceptRate, 1);
  assert.equal(two.configured.byKind["drift"]?.falseAcceptRate, 0);
  assert.equal(two.configured.byKind["same"]?.falseRejectRate, 0);
  assert.equal(two.configured.byCast["Woodland"]?.positives, 2);
  assert.equal(two.configured.bar.met, false);
  assert.ok(two.configured.bar.failures.includes("kind lookalike: false accepts 100% > 5%"));
  assert.ok(two.recommended);
  const three = report.media["3d"]!;
  assert.equal(three.provisional, true);
  assert.equal(three.configured.falseRejectRate, 1);
  assert.equal(three.configured.byCast["Reef"]?.cases, 1);
  const lines = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    [lines[2].case.kind, lines[2].case.cast, lines[2].case.medium],
    ["lookalike", "Woodland", "2d"],
  );
  // The cast and record-check calls are budgeted: a cap below the estimates refuses first.
  await assert.rejects(
    evaluateIdentity({
      casesPath: f.casesPath,
      profile: castProfile,
      routes: defaultRoutes,
      provider: provider([], CONSISTENT),
      providerName: "scripted",
      capUsd: 0.1,
    }),
    /cap/,
  );
});

test("a record that contradicts its references marks every case that used it", async () => {
  const f = await fixture([
    { image: "a.png", subject: "fox", same: true },
    { image: "b.png", subject: "kit", same: false },
  ]);
  const conflicted =
    '{"consistent": false, "conflicts": [{"field": "palette", "text": "#c86432", "observed": "grey"}]}';
  const report = await evaluateIdentity({
    biblePath: f.woodland,
    casesPath: f.casesPath,
    profile: castProfile,
    routes: defaultRoutes,
    provider: provider([0.9, 0.9], conflicted),
    providerName: "scripted",
    capUsd: 5,
  });
  assert.equal(report.recordChecks.length, 2);
  assert.ok(report.recordChecks.every((c) => !c.consistent));
  assert.ok(report.results.every((r) => r.untrustedRecord === true));
  assert.ok(report.results.every((r) => r.score?.filtered === false));
  // Nothing is measured on a record that never filters: no sweep, threshold, AUC or bar.
  assert.deepEqual(report.sweep, []);
  assert.equal(report.recommended, undefined);
  assert.equal(report.auc, undefined);
  assert.deepEqual(report.media, {});
  assert.equal(report.untrusted?.cases, 2);
  assert.equal(report.untrusted?.positives, 1);
  assert.equal(report.untrusted?.falseRejects, 0);
});

test("a set with no 2D case recommends no threshold; 3D stays provisional", async () => {
  const f = await fixture([
    { image: "a.png", subject: "fox", same: true, medium: "3d" },
    { image: "b.png", subject: "fox", same: false, kind: "lookalike", medium: "3d" },
  ]);
  const report = await evaluateIdentity({
    biblePath: f.woodland,
    casesPath: f.casesPath,
    profile: castProfile,
    routes: defaultRoutes,
    provider: provider([0.9, 0.1], CONSISTENT),
    providerName: "scripted",
    capUsd: 5,
  });
  assert.equal(report.scored, 2);
  assert.deepEqual(report.sweep, []);
  assert.equal(report.recommended, undefined);
  assert.equal(report.auc, undefined);
  assert.equal(report.labelAgreement, undefined);
  assert.equal(report.media["2d"], undefined);
  assert.equal(report.media["3d"]?.provisional, true);
  assert.equal(report.media["3d"]?.recommended, undefined);
  assert.equal(report.media["3d"]?.configured.auc, 1);
});

test("case validation refuses unknown or contradictory labels and a case without a bible", async () => {
  const f = await fixture([{ image: "a.png", subject: "fox", same: true }]);
  const read = async (c: unknown) => {
    await writeFile(
      f.casesPath,
      JSON.stringify([{ image: "a.png", subject: "fox", ...(c as object) }]),
    );
    return readEvalCases(f.casesPath);
  };
  await assert.rejects(read({ same: true, kind: "weird" }), /kind/);
  await assert.rejects(read({ same: true, medium: "4d" }), /medium/);
  await assert.rejects(read({ same: true, kind: "drift" }), /same-character/);
  await assert.rejects(read({ same: false, kind: "same" }), /different-character/);
  assert.equal((await read({ same: false, kind: "generic", medium: "3d" })).cases.length, 1);
  await assert.rejects(
    evaluateIdentity({
      casesPath: f.casesPath,
      profile: syntheticProfile(),
      routes: defaultRoutes,
      provider: provider([], CONSISTENT),
      providerName: "scripted",
      capUsd: 5,
    }),
    /no --bible/,
  );
});

test("the breakdown measures kinds against all positives and judges the provisional bar", () => {
  assert.deepEqual(IDENTITY_ENFORCE_BAR, {
    auc: 0.95,
    falseAcceptRate: 0.05,
    falseRejectRate: 0.1,
  });
  const clean = breakdown(
    [
      { score: 0.9, same: true, kind: "same", cast: "A" },
      { score: 0.1, same: false, kind: "drift", cast: "A" },
    ],
    0.68,
  );
  assert.equal(clean.auc, 1);
  assert.equal(clean.byKind["same"]?.auc, undefined);
  assert.equal(clean.byKind["drift"]?.auc, 1);
  assert.deepEqual(clean.bar, { met: true, failures: [] });
  const bad = breakdown(
    [
      { score: 0.9, same: true, kind: "same", cast: "A" },
      { score: 0.5, same: true, kind: "same", cast: "A" },
      { score: 0.8, same: false, kind: "drift", cast: "A" },
      { score: 0.1, same: false, kind: "generic", cast: "B" },
    ],
    0.68,
  );
  assert.equal(bad.falseAccepts, 1);
  assert.equal(bad.falseRejectRate, 0.5);
  assert.equal(bad.byKind["generic"]?.falseAcceptRate, 0);
  assert.equal(bad.byCast["B"]?.positives, 0);
  assert.equal(bad.byCast["A"]?.falseAcceptRate, 1);
  assert.equal(bad.bar.met, false);
  assert.ok(bad.bar.failures.includes("kind drift: false accepts 100% > 5%"));
  assert.ok(bad.bar.failures.includes("kind same: false rejects 50% > 10%"));
  // Cast B has no positives: it cannot be measured, so it fails rather than passing on 0%.
  assert.ok(bad.bar.failures.includes("cast B: not measured (no positives)"));
  const onlyPositives = breakdown([{ score: 0.9, same: true, kind: "same", cast: "A" }], 0.68);
  assert.deepEqual(onlyPositives.bar.failures, [
    "overall: not measured (no negatives)",
    "cast A: not measured (no negatives)",
  ]);
});
