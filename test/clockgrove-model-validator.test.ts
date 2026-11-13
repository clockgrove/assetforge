/**
 * The 3D hand-off passes Clockgrove's real model validator (assetforge#137). The validator is
 * vendored, unchanged but for import paths, in test/fixtures/clockgrove (see its README.md for the
 * source commit). The target profile declares Clockgrove's shape: the clip fields its contract
 * takes, and side images embedded in the `.glb`.
 */
import "./fixtures/spend-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodePng } from "../src/image/raster.ts";
import { pick } from "../src/handoff.ts";
import { RUN_FILE, writeRun } from "../src/loop.ts";
import type { RunRecord, StagedCandidate } from "../src/loop.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { GLB_MEDIA_TYPE, parseGlb, writeGlb } from "../src/model3d/glb.ts";
import { handoffSettings } from "../src/model3d/handoff.ts";
import { measure } from "../src/model3d/scene.ts";
import { sha256 } from "../src/request.ts";
import type { Provenance, TargetProfile } from "../src/types.ts";
import { syntheticCharacter } from "./fixtures/glb.ts";
import { PALETTE, drawSubject } from "./fixtures/synthetic.ts";
import { quadrupedTemplate, walkGait } from "./fixtures/quadruped.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/model3d-quadruped-script.ts", import.meta.url));
const LOOKDEV_SCRIPT = fileURLToPath(new URL("./fixtures/lookdev-script.ts", import.meta.url));
const CLOCKGROVE = fileURLToPath(new URL("./fixtures/clockgrove/check-model.ts", import.meta.url));

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

const BUDGETS = { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 };

/** Clockgrove's shape: its clip contract `{ name, durationMs, loop, generated? }`, one `.glb`. */
const CLOCKGROVE_HANDOFF = {
  clipFields: { name: "name", durationMs: "durationMs", loop: "loop", generated: "generated" },
  sideImages: "embedded",
};

/** Clockgrove's model manifest (packages/contracts) and its validator, as a profile declares them. */
const CLOCKGROVE_TARGET = {
  layout: {
    media: "assets/source/{{spec.assetId}}/model.glb",
    manifest: "assets/manifests/{{spec.assetId}}/model.json",
  },
  manifest: {
    kind: "model",
    assetManifestVersion: 2,
    assetId: "{{spec.assetId}}",
    source: {
      kind: "generated",
      path: "{{output.path}}",
      creator: "{{profile.creator}}",
      tool: "assetforge",
    },
    license: "{{profile.license}}",
    provenance: {
      prompt: "{{provenance.prompt}}",
      references: "{{provenance.referenceHashes}}",
      outputGrant: "{{provenance.outputGrant?}}",
    },
    review: { status: "pending", reviewer: null, reviewedAt: null, notes: "" },
    semantic: "{{spec.fields.semantic}}",
    accessibilityLabel: "{{spec.fields.accessibilityLabel}}",
    output: {
      path: "{{output.path}}",
      mediaType: "{{output.mediaType}}",
      extension: "{{output.extension}}",
      sha256: "{{output.sha256}}",
      triangles: "{{output.triangles}}",
      textureMaxPx: "{{output.textureMaxPx}}",
      materials: "{{output.materials}}",
      bones: "{{output.bones}}",
      lods: "{{output.lods}}",
      clips: "{{output.clips}}",
      bounds: "{{output.bounds}}",
      rig: "{{output.rig?}}",
    },
  },
  review: { path: "review.status", pending: "pending" },
  validator: {
    command: [process.execPath, CLOCKGROVE, "{{manifest}}", "model-target.json"],
  },
};

/** A target whose manifest template is Clockgrove's model manifest (packages/contracts). */
async function world() {
  const dir = await mkdtemp(join(tmpdir(), "assetforge-clockgrove-"));
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
      fields: {
        semantic: { role: "actor", entity: "grove.kit", archetype: null },
        accessibilityLabel: "A small synthetic quadruped",
      },
    }),
  );
  await writeFile(
    files.bible,
    JSON.stringify({
      version: "2026-11-13",
      palette: PALETTE,
      references: roles.map((role) => ({ path: `refs/${role}.png`, role, subject: "kit" })),
      perspective: "refs/turnaround-front.png",
      subjects: { kit: { description: "a small synthetic quadruped" } },
    }),
  );
  await writeFile(
    files.profile,
    JSON.stringify({
      name: "synthetic-clockgrove-world",
      license: "MIT",
      values: { creator: "Synthetic" },
      frames: { width: 32, height: 32 },
      model3d: {
        format: "glb",
        budgets: BUDGETS,
        units: "m",
        turntable: { sizePx: 64 },
        rig: { template: "rig/quadruped.json", kind: "synthetic-quadruped" },
        gaits: { walk: walkGait() },
        groom: { sizePx: 256, seasons: ["summer", "winter"] },
        handoff: CLOCKGROVE_HANDOFF,
      },
      ...CLOCKGROVE_TARGET,
    }),
  );
  const target = async (name: string) => {
    const path = join(dir, name);
    await mkdir(path);
    await writeFile(
      join(path, "model-target.json"),
      JSON.stringify({ version: 1, limits: BUDGETS }),
    );
    return path;
  };
  const base = ["--spec", files.spec, "--bible", files.bible, "--profile", files.profile];
  return { dir, files, base, runs: join(dir, "runs"), target };
}

