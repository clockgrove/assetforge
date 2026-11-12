import "./fixtures/spend-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodePng } from "../src/image/raster.ts";
import { parseGlb } from "../src/model3d/glb.ts";
import { sha256 } from "../src/request.ts";
import { PALETTE, drawSubject } from "./fixtures/synthetic.ts";
import { quadrupedTemplate, walkGait } from "./fixtures/quadruped.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/model3d-quadruped-script.ts", import.meta.url));
const LOOKDEV_SCRIPT = fileURLToPath(new URL("./fixtures/lookdev-script.ts", import.meta.url));
const VALIDATOR = fileURLToPath(new URL("./fixtures/validator-3d.ts", import.meta.url));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<Result> {
  const env = { ...process.env, ...extraEnv };
  delete env["AI_GATEWAY_API_KEY"];
  delete env["TRIPO_API_KEY"];
  delete env["MESHY_API_KEY"];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
const doc = (r: Result): Doc => JSON.parse(r.stdout);
const checksOf = (c: Doc): Record<string, { passed: boolean; reason: string }> =>
  Object.fromEntries(c["reasons"].map((x: { check: string }) => [x.check, x]));

const GROOM = {
  seasons: ["summer", "winter"],
  traits: { summer: "short, sleek, grey-brown", winter: "long, dense, frosted" },
};

/** A target with a rig template, a groom declaration and a manifest that carries the look-dev fields. */
async function world(options: { groom?: Doc | null; model3d?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "assetforge-lookdev-"));
  await mkdir(join(dir, "refs"));
  const roles = ["turnaround-front", "turnaround-side", "turnaround-back"];
  for (const [i, role] of roles.entries()) {
    await writeFile(join(dir, "refs", `${role}.png`), encodePng(drawSubject(64, i * 4)));
  }
  await mkdir(join(dir, "rig"));
  await writeFile(join(dir, "rig", "quadruped.json"), JSON.stringify(quadrupedTemplate()));
  const files = {
    spec: join(dir, "spec.json"),
    bible: join(dir, "bible.json"),
    profile: join(dir, "profile.json"),
  };
  await writeFile(
    files.spec,
    JSON.stringify({
      kind: "character-3d",
      assetId: "kit",
      subject: "kit",
      gait: "quadruped",
      clips: ["walk"],
      heightM: 0.45,
    }),
  );
  await writeFile(
    files.bible,
    JSON.stringify({
      version: "2026-11-10",
      palette: PALETTE,
      references: roles.map((role) => ({ path: `refs/${role}.png`, role, subject: "kit" })),
      perspective: "refs/turnaround-front.png",
      subjects: { kit: { description: "a small synthetic quadruped" } },
    }),
  );
  const groom = options.groom === undefined ? GROOM : options.groom;
  await writeFile(
    files.profile,
    JSON.stringify({
      name: "synthetic-grove-lookdev",
      license: "MIT",
      frames: { width: 32, height: 32 },
      ...(options.model3d !== false && {
        model3d: {
          format: "glb",
          budgets: { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 },
          units: "m",
          turntable: { sizePx: 64 },
          rig: { template: "rig/quadruped.json", kind: "synthetic-quadruped" },
          gaits: { walk: walkGait() },
          ...(groom && { groom }),
        },
      }),
      layout: {
        media: "characters/{{spec.assetId}}/{{spec.assetId}}.{{output.extension}}",
        manifest: "characters/{{spec.assetId}}/manifest.json",
      },
      manifest: {
        assetId: "{{spec.assetId}}",
        source: { path: "{{output.path}}", mediaType: "{{output.mediaType}}" },
        license: "{{profile.license}}",
        review: { status: "pending" },
        model: {
          triangles: "{{output.triangles}}",
          textureMaxPx: "{{output.textureMaxPx}}",
          materials: "{{output.materials}}",
          bones: "{{output.bones}}",
          lods: "{{output.lods}}",
          clips: "{{output.clips}}",
          bounds: "{{output.bounds}}",
          rig: "{{output.rig}}",
        },
        groom: "{{output.groom}}",
        textures: "{{output.textures}}",
        eyes: "{{output.eyes}}",
        contentHash: "{{output.sha256}}",
      },
      review: { path: "review.status", pending: "pending" },
      validator: { command: [process.execPath, VALIDATOR, "{{manifest}}"] },
    }),
  );
  const runs = join(dir, "runs");
  const target = join(dir, "target");
  await mkdir(target);
  const base = ["--spec", files.spec, "--bible", files.bible, "--profile", files.profile];
  return { dir, files, base, runs, target };
}

