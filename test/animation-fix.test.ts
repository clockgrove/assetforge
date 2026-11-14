import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runFixFrame, stripTarget } from "../src/animation/commands.ts";
import {
  DEFAULT_FIX_CAP_USD,
  buildFixPrompt,
  fixFrame,
  planFix,
  provenanceProblems,
} from "../src/animation/fix.ts";
import type { FixFrameOptions } from "../src/animation/fix.ts";
import { splitStrip } from "../src/animation/strip.ts";
import { Budget, BudgetExceededError } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { InputError } from "../src/errors.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { sha256 } from "../src/request.ts";
import { defaultRoutes } from "../src/routes.ts";
import { measureFrame } from "../src/sheet/register.ts";
import { resolveStyle } from "../src/style.ts";
import { parseRecipe, transformFiles } from "../src/transform/run.ts";
import type { Provenance } from "../src/types.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const frame = { width: 24, height: 32 };
const anchor = { x: 12, y: 30 };

function rect(r: Raster, x0: number, y0: number, w: number, h: number, rgb: number[]): void {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) setPixel(r, x, y, [...rgb, 255]);
}

function makeStrip(count: number): Raster {
  const strip = createRaster(frame.width * count, frame.height);
  for (let i = 0; i < count; i++) {
    rect(strip, i * frame.width + 8, 12 + (i % 2), 8, 18 - (i % 2), [60 + i * 20, 90, 140]);
  }
  return strip;
}

/** A figure at a larger size and off-centre; opaque on a flat light background, or transparent. */
function figureImage(transparent: boolean): Uint8Array {
  const r = createRaster(80, 80);
  if (!transparent) rect(r, 0, 0, 80, 80, [245, 243, 238]);
  rect(r, 10, 20, 24, 50, [200, 60, 50]);
  return encodePng(r);
}

function setup(options: { transparent?: boolean; cap?: number } = {}) {
  const provider = new ScriptedProvider({
    image: () => ({
      images: [{ mediaType: "image/png", bytes: figureImage(!!options.transparent) }],
    }),
    vision: () => ({ text: "" }),
  });
  const call = new Caller({
    provider,
    providerName: "scripted",
    budget: new Budget(options.cap ?? DEFAULT_FIX_CAP_USD),
    routes: defaultRoutes,
  });
  return { provider, call };
}

function base(call: Caller, over: Partial<FixFrameOptions> = {}): FixFrameOptions {
  return {
    strip: makeStrip(4),
    frame,
    anchor,
    family: "walk",
    subject: "raccoon",
    index: 3,
    from: { neighbour: 2 },
    style: resolveStyle(undefined),
    call,
    ...over,
  };
}

test("plans one edit call and builds a prompt with the note", () => {
  const plan = planFix(defaultRoutes);
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.operation, "edit");
  const prompt = buildFixPrompt({
    subject: "raccoon",
    family: "walk",
    frame: 3,
    count: 4,
    source: "neighbour",
    sourceFrame: 2,
    note: "keep the tail down",
  });
  assert.match(prompt, /frame 3 of 4/);
  assert.match(prompt, /keep the tail down/);
});

for (const transparent of [false, true]) {
  test(`fixes only the target frame (${transparent ? "alpha" : "opaque, matted"})`, async () => {
    const { provider, call } = setup({ transparent });
    const options = base(call);
    const result = await fixFrame(options);
    const before = splitStrip(options.strip, frame);
    const after = splitStrip(result.strip, frame);
    after.forEach((f, i) => {
      if (i !== 2) assert.deepEqual(f.data, before[i]?.data);
    });
    assert.notDeepEqual(after[2]?.data, before[2]?.data);
    const m = measureFrame(result.frame);
    assert.ok(m);
    assert.equal(m.baseline, anchor.y);
    assert.ok(Math.abs(m.centerX - (anchor.x + 0.5)) <= 1);

    const neighbourPng = encodePng(before[1] as Raster);
    const badPng = encodePng(before[2] as Raster);
    const refs = provider.calls[0]?.request;
    assert.ok(refs && "references" in refs);
    assert.deepEqual(
      refs.references.map((r) => sha256(r.bytes)),
      [sha256(neighbourPng), sha256(badPng)],
    );
    assert.equal(provider.calls.length, 1);
  });
}

