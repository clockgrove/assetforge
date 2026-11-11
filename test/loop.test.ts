import "./fixtures/spend-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { BudgetExceededError } from "../src/budget.ts";
import { InputError, ProviderError } from "../src/errors.ts";
import type { GenerationProvider, ImageRequest } from "../src/gateway/provider.ts";
import type { Generator } from "../src/generators/generator.ts";
import { imageGenerators } from "../src/generators/image.ts";
import { pick } from "../src/handoff.ts";
import { planStage, stage } from "../src/loop.ts";
import type { StageOptions } from "../src/loop.ts";
import { sha256 } from "../src/request.ts";
import { defaultRoutes } from "../src/routes.ts";
import type { AssetSpec } from "../src/types.ts";
import {
  PALETTE,
  scriptedProvider,
  shelterSpec,
  syntheticProfile,
  syntheticWorld,
} from "./fixtures/synthetic.ts";
import type { World } from "./fixtures/synthetic.ts";

const exec = promisify(execFile);

function options(
  world: World,
  provider: StageOptions["provider"],
  spec: AssetSpec = shelterSpec,
): StageOptions {
  return {
    spec,
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile: world.profile,
    routes: defaultRoutes,
    provider,
    providerName: "scripted",
    generators: imageGenerators,
    runsDir: world.runsDir,
  };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

test("Stevie's shelter strip: 4 candidates within $5, only passing ones staged, the pick lands pending with provenance and the target validator accepts it", async () => {
  const world = await syntheticWorld();

  // Key pose first (owner decision): the author stages a still of the pose and chooses one.
  const poseProvider = scriptedProvider({ imageCostUsd: 0.04, visionCostUsd: 0.01 });
  const poseSpec: AssetSpec = {
    kind: "still",
    assetId: "stevie",
    animationFamily: "shelter",
    frames: { width: 96, height: 96 },
  };
  const pose = await stage(options(world, poseProvider, poseSpec));
  assert.equal(pose.run.candidates.length, 4);
  // Spec-driven request: the bible's references, perspective sample and palette go as images.
  const keyPoseCall = poseProvider.calls.find((c) => c.kind === "image")!.request as ImageRequest;
  assert.equal(keyPoseCall.model, defaultRoutes.still.model);
  const sheet = await readFile(join(world.bibleDir, "refs/stevie-sheet.png"));
  const perspective = await readFile(join(world.bibleDir, "refs/perspective.png"));
  assert.equal(keyPoseCall.references.length, 4);
  assert.deepEqual(Buffer.from(keyPoseCall.references[0]!.bytes), sheet);
  assert.deepEqual(Buffer.from(keyPoseCall.references[2]!.bytes), perspective);
  assert.match(keyPoseCall.prompt, /Key pose/);
  assert.match(keyPoseCall.prompt, /grey adult raccoon/);
  assert.match(keyPoseCall.prompt, /"shelter"/);
  for (const hex of PALETTE) assert.ok(keyPoseCall.prompt.includes(hex));
  const poseCalls = pose.run.candidates[0]!.provenance.calls;
  assert.equal(poseCalls[0]!.seed, undefined, "gpt-image takes no seed, so none is recorded");
  const keyPosePath = join(pose.runDir, pose.run.candidates[0]!.file);
  const keyPoseBytes = await readFile(keyPosePath);

  const provider = scriptedProvider({ failIdentity: [1], imageCostUsd: 0.04, visionCostUsd: 0.01 });
  const { run, runDir } = await stage(
    options(world, provider, { ...shelterSpec, keyPose: keyPosePath }),
  );

  // Bounded spend: 4 candidates by default, a $5 cap, and the estimate reserved within it.
  assert.equal(run.requested, 4);
  assert.equal(run.capUsd, 5);
  assert.ok(run.estimateUsd <= 5, `estimate ${run.estimateUsd}`);
  assert.ok(run.spentUsd <= 5);
  // Each of the 6 frames is an edit of the approved key pose, then one vision QA call per candidate.
  const images = provider.calls.filter((c) => c.kind === "image");
  assert.equal(images.length, 4 * 6);
  assert.equal(provider.calls.filter((c) => c.kind === "vision").length, 4);
  for (let f = 1; f <= 6; f++) {
    const edit = images[f - 1]!.request as ImageRequest;
    assert.equal(edit.model, defaultRoutes.edit.model);
    assert.match(edit.prompt, new RegExp(`frame ${f} of 6`));
    assert.equal(edit.references.length, 1);
    assert.deepEqual(Buffer.from(edit.references[0]!.bytes), keyPoseBytes);
  }

  // Only passing candidates are staged and shown, each with the reason it passed.
  assert.deepEqual(
    run.candidates.map((c) => c.id),
    ["c1", "c3", "c4"],
  );
  assert.equal(run.filtered, 1);
  assert.equal(await exists(join(runDir, "c2.png")), false);
  for (const c of run.candidates) {
    assert.ok(await exists(join(runDir, c.file)));
    const checks = c.reasons.map((r) => r.check);
    for (const check of ["transparency", "frame-count", "palette", "identity", "perspective"]) {
      assert.ok(checks.includes(check), `${c.id} lacks ${check}`);
    }
    for (const r of c.reasons) {
      assert.equal(r.passed, true);
      assert.ok(r.reason.length > 0);
    }
  }

  // The author picks one; the strip and its manifest land in the target, pending, with provenance.
  const result = await pick({ runDir, candidateId: "c3", targetDir: world.targetDir });
  assert.equal(result.validator?.accepted, true, result.validator?.output);
  const manifest = JSON.parse(
    await readFile(join(world.targetDir, "assets/manifests/stevie/shelter.json"), "utf8"),
  );
  const strip = await readFile(join(world.targetDir, "assets/source/stevie/shelter.png"));
  assert.equal(manifest.review.status, "pending");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.contentHash, sha256(strip));
  assert.deepEqual(manifest.frames, { width: 32, height: 32, count: 6, durationMs: 250 });
  assert.deepEqual(manifest.anchor, { x: 16, y: 30 });
  assert.deepEqual(manifest.semantic, { role: "actor", entity: "grove.stevie" });
  assert.equal(manifest.source.mediaType, "image/png");
  const p = manifest.provenance.generated;
  assert.deepEqual(p.models, [defaultRoutes.edit.model, defaultRoutes.vision.model]);
  assert.match(p.route, /scripted:edit:bfl\/flux-kontext-pro/);
  assert.match(p.prompt, /Key pose/);
  assert.ok(p.parameters.frameCount === 6);
  assert.equal(typeof p.seed, "number");
  assert.equal(p.requestIds.length, 7);
  assert.equal(p.parameters.keyPose.sha256, sha256(keyPoseBytes));
  assert.ok(p.startedAt && p.finishedAt);
  assert.equal(p.bibleVersion, "synthetic-1");
  assert.equal(p.license, "MIT");
  assert.ok(p.providerTerms.length === 2);
  assert.ok(Math.abs(p.costUsd - (6 * 0.04 + 0.01)) < 1e-9);
  for (const call of p.calls) {
    for (const key of [
      "model",
      "route",
      "prompt",
      "parameters",
      "requestId",
      "startedAt",
      "finishedAt",
      "costUsd",
      "providerTerms",
    ]) {
      assert.ok(call[key] !== undefined, `call lacks ${key}`);
    }
    assert.equal(call.costSource, "provider");
    assert.equal(call.requestIdSource, "provider");
  }
  const editCall = p.calls.find((c: { operation: string }) => c.operation === "edit");
  assert.equal(typeof editCall.seed, "number");
});

