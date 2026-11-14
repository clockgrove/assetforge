/**
 * `assetgrove lod` end to end (assetgrove#136): the detail-level chain and tier renditions a target
 * profile declares, made from a synthetic `.glb`, checked, staged, and handed off by `pick`. No
 * model is called.
 */
import "./fixtures/spend-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pick } from "../src/handoff.ts";
import { InputError } from "../src/errors.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { parseGlb } from "../src/model3d/glb.ts";
import { lodChain } from "../src/model3d/lod/command.ts";
import type { LodOptions } from "../src/model3d/lod/command.ts";
import { validatorCheck } from "../src/model3d/qa.ts";
import { clips, imageSize, measure } from "../src/model3d/scene.ts";
import { sha256 } from "../src/request.ts";
import type { AssetSpec, Provenance, TargetProfile } from "../src/types.ts";
import { inspectModel } from "./fixtures/clockgrove/model.ts";
import { checkerPng, lodModel } from "./fixtures/lod.ts";
import type { LodModelOptions } from "./fixtures/lod.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const CLOCKGROVE = fileURLToPath(new URL("./fixtures/clockgrove/check-model.ts", import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const BUDGETS = { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 3 };
const LODS = [
  { level: 0, triangleRatio: 1, minScreenHeight: 0.15 },
  { level: 1, triangleRatio: 0.33, minScreenHeight: 0.05 },
  { level: 2, triangleRatio: 0.1, minScreenHeight: 0 },
];
/** Between level 1 (at most a third of the full model) and level 0. */
const PHONE_TRIANGLES = 2000;

