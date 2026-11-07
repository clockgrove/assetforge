import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { createRaster, decodeImage, encodePng, getPixel, setPixel } from "../src/image/raster.ts";
import { defaultRoutes } from "../src/routes.ts";
import type { TargetProfile } from "../src/types.ts";
import { runMaterials } from "../src/material/pipeline.ts";
import type { MaterialDerivation, MaterialProfile } from "../src/material/pipeline.ts";

async function setup(options: { failLit?: boolean; compression?: boolean; model?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "assetforge-material-pipeline-"));
  const albedo = createRaster(8, 4),
    height = createRaster(8, 4),
    zero = createRaster(8, 4);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 8; x++) {
      setPixel(albedo, x, y, [80, 100, 120, 255]);
      setPixel(height, x, y, [128, 128, 128, 255]);
      setPixel(zero, x, y, [0, 0, 0, 255]);
    }
  await writeFile(join(dir, "albedo.png"), encodePng(albedo));
  await writeFile(join(dir, "height.png"), encodePng(height));
  await writeFile(join(dir, "zero.png"), encodePng(zero));
  // Fake-only lit-quality proof: this target fixture copies albedo; it exercises the real
  // subprocess and QA gate, while game-renderer lighting and model judgement stay opt-in.
  const renderer = join(dir, "renderer.mjs");
  await writeFile(
    renderer,
    `import {readFile,writeFile} from 'node:fs/promises'; const [manifest,out,scene]=process.argv.slice(2);const data=JSON.parse(await readFile(manifest,'utf8'));if(!['dusk-rain','night'].includes(scene))throw Error('scene');await writeFile(out,await readFile(data.outputs.find(o=>o.channel==='albedo'&&o.scale===1).path));`,
  );
  const config: MaterialProfile = {
    channels: ["height", "normal", "emissive", "roughness", "wind"],
    scales: [1, 2],
    flickerBound: 0,
    preview: {
      command: [process.execPath, renderer, "{{materials}}", "{{output}}", "{{scene}}"],
      version: "synthetic-1",
    },
  };
  if (options.compression) {
    // Fake-only codec proof: this is a structural KTX2 fixture, never an actual Basis encoder.
    const compressor = join(dir, "compressor.mjs");
    await writeFile(
      compressor,
      `import {readFile,writeFile} from 'node:fs/promises'; const [input,out]=process.argv.slice(2);const png=await readFile(input);const b=Buffer.alloc(133);Buffer.from([171,75,84,88,32,50,48,187,13,10,26,10]).copy(b);b.writeUInt32LE(1,16);b.writeUInt32LE(png.readUInt32BE(16),20);b.writeUInt32LE(png.readUInt32BE(20),24);b.writeUInt32LE(1,36);b.writeUInt32LE(1,40);b.writeUInt32LE(1,44);b.writeUInt32LE(104,48);b.writeUInt32LE(28,52);b.writeUInt32LE(28,104);b[116]=163;b.writeBigUInt64LE(132n,80);b.writeBigUInt64LE(1n,88);b.writeBigUInt64LE(1n,96);await writeFile(out,b);`,
    );
    config.compression = {
      command: [process.execPath, compressor, "{{input}}", "{{output}}"],
      version: "fake-ktx2-container",
    };
  }
  const profile = {
    name: "synthetic",
    license: "MIT",
    frames: { width: 2, height: 2 },
    style: { materials: config },
    layout: { media: "{{output.path}}", manifest: "asset.json" },
    manifest: {},
    review: { path: "review.status", pending: "pending" },
  } as TargetProfile;
  const derivation: MaterialDerivation = {
    maps: {
      height: {
        method: options.model ? "model-assisted-painting" : "mask-extraction",
        version: "painted-v1",
        path: "height.png",
      },
      normal: { method: "height-derived-normal", version: "1" },
      emissive: { method: "mask-extraction", version: "1", path: "zero.png" },
      roughness: { method: "mask-extraction", version: "1", path: "height.png" },
      wind: { method: "mask-extraction", version: "1", path: "zero.png" },
    },
  };
  const provider = new ScriptedProvider({
    image: () => ({ images: [{ mediaType: "image/png", bytes: encodePng(height) }], costUsd: 0.1 }),
    vision: () => ({
      text: JSON.stringify({
        checks: [
          "flat-albedo",
          "normal-orientation",
          "emissive-placement",
          "dusk-rain",
          "night",
        ].map((check) => ({
          check,
          passed: !(options.failLit && check === "normal-orientation"),
          reason: "synthetic renderer judgement",
        })),
      }),
      costUsd: 0.1,
    }),
  });
  const call = new Caller({
    provider,
    providerName: "scripted",
    budget: new Budget(1),
    routes: {
      ...defaultRoutes,
      "material-qa": { model: "vision", estimatedCostUsd: 0.1, providerTerms: "synthetic" },
      "material-height": { model: "depth", estimatedCostUsd: 0.1, providerTerms: "synthetic" },
    },
  });
  return {
    dir,
    config,
    provider,
    call,
    options: {
      albedoPath: join(dir, "albedo.png"),
      spec: { kind: "sprite-strip", assetId: "synthetic", frames: { count: 2 } },
      profile,
      derivation,
      baseDir: dir,
      outDir: join(dir, "out"),
      call,
    },
  };
}

