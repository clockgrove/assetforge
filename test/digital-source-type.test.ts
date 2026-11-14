import jpeg from "jpeg-js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { imageGenerators } from "../src/generators/image.ts";
import { pick } from "../src/handoff.ts";
import { decodeImage, encodePng } from "../src/image/raster.ts";
import { stage } from "../src/loop.ts";
import {
  DIGITAL_SOURCE_TYPES as types,
  embedDigitalSourceType,
  readDigitalSourceType,
} from "../src/metadata.ts";
import { sha256 } from "../src/request.ts";
import { defaultRoutes } from "../src/routes.ts";
import { importSheet, writeFamilies } from "../src/sheet/import.ts";
import { pixelHash, runRecipeAsync, transformFiles } from "../src/transform/run.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import {
  drawSubject,
  scriptedProvider,
  shelterSpec,
  syntheticProfile,
  syntheticWorld,
} from "./fixtures/synthetic.ts";

const metadataOp = "embed-digital-source-type";

function taggedJpeg(raster: ReturnType<typeof drawSubject>, value: string): Buffer {
  const original = jpeg.encode(raster, 95).data;
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:iptc="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" iptc:DigitalSourceType="${value}"/></rdf:RDF></x:xmpmeta>`;
  const payload = Buffer.from(`http://ns.adobe.com/xap/1.0/\0${xml}`);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([original.subarray(0, 2), header, payload, original.subarray(2)]);
}

test("JPEG APP1 lineage survives deterministic transforms and sheet import", async () => {
  const root = await mkdtemp(join(tmpdir(), "iptc-jpeg-"));
  const sheet = syntheticSheet();
  for (const value of [types.generated, types.composite]) {
    const bytes = taggedJpeg(sheet.raster, value);
    const path = join(root, "sheet.jpg");
    await writeFile(path, bytes);
    const result = await transformFiles({
      inputs: [path],
      out: join(root, "out.png"),
      recipe: { steps: [] },
    });
    assert.equal(result.record.outputs[0]!.digitalSourceType, value);
    assert.equal(
      readDigitalSourceType(await readFile(result.record.outputs[0]!.path), "image/png"),
      value,
    );
    const { record, importDir } = await importSheet({
      sheet: bytes,
      sheetPath: path,
      tool: "synthetic",
      assetId: "jpeg-sheet",
      importsDir: root,
      digitalSourceType: types.human,
      profile: syntheticProfile({ style: { alpha: { mode: "soft" }, color: { rule: "full" } } }),
    });
    assert.equal(record.digitalSourceType, value);
    for (const file of ["contact.png", ...record.frames.map((frame) => frame.file)]) {
      assert.equal(
        readDigitalSourceType(await readFile(join(importDir, file)), "image/png"),
        value,
      );
    }
  }
});

test("transform files retain generation lineage, combine human pixels, and leave pixel hashes unchanged by XMP", async () => {
  const root = await mkdtemp(join(tmpdir(), "iptc-transform-"));
  const raster = drawSubject(16);
  const human = join(root, "human.png"),
    generated = join(root, "generated.png");
  await writeFile(human, embedDigitalSourceType(encodePng(raster), "image/png", types.human));
  await writeFile(
    generated,
    embedDigitalSourceType(encodePng(raster), "image/png", types.generated),
  );
  for (const [name, inputs, expected] of [
    ["human", [human], types.human],
    ["generated", [generated], types.generated],
    ["combined", [human, generated], types.composite],
  ] as const) {
    const result = await transformFiles({
      inputs: [...inputs],
      out: join(root, `${name}-out.png`),
      recipe: { steps: [{ op: "join" }] },
    });
    const output = result.record.outputs[0]!;
    const bytes = await readFile(output.path);
    assert.equal(output.digitalSourceType, expected);
    assert.equal(readDigitalSourceType(bytes, "image/png"), expected);
    assert.equal(output.sha256, sha256(bytes));
    assert.equal(output.pixels, pixelHash(decodeImage(bytes)));
    const step = result.record.steps.at(-1)!;
    assert.equal(step.op, metadataOp);
    assert.deepEqual(step.params, { digitalSourceType: expected });
    assert.deepEqual(step.inputs, step.outputs);
    assert.deepEqual(step.outputs, [output.pixels]);
  }
});