test("a run that would exceed the cap is refused before any provider call", async () => {
  const world = await syntheticWorld();
  const provider = scriptedProvider();
  await assert.rejects(stage({ ...options(world, provider), capUsd: 1 }), BudgetExceededError);
  assert.equal(provider.calls.length, 0);
  assert.equal(await exists(world.runsDir), false);
});

test("each call reserves before it is made, so spend reported above the estimate stops the run at the cap", async () => {
  const world = await syntheticWorld();
  const provider = scriptedProvider({ imageCostUsd: 0.3 });
  const { run } = await stage(options(world, provider));
  assert.match(run.stopped ?? "", /refused/);
  assert.ok(provider.calls.length < 32);
  // The last call made fitted its estimate in the cap; only its overrun above the estimate can show.
  assert.ok(run.spentUsd <= run.capUsd + 0.3, `spent ${run.spentUsd}`);
});

test("a candidate that failed QA cannot be picked, and the review field is always written pending", async () => {
  const world = await syntheticWorld();
  world.profile.manifest = {
    ...(world.profile.manifest as object),
    review: { status: "approved" },
  };
  const { runDir } = await stage(options(world, scriptedProvider({ failIdentity: [0] })));
  await assert.rejects(
    pick({ runDir, candidateId: "c1", targetDir: world.targetDir }),
    /not a QA-passing candidate/,
  );
  await pick({ runDir, candidateId: "c2", targetDir: world.targetDir });
  const manifest = JSON.parse(
    await readFile(join(world.targetDir, "assets/manifests/stevie/shelter.json"), "utf8"),
  );
  assert.equal(manifest.review.status, "pending");
});