test("provenance records the call, the fix and the frame transform", async () => {
  const { call } = setup();
  const prior: Provenance = {
    generator: "sheet",
    route: "r",
    models: ["m"],
    prompt: "p",
    parameters: {},
    requestIds: ["a"],
    referenceHashes: [],
    bibleVersion: "1",
    license: "MIT",
    providerTerms: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.000Z",
    costUsd: 0.3,
    calls: [],
    digitalSourceType: DIGITAL_SOURCE_TYPES.human,
    frames: [0, 1, 2, 3].map((index) => ({
      index,
      frame: index + 1,
      cell: { row: 0, column: index, box: { x: 0, y: 0, width: 1, height: 1 } },
      tool: "t",
      sheetSha256: "s",
      transforms: [],
    })),
  };
  const result = await fixFrame(base(call, { provenance: prior }));
  const record = call.records[0];
  assert.ok(record);
  const p = result.provenance;
  assert.equal(p.calls.length, 1);
  assert.equal(record.operation, "edit");
  assert.equal(record.model, defaultRoutes.edit.model);
  assert.match(record.route, /edit/);
  assert.equal(record.prompt, result.fix.prompt);
  assert.ok(record.seed !== undefined);
  assert.deepEqual(p.requestIds, ["a", record.requestId]);
  assert.deepEqual(p.models, ["m", record.model]);
  assert.equal(p.costUsd, 0.3 + record.costUsd);
  assert.equal(p.digitalSourceType, DIGITAL_SOURCE_TYPES.composite);
  assert.equal(p.fixes?.length, 1);
  assert.equal(p.fixes?.[0]?.requestId, record.requestId);
  assert.equal(p.fixes?.[0]?.seed, record.seed);
  assert.equal(p.fixes?.[0]?.costUsd, record.costUsd);
  assert.notEqual(result.fix.beforeHash, result.fix.afterHash);
  assert.deepEqual(p.frames?.[2]?.transforms[0], {
    op: "edit-frame",
    from: { neighbour: 2 },
    model: record.model,
    requestId: record.requestId,
  });
  assert.equal(p.frames?.[1]?.transforms.length, 0);
  assert.ok(p.steps?.some((s) => s.op === "register"));
});

test("a key pose is sent first and a minimal provenance is made", async () => {
  const { provider, call } = setup();
  const bytes = encodePng(makeStrip(1));
  const keyPose = {
    role: "key pose (approved)",
    path: "key.png",
    mediaType: "image/png",
    bytes,
    sha256: sha256(bytes),
  };
  const result = await fixFrame(base(call, { from: { keyPose } }));
  const request = provider.calls[0]?.request;
  assert.ok(request && "references" in request);
  assert.deepEqual(request.references[0]?.bytes, bytes);
  assert.deepEqual(result.fix.from, { keyPose: { path: "key.png", sha256: keyPose.sha256 } });
  assert.equal(result.provenance.generator, "frame-fix");
  assert.equal(result.provenance.digitalSourceType, DIGITAL_SOURCE_TYPES.composite);
});

test("invalid index or neighbour refuses before any call", async () => {
  const { provider, call } = setup();
  for (const over of [
    { index: 0 },
    { index: 5 },
    { from: { neighbour: 3 } },
    { from: { neighbour: 9 } },
  ]) {
    await assert.rejects(fixFrame(base(call, over)), InputError);
  }
  assert.equal(provider.calls.length, 0);
});

test("a cap too small refuses before any call", async () => {
  const { provider, call } = setup({ cap: 0.01 });
  await assert.rejects(fixFrame(base(call)), BudgetExceededError);
  assert.equal(provider.calls.length, 0);
});

test("soft and binary styles both work", async () => {
  for (const mode of ["soft", "binary"] as const) {
    const { call } = setup();
    const style = resolveStyle({ alpha: { mode } });
    const result = await fixFrame(base(call, { style }));
    const alphas = new Set<number>();
    for (let i = 3; i < result.frame.data.length; i += 4)
      alphas.add(result.frame.data[i] as number);
    if (mode === "binary") assert.deepEqual([...alphas].sort(), [0, 255]);
    assert.ok(measureFrame(result.frame, 128));
  }
});

