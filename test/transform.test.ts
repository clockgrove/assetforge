import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRaster, encodePng, getPixel, setPixel } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { resolveStyle } from "../src/style.ts";
import { OPERATIONS } from "../src/transform/operations.ts";
import { rasterEngine } from "../src/transform/raster-engine.ts";
import {
  DEFAULT_ENGINES,
  parseRecipe,
  pixelHash,
  runOperation,
  runRecipe,
  transformFiles,
} from "../src/transform/run.ts";
import type { ImageEngine, ImageItem } from "../src/transform/types.ts";
import { decodeWebpLossless } from "./fixtures/webp-decode.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";

/** A w x h image, transparent, with an opaque block at (bx, by, bw, bh) and a soft pixel beside it. */
function blockImage(w: number, h: number, bx: number, by: number, bw: number, bh: number): Raster {
  const r = createRaster(w, h);
  for (let y = by; y < by + bh; y++)
    for (let x = bx; x < bx + bw; x++) setPixel(r, x, y, [200, 40 + x, 60 + y, 255]);
  setPixel(r, bx + bw, by, [10, 10, 10, 60]);
  return r;
}

const item = (raster: Raster, name = "img"): ImageItem => ({
  name,
  raster,
  mediaType: "image/png",
  meta: {},
});

test("every declared operation is implemented by a default engine", () => {
  for (const op of OPERATIONS)
    assert.ok(
      DEFAULT_ENGINES.some(
        (engine) => engine.operations[op.name] || engine.asyncOperations?.[op.name],
      ),
      op.name,
    );
  assert.deepEqual(OPERATIONS.map((o) => o.name).sort(), [
    "apply-style",
    "convert",
    "crop",
    "flip",
    "join",
    "material-emissive",
    "material-encode",
    "material-height",
    "material-normal",
    "material-rendition",
    "material-roughness",
    "material-wind",
    "matte",
    "pad",
    "register",
    "renditions",
    "scale",
    "slice",
    "trim",
  ]);
});

test("each operation appends one provenance step: op, parameters with defaults, engine, hashes", () => {
  const src = item(blockImage(10, 8, 2, 3, 4, 2));
  const { items, step } = runOperation([src], { op: "pad", params: { left: 2 } });
  assert.equal(items.length, 1);
  assert.deepEqual(step.params, { top: 0, right: 0, bottom: 0, left: 2 });
  assert.deepEqual(step.engine, { name: "assetforge-raster", version: rasterEngine.version });
  assert.deepEqual(step.inputs, [pixelHash(src.raster)]);
  assert.deepEqual(step.outputs, [pixelHash((items[0] as ImageItem).raster)]);
  assert.equal((items[0] as ImageItem).raster.width, 12);
  // The source is never changed.
  assert.equal(src.raster.width, 10);
});

test("crop, trim, pad, flip and join move pixels exactly", () => {
  const src = blockImage(10, 8, 2, 3, 4, 2);
  const cropped = runOperation([item(src)], {
    op: "crop",
    params: { x: 2, y: 3, width: 4, height: 2 },
  }).items[0] as ImageItem;
  assert.deepEqual(getPixel(cropped.raster, 0, 0), getPixel(src, 2, 3));
  assert.throws(
    () => runOperation([item(src)], { op: "crop", params: { x: 8, y: 0, width: 4, height: 2 } }),
    /outside/,
  );

  // Soft alpha profile: threshold 1 keeps the soft pixel; a threshold above it trims it away.
  const soft = runOperation([item(src)], { op: "trim" }).items[0] as ImageItem;
  assert.deepEqual([soft.raster.width, soft.raster.height], [5, 2]);
  const binary = resolveStyle({ alpha: { mode: "binary" } });
  const hard = runOperation([item(src)], { op: "trim" }, { style: binary });
  assert.deepEqual([hard.items[0]?.raster.width, hard.items[0]?.raster.height], [4, 2]);
  assert.equal(hard.step.params["threshold"], 128);
  const margin = runOperation([item(src)], { op: "trim", params: { threshold: 255, margin: 1 } });
  assert.deepEqual([margin.items[0]?.raster.width, margin.items[0]?.raster.height], [6, 4]);
  assert.throws(() => runOperation([item(createRaster(3, 3))], { op: "trim" }), /no pixel/);

  const flipped = runOperation([item(src)], { op: "flip" }).items[0] as ImageItem;
  assert.deepEqual(getPixel(flipped.raster, 9 - 2, 3), getPixel(src, 2, 3));
  const vflip = runOperation([item(src)], { op: "flip", params: { direction: "vertical" } });
  assert.deepEqual(getPixel((vflip.items[0] as ImageItem).raster, 2, 7 - 3), getPixel(src, 2, 3));

  const a = blockImage(4, 4, 0, 0, 2, 2);
  const b = blockImage(3, 5, 1, 1, 2, 2);
  const strip = runOperation([item(a, "a"), item(b, "b"), item(a, "c")], { op: "join" });
  const s = strip.items[0] as ImageItem;
  assert.equal(s.name, "a-strip");
  assert.deepEqual([s.raster.width, s.raster.height], [12, 5]);
  assert.deepEqual(getPixel(s.raster, 4 + 1, 1), getPixel(b, 1, 1));
  assert.deepEqual(getPixel(s.raster, 8, 0), getPixel(a, 0, 0));
  const sheet = runOperation([item(a), item(b), item(a)], { op: "join", params: { columns: 2 } });
  const g = sheet.items[0] as ImageItem;
  assert.deepEqual([g.raster.width, g.raster.height], [8, 10]);
  assert.deepEqual(getPixel(g.raster, 0, 5), getPixel(a, 0, 0));
});

