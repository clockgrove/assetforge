import "./fixtures/spend-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodePng } from "../src/image/raster.ts";
import { parseGlb } from "../src/model3d/glb.ts";
import { clips as clipsOf } from "../src/model3d/scene.ts";
import { sha256 } from "../src/request.ts";
import { PALETTE, drawSubject } from "./fixtures/synthetic.ts";
import { quadrupedTemplate, syntheticQuadruped, walkGait } from "./fixtures/quadruped.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/model3d-quadruped-script.ts", import.meta.url));
const VALIDATOR = fileURLToPath(new URL("./fixtures/validator-3d.ts", import.meta.url));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Result> {
  const env = { ...process.env };
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
const doc = (r: Result): Record<string, any> => JSON.parse(r.stdout);

/** A target that declares the shared rig: the template file sits beside the profile. */
async function world(options: { template?: string; reference?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "assetforge-rig-"));
  await mkdir(join(dir, "refs"));
  const roles = ["turnaround-front", "turnaround-side", "turnaround-back"];
  for (const [i, role] of roles.entries()) {
    await writeFile(join(dir, "refs", `${role}.png`), encodePng(drawSubject(64, i * 4)));
  }
  await mkdir(join(dir, "rig"));
  await writeFile(join(dir, "rig", "quadruped.json"), JSON.stringify(quadrupedTemplate()));
  if (options.reference) {
    await mkdir(join(dir, "gait-reference"));
    for (const i of [1, 2]) {
      await writeFile(
        join(dir, "gait-reference", `frame-${i}.png`),
        encodePng(drawSubject(48, i * 3)),
      );
    }
  }
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
      clips: ["walk", "sniff"],
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
  await writeFile(
    files.profile,
    JSON.stringify({
      name: "synthetic-grove-rig",
      license: "MIT",
      frames: { width: 32, height: 32 },
      model3d: {
        format: "glb",
        budgets: { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 },
        units: "m",
        turntable: { sizePx: 64 },
        rig: { template: options.template ?? "rig/quadruped.json", kind: "synthetic-quadruped" },
        gaits: {
          walk: { ...walkGait(), ...(options.reference && { reference: "gait-reference" }) },
        },
      },
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

test("a target with a rig template forecasts no provider rig or clip call", async () => {
  const w = await world();
  const r = await cli(["stage", ...w.base, "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    doc(r)["plan"].perCandidate.map((c: { operation: string }) => c.operation),
    ["model3d", "identity"],
  );
});

test("stage fits the shared rig, generates the walk, checks every clip, and pick hands it off", async () => {
  const w = await world();
  const r = await cli([
    "stage",
    ...w.base,
    "--runs",
    w.runs,
    "--candidates",
    "2",
    "--provider-script",
    SCRIPT,
    "--json",
  ]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const run = doc(r);
  assert.equal(run["candidates"].length, 2, JSON.stringify(run["rejections"]));
  for (const c of run["candidates"]) {
    const checks = Object.fromEntries(
      c.reasons.map((x: { check: string; passed: boolean; reason: string }) => [x.check, x]),
    );
    for (const check of [
      "gltf-validator",
      "skeleton",
      "clip-walk",
      "loop-walk",
      "contact-walk",
      "joint-limits-walk",
      "skinning-walk",
      "turntable",
    ]) {
      assert.equal(checks[check]?.passed, true, `${c.id} ${check}: ${checks[check]?.reason}`);
    }
    assert.match(checks["clip-sniff"].reason, /missing, not faked/);
    assert.deepEqual(
      c.provenance.calls.map((x: { operation: string }) => x.operation),
      ["model3d", "identity"],
    );
    assert.equal(c.fields.clips.length, 1);
    assert.equal(c.fields.clips[0].name, "walk");
    assert.equal(c.fields.clips[0].generated, true);
    assert.equal(c.fields.clips[0].loop, true);
    assert.ok(c.fields.clips[0].speedMps > 0);
    assert.equal(c.fields.rig.template, "rig/quadruped.json");
    const templateHash = sha256(await readFile(join(w.dir, "rig", "quadruped.json")));
    assert.equal(c.fields.rig.sha256, templateHash);
    const rig = c.provenance.parameters.rig;
    assert.equal(rig.templateSha256, templateHash);
    assert.match(rig.gaits.walk.sha256, /^[0-9a-f]{64}$/);
    assert.match(rig.sourceModelSha256, /^[0-9a-f]{64}$/);
    assert.match(c.provenance.parameters.targetProfileSha256, /^[0-9a-f]{64}$/);
  }
  // Characters of one kind share joint names, so clips are shared between them.
  const [a, b] = await Promise.all(
    run["candidates"].map(async (c: { file: string }) =>
      parseGlb(new Uint8Array(await readFile(join(w.runs, run["runId"], c.file)))),
    ),
  );
  const names = (g: ReturnType<typeof parseGlb>) =>
    g.json.skins![0]!.joints.map((j) => g.json.nodes![j]!.name);
  assert.deepEqual(names(a!), names(b!));
  assert.deepEqual(
    names(a!),
    quadrupedTemplate().joints.map((j) => j.name),
  );
  assert.deepEqual(
    clipsOf(a!).map((c) => c.name),
    ["walk"],
  );
  // A target reads the rig identity and each clip's loop and generated flags from the glb's
  // extras, and compares them with the manifest's fields.
  const c1 = run["candidates"][0];
  assert.deepEqual(a!.json.asset["extras"], { rig: c1.fields.rig });
  assert.deepEqual(a!.json.animations?.[0]?.["extras"], { loop: true, generated: true });
  const renders = await readdir(join(w.runs, run["runId"], "c1-character-3d"));
  for (const name of ["front.png", "side.png", "clip-walk-0.png", "walk-side.png"]) {
    assert.ok(renders.includes(name), name);
  }

  const picked = await cli([
    "pick",
    "--run",
    join(w.runs, run["runId"]),
    "--candidate",
    "c2",
    "--target",
    w.target,
    "--json",
  ]);
  assert.equal(picked.code, 0, picked.stdout + picked.stderr);
  assert.equal(doc(picked)["validator"].accepted, true, doc(picked)["validator"].output);
  const manifest = JSON.parse(
    await readFile(join(w.target, "characters/kit/manifest.json"), "utf8"),
  );
  assert.equal(manifest.model.clips[0].generated, true);
  assert.equal(manifest.model.rig.template, "rig/quadruped.json");
  const provenance = JSON.parse(
    await readFile(join(w.target, "characters/kit/kit.glb.provenance.json"), "utf8"),
  );
  assert.equal(provenance.parameters.rig.kind, "synthetic-quadruped");
});

test("an unreadable rig template is refused before any provider call", async () => {
  const w = await world({ template: "rig/missing.json" });
  const r = await cli([
    "stage",
    ...w.base,
    "--runs",
    w.runs,
    "--provider-script",
    SCRIPT,
    "--json",
  ]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(doc(r)["error"].message, /rig template rig\/missing\.json cannot be read/);
  const [runId] = await readdir(w.runs);
  const record = JSON.parse(await readFile(join(w.runs, runId!, "run.json"), "utf8"));
  assert.equal(record.spentUsd, 0);
});

test("rig re-rigs a picked model with raised heels; the walk plants them and pick hands it off", async () => {
  const w = await world({ reference: true });
  const model = join(w.dir, "c3.glb");
  const bytes = syntheticQuadruped({ raisedHeels: true, providerRig: true });
  await writeFile(model, bytes);
  const provenancePath = join(w.dir, "c3.provenance.json");
  await writeFile(
    provenancePath,
    JSON.stringify({
      generator: "character-3d",
      route: "scripted:model3d:synthetic",
      models: ["synthetic"],
      prompt: "a synthetic quadruped",
      parameters: { gait: "quadruped", rigType: "quadruped", heightM: 0.45 },
      requestIds: ["req-1"],
      referenceHashes: [],
      bibleVersion: "2026-11-10",
      license: "MIT",
      providerTerms: ["synthetic"],
      startedAt: "2026-11-10T00:00:00.000Z",
      finishedAt: "2026-11-10T00:00:01.000Z",
      costUsd: 0.65,
      calls: [],
    }),
  );
  const r = await cli([
    "rig",
    "--model",
    model,
    "--provenance",
    provenancePath,
    "--spec",
    w.files.spec,
    "--profile",
    w.files.profile,
    "--runs",
    w.runs,
    "--json",
  ]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const run = doc(r);
  assert.equal(run["spentUsd"], 0);
  const c1 = run["candidates"][0];
  const checks = Object.fromEntries(
    c1.reasons.map((x: { check: string; passed: boolean; reason: string }) => [x.check, x]),
  );
  // The model's hind heels rest raised; measured on the deformed sole, they are down in stance.
  const heel = /hind_l sole .*?heel (-?[\d.]+) m above toe \((-?[\d.]+) m at rest\)/.exec(
    checks["contact-walk"].reason,
  );
  assert.ok(heel, checks["contact-walk"].reason);
  assert.ok(Number(heel[2]) > 0.01, `rest heel ${heel[2]} m`);
  assert.ok(Math.abs(Number(heel[1])) < 0.005, `stance heel ${heel[1]} m`);
  assert.equal(checks["contact-walk"].passed, true, checks["contact-walk"].reason);
  assert.equal(checks["joint-limits-walk"].passed, true, checks["joint-limits-walk"].reason);
  assert.equal(c1.provenance.parameters.rig.sourceModelSha256, sha256(bytes));
  assert.equal(c1.provenance.parameters.rerig.sourceModel, basename(model));
  assert.equal(c1.provenance.parameters.rigType, undefined, "the provider rig is gone");
  const step = c1.provenance.steps.find((s: { op: string }) => s.op === "rig-generated-gait");
  assert.equal(step.inputs[0], sha256(bytes));
  assert.equal(step.params.templateSha256, c1.fields.rig.sha256);
  const renders = await readdir(join(run["runDir"], "c1-character-3d"));
  assert.ok(renders.includes("walk-vs-reference.png"), renders.join(", "));

  const picked = await cli([
    "pick",
    "--run",
    run["runDir"],
    "--candidate",
    "c1",
    "--target",
    w.target,
    "--json",
  ]);
  assert.equal(picked.code, 0, picked.stdout + picked.stderr);
  assert.equal(existsSync(join(w.target, "characters/kit/kit.glb")), true);
});

test("rig refuses a profile without a rig template", async () => {
  const w = await world();
  const profile = JSON.parse(await readFile(w.files.profile, "utf8"));
  delete profile.model3d.rig;
  await writeFile(w.files.profile, JSON.stringify(profile));
  const model = join(w.dir, "m.glb");
  await writeFile(model, syntheticQuadruped());
  const provenancePath = join(w.dir, "p.json");
  await writeFile(provenancePath, JSON.stringify({ calls: [], parameters: {} }));
  const r = await cli([
    "rig",
    "--model",
    model,
    "--provenance",
    provenancePath,
    "--spec",
    w.files.spec,
    "--profile",
    w.files.profile,
    "--runs",
    w.runs,
    "--json",
  ]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(doc(r)["error"].message, /declares no rig template/);
});