const provenance: Provenance = {
  digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
  generator: "model3d",
  route: "scripted",
  models: ["scripted"],
  prompt: "a kit",
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

const spec = {
  kind: "character-3d",
  assetId: "kit",
  fields: {
    semantic: { role: "actor", entity: "grove.kit", archetype: null },
    accessibilityLabel: "A small synthetic kit",
  },
} as unknown as AssetSpec;

function profile(model3d: Doc = {}): TargetProfile {
  const p = syntheticProfile({
    layout: {
      media: "assets/{{spec.assetId}}/{{spec.assetId}}.{{output.extension}}",
      manifest: "assets/{{spec.assetId}}/manifest.json",
    },
    manifest: {
      assetId: "{{spec.assetId}}",
      output: {
        path: "{{output.path}}",
        sha256: "{{output.sha256}}",
        triangles: "{{output.triangles}}",
        lods: "{{output.lods}}",
        levels: "{{output.levels?}}",
        tiers: "{{output.tiers?}}",
      },
      review: { status: "pending" },
    },
    model3d: {
      format: "glb",
      units: "m",
      budgets: BUDGETS,
      turntable: { sizePx: 64 },
      lods: LODS,
      ...model3d,
    },
  } as Partial<TargetProfile>);
  delete p.validator;
  return p;
}

/** A model, its provenance and spec in a fresh directory, chained with `lodChain`. */
async function chain(
  model: LodModelOptions,
  p: TargetProfile,
  options: { spec?: AssetSpec; side?: Uint8Array } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-lod-"));
  const bytes = lodModel(model);
  if (model.external) await writeFile(join(dir, model.external.uri), options.side!);
  const path = join(dir, "model.glb");
  await writeFile(path, bytes);
  const result = await lodChain({
    model: { bytes, path },
    provenance,
    spec: options.spec ?? spec,
    specDir: dir,
    profile: p,
    runsDir: join(dir, "runs"),
  });
  return { ...result, dir, bytes, path };
}

type Run = Awaited<ReturnType<typeof chain>>["run"];
const candidate = (run: Run) => run.candidates[0]!;
const reason = (run: Run, check: string) =>
  [...(candidate(run)?.reasons ?? []), ...(run.rejections?.[0]?.reasons ?? [])].find(
    (r) => r.check === check,
  );
const sidecar = (run: Run, name: string) => candidate(run).sidecars!.find((s) => s.name === name)!;
const staged = async (runDir: string, file: string) =>
  new Uint8Array(await readFile(join(runDir, file)));
const sidecarGlb = async (runDir: string, run: Run, name: string) =>
  parseGlb(await staged(runDir, sidecar(run, name).file));

test("a static model gets its chain embedded, a phone tier beside, renders, and is handed off", async () => {
  const p = profile({ tiers: { phone: { triangles: PHONE_TRIANGLES, textureMaxPx: 64 } } });
  const { run, runDir, passed, bytes } = await chain({}, p);
  assert.equal(passed, true, JSON.stringify(run.rejections));
  const full = measure(parseGlb(bytes)).triangles;
  assert.ok(full > 3500 && full < 5000, `${full}`);

  const levels = (candidate(run).fields["chain"] as Doc)["levels"] as Doc[];
  assert.equal(levels.length, 3);
  for (const level of levels.slice(1)) {
    assert.ok(level.triangles <= Math.floor(level.triangleRatio * full), JSON.stringify(level));
    assert.equal(level.passed, true);
  }
  assert.ok(levels[1]!.triangles < PHONE_TRIANGLES && levels[1]!.triangles > 0);
  for (const n of [1, 2]) {
    for (const part of ["triangles", "rig", "clips", "silhouette"]) {
      const r = reason(run, `lod-${n}-${part}`);
      assert.equal(r?.passed, true, `lod-${n}-${part}: ${r?.reason}`);
      assert.equal(r?.shadow, undefined);
    }
  }
  assert.equal(reason(run, "tier-phone")?.passed, true);

  // Embedded packaging: every passing level is inside the main file, as MSFT_lod.
  const main = parseGlb(await staged(runDir, candidate(run).file));
  const lodNode = main.json.nodes!.find((n) => n.extensions?.["MSFT_lod"])!;
  assert.equal((lodNode.extensions!["MSFT_lod"] as Doc)["ids"].length, 2);
  assert.deepEqual((lodNode["extras"] as Doc)["MSFT_screencoverage"], [0.15, 0.05, 0]);
  assert.ok(main.json.extensionsUsed!.includes("MSFT_lod"));
  const measures = measure(main);
  assert.equal(measures.lods, 3);
  assert.equal(measures.triangles, full);
  assert.equal(candidate(run).fields["lods"], 3);
  assert.equal(candidate(run).fields["triangles"], full);

  // The phone tier is a file beside it: textures within 64 px, starting at level 1.
  const phone = sidecar(run, "kit.phone.glb");
  assert.equal(phone.field, "tiers.phone.model");
  assert.deepEqual(phone.extra!["levels"], [1, 2]);
  assert.equal(phone.extra!["lods"], 2);
  const phoneGlb = await sidecarGlb(runDir, run, "kit.phone.glb");
  const phoneMeasures = measure(phoneGlb);
  assert.ok(phoneMeasures.textureMaxPx <= 64 && phoneMeasures.textureMaxPx > 0);
  assert.equal(phoneMeasures.lods, 2);
  assert.equal(phoneMeasures.triangles, levels[1]!.triangles);
  assert.equal(phone.extra!["triangles"], levels[1]!.triangles);
  assert.equal((await validatorCheck(await staged(runDir, phone.file))).passed, true);

  const artifacts = candidate(run).artifacts!.map((a) => a.split("/").pop());
  for (const name of [
    "lod0-front.png",
    "lod1-three-quarter.png",
    "lod2-back.png",
    "lods-front.png",
    "lods-side.png",
    "tier-phone.png",
  ]) {
    assert.ok(artifacts.includes(name), `${name} in ${artifacts.join(", ")}`);
  }
  for (const a of candidate(run).artifacts!) assert.ok(existsSync(join(runDir, a)), a);

  // pick hands the main file and the tier off, with the tier in the manifest.
  const target = await mkdtemp(join(tmpdir(), "assetgrove-lod-target-"));
  const picked = await pick({ runDir, candidateId: "c1", targetDir: target });
  const written = await readdir(join(target, "assets/kit"));
  assert.deepEqual(written.sort(), [
    "kit.glb",
    "kit.glb.provenance.json",
    "kit.phone.glb",
    "manifest.json",
  ]);
  const manifest = JSON.parse(await readFile(picked.manifestPath, "utf8"));
  assert.equal(manifest.output.lods, 3);
  assert.equal(manifest.output.triangles, full);
  const tier = manifest.output.tiers.phone.model;
  assert.equal(tier.path, "assets/kit/kit.phone.glb");
  assert.equal(tier.sha256, phone.sha256);
  assert.equal(tier.sha256, sha256(await readFile(join(target, tier.path))));
  assert.equal(manifest.output.sha256, sha256(await readFile(join(target, "assets/kit/kit.glb"))));
});

const CLOCKGROVE_BUDGETS = {
  triangles: 40000,
  textureMaxPx: 2048,
  materials: 4,
  bones: 80,
  lods: 1,
};
const CLOCKGROVE_HANDOFF = {
  clipFields: { name: "name", durationMs: "durationMs", loop: "loop", generated: "generated" },
  sideImages: "embedded",
  lods: "files",
};

/** Clockgrove's model manifest and validator, as its profile declares them. */
function clockgrove(model3d: Doc = {}): TargetProfile {
  const p = profile({ handoff: CLOCKGROVE_HANDOFF, ...model3d });
  return {
    ...p,
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
        tool: "assetgrove",
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
    validator: { command: [process.execPath, CLOCKGROVE, "{{manifest}}", "model-target.json"] },
  } as TargetProfile;
}

// Clockgrove's validator allows no `levels` or `tiers` field in its manifest (its `output` has exact
// keys), so the level files are written beside `model.glb` and named only in Assetgrove's run record.
test("files packaging: a file per level, tier files per level, each valid; Clockgrove accepts the pick", async () => {
  const p = clockgrove({ tiers: { phone: { triangles: PHONE_TRIANGLES, textureMaxPx: 64 } } });
  const { run, runDir, passed, bytes } = await chain({}, p);
  assert.equal(passed, true, JSON.stringify(run.rejections));
  const full = measure(parseGlb(bytes)).triangles;

  const main = parseGlb(await staged(runDir, candidate(run).file));
  assert.equal(
    main.json.nodes!.some((n) => n.extensions?.["MSFT_lod"]),
    false,
  );
  assert.equal(measure(main).lods, 1);
  assert.equal(measure(main).triangles, full);

  const names = candidate(run)
    .sidecars!.map((s) => s.name)
    .sort();
  assert.deepEqual(names, [
    "kit.lod1.glb",
    "kit.lod2.glb",
    "kit.phone.lod1.glb",
    "kit.phone.lod2.glb",
  ]);
  const levels = (candidate(run).fields["chain"] as Doc)["levels"] as Doc[];
  for (const n of [1, 2]) {
    const side = sidecar(run, `kit.lod${n}.glb`);
    assert.equal(side.field, `levels.lod${n}`);
    assert.deepEqual(side.extra, {
      level: n,
      triangles: levels[n]!.triangles,
      triangleRatio: LODS[n]!.triangleRatio,
      minScreenHeight: LODS[n]!.minScreenHeight,
    });
    const tier = sidecar(run, `kit.phone.lod${n}.glb`);
    assert.equal(tier.field, `tiers.phone.levels.lod${n}`);
    assert.equal(tier.extra!["level"], n);
    assert.equal(tier.extra!["triangles"], levels[n]!.triangles);
    assert.ok((tier.extra!["textureMaxPx"] as number) <= 64);
  }

  const target = await mkdtemp(join(tmpdir(), "assetgrove-lod-clockgrove-"));
  await writeFile(
    join(target, "model-target.json"),
    JSON.stringify({ version: 1, limits: CLOCKGROVE_BUDGETS }),
  );
  const picked = await pick({ runDir, candidateId: "c1", targetDir: target });
  assert.equal(picked.validator?.accepted, true, picked.validator?.output);
  const manifest = JSON.parse(await readFile(picked.manifestPath, "utf8"));
  assert.equal(manifest.output.lods, 1);
  assert.equal(manifest.output.levels, undefined, "Clockgrove's manifest names no level file");
  assert.equal(manifest.output.tiers, undefined);
  const folder = join(target, "assets/source/kit");
  assert.deepEqual((await readdir(folder)).sort(), [
    "kit.lod1.glb",
    "kit.lod2.glb",
    "kit.phone.lod1.glb",
    "kit.phone.lod2.glb",
    "model.glb",
    "model.glb.provenance.json",
  ]);

  for (const side of candidate(run).sidecars!) {
    const written = new Uint8Array(await readFile(join(folder, side.name)));
    assert.equal(sha256(written), side.sha256);
    const verdict = await validatorCheck(written);
    assert.equal(verdict.passed, true, `${side.name}: ${verdict.reason}`);
    const facts = inspectModel(written);
    assert.equal(facts.triangles, side.extra!["triangles"], side.name);
    assert.equal(facts.lods, 1, side.name);
  }
  const mainFacts = inspectModel(new Uint8Array(await readFile(join(folder, "model.glb"))));
  assert.equal(mainFacts.triangles, full);
});

/** A 256 px side image beside the model, as look-dev leaves a groom map. */
const GROOM = "kit.groom.length.png";

test("a rigged model's levels keep every clip, and its side image is fitted per tier or dropped", async () => {
  const p = profile({
    handoff: { lods: "files" },
    tiers: { phone: { textureMaxPx: 64 }, lite: { textureMaxPx: 64, fur: false } },
  });
  const { run, runDir, passed } = await chain({ rigged: true, external: { uri: GROOM } }, p, {
    side: checkerPng(256),
  });
  assert.equal(passed, true, JSON.stringify(run.rejections));
  for (const n of [1, 2]) {
    assert.equal(reason(run, `lod-${n}-rig`)?.passed, true, reason(run, `lod-${n}-rig`)?.reason);
    assert.equal(reason(run, `lod-${n}-clips`)?.passed, true);
    assert.match(reason(run, `lod-${n}-clips`)!.reason, /idle, wave/);
  }
  assert.deepEqual(
    (candidate(run).fields["clips"] as Doc[]).map((c) => [c["name"], c["loop"]]),
    [
      ["idle", true],
      ["wave", false],
    ],
  );
  assert.equal(candidate(run).fields["bones"], 2);

  // Every file of every level and tier plays every clip.
  const models = candidate(run).sidecars!.filter((s) => s.name.endsWith(".glb"));
  assert.deepEqual(models.map((m) => m.name).sort(), [
    "kit.lite.lod0.glb",
    "kit.lite.lod1.glb",
    "kit.lite.lod2.glb",
    "kit.lod1.glb",
    "kit.lod2.glb",
    "kit.phone.lod0.glb",
    "kit.phone.lod1.glb",
    "kit.phone.lod2.glb",
  ]);
  for (const m of models) {
    const glb = await sidecarGlb(runDir, run, m.name);
    assert.deepEqual(
      clips(glb).map((c) => c.name),
      ["idle", "wave"],
      m.name,
    );
    assert.equal((glb.json.animations![0]!["extras"] as Doc)["loop"], true, m.name);
    assert.equal(glb.json.skins!.length, 1, m.name);
  }

  // The source's own side map is carried as it is; the phone tier's is fitted and renamed.
  assert.equal(sidecar(run, GROOM).field, "groom.length");
  const groom = sidecar(run, "kit.phone.groom.length.png");
  assert.equal(groom.field, "tiers.phone.groom.length");
  const size = imageSize(await staged(runDir, groom.file))!;
  assert.deepEqual([size.width, size.height], [64, 64]);
  const phone = await sidecarGlb(runDir, run, "kit.phone.lod1.glb");
  assert.equal(phone.json.images![1]!.uri, "kit.phone.groom.length.png");
  const lookdev = (phone.json.asset["extras"] as Doc)["lookdev"].images;
  assert.equal(lookdev["groom.length"].uri, "kit.phone.groom.length.png");
  assert.equal(lookdev["groom.length"].image, 1);
  assert.ok(measure(phone).textureMaxPx <= 64);

  // The lite tier draws no fur: the map is out of its files, its images and its extras.
  assert.equal(
    candidate(run).sidecars!.some((s) => s.name.startsWith("kit.lite.groom")),
    false,
  );
  for (const n of [0, 1, 2]) {
    const lite = await sidecarGlb(runDir, run, `kit.lite.lod${n}.glb`);
    assert.equal(lite.json.images!.length, 1);
    assert.ok(lite.json.images!.every((i) => i.uri === undefined));
    assert.equal((lite.json.asset["extras"] as Doc)["lookdev"].images["groom.length"], undefined);
    assert.ok(measure(lite).textureMaxPx <= 64);
  }
  assert.match(reason(run, "tier-lite")!.reason, /draws no fur, so 1 side map/);

  // The source's own file still has its image beside it, as the validator needs.
  assert.equal(reason(run, "gltf-validator-kit.lod1.glb")?.passed, true);
});

test("a tier the main file serves is still measured against its materials and bones", async () => {
  const p = profile({ tiers: { phone: { bones: 1, materials: 0 } } });
  const { run } = await chain({ rigged: true }, p);
  const tier = reason(run, "tier-phone")!;
  assert.equal(tier.passed, false, tier.reason);
  assert.match(tier.reason, /the main file: materials 1 over 0; bones 2 over 1/);
});

test("a side image a tier cannot resize fails the tier, naming the image and its type", async () => {
  // A WebP header 256 px wide: measurable, but not decodable here.
  const webp = new Uint8Array(30);
  webp.set(Buffer.from("RIFF"), 0);
  webp.set(Buffer.from("WEBPVP8X"), 8);
  webp.set([255, 0, 0, 255, 0, 0], 24);
  const p = profile({ tiers: { phone: { textureMaxPx: 64 } } });
  const { run } = await chain({ rigged: true, external: { uri: "kit.groom.length.webp" } }, p, {
    side: webp,
  });
  const tier = reason(run, "tier-phone")!;
  assert.equal(tier.passed, false, tier.reason);
  assert.match(tier.reason, /image kit\.groom\.length\.webp \(WebP\) cannot be resized/);
});

test("a level that fails is filtered with its reason, and the candidate is still staged", async () => {
  // Level 1 differs from the full model's silhouette by under 1%, level 2 by over 3%.
  const p = profile({
    lodQa: { silhouette: 0.02 },
    tiers: { phone: { triangles: PHONE_TRIANGLES } },
  });
  const { run, runDir, passed } = await chain({}, p);
  assert.equal(passed, true, JSON.stringify(run.rejections));
  const silhouette = reason(run, "lod-2-silhouette")!;
  assert.equal(silhouette.passed, false);
  assert.equal(silhouette.shadow, true);
  assert.equal(reason(run, "lod-1-silhouette")?.passed, true);
  const left = reason(run, "lod-2")!;
  assert.equal(left.shadow, true);
  assert.match(left.reason, /level 2 is left out of the chain: lod-2-silhouette failed/);
  const levels = (candidate(run).fields["chain"] as Doc)["levels"] as Doc[];
  assert.equal(levels[2]!.passed, false);
  assert.equal(levels[1]!.passed, true);
  assert.equal(levels[0]!.passed, true);
  assert.deepEqual(
    (candidate(run).fields["chain"] as Doc)["tiers"].map((t: Doc) => [t["name"], t["levels"]]),
    [["phone", [1]]],
  );

  // Level 2 is in no file: the main file has level 1 below level 0, and the tier has only level 1.
  const main = parseGlb(await staged(runDir, candidate(run).file));
  assert.equal(measure(main).lods, 2);
  assert.equal(candidate(run).fields["lods"], 2);
  assert.equal(
    candidate(run).sidecars!.some((s) => /lod2/.test(s.name)),
    false,
  );
  const phone = await sidecarGlb(runDir, run, "kit.phone.glb");
  assert.equal(measure(phone).lods, 1);
  assert.equal(measure(phone).triangles, levels[1]!.triangles);
  assert.equal(
    candidate(run).artifacts!.some((a) => a.endsWith("lod2-front.png")),
    true,
    "the failing level is still rendered for the person who reads the reason",
  );
});

test("a failing level in files packaging produces no level file", async () => {
  const p = profile({ handoff: { lods: "files" }, lodQa: { silhouette: 0.02 } });
  const { run } = await chain({}, p);
  const names = (candidate(run)?.sidecars ?? []).map((s) => s.name);
  assert.deepEqual(names, ["kit.lod1.glb"]);
  assert.equal(reason(run, "lod-2-silhouette")?.passed, false);
});

test("a profile without model3d.lods, and class-nested tiers without a tierClass, are refused", async () => {
  const noLods = profile();
  delete noLods.model3d!.lods;
  await assert.rejects(chain({}, noLods), (e: Error) => {
    assert.ok(e instanceof InputError);
    assert.match(e.message, /model3d\.lods/);
    return true;
  });

  const nested = profile({
    tiers: { phone: { character: { triangles: 2000 }, prop: { triangles: 500 } } },
  });
  await assert.rejects(chain({}, nested), (e: Error) => {
    assert.ok(e instanceof InputError);
    assert.match(e.message, /tierClass/);
    return true;
  });
  // The class the spec names selects the tier's limits.
  const classed = { ...spec, tierClass: "character" } as AssetSpec;
  const ok = await chain({}, nested, { spec: classed });
  assert.equal(ok.passed, true, JSON.stringify(ok.run.rejections));
  assert.ok(ok.run.candidates[0]!.sidecars!.some((s) => s.name === "kit.phone.glb"));
  const unknown = { ...spec, tierClass: "vehicle" } as AssetSpec;
  await assert.rejects(chain({}, nested, { spec: unknown }), /tierClass/);
});

test("the CLI refuses a profile without model3d.lods with exit 2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-lod-cli-"));
  const noLods = profile();
  delete noLods.model3d!.lods;
  await writeFile(join(dir, "model.glb"), lodModel());
  await writeFile(join(dir, "provenance.json"), JSON.stringify(provenance));
  await writeFile(join(dir, "spec.json"), JSON.stringify(spec));
  await writeFile(join(dir, "profile.json"), JSON.stringify(noLods));
  const env = { ...process.env };
  delete env["AI_GATEWAY_API_KEY"];
  const result = await new Promise<{ code: number; stderr: string; stdout: string }>((resolve) => {
    execFile(
      process.execPath,
      [
        "src/cli.ts",
        "lod",
        "--model",
        join(dir, "model.glb"),
        "--provenance",
        join(dir, "provenance.json"),
        "--spec",
        join(dir, "spec.json"),
        "--profile",
        join(dir, "profile.json"),
        "--runs",
        join(dir, "runs"),
        "--json",
      ],
      { cwd: root, env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /model3d\.lods/);
});

/** Stages `first` from a model, then chains its c1 again under `again`. */
async function chainTwice(first: TargetProfile, again: TargetProfile) {
  const one = await chain({ rigged: true, external: { uri: GROOM } }, first, {
    side: checkerPng(256),
  });
  assert.equal(one.passed, true, JSON.stringify(one.run.rejections));
  const options: LodOptions = {
    run: { dir: one.runDir, candidate: "c1" },
    profile: again,
    runsDir: join(one.dir, "again"),
  };
  const two = await lodChain(options);
  assert.equal(two.passed, true, JSON.stringify(two.run.rejections));
  const names = two.run.candidates[0]!.sidecars!.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, `no file twice: ${names.join(", ")}`);
  // The earlier chain is made anew, not stacked: the same nodes and meshes as the first time.
  const [a, b] = await Promise.all(
    [one, two].map(async (r) =>
      parseGlb(new Uint8Array(await readFile(join(r.runDir, r.run.candidates[0]!.file)))),
    ),
  );
  assert.equal(b!.json.nodes!.length, a!.json.nodes!.length);
  assert.equal(b!.json.meshes!.length, a!.json.meshes!.length);
  return { one, two, names };
}