test("scale and renditions follow the style's edges; crisp never makes a new colour", () => {
  const src = blockImage(6, 6, 1, 1, 3, 3);
  const crisp = resolveStyle({ alpha: { mode: "binary" } });
  const up = runOperation([item(src)], { op: "scale", params: { factor: 2 } }, { style: crisp });
  assert.equal(up.step.params["filter"], "crisp");
  const r = (up.items[0] as ImageItem).raster;
  assert.deepEqual([r.width, r.height], [12, 12]);
  assert.deepEqual(getPixel(r, 3, 3), getPixel(src, 1, 1));
  const toWidth = runOperation([item(src)], { op: "scale", params: { width: 3 } });
  assert.deepEqual([toWidth.items[0]?.raster.width, toWidth.items[0]?.raster.height], [3, 3]);
  assert.equal(toWidth.step.params["filter"], "antialiased");
  assert.throws(
    () => runOperation([item(src)], { op: "scale", params: { factor: 2, width: 3 } }),
    /exactly one/,
  );

  const reps = runOperation([item(src, "icon")], { op: "renditions" });
  assert.deepEqual(
    reps.items.map((i) => [i.name, i.raster.width]),
    [
      ["icon@1x", 6],
      ["icon@2x", 12],
    ],
  );
  // 1x is the input itself.
  assert.equal(pixelHash((reps.items[0] as ImageItem).raster), pixelHash(src));
});

test("convert sets the written format; an engine refuses a format it cannot encode", () => {
  const src = blockImage(5, 4, 1, 1, 2, 2);
  const webp = runOperation([item(src)], { op: "convert", params: { format: "webp" } });
  assert.equal(webp.items[0]?.mediaType, "image/webp");
  const byType = runOperation([item(src)], { op: "convert", params: { format: "image/png" } });
  assert.equal(byType.items[0]?.mediaType, "image/png");
  assert.throws(
    () => runOperation([item(src)], { op: "convert", params: { format: "tiff" } }),
    /cannot encode "tiff"/,
  );
});

test("matte cleans a hand-made image with no slicing: background gone, figure kept, checks pass", () => {
  const w = 40;
  const h = 32;
  const r = createRaster(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = ((x - 20) / 12) ** 2 + ((y - 16) / 9) ** 2 <= 1;
      setPixel(r, x, y, inside ? [70, 60, 90, 255] : [236, 230, 216, 255]);
    }
  }
  const { items, step } = runOperation([item(r)], { op: "matte" });
  const out = items[0] as ImageItem;
  assert.deepEqual([out.raster.width, out.raster.height], [w, h]);
  assert.equal(getPixel(out.raster, 0, 0)[3], 0);
  assert.equal(getPixel(out.raster, 20, 16)[3], 255);
  assert.deepEqual(step.params, {
    band: 2,
    tolerance: 24,
    maxHaloFraction: 0.005,
    sliceTolerance: 40,
  });
  const checks = out.meta["checks"] as Array<{ passed: boolean }>;
  assert.ok(checks.length > 0 && checks.every((c) => c.passed));
});

