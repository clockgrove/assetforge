import "./fixtures/spend-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { InputError } from "../src/errors.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import { parseGlb, writeGlb } from "../src/model3d/glb.ts";
import { riggedCandidate } from "../src/model3d/rig/candidate.ts";
import { timeline } from "../src/model3d/rig/motion.ts";
import type { RiggedCandidate } from "../src/model3d/rig/candidate.ts";
import { model3dSettings } from "../src/model3d/profile.ts";
import { qaPassed } from "../src/model3d/qa.ts";
import { DEFAULT_RIG_QA, loadRig, parseMotion } from "../src/model3d/rig/template.ts";
import type {
  GaitProfile,
  LoadedRig,
  MotionProfile,
  SkeletonTemplate,
} from "../src/model3d/rig/template.ts";
import { sha256 } from "../src/request.ts";
import type { TargetProfile } from "../src/types.ts";
import { bipedTemplate, syntheticBiped } from "./fixtures/biped.ts";
import {
  quadrupedIdle,
  quadrupedPaw,
  quadrupedTemplate,
  syntheticQuadruped,
  walkGait,
} from "./fixtures/quadruped.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const VALIDATOR = fileURLToPath(new URL("./fixtures/validator-3d.ts", import.meta.url));

const MODEL3D = {
  format: "glb",
  budgets: { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 },
  units: "m",
  turntable: { sizePx: 32 },
};

const profileOf = (extra: Record<string, unknown>): TargetProfile =>
  ({
    name: "motions",
    license: "MIT",
    model3d: { ...MODEL3D, ...extra },
  }) as unknown as TargetProfile;

/** A biped's idle: breathing (back, head, a little height) and one arm swaying. */
const bipedIdle = (): MotionProfile => ({
  loop: true,
  durationS: 2,
  keys: [
    { at: 0, pose: { joints: { upper_arm_l: { z: 0 } } } },
    {
      at: 0.5,
      pose: {
        backArchDeg: 4,
        headYawDeg: 6,
        body: { raiseBodyLengths: -0.01 },
        joints: { upper_arm_l: { z: 8 } },
      },
    },
  ],
});

/** A biped's wave: the right hand up and out, one foot lifted briefly and put down. */
const bipedWave = (): MotionProfile => ({
  loop: false,
  idle: "idle",
  entryS: 0.3,
  exitS: 0.3,
  durationS: 1.2,
  keys: [
    { at: 0, pose: {} },
    {
      at: 0.3,
      pose: {
        headYawDeg: -8,
        joints: { upper_arm_r: { z: -80 }, forearm_r: { x: -30 } },
        feet: { foot_l: { liftBodyLengths: 0.06 } },
      },
    },
    {
      at: 0.6,
      pose: {
        headYawDeg: -8,
        joints: { upper_arm_r: { z: -80 }, forearm_r: { x: 20 } },
        feet: { foot_l: { liftBodyLengths: 0.06 } },
      },
    },
    { at: 1, pose: {} },
  ],
});

function loaded(
  template: SkeletonTemplate,
  motions: Record<string, MotionProfile>,
  gaits: Record<string, GaitProfile> = {},
): LoadedRig {
  const hashes = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.keys(o).map((k) => [k, "1".repeat(64)]));
  return {
    templatePath: "template.json",
    kind: template.kind ?? "synthetic",
    template,
    templateSha256: "0".repeat(64),
    gaits,
    gaitSha256: hashes(gaits),
    motions,
    motionSha256: hashes(motions),
    qa: DEFAULT_RIG_QA,
    baseDir: ".",
  };
}

type Checks = Record<string, { passed: boolean; reason: string; shadow?: boolean }>;
const checksOf = (c: RiggedCandidate): Checks =>
  Object.fromEntries(c.reasons.map((r) => [r.check, r]));