test("a strip spec without an approved key pose is refused before any provider call", async () => {
  const world = await syntheticWorld();
  const provider = scriptedProvider();
  const unapproved: AssetSpec = { ...shelterSpec };
  delete unapproved.keyPose;
  await assert.rejects(
    stage(options(world, provider, unapproved)),
    /needs an author-approved keyPose/,
  );
  await assert.rejects(stage(options(world, provider, unapproved)), InputError);
  assert.equal(provider.calls.length, 0);
  assert.equal(await exists(world.runsDir), false);
});

test("without a provenance path or an embedded record, the pick writes provenance beside the media", async () => {
  const world = await syntheticWorld();
  world.profile.manifest = {
    ...(world.profile.manifest as object),
    provenance: { prompt: "{{provenance.prompt}}", references: "{{provenance.referenceHashes}}" },
  };
  const { runDir } = await stage({ ...options(world, scriptedProvider()), candidates: 1 });
  const result = await pick({ runDir, candidateId: "c1", targetDir: world.targetDir });
  assert.equal(
    result.provenancePath,
    join(world.targetDir, "assets/source/stevie/shelter.png.provenance.json"),
  );
  const record = JSON.parse(await readFile(result.provenancePath!, "utf8"));
  assert.equal(record.requestIds.length, 7);
  assert.ok(record.models.length > 0 && record.costUsd > 0 && record.startedAt);
});

test("a request ID the provider did not report is marked local in provenance", async () => {
  const world = await syntheticWorld();
  const base = scriptedProvider();
  const provider: GenerationProvider = {
    generateImage: (request) => base.generateImage(request),
    analyzeImages: async (request) => ({
      ...(await base.analyzeImages(request)),
      requestId: "local-1",
      requestIdSource: "local",
    }),
  };
  const { run } = await stage({ ...options(world, provider), candidates: 1 });
  const calls = run.candidates[0]!.provenance.calls;
  assert.equal(calls.find((c) => c.operation === "vision")?.requestIdSource, "local");
  assert.ok(
    calls.filter((c) => c.operation === "edit").every((c) => c.requestIdSource === "provider"),
  );
});

test("the same loop handles a still image with no code changes", async () => {
  const world = await syntheticWorld();
  const provider = scriptedProvider();
  const spec: AssetSpec = { kind: "still", assetId: "den", animationFamily: "idle" };
  const { run, runDir } = await stage(options(world, provider, spec));
  assert.equal(provider.calls.filter((c) => c.kind === "image").length, 4);
  assert.equal(run.candidates.length, 4);
  const result = await pick({ runDir, candidateId: "c1", targetDir: world.targetDir });
  assert.equal(result.validator?.accepted, true, result.validator?.output);
  const manifest = JSON.parse(
    await readFile(join(world.targetDir, "assets/manifests/den/idle.json"), "utf8"),
  );
  assert.equal(manifest.frames.count, 1);
});

test("another media type arrives through an added generator; each output declares its own media type", async () => {
  const world = await syntheticWorld();
  const tone: Generator = {
    kind: "ambient-loop",
    planCandidate: () => [],
    async generate() {
      const samples = 800;
      const wav = Buffer.alloc(44 + samples * 2);
      wav.write("RIFF", 0, "latin1");
      wav.writeUInt32LE(36 + samples * 2, 4);
      wav.write("WAVEfmt ", 8, "latin1");
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(8000, 24);
      wav.writeUInt32LE(16000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36, "latin1");
      wav.writeUInt32LE(samples * 2, 40);
      for (let i = 0; i < samples; i++)
        wav.writeInt16LE(Math.round(8000 * Math.sin(i / 4)), 44 + i * 2);
      return {
        output: {
          mediaType: "audio/wav",
          extension: "wav",
          bytes: new Uint8Array(wav),
          fields: { seconds: 0.1 },
        },
        qa: {
          passed: true,
          reasons: [{ check: "loop", passed: true, reason: "seamless", source: "deterministic" }],
        },
        prompt: "synthetic tone",
        parameters: {},
      };
    },
  };
  const profile = {
    ...world.profile,
    validator: undefined,
    manifest: { media: "{{output.mediaType}}", seconds: "{{output.seconds}}", review: {} },
  };
  const { runDir } = await stage({
    ...options(world, scriptedProvider(), {
      kind: "ambient-loop",
      assetId: "rain",
      animationFamily: "loop",
    }),
    profile,
    generators: [...imageGenerators, tone],
    candidates: 1,
  });
  const result = await pick({ runDir, candidateId: "c1", targetDir: world.targetDir });
  assert.ok(result.mediaPath.endsWith("assets/source/rain/loop.wav"));
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.deepEqual(manifest, { media: "audio/wav", seconds: 0.1, review: { status: "pending" } });
});