test("matte on a hand-made image keeps a small detached part; it drops nothing as a label", () => {
  const r = createRaster(60, 40);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 60; x++) setPixel(r, x, y, [236, 230, 216, 255]);
  for (let y = 7; y < 33; y++) for (let x = 5; x < 35; x++) setPixel(r, x, y, [70, 60, 90, 255]);
  for (let y = 18; y < 21; y++) for (let x = 48; x < 51; x++) setPixel(r, x, y, [70, 60, 90, 255]);
  const { items, step } = runOperation([item(r)], { op: "matte" });
  const out = (items[0] as ImageItem).raster;
  assert.equal(getPixel(out, 20, 20)[3], 255);
  assert.equal(getPixel(out, 49, 19)[3], 255);
  assert.equal(getPixel(out, 0, 0)[3], 0);
  assert.deepEqual(step.report, { figure: { source: "whole-image", background: "#ece6d8" } });
});

test("matte records the slice figure it used, so equal input hashes never hide a different matte", () => {
  const sheet = syntheticSheet();
  const sliced = runOperation([item(sheet.raster, "walk")], { op: "slice" }).items;
  const direct = runOperation(sliced, { op: "matte" }).step;
  const padded = runOperation(runOperation(sliced, { op: "pad" }).items, { op: "matte" }).step;
  assert.deepEqual(direct.inputs, padded.inputs);
  assert.deepEqual(direct.params, padded.params);
  const reports = (direct.report as { perInput: Array<{ figure: Record<string, string> }> })
    .perInput;
  assert.equal(reports.length, sliced.length);
  assert.ok(
    reports.every(
      (r) => r.figure["source"] === "slice" && /^[0-9a-f]{64}$/.test(r.figure["sha256"] ?? ""),
    ),
  );
  assert.notDeepEqual(direct.report, padded.report);
});

test("slice, matte and register over a sheet give registered frames with jitter in the meta", () => {
  const sheet = syntheticSheet();
  const recipe = parseRecipe({
    steps: [
      { op: "slice" },
      { op: "matte" },
      { op: "register", params: { frame: { width: 48, height: 48 } } },
    ],
  });
  const { items, steps } = runRecipe(recipe, [item(sheet.raster, "sheet")]);
  assert.equal(items.length, sheet.figures.length);
  assert.equal(items[0]?.name, "sheet-f001");
  assert.deepEqual(steps[2]?.params["anchor"], { x: 24, y: 47 });
  for (const i of items) {
    assert.deepEqual([i.raster.width, i.raster.height], [48, 48]);
    assert.ok((i.meta["jitterPx"] as number) <= 1);
  }
  assert.equal((steps[0]?.report as { mode: string }).mode, "grid");
  assert.throws(() => runOperation([item(sheet.raster)], { op: "register" }), /frame size/);
});

test("recipes are validated against the operation schemas before anything runs", () => {
  assert.throws(() => parseRecipe({}), /steps/);
  assert.throws(() => parseRecipe({ steps: [{ op: "sharpen" }] }), /unknown operation "sharpen"/);
  assert.throws(
    () => parseRecipe({ steps: [{ op: "trim", params: { threshold: 0 } }] }),
    /recipe\.steps\[0\]\.params\.threshold: must be at least 1/,
  );
  assert.throws(
    () => parseRecipe({ steps: [{ op: "pad" }, { op: "pad", params: { inner: 1 } }] }),
    /steps\[1\]\.params: unknown parameter "inner"/,
  );
  assert.throws(
    () => parseRecipe({ steps: [{ op: "crop", params: { x: 0, y: 0, width: 2 } }] }),
    /params\.height: is required/,
  );
  assert.throws(
    () => parseRecipe({ steps: [{ op: "flip", engine: "imagemagick" }] }),
    /unknown engine "imagemagick"/,
  );
  assert.throws(() => parseRecipe({ steps: [{ op: "flip", colour: 1 }] }), /unknown field/);
});