test("a staged run's candidate is chained again, with a profile override, carrying its sidecars", async () => {
  const { two, names } = await chainTwice(
    profile(),
    profile({ tiers: { phone: { textureMaxPx: 64 } } }),
  );
  assert.ok(names.includes(GROOM), names.join(", "));
  assert.ok(names.includes("kit.phone.glb"), names.join(", "));
  assert.ok(names.includes("kit.phone.groom.length.png"), names.join(", "));
  assert.deepEqual(
    two.run.candidates[0]!.provenance.steps!.map((s) => s.op),
    ["lod-chain", "lod-chain"],
  );
  const target = await mkdtemp(join(tmpdir(), "assetgrove-lod-again-"));
  await pick({ runDir: two.runDir, candidateId: "c1", targetDir: target });
  const written = await readdir(join(target, "assets/kit"));
  assert.ok(written.includes("kit.phone.groom.length.png"), written.join(", "));
});

test("chaining a files-packaged run again makes its level files anew, not carried as images", async () => {
  const { names } = await chainTwice(
    profile({ handoff: { lods: "files" } }),
    profile({ handoff: { lods: "files" }, tiers: { phone: { textureMaxPx: 64 } } }),
  );
  assert.ok(names.includes("kit.lod1.glb"), names.join(", "));
  assert.ok(names.includes("kit.phone.groom.length.png"), names.join(", "));
});