test("a validator rejection is reported, not hidden", async () => {
  const world = await syntheticWorld();
  world.profile.validator = {
    command: [process.execPath, "-e", "console.error('nope'); process.exit(1)"],
  };
  const { runDir } = await stage({ ...options(world, scriptedProvider()), candidates: 1 });
  const result = await pick({ runDir, candidateId: "c1", targetDir: world.targetDir });
  assert.equal(result.validator?.accepted, false);
  assert.match(result.validator?.output ?? "", /nope/);
});

test("the CLI takes the gateway key from the environment only, and refuses without it", async () => {
  const world = await syntheticWorld();
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  const env = { ...process.env };
  delete env["AI_GATEWAY_API_KEY"];
  await assert.rejects(
    exec(
      process.execPath,
      [
        "src/cli.ts",
        "stage",
        "--spec",
        spec,
        "--bible",
        bible,
        "--profile",
        profile,
        "--runs",
        world.runsDir,
      ],
      { env },
    ),
    (error: { code: number; stderr: string }) =>
      error.code === 4 && /AI_GATEWAY_API_KEY is not set/.test(error.stderr),
  );
});

test("planStage forecasts a still and a strip without spending, and flags an over-cap forecast", () => {
  const base = { profile: syntheticProfile(), routes: defaultRoutes, generators: imageGenerators };
  const still = planStage({
    ...base,
    spec: { kind: "still", assetId: "den", animationFamily: "idle" },
    candidates: 2,
    capUsd: 5,
  });
  assert.deepEqual(
    still.perCandidate.map((c) => c.operation),
    ["still", "vision"],
  );
  assert.equal(still.calls, 4);
  assert.ok(
    Math.abs(
      still.estimateUsd -
        2 * (defaultRoutes.still.estimatedCostUsd + defaultRoutes.vision.estimatedCostUsd),
    ) < 1e-9,
  );
  assert.equal(still.withinCap, true);

  const strip = planStage({ ...base, spec: shelterSpec, candidates: 4, capUsd: 1 });
  assert.equal(strip.perCandidate.length, 7);
  assert.equal(strip.perCandidate[0]?.operation, "edit");
  assert.equal(strip.perCandidate[6]?.operation, "vision");
  assert.equal(strip.calls, 28);
  assert.equal(strip.withinCap, false);

  assert.throws(() => planStage({ ...base, spec: shelterSpec, candidates: 0 }), InputError);
  assert.throws(() => planStage({ ...base, spec: shelterSpec, capUsd: Number.NaN }), InputError);
  assert.throws(() => planStage({ ...base, spec: { kind: "nope", assetId: "x" } }), InputError);
});

test("a provider failure is a ProviderError recorded in the run's errors, and the run goes on", async () => {
  const world = await syntheticWorld();
  const good = scriptedProvider();
  const failing: GenerationProvider = {
    generateImage: () => Promise.reject(new Error("upstream 503")),
    analyzeImages: (request) => good.analyzeImages(request),
  };
  const lines: string[] = [];
  const spec: AssetSpec = { kind: "still", assetId: "den", animationFamily: "idle" };
  const { run } = await stage({
    ...options(world, failing, spec),
    candidates: 2,
    log: (m) => lines.push(m),
  });
  assert.equal(run.candidates.length, 0);
  assert.deepEqual(run.errors, [
    "candidate 1: the still call failed: upstream 503",
    "candidate 2: the still call failed: upstream 503",
  ]);
  assert.match(lines[0] ?? "", /^candidate 1\/2: failed: the still call failed/);
  const caller = new (await import("../src/calls.ts")).Caller({
    provider: failing,
    providerName: "scripted",
    budget: new (await import("../src/budget.ts")).Budget(5),
    routes: defaultRoutes,
  });
  await assert.rejects(caller.image("still", "p", []), ProviderError);
});

test("a missing bible reference refuses the run as InputError and still leaves its run record", async () => {
  const world = await syntheticWorld();
  await rm(join(world.bibleDir, "refs/den.png"));
  const provider = scriptedProvider();
  const spec: AssetSpec = { kind: "still", assetId: "den", animationFamily: "idle" };
  await assert.rejects(stage({ ...options(world, provider, spec), candidates: 2 }), InputError);
  const [runId, ...more] = await readdir(world.runsDir);
  assert.ok(runId);
  assert.deepEqual(more, []);
  const record = JSON.parse(await readFile(join(world.runsDir, runId, "run.json"), "utf8"));
  assert.deepEqual(record.candidates, []);
  assert.match(record.stopped, /^refused: cannot read/);
  assert.equal(record.errors.length, 1);
});
