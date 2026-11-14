import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { joinStrip, splitStrip } from "../src/animation/strip.ts";
import { decodePng, encodePng } from "../src/image/raster.ts";
import type { Grouping } from "../src/sheet/types.ts";
import type { TargetProfile } from "../src/types.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { quadrupedWalk, syntheticStrip } from "./fixtures/strip.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/animation-script.ts", import.meta.url));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Result> {
  const env = { ...process.env };
  delete env["AI_GATEWAY_API_KEY"];
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = (r: Result): Record<string, any> => JSON.parse(r.stdout);

function profile(style: TargetProfile["style"]): TargetProfile {
  return { ...syntheticProfile(), style, frames: { width: 64, height: 64, durationMs: 100 } };
}

async function setup(style: TargetProfile["style"], drawn: Parameters<typeof syntheticStrip>[0]) {
  const root = await mkdtemp(join(tmpdir(), "assetgrove-anim-cli-"));
  const { strip } = syntheticStrip(drawn);
  await writeFile(join(root, "walk-right.png"), encodePng(strip));
  await writeFile(join(root, "profile.json"), JSON.stringify(profile(style)));
  return { root, strip };
}

const STYLES: Array<[string, TargetProfile["style"], "painterly" | "flat" | "pixel"]> = [
  ["painterly", { alpha: { mode: "soft" }, color: { rule: "full" } }, "painterly"],
  ["flat-cartoon", { alpha: { mode: "binary" }, color: { rule: "full" } }, "flat"],
  [
    "pixel-art",
    { alpha: { mode: "binary" }, color: { rule: "palette", palette: ["#000000"] }, edges: "crisp" },
    "pixel",
  ],
];

for (const [name, style, drawn] of STYLES) {
  test(`animation-qa: a clean ${name} walk passes, with previews and a flicker log`, async () => {
    const { root } = await setup(style, { count: 8, style: drawn, motion: "walk" });
    const out = join(root, "qa");
    const r = await cli([
      "animation-qa",
      ...["--strip", join(root, "walk-right.png"), "--family", "walk-right"],
      ...["--profile", join(root, "profile.json"), "--out", out, "--subject", "testcoon"],
      ...["--provider-script", SCRIPT, "--json"],
    ]);
    const d = doc(r);
    // The scripted model calls the 2 → 3 pair a flicker; everything on pixels passes.
    assert.equal(r.code, 5, r.stderr);
    assert.equal(d.error.code, "qa_found_nothing");
    const family = d.families[0];
    assert.equal(family.template, "walk");
    assert.equal(family.identityFlicker, "checked");
    const failed = family.reasons.filter((x: { passed: boolean }) => !x.passed);
    assert.deepEqual(
      failed.map((x: { check: string; frames: number[] }) => [x.check, x.frames]),
      [["identity-flicker", [2, 3]]],
    );
    assert.match(failed[0].reason, /frame 2 → frame 3/);
    // 7 consecutive pairs plus the seam, one call each.
    assert.equal(family.decisions.length, 8);
    const log = (await readFile(join(out, "flicker.jsonl"), "utf8")).trim().split("\n");
    assert.equal(log.length, 8);
    const line = JSON.parse(log[1] as string);
    assert.equal(line.label, "flicker");
    assert.equal(line.confidence, 0.91);
    assert.equal(line.cutoff, 0.7);
    assert.equal(typeof line.model, "string");
    // Frames whose legs cross enclose a see-through area: one holes call each, judged openings.
    assert.equal(family.holes, "checked");
    assert.ok(family.holeDecisions.length > 0);
    for (const h of family.holeDecisions) {
      assert.equal(h.label, "openings");
      assert.equal(h.flagged, false);
      assert.ok(h.areas.length > 0);
    }
    assert.equal(d.spentUsd.toFixed(3), (0.08 + 0.003 * family.holeDecisions.length).toFixed(3));
    const onion = decodePng(new Uint8Array(await readFile(join(out, "walk-right.onion.png"))));
    assert.ok(onion.width > 64 && onion.height > 64);
    const webp = await readFile(join(out, "walk-right.webp"));
    assert.equal(webp.subarray(0, 4).toString(), "RIFF");
    assert.equal(webp.subarray(8, 12).toString(), "WEBP");
    assert.ok(webp.includes(Buffer.from("ANMF")));
  });
}

test("animation-qa: pixel failures name the frame; --no-vision spends nothing", async () => {
  const { root } = await setup(undefined, {
    count: 8,
    style: "painterly",
    motion: "walk",
    floatFrame: 5,
  });
  const r = await cli([
    "animation-qa",
    ...["--strip", join(root, "walk-right.png"), "--family", "walk-right"],
    ...["--profile", join(root, "profile.json"), "--out", join(root, "qa")],
    ...["--no-vision", "--json"],
  ]);
  const d = doc(r);
  assert.equal(r.code, 5);
  const family = d.families[0];
  assert.equal(family.identityFlicker, "skipped");
  const ground = family.reasons.find((x: { check: string; passed: boolean }) => !x.passed);
  assert.equal(ground.check, "ground-contact");
  assert.deepEqual(ground.frames, [5]);
  assert.match(ground.reason, /^frame 5: /);
  assert.equal(d.spentUsd, 0);
});