/** A 4-frame strip on disk with a target profile of its frame size, for `runFixFrame`. */
async function stripOnDisk() {
  const root = await mkdtemp(join(tmpdir(), "assetgrove-fix-prov-"));
  const path = join(root, "walk.png");
  await writeFile(path, encodePng(makeStrip(4)));
  const target = stripTarget({
    path,
    family: "walk",
    profile: syntheticProfile({ frames: { width: frame.width, height: frame.height } }),
    anchor,
  });
  return { root, path, target };
}

function runOn(
  target: ReturnType<typeof stripTarget>,
  provider: ScriptedProvider,
  out: string,
  provenancePath?: string,
) {
  return runFixFrame({
    target,
    index: 3,
    from: { neighbour: 2 },
    ...(provenancePath !== undefined && { provenancePath }),
    outDir: out,
    routes: defaultRoutes,
    capUsd: DEFAULT_FIX_CAP_USD,
    provider: { provider, name: "scripted" },
  });
}

test("a provenance the fix cannot extend refuses before any paid call", async () => {
  const { root, path, target } = await stripOnDisk();
  // A recipe's record for another image, a record with no models, and not a record at all.
  const other = await transformFiles({
    recipe: parseRecipe({ steps: [{ op: "convert", params: { format: "png" } }] }),
    inputs: [path],
    out: join(root, "other", "other.png"),
  });
  const otherRecord = JSON.parse(await readFile(other.provenancePath, "utf8"));
  otherRecord.outputs[0].pixels = "not-this-strip";
  const shapes: Array<[string, unknown]> = [
    ["recipe-for-another-image", otherRecord],
    ["no-models", { generator: "frame-fix", calls: [], costUsd: 0 }],
    ["a-list", [1, 2, 3]],
  ];
  for (const [name, record] of shapes) {
    const provenancePath = join(root, `${name}.provenance.json`);
    await writeFile(provenancePath, JSON.stringify(record));
    const { provider } = setup();
    const out = join(root, `out-${name}`);
    await assert.rejects(runOn(target, provider, out, provenancePath), (error: Error) => {
      assert.ok(error instanceof InputError, String(error));
      assert.match(error.message, /cannot extend the provenance/);
      assert.match(error.message, /write-families/);
      return true;
    });
    assert.equal(provider.calls.length, 0, `${name}: no paid call`);
    await assert.rejects(access(out), `${name}: nothing written`);
  }
});

test("fixFrame itself refuses a provenance it cannot extend before the call", async () => {
  const { provider, call } = setup();
  const transform = { generator: "transform", sources: [], steps: [], outputs: [] };
  await assert.rejects(
    fixFrame(base(call, { provenance: transform as unknown as Provenance })),
    InputError,
  );
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(provenanceProblems(transform), [
    "models is not a list of strings",
    "requestIds is not a list of strings",
    "referenceHashes is not a list of strings",
    "providerTerms is not a list of strings",
    "calls is not a list",
    "costUsd is not a number",
  ]);
});

test("a recipe's transform record for the strip is carried forward with the fix", async () => {
  const { root, path } = await stripOnDisk();
  // `recipe` with one output writes `<out>.provenance.json`, the sidecar fix-frame reads.
  const recipeOut = join(root, "recipe", "walk.png");
  const made = await transformFiles({
    recipe: parseRecipe({ name: "tidy", steps: [{ op: "convert", params: { format: "png" } }] }),
    inputs: [path],
    out: recipeOut,
  });
  const target = stripTarget({
    path: recipeOut,
    family: "walk",
    profile: syntheticProfile({ frames: { width: frame.width, height: frame.height } }),
    anchor,
  });
  const { provider } = setup();
  const run = await runOn(target, provider, join(root, "fixed"));
  assert.equal(provider.calls.length, 1);
  const p = JSON.parse(await readFile(run.provenancePath, "utf8"));
  assert.equal(p.generator, "transform");
  assert.deepEqual(p.parameters.recipe, { name: "tidy" });
  assert.equal(p.parameters.sources[0].sha256, made.record.sources[0]?.sha256);
  assert.deepEqual(p.referenceHashes.slice(0, 1), [made.record.sources[0]?.sha256]);
  assert.deepEqual(
    p.steps.slice(0, made.record.steps.length).map((s: { op: string }) => s.op),
    made.record.steps.map((s) => s.op),
  );
  assert.equal(p.calls.length, 1);
  assert.equal(p.fixes[0].frame, 3);
  assert.equal(p.license, "MIT");
});