test("another engine plugs in behind the adapter without touching the recipe", () => {
  const recipe = parseRecipe({ steps: [{ op: "flip" }, { op: "pad", params: { left: 1 } }] });
  const other: ImageEngine = {
    name: "test-engine",
    version: "9.9.9",
    operations: {
      // A stand-in for sharp/libvips: same operation, its own code.
      flip: ([it]) => {
        const src = (it as ImageItem).raster;
        const out = createRaster(src.width, src.height);
        for (let y = 0; y < src.height; y++)
          for (let x = 0; x < src.width; x++)
            setPixel(out, src.width - 1 - x, y, getPixel(src, x, y));
        return { items: [{ ...(it as ImageItem), raster: out }] };
      },
    },
    encoders: {},
    decode: rasterEngine.decode,
  };
  const src = [item(blockImage(7, 5, 1, 1, 3, 2))];
  const inHouse = runRecipe(recipe, src);
  const swapped = runRecipe(recipe, src, { engines: [other, rasterEngine] });
  assert.deepEqual(
    swapped.steps.map((s) => s.engine.name),
    ["test-engine", "assetforge-raster"],
  );
  assert.equal(swapped.steps[0]?.engine.version, "9.9.9");
  assert.deepEqual(swapped.steps.at(-1)?.outputs, inHouse.steps.at(-1)?.outputs);
  // A step can also name its engine.
  const named = parseRecipe({ steps: [{ op: "flip", engine: "test-engine" }] }, [
    rasterEngine,
    other,
  ]);
  assert.equal(
    runRecipe(named, src, { engines: [rasterEngine, other] }).steps[0]?.engine.name,
    "test-engine",
  );
});

async function listFiles(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const f of (await readdir(dir)).sort()) out.set(f, await readFile(join(dir, f)));
  return out;
}

test("the full chain on a sheet is deterministic: same input, recipe and engines give the same bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "assetforge-transform-"));
  const sheetPath = join(root, "walk.png");
  await writeFile(
    sheetPath,
    syntheticSheet({ families: [{ name: "walk", count: 4, facing: 1, walk: true }] }).png,
  );
  const recipe = parseRecipe({
    format: "assetforge-recipe/1",
    name: "sheet-to-renditions",
    steps: [
      { op: "slice" },
      { op: "matte" },
      { op: "register", params: { frame: { width: 40, height: 40 } } },
      { op: "trim" },
      { op: "pad", params: { top: 2, right: 2, bottom: 2, left: 2 } },
      { op: "scale", params: { factor: 0.5 } },
      { op: "renditions", params: { scales: [1, 2] } },
      { op: "convert", params: { format: "webp" } },
    ],
  });
  const runs = [];
  for (const name of ["a", "b"]) {
    const out = join(root, name);
    const { record, provenancePath } = await transformFiles({ recipe, inputs: [sheetPath], out });
    runs.push({ files: await listFiles(out), record, provenancePath });
  }
  const [a, b] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(a.record.outputs.length, 8);
  assert.deepEqual(
    a.record.steps.map((s) => s.op),
    [
      "slice",
      "matte",
      "register",
      "trim",
      "pad",
      "scale",
      "renditions",
      "convert",
      ...Array(8).fill("embed-digital-source-type"),
    ],
  );
  for (const s of a.record.steps) {
    assert.equal(
      s.engine.name,
      s.op === "embed-digital-source-type" ? "assetforge-xmp" : "assetforge-raster",
    );
    assert.ok(s.inputs.length > 0 && s.outputs.length > 0);
  }
  assert.equal(a.record.sources[0]?.mediaType, "image/png");
  assert.deepEqual([...a.files.keys()], [...b.files.keys()]);
  assert.ok(a.files.has("walk-f001@2x.webp") && a.files.has("provenance.json"));
  for (const [name, bytes] of a.files) {
    if (name === "provenance.json") continue;
    assert.ok(bytes.equals(b.files.get(name) as Buffer), `${name} differs between runs`);
  }
  // The provenance records match too, apart from where the outputs were written.
  const strip = (r: typeof a.record) => ({
    ...r,
    outputs: r.outputs.map((o) => ({ ...o, path: "" })),
  });
  assert.deepEqual(strip(a.record), strip(b.record));
  // The WebP holds exactly the recorded pixels.
  const out = a.record.outputs.find((o) => o.name === "walk-f001@2x") as {
    path: string;
    pixels: string;
  };
  assert.equal(pixelHash(decodeWebpLossless(new Uint8Array(await readFile(out.path)))), out.pixels);
});