test("animation-qa: --dry-run forecasts the flicker calls and refuses over the cap", async () => {
  const { root } = await setup(undefined, { count: 8, style: "painterly", motion: "walk" });
  const args = [
    "animation-qa",
    ...["--strip", join(root, "walk-right.png"), "--family", "walk-right"],
    ...["--profile", join(root, "profile.json"), "--dry-run", "--json"],
  ];
  const ok = await cli(args);
  assert.equal(ok.code, 0, ok.stderr);
  const plan = doc(ok).plan;
  assert.equal(plan.perFamily[0].flickerCalls, 8);
  assert.ok(plan.perFamily[0].holeCalls > 0, "the crossing legs enclose see-through areas");
  assert.equal(plan.calls, 8 + plan.perFamily[0].holeCalls);
  assert.equal(plan.estimateUsd.toFixed(2), (0.16 + 0.01 * plan.perFamily[0].holeCalls).toFixed(2));
  const over = await cli([...args, "--cap", "0.1"]);
  assert.equal(over.code, 3);
  assert.equal(doc(over).error.code, "cap_refused");
  // Without --dry-run the same cap refuses before any call, and without a key nothing is called.
  const refused = await cli([...args.filter((a) => a !== "--dry-run"), "--cap", "0.1"]);
  assert.equal(refused.code, 4, "no key: provider error before any spend");
});

