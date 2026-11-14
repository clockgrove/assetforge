import "./fixtures/spend-env.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pick } from "../src/handoff.ts";
import { RUN_FILE, writeRun } from "../src/loop.ts";
import type { RunRecord, StagedCandidate } from "../src/loop.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { GLB_MEDIA_TYPE, parseGlb, writeGlb } from "../src/model3d/glb.ts";
import { validatorCheck } from "../src/model3d/qa.ts";
import { encodePng, createRaster } from "../src/image/raster.ts";
import { sha256 } from "../src/request.ts";
import type { Provenance } from "../src/types.ts";
import { syntheticCharacter } from "./fixtures/glb.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const PNG = encodePng(createRaster(4, 4));
const MAP = new Uint8Array([1, 2, 3, 4]);

const provenance: Provenance = {
  digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
  generator: "model3d",
  route: "scripted",
  models: ["scripted"],
  prompt: "a fox",
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

async function stagedRun(
  mutate: (candidate: StagedCandidate) => void = () => {},
): Promise<{ runDir: string; targetDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-lookdev-"));
  const runDir = join(dir, "run");
  const targetDir = join(dir, "target");
  await mkdir(runDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  const glb = syntheticCharacter();
  await writeFile(join(runDir, "fox.glb"), glb);
  await writeFile(join(runDir, "base.png"), PNG);
  await writeFile(join(runDir, "length.png"), MAP);
  const candidate: StagedCandidate = {
    id: "c1",
    file: "fox.glb",
    mediaType: GLB_MEDIA_TYPE,
    extension: "glb",
    sha256: sha256(glb),
    reasons: [],
    fields: {},
    provenance,
    sidecars: [
      {
        file: "length.png",
        name: "fox.winter.length.png",
        mediaType: "image/png",
        sha256: sha256(MAP),
        field: "groom.winter.length",
      },
      {
        file: "base.png",
        name: "fox.eyes.png",
        mediaType: "image/png",
        sha256: sha256(PNG),
        field: "eyes",
        extra: { material: "eyes" },
      },
    ],
  };
  mutate(candidate);
  const profile = syntheticProfile({
    layout: {
      media: "characters/{{spec.assetId}}/{{spec.assetId}}.{{output.extension}}",
      manifest: "characters/{{spec.assetId}}/manifest.json",
    },
    manifest: {
      assetId: "{{spec.assetId}}",
      length: "{{output.groom.winter.length}}",
      eyes: "{{output.eyes?}}",
      review: { status: "pending" },
    },
  });
  delete profile.validator;
  const record: RunRecord = {
    runId: "r1",
    createdAt: "2026-01-01T00:00:00.000Z",
    spec: { kind: "character-3d", assetId: "fox", fields: {} } as RunRecord["spec"],
    specDir: dir,
    profile,
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
  assert.ok(RUN_FILE);
  return { runDir, targetDir };
}

test("pick writes sidecars beside the media and exposes {path, sha256} to the manifest", async () => {
  const { runDir, targetDir } = await stagedRun();
  const result = await pick({ runDir, candidateId: "c1", targetDir });
  const lengthPath = join(targetDir, "characters/fox/fox.winter.length.png");
  assert.deepEqual(new Uint8Array(await readFile(lengthPath)), MAP);
  assert.deepEqual(
    new Uint8Array(await readFile(join(targetDir, "characters/fox/fox.eyes.png"))),
    PNG,
  );
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.deepEqual(manifest.length, {
    path: "characters/fox/fox.winter.length.png",
    sha256: sha256(MAP),
  });
  assert.deepEqual(manifest.eyes, {
    material: "eyes",
    path: "characters/fox/fox.eyes.png",
    sha256: sha256(PNG),
  });
  const run = JSON.parse(await readFile(join(runDir, RUN_FILE), "utf8"));
  assert.ok(run.picked.files.includes("characters/fox/fox.eyes.png"));
  assert.ok(run.picked.files.includes("characters/fox/fox.winter.length.png"));
});

test("pick refuses a sidecar that changed since it was staged", async () => {
  const { runDir, targetDir } = await stagedRun();
  await writeFile(join(runDir, "length.png"), new Uint8Array([9]));
  await assert.rejects(
    pick({ runDir, candidateId: "c1", targetDir }),
    /changed since it was staged/,
  );
});

test("pick refuses a sidecar name with a directory part", async () => {
  for (const name of ["a/b.png", "a\\b.png", "..png/../x", "../x.png"]) {
    const { runDir, targetDir } = await stagedRun((c) => {
      c.sidecars![0]!.name = name;
    });
    await assert.rejects(pick({ runDir, candidateId: "c1", targetDir }), /bare file name/);
  }
});

function withExternalImage(uri: string): Uint8Array {
  const glb = parseGlb(syntheticCharacter());
  glb.json.images = [{ uri }];
  return writeGlb(glb);
}

test("validatorCheck resolves external image uris from the given resources", async () => {
  const bytes = withExternalImage("base%20colour.png");
  const found = await validatorCheck(bytes, { "base colour.png": PNG });
  assert.equal(found.passed, true, found.reason);
  const missing = await validatorCheck(bytes, {});
  assert.equal(missing.passed, false, missing.reason);
});