/** A rigged one-candidate run made by `rig` (the look-dev input), with its provenance in a file. */
async function riggedModel(w: Awaited<ReturnType<typeof world>>) {
  const staged = await cli([
    "stage",
    ...w.base,
    "--runs",
    w.runs,
    "--candidates",
    "1",
    "--provider-script",
    SCRIPT,
    "--json",
  ]);
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  const c = doc(staged)["candidates"][0];
  const stagedModel = join(w.runs, doc(staged)["runId"], c.file);
  const provenance = join(w.dir, "c1.provenance.json");
  await writeFile(provenance, JSON.stringify(c.provenance));
  const rigged = await cli([
    "rig",
    "--model",
    stagedModel,
    "--provenance",
    provenance,
    "--spec",
    w.files.spec,
    "--profile",
    w.files.profile,
    "--runs",
    join(w.dir, "rigged"),
    "--json",
  ]);
  assert.equal(rigged.code, 0, rigged.stdout + rigged.stderr);
  const run = doc(rigged);
  const model = join(run["runDir"], run["candidates"][0].file);
  const riggedProvenance = join(w.dir, "rigged.provenance.json");
  await writeFile(riggedProvenance, JSON.stringify(run["candidates"][0].provenance));
  return { model, provenance: riggedProvenance, source: run["candidates"][0].provenance };
}

const lookDevArgs = (
  w: Awaited<ReturnType<typeof world>>,
  m: { model: string; provenance: string },
) => [
  "look-dev",
  "--model",
  m.model,
  "--provenance",
  m.provenance,
  ...w.base,
  "--runs",
  w.runs,
  "--provider-script",
  LOOKDEV_SCRIPT,
  "--json",
];