function candidate(
  bytes: Uint8Array,
  gait: "biped" | "quadruped",
  rig: LoadedRig,
  clips: string[],
): Promise<RiggedCandidate> {
  return riggedCandidate({
    source: parseGlb(bytes),
    sourceSha256: sha256(bytes),
    sourceForward: "+z",
    settings: model3dSettings(profileOf({})),
    character: { gait, clips },
    rig,
  });
}

const failing = (c: RiggedCandidate) =>
  c.reasons
    .filter((r) => !r.shadow && !r.passed)
    .map((r) => `${r.check}: ${r.reason}`)
    .join("\n");

const isWebp = (bytes: Uint8Array) =>
  Buffer.from(bytes.subarray(0, 4)).toString("latin1") === "RIFF" &&
  Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP";

/** The animations of a written model by name, with their extras. */
function animations(c: RiggedCandidate) {
  return Object.fromEntries(
    (c.written.json.animations ?? []).map((a) => [a.name, a["extras"] as unknown]),
  );
}

test("a biped idles and waves on the shared rig: every check passes, jump is missing, not faked", async () => {
  const bytes = syntheticBiped();
  const rig = loaded(bipedTemplate(), { idle: bipedIdle(), wave: bipedWave() });
  const families = ["idle", "wave", "jump"];
  const first = await candidate(bytes, "biped", rig, families);
  const checks = checksOf(first);
  for (const check of [
    "gltf-validator",
    "clip-idle",
    "clip-wave",
    "loop-idle",
    "ends-wave",
    "contact-idle",
    "contact-wave",
    "joint-limits-idle",
    "joint-limits-wave",
    "skinning-idle",
    "skinning-wave",
  ]) {
    assert.equal(checks[check]?.passed, true, `${check}: ${checks[check]?.reason}`);
  }
  assert.equal(qaPassed(first.reasons), true, failing(first));
  assert.equal(checks["loop-wave"], undefined, "a one-shot is not held to the loop check");
  assert.equal(checks["ends-idle"], undefined);
  // Lifting a foot is a swing the contact check sees: the lifted foot has a gap in its contacts.
  assert.match(checks["contact-wave"]!.reason, /foot_l sole/);

  assert.match(checks["clip-jump"]!.reason, /missing, not faked/);
  assert.equal(checks["clip-jump"]!.passed, true);
  assert.deepEqual(
    (first.fields["missingClips"] as Array<{ family: string; why: string }>).map((m) => m.family),
    ["jump"],
  );
  assert.match(
    (first.fields["missingClips"] as Array<{ why: string }>)[0]!.why,
    /no gait profile or motion/,
  );

  assert.deepEqual(animations(first), {
    idle: { loop: true, generated: true },
    wave: { loop: false, generated: true },
  });
  const clips = first.fields["clips"] as Array<Record<string, unknown>>;
  assert.deepEqual(
    clips.map((c) => [c.name, c.loop, c.generated, c.speedMps]),
    [
      ["idle", true, true, 0],
      ["wave", false, true, 0],
    ],
  );
  assert.equal(clips[0]!["durationMs"], 2000);
  assert.equal(clips[1]!["durationMs"], 1800);

  const named = new Map(first.artifacts.map((a) => [a.name, a.bytes]));
  for (const name of ["idle-preview.webp", "wave-preview.webp"]) {
    assert.ok(named.has(name), name);
    assert.ok(isWebp(named.get(name)!), `${name} is a WebP`);
  }
  assert.ok(named.has("wave-side.png"));
  assert.ok(!named.has("jump-preview.webp"));

  const params = first.parameters["rig"] as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(params["motions"]!), ["idle", "wave"]);

  const second = await candidate(bytes, "biped", rig, families);
  assert.deepEqual(second.bytes, first.bytes, "the same input makes the same file");
  assert.deepEqual(
    second.artifacts.find((a) => a.name === "wave-preview.webp")!.bytes,
    named.get("wave-preview.webp"),
  );
});