test("fix-frame: regenerates only that frame and records it in provenance", async () => {
  const { root, strip } = await setup(undefined, {
    count: 8,
    style: "painterly",
    motion: "walk",
    floatFrame: 3,
  });
  await writeFile(
    join(root, "walk-right.png.provenance.json"),
    JSON.stringify({
      generator: "sheet-import",
      route: "import:hand",
      models: ["hand"],
      prompt: "imported",
      parameters: {},
      requestIds: [],
      referenceHashes: [],
      bibleVersion: "1",
      license: "MIT",
      providerTerms: [],
      startedAt: "2026-11-08T00:00:00.000Z",
      finishedAt: "2026-11-08T00:00:00.000Z",
      costUsd: 0,
      calls: [],
    }),
  );
  const out = join(root, "fixed");
  const base = [
    "fix-frame",
    ...["--strip", join(root, "walk-right.png"), "--family", "walk-right"],
    ...["--profile", join(root, "profile.json"), "--frame", "3", "--from", "2", "--out", out],
  ];
  const dry = await cli([...base, "--dry-run", "--json"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(doc(dry).plan.calls, 1);
  assert.equal((await cli([...base, "--dry-run", "--cap", "0.01", "--json"])).code, 3);
  assert.equal((await cli([...base, "--json"])).code, 4, "no key and no script: provider error");
  const bad = await cli([...base, "--key-pose", join(root, "walk-right.png"), "--json"]);
  assert.equal(bad.code, 2);

  const r = await cli([...base, "--provider-script", SCRIPT, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const d = doc(r);
  assert.equal(d.fix.frame, 3);
  assert.deepEqual(d.fix.from, { neighbour: 2 });
  const before = splitStrip(strip, { width: 64, height: 64 });
  const after = splitStrip(decodePng(new Uint8Array(await readFile(d.stripPath))), {
    width: 64,
    height: 64,
  });
  before.forEach((f, i) => {
    if (i === 2) assert.notDeepEqual(after[i]?.data, f.data);
    else assert.deepEqual(after[i]?.data, f.data, `frame ${i + 1} unchanged`);
  });
  const provenance = JSON.parse(await readFile(d.provenancePath, "utf8"));
  assert.equal(provenance.generator, "sheet-import");
  assert.equal(provenance.calls.length, 1);
  assert.equal(provenance.calls[0].operation, "edit");
  assert.equal(provenance.fixes[0].frame, 3);
  assert.equal(provenance.costUsd, 0.04);
  // The fixed frame now rests on the ground line.
  const ground = d.qa.reasons.filter((x: { check: string }) => x.check === "ground-contact");
  assert.ok(
    ground.every((x: { passed: boolean }) => x.passed),
    JSON.stringify(ground),
  );
});

test("fix-frame: a provenance it cannot extend exits 2 before any call and writes nothing", async () => {
  const { root } = await setup(undefined, { count: 8, style: "painterly", motion: "walk" });
  // A transform record (what `recipe` writes) for some other image.
  await writeFile(
    join(root, "other.provenance.json"),
    JSON.stringify({ generator: "transform", sources: [], steps: [], outputs: [] }),
  );
  const out = join(root, "fixed");
  const r = await cli([
    "fix-frame",
    ...["--strip", join(root, "walk-right.png"), "--family", "walk-right"],
    ...["--profile", join(root, "profile.json"), "--frame", "3", "--from", "2", "--out", out],
    ...["--provenance", join(root, "other.provenance.json")],
    ...["--provider-script", SCRIPT, "--json"],
  ]);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r).error.code, "invalid_input");
  assert.match(doc(r).error.message, /cannot extend the provenance/);
  await assert.rejects(readFile(join(out, "walk-right.png")), "nothing written");
});

test("write-families writes the onion skin and loop preview and reports animation QA", async () => {
  const root = await mkdtemp(join(tmpdir(), "assetgrove-anim-wf-"));
  const target = join(root, "target");
  await mkdir(target);
  await writeFile(join(root, "sheet.png"), syntheticSheet().png);
  await writeFile(
    join(root, "profile.json"),
    JSON.stringify({
      ...syntheticProfile(),
      style: { alpha: { mode: "soft" }, color: { rule: "full" } },
      manifest: {
        ...(syntheticProfile().manifest as Record<string, unknown>),
        style: "{{profile.style?}}",
      },
    }),
  );
  const imported = await cli([
    "import",
    ...["--sheet", join(root, "sheet.png"), "--profile", join(root, "profile.json")],
    ...["--asset", "fern", "--tool", "hand drawn", "--no-propose"],
    ...["--digital-source-type", "digitalCreation", "--imports", join(root, "imports"), "--json"],
  ]);
  assert.equal(imported.code, 0, imported.stderr);
  const importDir = doc(imported).importDir as string;
  const grouping: Grouping = {
    status: "confirmed",
    families: [
      { name: "idle", frames: [1, 2, 3, 4], reason: "standing" },
      { name: "walk-right", frames: [5, 6, 7, 8, 9, 10], reason: "legs swing" },
    ],
    unassigned: [],
  };
  await writeFile(join(root, "confirmed.json"), JSON.stringify(grouping));
  const written = await cli([
    "write-families",
    ...["--import", importDir, "--target", target, "--grouping", join(root, "confirmed.json")],
    "--json",
  ]);
  assert.equal(written.code, 0, written.stderr);
  const families = doc(written).families as Array<{
    name: string;
    animation: {
      template: string;
      passed: boolean;
      reasons: Array<{ check: string; passed: boolean }>;
    };
    onionPath: string;
    loopPreviewPath: string;
  }>;
  assert.deepEqual(
    families.map((f) => [f.name, f.animation.template]),
    [
      ["idle", "idle"],
      ["walk-right", "walk"],
    ],
  );
  for (const f of families) {
    // The synthetic idle and walk strips are clean: every check reports, none fails (the walk
    // template also bounds its cycle, so the walk adds a timing check).
    assert.deepEqual(
      [...new Set(f.animation.reasons.map((r) => r.check))],
      [
        "template",
        ...(f.name === "walk-right" ? ["timing"] : []),
        "beats",
        "ground-contact",
        "anchor-drift",
        "footprint-drift",
        "silhouette",
        "loop-seam",
        "edge-halo",
      ],
      f.name,
    );
    assert.deepEqual(
      f.animation.reasons.filter((r) => !r.passed),
      [],
      f.name,
    );
    assert.equal(f.animation.passed, true, f.name);
    decodePng(new Uint8Array(await readFile(f.onionPath)));
    assert.equal((await readFile(f.loopPreviewPath)).subarray(8, 12).toString(), "WEBP");
  }
  // The import's families can then be checked together, offline.
  const qa = await cli([
    "animation-qa",
    ...["--import", importDir, "--out", join(root, "qa"), "--no-vision", "--json"],
  ]);
  assert.equal(qa.code, 0, qa.stderr);
  assert.deepEqual(
    doc(qa).families.map((f: { family: string }) => f.family),
    ["idle", "walk-right"],
  );
});

test("animation-qa: --spec declares the gait; a four-legged walk passes under it", async () => {
  const root = await mkdtemp(join(tmpdir(), "assetgrove-anim-gait-"));
  const walk = quadrupedWalk(8);
  await writeFile(join(root, "walk-right.png"), encodePng(joinStrip(walk.frames)));
  await writeFile(
    join(root, "profile.json"),
    JSON.stringify({
      ...syntheticProfile(),
      frames: { ...walk.frame, durationMs: 100 },
      animation: { thresholds: { anchorDriftPx: 2 } },
    }),
  );
  await writeFile(
    join(root, "spec.json"),
    JSON.stringify({ kind: "sprite-strip", assetId: "testcoon", gait: "quadruped" }),
  );
  const args = [
    "animation-qa",
    ...["--strip", join(root, "walk-right.png"), "--family", "walk-right"],
    ...["--profile", join(root, "profile.json"), "--out", join(root, "qa")],
    ...["--anchor", "80,70", "--no-vision", "--json"],
  ];
  // No gait declared: the two-legged rule fails the four-legged walk.
  const without = await cli(args);
  assert.equal(without.code, 5, without.stderr);
  const failed = doc(without).families[0].reasons.filter((x: { passed: boolean }) => !x.passed);
  assert.deepEqual(
    [...new Set(failed.map((x: { check: string }) => x.check))],
    ["footprint-drift"],
  );
  const withSpec = await cli([...args, "--spec", join(root, "spec.json")]);
  assert.equal(withSpec.code, 0, withSpec.stdout + withSpec.stderr);
  const family = doc(withSpec).families[0];
  assert.equal(family.gait, "quadruped");
  assert.equal(family.passed, true);
});