test("look-dev forecasts its calls, refuses over the cap and needs a model3d profile", async () => {
  const w = await world();
  const none = { model: "x.glb", provenance: "x.json" };
  const r = await cli([...lookDevArgs(w, none), "--dry-run"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const plan = doc(r)["plan"];
  const count = (op: string) =>
    plan.calls.filter((c: { operation: string }) => c.operation === op).length;
  assert.equal(count("lookdev"), 7);
  assert.equal(count("lookdev-locate"), 1);
  assert.equal(count("lookdev-groom"), 2);
  assert.equal(count("identity"), 1);
  assert.deepEqual(plan.seasons, ["summer", "winter"]);
  assert.equal(plan.capUsd, 3);

  const capped = await cli([...lookDevArgs(w, none), "--dry-run", "--cap", "0.5"]);
  assert.equal(capped.code, 3, capped.stdout + capped.stderr);
  assert.equal(doc(capped)["error"].code, "cap_refused");

  const bare = await world({ model3d: false });
  const refused = await cli([...lookDevArgs(bare, none), "--dry-run"]);
  assert.equal(refused.code, 2, refused.stdout + refused.stderr);
});

test("look-dev gives a rigged model its look, maps and eyes; pick hands it all off", async () => {
  const w = await world();
  const input = await riggedModel(w);
  const inputBytes = new Uint8Array(await readFile(input.model));
  const r = await cli(lookDevArgs(w, input));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const run = doc(r);
  assert.equal(run["candidates"].length, 1, JSON.stringify(run["rejections"]));
  const c = run["candidates"][0];
  const checks = checksOf(c);
  for (const check of [
    "groom-summer-masks",
    "groom-winter-masks",
    "groom-summer-render",
    "groom-winter-render",
    "lookdev-albedo-coverage",
    "lookdev-seams",
    "eyes-catch-light",
    "gltf-validator",
  ]) {
    assert.equal(checks[check]?.passed, true, `${check}: ${checks[check]?.reason}`);
  }

  const fields = c.sidecars.map((s: { field: string }) => s.field);
  for (const season of ["summer", "winter"]) {
    for (const map of ["length", "direction", "density"]) {
      assert.ok(fields.includes(`groom.${season}.${map}`), `groom.${season}.${map}`);
    }
  }
  assert.ok(fields.includes("textures.tint.winter"));
  assert.ok(!fields.includes("textures.tint.summer"));
  assert.ok(fields.includes("textures.baseColor"));
  const eyes = c.sidecars.find((s: { field: string }) => s.field === "eyes");
  assert.equal(eyes.extra.material, "eyes");

  const ops = (calls: Array<{ operation: string }>) => calls.map((x) => x.operation);
  const added = ops(c.provenance.calls).slice(input.source.calls.length);
  assert.equal(c.provenance.calls.length, input.source.calls.length + 11);
  assert.deepEqual(
    added.toSorted(),
    [
      ...Array(7).fill("lookdev"),
      "lookdev-locate",
      "lookdev-groom",
      "lookdev-groom",
      "identity",
    ].toSorted(),
  );
  assert.equal(c.provenance.parameters.lookdev.sourceModelSha256, sha256(inputBytes));
  assert.ok(c.provenance.outputGrant);
  assert.deepEqual(c.provenance.parameters.lookdev.seasons, ["summer", "winter"]);

  const runDir = run["runDir"];
  const glb = parseGlb(new Uint8Array(await readFile(join(runDir, c.file))));
  const external = glb.json.images!.filter((i) => i.uri !== undefined);
  assert.equal(external.length, 8, "six groom maps, the winter tint and the eye mask");
  for (const image of external) assert.equal(image.bufferView, undefined);
  assert.ok(external.some((i) => i.uri === "kit.groom.summer.length.png"));
  assert.ok(glb.json.materials!.some((m) => m.name === "eyes"));
  assert.ok(
    glb.json.images!.some((i) => i.bufferView !== undefined),
    "base colour is embedded",
  );

  const renders = await readdir(join(runDir, "c1-character-3d"));
  for (const view of ["front", "three-quarter", "side", "back", "close-up"]) {
    for (const name of [
      `compare-${view}.png`,
      `before-${view}.png`,
      `after-summer-${view}.png`,
      `after-winter-${view}.png`,
    ]) {
      assert.ok(renders.includes(name), name);
    }
  }
  assert.equal(run["spentUsd"] > 0, true);

  // Scripted spend is not counted against the ledger.
  const status = await cli([...lookDevArgs(w, input), "--dry-run"]);
  assert.equal(doc(status)["spend"].counted, false);

  const picked = await cli([
    "pick",
    "--run",
    runDir,
    "--candidate",
    "c1",
    "--target",
    w.target,
    "--json",
  ]);
  assert.equal(picked.code, 0, picked.stdout + picked.stderr);
  assert.equal(doc(picked)["validator"].accepted, true, doc(picked)["validator"].output);
  const written = await readdir(join(w.target, "characters/kit"));
  for (const s of c.sidecars) assert.ok(written.includes(s.name), s.name);
  assert.ok(written.includes("kit.glb"));
  const manifest = JSON.parse(
    await readFile(join(w.target, "characters/kit/manifest.json"), "utf8"),
  );
  assert.equal(manifest.review.status, "pending");
  for (const season of ["summer", "winter"]) {
    for (const map of ["length", "direction", "density"]) {
      const entry = manifest.groom[season][map];
      assert.equal(entry.path, `characters/kit/kit.groom.${season}.${map}.png`);
      const bytes = await readFile(join(w.target, entry.path));
      assert.equal(entry.sha256, sha256(bytes));
    }
  }
  assert.ok(manifest.textures.tint.winter.sha256);
  assert.equal(manifest.textures.tint.summer, undefined);
  assert.ok(manifest.textures.baseColor.sha256);
  assert.ok(manifest.eyes.sha256);
});

test("without declared seasons the maps are keyed by name and there is no tint", async () => {
  const w = await world({ groom: {} });
  const input = await riggedModel(w);
  const r = await cli(lookDevArgs(w, input));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const c = doc(r)["candidates"][0];
  const fields = c.sidecars.map((s: { field: string }) => s.field);
  for (const map of ["length", "direction", "density"]) {
    assert.ok(fields.includes(`groom.${map}`), map);
  }
  assert.ok(!fields.some((f: string) => f.startsWith("textures.tint")));
  const checks = checksOf(c);
  assert.equal(checks["groom-masks"]?.passed, true, checks["groom-masks"]?.reason);
  assert.equal(checks["groom-render"]?.passed, true, checks["groom-render"]?.reason);
  assert.equal(checks["groom-summer-masks"], undefined);
  assert.ok(existsSync(join(doc(r)["runDir"], "c1.glb")));
});