test("material pipeline emits aligned native 1x/2x maps, provenance and lit review", async () => {
  const f = await setup();
  const result = await runMaterials(f.options);
  assert.equal(result.passed, true);
  assert.equal(result.outputs.length, 12);
  const normal = decodeImage(new Uint8Array(await readFile(join(f.dir, "out", "normal@1x.png"))));
  assert.equal(normal.width, 4);
  assert.equal(normal.height, 2);
  assert.deepEqual(getPixel(normal, 1, 1), [128, 128, 255, 255]);
  const record = JSON.parse(
    await readFile(join(f.dir, "out", "height@2x.png.provenance.json"), "utf8"),
  );
  assert.equal(record.derivation.method, "mask-extraction");
  assert.equal(record.derivation.version, "painted-v1");
  assert.equal(record.upscalerUsed, false);
  assert.equal(record.source.nativeScale, 2);
  assert.equal(record.calls[0].operation, "material-qa");
  assert.equal(record.costUsd, 0.1);
  const vision = f.provider.calls.find((c) => c.kind === "vision");
  assert.equal(vision?.request.images.length, 3);
  assert.match(await readFile(join(f.dir, "out", "preview.html"), "utf8"), /dusk-rain.png/);
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(report.calls[0].operation, "material-qa");
});

test("lit QA rejects bad normal orientation even with valid maps", async () => {
  const f = await setup({ failLit: true });
  const result = await runMaterials(f.options);
  assert.equal(result.passed, false);
  assert.equal(result.qa.reasons.find((r) => r.check === "normal-orientation")?.passed, false);
});

test("native resolution, named emitters and declared range fail closed", async () => {
  const f = await setup();
  f.config.scales.push(4);
  await assert.rejects(runMaterials(f.options), /without upscaling/);
  f.config.scales = [1, 2];
  f.options.derivation.lightSources = [{ name: "invented", mask: "zero.png" }];
  await assert.rejects(runMaterials(f.options), /not named/);
  f.options.derivation.lightSources = [];
  f.config.encoding = { height: { range: [0, 0.1], encoding: "unorm8" } };
  assert.equal((await runMaterials(f.options)).passed, false);
});

test("model-assisted maps reserve spend and record actual model calls", async () => {
  const f = await setup({ model: true });
  const result = await runMaterials(f.options);
  assert.equal(result.passed, true);
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(report.calls[0].model, "depth");
  assert.equal(report.calls[0].operation, "material-height");
  assert.equal(report.calls.length, 2);
});

test("fake-only KTX2 compressor exercises external container validation per rendition", async () => {
  const f = await setup({ compression: true });
  const result = await runMaterials(f.options);
  assert.equal(result.passed, true);
  assert.equal(result.outputs.filter((o) => o.mediaType === "image/ktx2").length, 12);
  const p = JSON.parse(
    await readFile(join(f.dir, "out", "normal@1x.ktx2.provenance.json"), "utf8"),
  );
  assert.equal(p.compression.version, "fake-ktx2-container");
  f.config.compression!.command = [
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], 'bad')",
    "{{output}}",
  ];
  await assert.rejects(runMaterials(f.options), /did not produce KTX2/);
});