test("a single output goes to the named file with its provenance beside it; sources are never overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "assetforge-transform-"));
  const input = join(root, "in.png");
  await writeFile(input, encodePng(blockImage(8, 8, 2, 2, 3, 3)));
  const recipe = parseRecipe({ steps: [{ op: "trim" }] });
  const { provenancePath, record } = await transformFiles({
    recipe,
    inputs: [input],
    out: join(root, "out.png"),
  });
  assert.equal(provenancePath, join(root, "out.png.provenance.json"));
  assert.equal(record.outputs[0]?.path, join(root, "out.png"));
  await assert.rejects(
    transformFiles({ recipe, inputs: [input], out: input }),
    /never overwritten/,
  );
  const engine = { name: rasterEngine.name, version: rasterEngine.version };
  assert.deepEqual(record.sources[0]?.decodedBy, engine);
  assert.deepEqual(record.outputs[0]?.encodedBy, engine);
});

test("a single output's file extension always matches the bytes written", async () => {
  const root = await mkdtemp(join(tmpdir(), "assetforge-transform-"));
  const input = join(root, "in.png");
  await writeFile(input, encodePng(blockImage(8, 8, 2, 2, 3, 3)));
  await assert.rejects(
    transformFiles({
      recipe: parseRecipe({ steps: [{ op: "trim" }] }),
      inputs: [input],
      out: join(root, "out.webp"),
    }),
    /out\.webp names a \.webp file but the output is image\/png/,
  );
  const toWebp = parseRecipe({ steps: [{ op: "convert", params: { format: "webp" } }] });
  await assert.rejects(
    transformFiles({ recipe: toWebp, inputs: [input], out: join(root, "out2.png") }),
    /output is image\/webp; use a \.webp path/,
  );
  assert.deepEqual(await readdir(root), ["in.png"]);
  const { record } = await transformFiles({
    recipe: toWebp,
    inputs: [input],
    out: join(root, "out.webp"),
  });
  assert.equal(record.outputs[0]?.mediaType, "image/webp");
  const bytes = await readFile(join(root, "out.webp"));
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "RIFF");
});

test("the sheet import records its transformation steps, and each strip's provenance carries them", async () => {
  const { importSheet, writeFamilies } = await import("../src/sheet/import.ts");
  const { syntheticProfile } = await import("./fixtures/synthetic.ts");
  const root = await mkdtemp(join(tmpdir(), "assetforge-transform-"));
  const sheet = syntheticSheet();
  const { record, importDir } = await importSheet({
    digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
    sheet: sheet.png,
    sheetPath: "sheet.png",
    tool: "hand drawn",
    assetId: "blob",
    profile: syntheticProfile(),
    importsDir: join(root, "imports"),
  });
  assert.deepEqual(
    record.steps?.map((s) => s.op),
    ["slice", "matte", ...Array(record.frames.length + 1).fill("embed-digital-source-type")],
  );
  assert.deepEqual(record.steps?.[0]?.inputs, [pixelHash(sheet.raster)]);
  const target = join(root, "target");
  const { families } = await writeFamilies({
    importDir,
    targetDir: target,
    grouping: {
      status: "confirmed",
      unassigned: [],
      families: [
        { name: "walk-right", frames: [5, 6, 7, 8, 9, 10], reason: "walk" },
        { name: "walk-left", mirrorOf: "walk-right", reason: "mirror" },
      ],
    },
  });
  const stepsOf = async (i: number) => {
    const path = families[i]?.result.manifestPath as string;
    const manifest = JSON.parse(await readFile(path, "utf8"));
    return (manifest.provenance.generated as { steps: Array<{ op: string }> }).steps;
  };
  // The non-mirrored family records no flip; the mirrored one records its own flip only.
  assert.deepEqual(
    (await stepsOf(0)).map((s) => s.op),
    [
      "slice",
      "matte",
      ...Array(record.frames.length + 1).fill("embed-digital-source-type"),
      "register",
      "apply-style",
      "join",
      "embed-digital-source-type",
    ],
  );
  const mirrored = await stepsOf(1);
  assert.deepEqual(
    mirrored.map((s) => s.op),
    [
      "slice",
      "matte",
      ...Array(record.frames.length + 1).fill("embed-digital-source-type"),
      "flip",
      "register",
      "apply-style",
      "join",
      "embed-digital-source-type",
    ],
  );
  assert.equal(mirrored.filter((s) => s.op === "flip").length, 1);
});
