import "./fixtures/spend-env.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { evaluateIdentity } from "../src/identity-eval.ts";
import { defaultRoutes } from "../src/routes.ts";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";
import { buildIdentitySet, heldOutCut } from "./fixtures/identity-set/build.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const fakeFetch: typeof fetch = async () => {
  const raster = createRaster(12, 10);
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 12; x++) setPixel(raster, x, y, [40 + x * 10, 90 + y * 5, 150, 255]);
  return new Response(encodePng(raster));
};

interface SetCase {
  subject: string;
  same: boolean;
  kind: string;
  cast: string;
  medium?: string;
  bible?: string;
}

/**
 * The whole acceptance set through `identity-eval`, both casts, with a scripted model: it answers
 * the cast question in case order (every same case 0.9, drift 0.7, other negatives 0.1) and finds
 * a conflict in any record written with the lean or conflicting text.
 */
test("identity-eval reports the combined set per kind, cast and medium, and catches both conflicting records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "identity-set-"));
  roots.push(dir);
  const { casesPath } = await buildIdentitySet(dir, { fetch: fakeFetch });
  const cases = JSON.parse(await readFile(casesPath, "utf8")) as SetCase[];
  const birdConflict = await readFile(join(dir, "birds", "BIBLE.conflict.md"), "utf8");
  // The first signature feature written for fern in the conflicting bible.
  const fernText = /fern:[\s\S]*?signatureFeatures:\s*\n\s*- (.+)/.exec(birdConflict)![1]!.trim();
  let next = 0;
  const provider = new ScriptedProvider({
    image: () => {
      throw new Error("no image generation");
    },
    vision: (request) => {
      if (request.prompt.includes("For each written claim")) {
        const conflicting =
          /long legs/.test(request.prompt) ||
          (request.prompt.includes('"fern"') && request.prompt.includes(fernText));
        return {
          text: JSON.stringify({
            consistent: !conflicting,
            conflicts: conflicting
              ? [{ field: "proportions", text: "the written build", observed: "another build" }]
              : [],
          }),
          costUsd: 0.001,
        };
      }
      const c = cases[next++]!;
      const p = c.same ? 0.9 : c.kind === "drift" ? 0.7 : 0.1;
      const other = c.same ? "neither" : c.subject;
      return {
        text: JSON.stringify({
          probabilities: { [c.subject]: p, neither: 1 - p },
          choice: p >= 0.5 ? c.subject : "neither",
          reason: `scripted for ${other}`,
        }),
        costUsd: 0.001,
      };
    },
  });
  const report = await evaluateIdentity({
    casesPath,
    profile: { identity: { question: "cast", threshold: 0.5 } },
    routes: defaultRoutes,
    provider,
    providerName: "scripted",
    capUsd: 50,
  });
  assert.equal(report.cases, cases.length);
  assert.equal(report.failed, 0);
  assert.equal(report.question, "cast");
  const twoD = report.media["2d"]!;
  assert.equal(twoD.provisional, false);
  assert.equal(report.media["3d"]?.provisional, true);
  for (const kind of ["same", "drift", "generic", "lookalike"])
    assert.ok(twoD.configured.byKind[kind], kind);
  for (const cast of ["pebble-birds", "raccoon-world"])
    assert.ok(twoD.configured.byCast[cast], cast);
  // Drift at 0.7 passes a 0.5 threshold: the bar names it.
  assert.equal(twoD.configured.byKind["drift"]!.falseAcceptRate, 1);
  assert.equal(twoD.configured.bar.met, false);
  assert.ok(twoD.configured.bar.failures.some((f) => f.startsWith("kind drift")));
  assert.equal(twoD.configured.byKind["lookalike"]!.falseAcceptRate, 0);
  // Both deliberately conflicting records are caught; the accurate ones are trusted.
  const untrusted = report.recordChecks.filter((c) => !c.consistent);
  assert.deepEqual(untrusted.map((c) => c.subject).sort(), ["fern", "stevie"]);
  assert.ok(untrusted.every((c) => c.checked && /disagrees/.test(c.reason)));
  assert.ok(
    report.results
      .filter((r) => r.cast.endsWith("-conflict"))
      .every((r) => r.untrustedRecord === true),
  );
  assert.ok(
    report.results.filter((r) => !r.cast.endsWith("-conflict")).every((r) => !r.untrustedRecord),
  );
});

test("the held-out cut keeps one run's positives and drift with every generic and look-alike", async () => {
  const cut = heldOutCut(
    [
      { id: 1, kind: "same", heldOut: "#104 run 7" },
      { id: 2, kind: "drift", heldOut: "#104 run 7" },
      { id: 3, kind: "same", heldOut: "#104 run 6" },
      { id: 4, kind: "drift" },
      { id: 5, kind: "same" },
      { id: 6, kind: "generic" },
      { id: 7, kind: "lookalike", heldOut: "#104 run 6" },
    ],
    "#104 run 7",
  );
  assert.deepEqual(
    cut.map((c) => c.id),
    [1, 2, 6, 7],
  );
  const dir = await mkdtemp(join(tmpdir(), "identity-set-"));
  roots.push(dir);
  const { cases } = (await buildIdentitySet(dir, {
    raccoonWorld: false,
    heldOut: "#104 run 7",
  })) as { cases: SetCase[] };
  const count = (kind: string) => cases.filter((c) => c.kind === kind).length;
  // Run 7's bird poses: 12 on-model frames and 12 drift, with every generic and look-alike.
  assert.deepEqual(["same", "drift", "generic", "lookalike"].map(count), [12, 12, 9, 14]);
  for (const run of ["#108 run 8", "#108 run 9"]) {
    const held = (await buildIdentitySet(join(dir, run.replace(/\W+/g, "-")), {
      fetch: fakeFetch,
      heldOut: run,
    })) as { cases: (SetCase & { heldOut?: string })[] };
    for (const cast of ["pebble-birds", "raccoon-world"]) {
      const mine = held.cases.filter((c) => c.cast === cast && c.heldOut === run);
      assert.ok(
        mine.some((c) => c.kind === "same"),
        `${run} ${cast}`,
      );
      assert.ok(
        mine.some((c) => c.kind === "drift"),
        `${run} ${cast}`,
      );
    }
  }
  await assert.rejects(
    buildIdentitySet(join(dir, "none"), { raccoonWorld: false, heldOut: "#104 run 99" }),
    /no case is held out/,
  );
});