test("a quadruped walks, idles and gestures in one file", async () => {
  const bytes = syntheticQuadruped();
  const rig = loaded(
    quadrupedTemplate(),
    { idle: quadrupedIdle(), paw: quadrupedPaw() },
    { walk: walkGait() },
  );
  const c = await candidate(bytes, "quadruped", rig, ["walk", "idle", "paw"]);
  assert.equal(qaPassed(c.reasons), true, failing(c));
  const checks = checksOf(c);
  for (const check of ["loop-walk", "contact-walk", "loop-idle", "ends-paw", "contact-paw"]) {
    assert.equal(checks[check]?.passed, true, `${check}: ${checks[check]?.reason}`);
  }
  assert.deepEqual(animations(c), {
    walk: { loop: true, generated: true },
    idle: { loop: true, generated: true },
    paw: { loop: false, generated: true },
  });
  const clips = c.fields["clips"] as Array<{ name: string; speedMps: number }>;
  assert.deepEqual(
    clips.map((x) => x.name),
    ["walk", "idle", "paw"],
  );
  assert.ok(clips[0]!.speedMps > 0);
  assert.equal(clips[1]!.speedMps, 0);
  assert.equal(clips[2]!.speedMps, 0);
  const params = c.parameters["rig"] as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(params["gaits"]!), ["walk"]);
  assert.deepEqual(Object.keys(params["motions"]!), ["idle", "paw"]);
  for (const name of ["walk", "idle", "paw"]) {
    assert.ok(
      isWebp(c.artifacts.find((a) => a.name === `${name}-preview.webp`)!.bytes),
      `${name} preview`,
    );
  }
});

/** The error `parseMotion` throws for a motion mended by `edit`. */
function refusal(edit: (m: MotionProfile) => unknown, template = bipedTemplate()): string {
  const motion = structuredClone(bipedWave()) as unknown as Record<string, unknown>;
  const value = edit(motion as unknown as MotionProfile) ?? motion;
  try {
    parseMotion(value, template, "motion");
  } catch (e) {
    assert.ok(e instanceof InputError, String(e));
    return e.message;
  }
  assert.fail("the motion was accepted");
}

test("parseMotion refuses what it cannot generate, naming what is wrong", () => {
  const pose = (m: MotionProfile, p: object) => {
    m.keys[1]!.pose = p;
  };
  assert.match(
    refusal((m) => pose(m, { wobble: 3 })),
    /keys\[1\]\.pose has an unknown key "wobble"/,
  );
  assert.match(
    refusal((m) => pose(m, { feet: { foot_x: { liftBodyLengths: 0.1 } } })),
    /names "foot_x", which the template has not/,
  );
  assert.match(
    refusal((m) => pose(m, { joints: { elbow_q: { x: 5 } } })),
    /names "elbow_q", which the template has not/,
  );
  assert.match(
    refusal((m) => pose(m, { joints: { knee_l: { x: 5 } } })),
    /"knee_l", a leg joint the feet pose/,
  );
  assert.match(
    refusal((m) => pose(m, { joints: { upper_arm_r: { w: 5 } } })),
    /unknown key "w"/,
  );
  assert.match(
    refusal((m) => {
      m.keys[0]!.at = 0.1;
    }),
    /keys must start at 0/,
  );
  assert.match(
    refusal((m) => {
      m.keys[2]!.at = 0.3;
    }),
    /keys must be in ascending order/,
  );
  assert.match(
    refusal((m) => {
      delete (m as Partial<MotionProfile>).loop;
    }),
    /loop must be true \(an idle\) or false \(a one-shot\)/,
  );
  assert.match(
    refusal((m) => pose(m, { feet: { foot_l: { liftBodyLengths: -0.01 } } })),
    /foot_l\.liftBodyLengths must be at least 0/,
  );
  assert.match(
    refusal((m) => {
      m.loop = true;
    }),
    /\.idle is for one-shots; a looping motion has none/,
  );
  assert.match(
    refusal((m) => {
      m.durationS = 0;
    }),
    /durationS must be a positive number/,
  );
  assert.match(
    refusal((m) => {
      m.exitS = -1;
    }),
    /exitS must be at least 0/,
  );
});