test("fractional 3x native downsampling preserves frame grid and preview failure remains pending", async () => {
  const f = await setup();
  const source = createRaster(12, 6);
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 12; x++) setPixel(source, x, y, [128, 128, 128, 255]);
  await writeFile(f.options.albedoPath, encodePng(source));
  await writeFile(join(f.dir, "height.png"), encodePng(source));
  const zero = createRaster(12, 6);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 12; x++) setPixel(zero, x, y, [0, 0, 0, 255]);
  await writeFile(join(f.dir, "zero.png"), encodePng(zero));
  let result = await runMaterials(f.options);
  assert.equal(result.passed, true);
  const map = decodeImage(new Uint8Array(await readFile(join(f.dir, "out", "height@2x.png"))));
  assert.equal(map.width, 8);
  assert.equal(map.height, 4);
  assert.equal(getPixel(map, 7, 3)[0], 128);
  f.config.preview.command = [process.execPath, "-e", "process.exit(1)"];
  await assert.rejects(runMaterials(f.options));
  result = JSON.parse(await readFile(join(f.dir, "out", "materials.json"), "utf8"));
  assert.equal(result.qa.passed, false);
  assert.equal(result.qa.reasons.at(-1)?.check, "material-delivery");
});

test("native 4x renditions retain exact geometry and temporal QA gates changed maps", async () => {
  const f = await setup();
  const flat = createRaster(16, 8);
  const emptyMask = createRaster(16, 8);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 16; x++) {
      setPixel(flat, x, y, [128, 128, 128, 255]);
      setPixel(emptyMask, x, y, [0, 0, 0, 255]);
    }
  await writeFile(f.options.albedoPath, encodePng(flat));
  await writeFile(join(f.dir, "height.png"), encodePng(flat));
  await writeFile(join(f.dir, "zero.png"), encodePng(emptyMask));
  f.config.scales.push(4);
  const result = await runMaterials(f.options);
  assert.equal(result.passed, true);
  const output = result.outputs.find((o) => o.channel === "normal" && o.scale === 4)!;
  const normal = decodeImage(new Uint8Array(await readFile(output.path)));
  assert.deepEqual([normal.width, normal.height], [16, 8]);
  assert.deepEqual(getPixel(normal, 12, 4), [128, 128, 255, 255]);
  setPixel(flat, 12, 4, [255, 255, 255, 255]);
  await writeFile(join(f.dir, "height.png"), encodePng(flat));
  const rejected = await runMaterials(f.options);
  assert.equal(rejected.passed, false);
  assert.deepEqual(rejected.outputs, []);
  assert.ok(rejected.qa.reasons.some((r) => !r.passed && /height: frame/.test(r.reason)));
  f.options.derivation.maps.height!.path = "missing.png";
  await assert.rejects(runMaterials(f.options));
  await assert.rejects(readFile(result.reportPath), { code: "ENOENT" });
});

test("rendition normal renormalization fails QA before out-of-range delivery or compression", async () => {
  const f = await setup();
  f.config.channels = ["normal"];
  f.config.encoding = { normal: { range: [0, 0.9], encoding: "unorm8" } };
  // Exercise compression for accepted albedo renditions before rejecting the normal.
  const compressor = join(f.dir, "compressor.mjs");
  const compressed = await setup({ compression: true });
  await writeFile(compressor, await readFile(join(compressed.dir, "compressor.mjs")));
  f.config.compression = {
    command: [process.execPath, compressor, "{{input}}", "{{output}}"],
    version: "fake-ktx2-container",
  };
  const normal = createRaster(8, 4);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 8; x++) setPixel(normal, x, y, [x % 2 ? 38 : 217, 128, 219, 255]);
  await writeFile(join(f.dir, "normal.png"), encodePng(normal));
  f.options.derivation.maps.normal = {
    method: "mask-extraction",
    version: "1",
    path: "normal.png",
  };
  const result = await runMaterials(f.options);
  assert.equal(result.passed, false);
  assert.ok(
    result.qa.reasons.some(
      (r) => r.check === "material-range" && r.passed && r.reason.startsWith("normal:"),
    ),
  );
  assert.ok(
    result.qa.reasons.some(
      (r) => r.check === "material-range" && !r.passed && r.reason.startsWith("normal@1x:"),
    ),
  );
  assert.equal(
    result.outputs.some((o) => o.channel === "normal"),
    false,
  );
  await assert.rejects(readFile(join(f.dir, "out", "normal@1x.png")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.dir, "out", "normal@1x.ktx2")), { code: "ENOENT" });
  assert.equal(f.provider.calls.length, 0);
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(report.qa.passed, false);
});