test("generated Fern strip and model-edited human prop disclose origin through staging, handoff, and profile validation", async () => {
  const world = await syntheticWorld();
  const validator = `import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises';
    const {readDigitalSourceType} = await import(${JSON.stringify(new URL("../src/metadata.ts", import.meta.url).href)});
    const manifest=JSON.parse(await readFile(process.argv[1],'utf8'));
    const bytes=await readFile(process.argv[2]);
    assert.equal(readDigitalSourceType(bytes,'image/png'),manifest.provenance.generated.digitalSourceType);`;
  world.profile.validator = {
    command: [
      process.execPath,
      "--input-type=module",
      "-e",
      validator,
      "{{manifest}}",
      "{{media}}",
    ],
  };
  const base = {
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile: world.profile,
    routes: defaultRoutes,
    providerName: "scripted",
    generators: imageGenerators,
    runsDir: world.runsDir,
    candidates: 1,
  };
  const pose = await stage({
    ...base,
    provider: scriptedProvider(),
    spec: { kind: "still", assetId: "fern", frames: { width: 96, height: 96 } },
  });
  const posePath = join(pose.runDir, pose.run.candidates[0]!.file);
  const jpegPose = join(world.dir, "human-pose.jpg");
  await writeFile(jpegPose, jpeg.encode(drawSubject(96), 90).data);
  const generatedJpegPose = join(world.dir, "generated-pose.jpg");
  const compositeJpegPose = join(world.dir, "composite-pose.jpg");
  await writeFile(generatedJpegPose, taggedJpeg(drawSubject(96), types.generated));
  await writeFile(compositeJpegPose, taggedJpeg(drawSubject(96), types.composite));
  for (const [assetId, keyPose, expected] of [
    ["fern", posePath, types.generated],
    ["prop", join(world.dir, "key-pose.png"), types.composite],
    ["jpeg-prop", jpegPose, types.composite],
    ["jpeg-generated", generatedJpegPose, types.generated],
    ["jpeg-composite", compositeJpegPose, types.composite],
  ] as const) {
    const { run, runDir } = await stage({
      ...base,
      provider: scriptedProvider(),
      spec: { ...shelterSpec, subject: "fern", assetId, keyPose },
    });
    const candidate = run.candidates[0]!;
    assert.equal(candidate.provenance.digitalSourceType, expected);
    assert.equal(candidate.provenance.steps?.at(-1)?.op, metadataOp);
    const staged = await readFile(join(runDir, candidate.file));
    assert.equal(readDigitalSourceType(staged, "image/png"), expected);
    assert.equal(candidate.sha256, sha256(staged));
    const picked = await pick({ runDir, candidateId: candidate.id, targetDir: world.targetDir });
    assert.equal(picked.validator?.accepted, true);
    assert.deepEqual(await readFile(picked.mediaPath), staged);
  }
});

test("sheet import carries declared model origin into cleaned frames, contact sheet and final strip", async () => {
  const root = await mkdtemp(join(tmpdir(), "iptc-sheet-"));
  const sheet = syntheticSheet();
  const profile = syntheticProfile({ style: { alpha: { mode: "soft" }, color: { rule: "full" } } });
  profile.manifest = {
    ...(profile.manifest as Record<string, unknown>),
    style: "{{profile.style}}",
  };
  const { record, importDir } = await importSheet({
    sheet: sheet.png,
    sheetPath: "synthetic.png",
    tool: "scripted model",
    digitalSourceType: types.generated,
    assetId: "blob",
    profile,
    importsDir: root,
  });
  assert.equal(record.digitalSourceType, types.generated);
  for (const path of ["contact.png", ...record.frames.map((f) => f.file)]) {
    assert.equal(
      readDigitalSourceType(await readFile(join(importDir, path)), "image/png"),
      types.generated,
    );
  }
  const { families } = await writeFamilies({
    importDir,
    targetDir: join(root, "target"),
    grouping: {
      status: "confirmed",
      unassigned: record.frames.map((f) => f.id).filter((id) => id < 5 || id > 10),
      families: [{ name: "walk", frames: [5, 6, 7, 8, 9, 10], reason: "synthetic" }],
    },
  });
  const result = families[0]!.result;
  assert.equal(result.validator?.accepted, true);
  assert.equal(
    readDigitalSourceType(await readFile(result.mediaPath), "image/png"),
    types.generated,
  );
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.provenance.generated.digitalSourceType, types.generated);
});