test("loadRig refuses motion declarations that conflict, before any spend", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-motion-"));
  await writeFile(join(dir, "biped.json"), JSON.stringify(bipedTemplate()));
  const rig = { template: "biped.json", kind: "synthetic-biped" };
  const load = (extra: Record<string, unknown>) => loadRig(profileOf({ rig, ...extra }), dir);
  const refused = async (extra: Record<string, unknown>, pattern: RegExp) => {
    await assert.rejects(load(extra), (e: Error) => {
      assert.ok(e instanceof InputError, String(e));
      assert.match(e.message, pattern);
      return true;
    });
  };

  const ok = await load({ motions: { idle: bipedIdle(), wave: bipedWave() } });
  assert.deepEqual(Object.keys(ok.motions), ["idle", "wave"]);
  assert.match(ok.motionSha256["wave"]!, /^[0-9a-f]{64}$/);

  await refused(
    { motions: { idle: bipedIdle(), wave: { ...bipedWave(), idle: "wave" } } },
    /model3d\.motions\.wave\.idle names "wave", which is not a looping motion/,
  );
  await refused(
    { motions: { wave: bipedWave() } },
    /model3d\.motions\.wave\.idle names "idle", which is not a looping motion/,
  );
  await refused(
    { motions: { idle: { ...bipedIdle(), entryS: 0.2 } } },
    /model3d\.motions\.idle\.entryS is for one-shots/,
  );
  await refused(
    { motions: { Idle: bipedIdle() } },
    /model3d\.motions has an invalid family name "Idle"/,
  );
  const gait: GaitProfile = {
    ...walkGait(),
    footfall: ["foot_l", "foot_r"],
    strideBodyLengths: 0.2,
  };
  await refused(
    { gaits: { idle: gait }, motions: { idle: bipedIdle() } },
    /"idle" is declared as both a gait \(model3d\.gaits\) and a motion \(model3d\.motions\)/,
  );
  await refused(
    {
      motions: {
        idle: { ...bipedIdle(), keys: [{ at: 0, pose: { joints: { ankle_l: { x: 3 } } } }] },
      },
    },
    /model3d\.motions\.idle\.keys\[0\]\.pose\.joints names "ankle_l", a leg joint/,
  );
});

test("QA filters a motion that does not end on its idle, slides a planted foot, or breaks a limit", async () => {
  const bytes = syntheticBiped();
  const run = (wave: MotionProfile) =>
    candidate(bytes, "biped", loaded(bipedTemplate(), { idle: bipedIdle(), wave }), ["wave"]);

  const control = await run(bipedWave());
  assert.equal(qaPassed(control.reasons), true, failing(control));

  // (a) The last key is held: the clip ends on a raised arm, not on the idle.
  const held = bipedWave();
  held.keys[3]!.pose = { joints: { upper_arm_r: { z: -80 } } };
  const unreturned = await run({ ...held, exitS: 0 });
  const ends = checksOf(unreturned)["ends-wave"]!;
  assert.equal(ends.passed, false, ends.reason);
  assert.match(ends.reason, /does not start and end on the pose of idle/);
  assert.equal(qaPassed(unreturned.reasons), false);

  // (b) A planted foot is dragged forward without being lifted.
  const sliding = bipedWave();
  sliding.keys[1]!.pose = { feet: { foot_l: { forwardBodyLengths: 0.05 } } };
  sliding.keys[2]!.pose = { feet: { foot_l: { forwardBodyLengths: 0.05 } } };
  const slid = await run(sliding);
  const contact = checksOf(slid)["contact-wave"]!;
  assert.equal(contact.passed, false, contact.reason);
  assert.match(contact.reason, /foot_l slides [\d.]+ m in stance/);
  assert.equal(qaPassed(slid.reasons), false);

  // (c) An arm raised past its joint's limit.
  const reaching = bipedWave();
  reaching.keys[1]!.pose = { joints: { upper_arm_r: { z: -150 } } };
  const over = await run(reaching);
  const limits = checksOf(over)["joint-limits-wave"]!;
  assert.equal(limits.passed, false, limits.reason);
  assert.match(
    limits.reason,
    /upper_arm_r in any phase at [\d.]+ s: z -?[\d.]+° outside \[-90, 90\]/,
  );
  assert.equal(qaPassed(over.reasons), false);
});