const pickInto = (runDir: string, target: string) =>
  cli(["pick", "--run", runDir, "--candidate", "c1", "--target", target, "--json"]);

test("rig and look-dev results pass Clockgrove's model validator under its declared shape", async () => {
  const w = await world();

  // A scripted model, re-rigged on the shared template with a generated walk.
  const staged = await cli(
    [
      "stage",
      ...w.base,
      "--runs",
      w.runs,
      "--candidates",
      "1",
      "--provider-script",
      SCRIPT,
      "--json",
    ],
    { SCRIPT_QUADRUPED_ATLAS: "1" },
  );
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  const source = doc(staged)["candidates"][0];
  const sourceProvenance = join(w.dir, "source.provenance.json");
  await writeFile(sourceProvenance, JSON.stringify(source.provenance));
  const rigged = await cli([
    "rig",
    "--model",
    join(w.runs, doc(staged)["runId"], source.file),
    "--provenance",
    sourceProvenance,
    "--spec",
    w.files.spec,
    "--profile",
    w.files.profile,
    "--runs",
    join(w.dir, "rigged"),
    "--json",
  ]);
  assert.equal(rigged.code, 0, rigged.stdout + rigged.stderr);
  const rigRun = doc(rigged);
  const rigCandidate = rigRun["candidates"][0];
  assert.ok(
    rigCandidate.fields.clips.every((c: Doc) => typeof c["speedMps"] === "number"),
    "the rig's clips carry speedMps; the declared shape leaves it out",
  );

  const rigTarget = await w.target("rig-target");
  const rigPick = await pickInto(rigRun["runDir"], rigTarget);
  assert.equal(rigPick.code, 0, rigPick.stdout + rigPick.stderr);
  assert.equal(doc(rigPick)["validator"].accepted, true, doc(rigPick)["validator"].output);
  const rigManifest = JSON.parse(
    await readFile(join(rigTarget, "assets/manifests/kit/model.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(rigManifest.output.clips[0]), [
    "name",
    "durationMs",
    "loop",
    "generated",
  ]);

  // Look-dev on the rigged model: groom maps, tints and the eye mask go inside the .glb.
  const riggedProvenance = join(w.dir, "rigged.provenance.json");
  await writeFile(riggedProvenance, JSON.stringify(rigCandidate.provenance));
  const looked = await cli([
    "look-dev",
    "--model",
    join(rigRun["runDir"], rigCandidate.file),
    "--provenance",
    riggedProvenance,
    ...w.base,
    "--runs",
    w.runs,
    "--provider-script",
    LOOKDEV_SCRIPT,
    "--json",
  ]);
  assert.equal(looked.code, 0, looked.stdout + looked.stderr);
  const lookRun = doc(looked);
  assert.equal(lookRun["candidates"].length, 1, JSON.stringify(lookRun["rejections"]));
  assert.ok(lookRun["candidates"][0].sidecars.length > 0, "look-dev staged its side images");

  const lookTarget = await w.target("lookdev-target");
  const lookPick = await pickInto(lookRun["runDir"], lookTarget);
  assert.equal(lookPick.code, 0, lookPick.stdout + lookPick.stderr);
  assert.equal(doc(lookPick)["validator"].accepted, true, doc(lookPick)["validator"].output);
  assert.deepEqual(await readdir(join(lookTarget, "assets/source/kit")), [
    "model.glb",
    "model.glb.provenance.json",
  ]);
  const glb = parseGlb(await readFile(join(lookTarget, "assets/source/kit/model.glb")));
  assert.ok(glb.json.images!.every((i) => i.uri === undefined && i.bufferView !== undefined));
  const lookdevImages = (glb.json.asset["extras"] as Doc)["lookdev"].images as Doc;
  assert.equal(lookdevImages["groom.winter.length"].uri, undefined);
  assert.ok(Number.isInteger(lookdevImages["groom.winter.length"].image));

  // The default hand-off is unchanged, and Clockgrove's validator refuses it: the control.
  const runFile = join(lookRun["runDir"], RUN_FILE);
  const record = JSON.parse(await readFile(runFile, "utf8"));
  delete record.profile.model3d.handoff;
  await writeFile(runFile, JSON.stringify(record));
  const defaultTarget = await w.target("default-target");
  const defaultPick = await pickInto(lookRun["runDir"], defaultTarget);
  assert.equal(doc(defaultPick)["validator"].accepted, false);
  assert.match(doc(defaultPick)["validator"].output, /speedMps: unknown field/);
  const written = await readdir(join(defaultTarget, "assets/source/kit"));
  assert.ok(written.includes("kit.groom.winter.length.png"), written.join(", "));
});

test("a malformed hand-off declaration is refused", () => {
  const profile = (handoff: unknown) =>
    ({ name: "t", model3d: { handoff } }) as unknown as TargetProfile;
  assert.deepEqual(handoffSettings(profile(undefined)), { sideImages: "beside" });
  assert.deepEqual(handoffSettings(profile(CLOCKGROVE_HANDOFF)), CLOCKGROVE_HANDOFF);
  for (const bad of [
    { sideImages: "inline" },
    { clipFields: {} },
    { clipFields: { name: 3 } },
    { clipFields: { "a.b": "name" } },
    { clipField: { name: "name" } },
    [],
  ]) {
    assert.throws(() => handoffSettings(profile(bad)), /model3d\.handoff/, JSON.stringify(bad));
  }
});

test("pick measures the bounds on the handed-off .glb, so rounding cannot push them past Clockgrove's 1 µm", async () => {
  // A box whose top sits one float32 step under 2.5 m, skinned to a joint 0.9 µm above its bind
  // pose. Assetforge measures the skinned rest pose; Clockgrove measures the mesh through its node.
  // The two differ by 0.9 µm, inside Clockgrove's 1 µm. Rounded to the micrometre, as staging
  // writes them, the top's 2.50000066 m becomes 2.500001 m: 1.24 µm off Clockgrove's measure.
  const top = Math.fround(2.5 - 2 ** -22);
  const glb = parseGlb(syntheticCharacter({ joints: 1, heightUnits: top - 0.5 }));
  glb.json.nodes![1]!.translation = [0.3, 0.5 + 9e-7, 0];
  const bytes = writeGlb(glb);
  const measures = measure(parseGlb(bytes));
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  const staged = { min: measures.bounds!.min.map(round), max: measures.bounds!.max.map(round) };
  assert.ok(Math.abs(staged.max[1]! - top) > 1e-6, `${staged.max[1]} vs ${top}`);
  assert.ok(Math.abs(measures.bounds!.max[1] - top) < 1e-6, `${measures.bounds!.max[1]}`);

  const dir = await mkdtemp(join(tmpdir(), "assetforge-clockgrove-bounds-"));
  const runDir = join(dir, "run");
  await mkdir(runDir);
  await writeFile(join(runDir, "box.glb"), bytes);
  const provenance: Provenance = {
    digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
    generator: "model3d",
    route: "scripted",
    models: ["scripted"],
    prompt: "a box",
    parameters: {},
    requestIds: [],
    referenceHashes: [],
    bibleVersion: "v1",
    license: "MIT",
    providerTerms: [],
    startedAt: "",
    finishedAt: "",
    costUsd: 0,
    calls: [],
  };
  const candidate: StagedCandidate = {
    id: "c1",
    file: "box.glb",
    mediaType: GLB_MEDIA_TYPE,
    extension: "glb",
    sha256: sha256(bytes),
    reasons: [],
    fields: {
      triangles: measures.triangles,
      textureMaxPx: measures.textureMaxPx,
      materials: measures.materials,
      bones: measures.bones,
      lods: measures.lods,
      clips: [],
      bounds: staged,
    },
    provenance,
  };
  const record: RunRecord = {
    runId: "r1",
    createdAt: "2026-11-13T00:00:00.000Z",
    spec: {
      kind: "character-3d",
      assetId: "box",
      fields: {
        semantic: { role: "object", entity: null, archetype: null },
        accessibilityLabel: "A synthetic box",
      },
    } as RunRecord["spec"],
    specDir: dir,
    profile: {
      name: "synthetic-clockgrove-world",
      license: "MIT",
      values: { creator: "Synthetic" },
      frames: { width: 32, height: 32 },
      model3d: { format: "glb", budgets: BUDGETS, units: "m", handoff: CLOCKGROVE_HANDOFF },
      ...CLOCKGROVE_TARGET,
    } as unknown as TargetProfile,
    bibleVersion: "v1",
    capUsd: 1,
    estimateUsd: 0,
    spentUsd: 0,
    requested: 1,
    candidates: [candidate],
    filtered: 0,
    errors: [],
  };
  await writeRun(runDir, record);
  const target = join(dir, "target");
  await mkdir(target);
  await writeFile(
    join(target, "model-target.json"),
    JSON.stringify({ version: 1, limits: BUDGETS }),
  );

  const picked = await pick({ runDir, candidateId: "c1", targetDir: target });
  assert.equal(picked.validator?.accepted, true, picked.validator?.output);
  const manifest = JSON.parse(await readFile(picked.manifestPath, "utf8"));
  assert.deepEqual(manifest.output.bounds, measures.bounds);
});