test("material recipe's model-assisted edit of hand-made pixels is composite, deterministic maps preserve origin", async () => {
  const raster = drawSubject(16);
  const provider = new ScriptedProvider({
    image: () => ({ images: [{ bytes: encodePng(raster), mediaType: "image/png" }] }),
    vision: () => ({ text: "{}" }),
  });
  const call = new Caller({
    provider,
    providerName: "scripted",
    budget: new Budget(1),
    routes: { ...defaultRoutes, "material-height": defaultRoutes.still },
  });
  const model = await runRecipeAsync(
    {
      steps: [
        {
          op: "material-height",
          params: {
            grid: { width: 16, height: 16, count: 1 },
            method: "model-assisted-painting",
            version: "1",
          },
        },
      ],
    },
    [{ name: "prop", raster, mediaType: "image/png", meta: {}, digitalSourceType: types.human }],
    { materialCall: call },
  );
  assert.equal(model.items[0]!.digitalSourceType, types.composite);
  const deterministic = await runRecipeAsync(
    {
      steps: [
        {
          op: "material-normal",
          params: {
            grid: { width: 16, height: 16, count: 1 },
            method: "height-derived-normal",
            version: "1",
          },
        },
      ],
    },
    model.items,
  );
  assert.equal(deterministic.items[0]!.digitalSourceType, types.composite);
});

test("undeclared imports stage previews but refuse target export until an identified declaration", async () => {
  const root = await mkdtemp(join(tmpdir(), "iptc-undeclared-"));
  const sheet = syntheticSheet();
  const profile = syntheticProfile({ style: { alpha: { mode: "soft" }, color: { rule: "full" } } });
  const base = {
    sheet: sheet.png,
    sheetPath: "synthetic.png",
    tool: "image generation label is not evidence",
    assetId: "prop",
    importsDir: root,
    profile,
  };
  const { record, importDir } = await importSheet(base);
  assert.equal(record.digitalSourceType, "undeclared");
  for (const file of ["contact.png", ...record.frames.map((frame) => frame.file)])
    assert.equal(
      readDigitalSourceType(await readFile(join(importDir, file)), "image/png"),
      undefined,
    );
  const grouping = {
    status: "confirmed",
    families: [{ name: "idle", frames: [1], reason: "synthetic" }],
  };
  await assert.rejects(
    writeFamilies({ importDir, grouping, targetDir: join(root, "target") }),
    /undeclared.*--digital-source-type/,
  );
  const declared = await importSheet({ ...base, digitalSourceType: types.human });
  assert.equal(declared.record.digitalSourceType, types.human);
  assert.equal(declared.record.sourceDeclaration?.value, types.human);
  assert.equal(
    declared.record.sourceDeclaration?.declaredBy,
    (await import("node:os")).userInfo().username,
  );
  const exported = await writeFamilies({
    importDir: declared.importDir,
    grouping,
    targetDir: join(root, "target"),
  });
  const manifest = JSON.parse(await readFile(exported.families[0]!.result.manifestPath, "utf8"));
  assert.deepEqual(
    manifest.provenance.generated.sourceDeclaration,
    declared.record.sourceDeclaration,
  );
  const undeclaredFile = join(root, "untagged.png");
  await writeFile(undeclaredFile, encodePng(drawSubject(16)));
  const transformed = await transformFiles({
    inputs: [undeclaredFile],
    recipe: { steps: [] },
    out: join(root, "local.png"),
  });
  assert.equal(transformed.record.outputs[0]!.digitalSourceType, "undeclared");
  assert.equal(
    readDigitalSourceType(await readFile(join(root, "local.png")), "image/png"),
    undefined,
  );
});