/** A target with a rig, a walk and motions, a model to re-rig, and the spec and profile files. */
async function world() {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-motion-cli-"));
  await mkdir(join(dir, "rig"));
  await writeFile(join(dir, "rig", "quadruped.json"), JSON.stringify(quadrupedTemplate()));
  const spec = join(dir, "spec.json");
  await writeFile(
    spec,
    JSON.stringify({
      kind: "character-3d",
      assetId: "kit",
      subject: "kit",
      gait: "quadruped",
      clips: ["walk", "idle", "paw", "jump"],
      heightM: 0.45,
    }),
  );
  const profile = join(dir, "profile.json");
  await writeFile(
    profile,
    JSON.stringify({
      name: "synthetic-grove-motions",
      license: "MIT",
      frames: { width: 32, height: 32 },
      model3d: {
        ...MODEL3D,
        turntable: { sizePx: 64 },
        rig: { template: "rig/quadruped.json", kind: "synthetic-quadruped" },
        gaits: { walk: walkGait() },
        motions: { idle: quadrupedIdle(), paw: quadrupedPaw() },
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
        model: { clips: "{{output.clips}}", rig: "{{output.rig}}" },
        contentHash: "{{output.sha256}}",
      },
      review: { path: "review.status", pending: "pending" },
      validator: { command: [process.execPath, VALIDATOR, "{{manifest}}"] },
    }),
  );
  const model = join(dir, "c3.glb");
  const modelBytes = syntheticQuadruped();
  await writeFile(model, modelBytes);
  const provenance = join(dir, "c3.provenance.json");
  await writeFile(
    provenance,
    JSON.stringify({
      generator: "character-3d",
      route: "scripted:model3d:synthetic",
      models: ["synthetic"],
      prompt: "a synthetic quadruped",
      parameters: { gait: "quadruped", heightM: 0.45 },
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
  return { dir, spec, profile, model, modelBytes, provenance, runs: join(dir, "runs") };
}

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const key of ["AI_GATEWAY_API_KEY", "TRIPO_API_KEY", "MESHY_API_KEY"]) delete env[key];
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

test("assetgrove rig stages a re-rigged model with its motions, hashes and previews", async () => {
  const w = await world();
  const r = await cli([
    "rig",
    "--model",
    w.model,
    "--provenance",
    w.provenance,
    "--spec",
    w.spec,
    "--profile",
    w.profile,
    "--runs",
    w.runs,
    "--json",
  ]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const run = JSON.parse(r.stdout);
  assert.equal(run["spentUsd"], 0);
  assert.equal(run["candidates"].length, 1, JSON.stringify(run["rejections"]));
  const c1 = run["candidates"][0];
  const checks = Object.fromEntries(
    c1.reasons.map((x: { check: string; passed: boolean; reason: string }) => [x.check, x]),
  );
  for (const check of ["loop-idle", "ends-paw", "contact-paw", "joint-limits-paw"]) {
    assert.equal(checks[check]?.passed, true, `${check}: ${checks[check]?.reason}`);
  }
  assert.match(checks["clip-jump"].reason, /missing, not faked/);

  assert.deepEqual(
    c1.fields.clips.map((c: { name: string }) => c.name),
    ["walk", "idle", "paw"],
  );
  const paw = c1.fields.clips.find((c: { name: string }) => c.name === "paw");
  assert.deepEqual([paw.loop, paw.generated, paw.speedMps], [false, true, 0]);
  assert.deepEqual(
    c1.fields.missingClips.map((m: { family: string }) => m.family),
    ["jump"],
  );

  const profile = JSON.parse(await readFile(w.profile, "utf8"));
  const rig = c1.provenance.parameters.rig;
  assert.deepEqual(Object.keys(rig.motions), ["idle", "paw"]);
  for (const family of ["idle", "paw"]) {
    assert.match(rig.motions[family].sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(rig.motions[family].profile, profile.model3d.motions[family]);
  }
  const step = c1.provenance.steps.find((s: { op: string }) => s.op === "rig-generated-gait");
  assert.deepEqual(Object.keys(step.params.motionSha256), ["idle", "paw"]);
  assert.equal(step.params.motionSha256.idle, rig.motions.idle.sha256);
  assert.equal(step.inputs[0], sha256(w.modelBytes));

  for (const family of ["idle", "paw"]) {
    assert.ok(
      c1.artifacts.includes(`c1-character-3d/${family}-preview.webp`),
      c1.artifacts.join(", "),
    );
  }
  const renders = await readdir(join(run["runDir"], "c1-character-3d"));
  assert.ok(renders.includes("paw-preview.webp"));
  const preview = await readFile(join(run["runDir"], "c1-character-3d", "paw-preview.webp"));
  assert.ok(isWebp(preview));
});

test("assetgrove rig resolves a look-dev'd model's external maps beside it and keeps its asset extras", async () => {
  const w = await world();
  // As look-dev leaves a model: an external groom map beside the .glb, and its record in extras.
  const glb = parseGlb(syntheticQuadruped());
  const map = encodePng(createRaster(64, 32));
  glb.json.images = [
    ...(glb.json.images ?? []),
    { uri: "kit.groom.length.png", mimeType: "image/png" },
  ];
  glb.json.textures = [...(glb.json.textures ?? []), { source: glb.json.images.length - 1 }];
  glb.json.asset.extras = { lookdev: { groom: { maxLengthM: 0.03 } } };
  await writeFile(w.model, writeGlb(glb));
  await writeFile(join(w.dir, "kit.groom.length.png"), map);
  const r = await cli([
    "rig",
    ...["--model", w.model, "--provenance", w.provenance, "--spec", w.spec],
    ...["--profile", w.profile, "--runs", w.runs, "--json"],
  ]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const [runId] = await readdir(w.runs);
  const run = JSON.parse(await readFile(join(w.runs, runId!, "run.json"), "utf8"));
  const c = run["candidates"][0];
  const checks = Object.fromEntries(c.reasons.map((x: { check: string }) => [x.check, x]));
  assert.equal(checks["gltf-validator"].passed, true, checks["gltf-validator"].reason);
  assert.equal(checks["budget-textureMaxPx"].passed, true, checks["budget-textureMaxPx"].reason);
  assert.ok(c.fields.textureMaxPx >= 64);
  const written = parseGlb(new Uint8Array(await readFile(join(w.runs, runId!, c.file))));
  const extras = written.json.asset.extras as Record<string, unknown>;
  assert.deepEqual(extras["lookdev"], { groom: { maxLengthM: 0.03 } });
  assert.ok(extras["rig"], "the rig's own record replaces only rig");
});

test("a one-shot holds its last key until durationS ends, then blends back over exitS", () => {
  const { keys, durationS } = timeline(
    {
      loop: false,
      idle: "idle",
      entryS: 0.2,
      exitS: 0.4,
      durationS: 1,
      keys: [
        { at: 0, pose: {} },
        { at: 0.5, pose: { headPitchDeg: 10 } },
      ],
    },
    { headPitchDeg: 2 },
  );
  assert.equal(durationS, 1.6);
  assert.deepEqual(
    keys.map((k) => [Number(k.t.toFixed(6)), k.pose.get("headPitchDeg") ?? 0]),
    [
      [0, 2],
      [0.2, 0],
      [0.7, 10],
      [1.2, 10],
      [1.6, 2],
    ],
  );
});
