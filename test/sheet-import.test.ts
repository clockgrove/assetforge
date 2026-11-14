import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget, BudgetExceededError } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import type { ImageRequest, VisionRequest } from "../src/gateway/provider.ts";
import { decodePng, getPixel } from "../src/image/raster.ts";
import { loadBibleInputs, sha256 } from "../src/request.ts";
import { defaultRoutes } from "../src/routes.ts";
import { generateSheet, motionLines, sheetBrief } from "../src/sheet/generate.ts";
import { templateFor, templatesFor } from "../src/animation/templates.ts";
import { SliceError } from "../src/sheet/slice.ts";
import { GROUPING_FILE, importSheet, writeFamilies } from "../src/sheet/import.ts";
import { jitterOf } from "../src/sheet/register.ts";
import type { Grouping } from "../src/sheet/types.ts";
import type { AssetSpec, FrameProvenance, TargetProfile } from "../src/types.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { PALETTE, syntheticProfile, syntheticWorld } from "./fixtures/synthetic.ts";

/** A painterly target: soft 8-bit alpha, full colour; the style passes through to the manifest. */
function painterlyProfile(): TargetProfile {
  const base = syntheticProfile();
  return {
    ...base,
    style: { alpha: { mode: "soft" }, color: { rule: "full" } },
    manifest: {
      ...(base.manifest as Record<string, unknown>),
      style: "{{profile.style?}}",
    },
  };
}

/** A pixel-art target: binary alpha, a fixed palette, crisp edges. */
function pixelArtProfile(): TargetProfile {
  const base = syntheticProfile();
  return {
    ...base,
    style: {
      alpha: { mode: "binary", threshold: 128 },
      color: { rule: "palette", palette: PALETTE },
      edges: "crisp",
    },
    manifest: { ...(base.manifest as Record<string, unknown>), style: "{{profile.style?}}" },
  };
}

const PROPOSAL = {
  families: [
    { name: "idle", frames: [1, 2, 3, 4], reason: "standing still, facing right" },
    { name: "walk-right", frames: [5, 6, 7, 8, 9, 10], reason: "legs swing, facing right" },
    {
      name: "walk-left",
      frames: [11, 12, 13, 14, 15, 16],
      reason: "the same walk facing left",
    },
  ],
  unassigned: [],
  notes: "walk-left could be walk-right mirrored",
};

function groupingProvider(sheetPng?: Uint8Array): ScriptedProvider {
  return new ScriptedProvider({
    image: () => ({
      images: [{ mediaType: "image/png", bytes: sheetPng ?? new Uint8Array() }],
      costUsd: 0.21,
    }),
    vision: () => ({ text: "```json\n" + JSON.stringify(PROPOSAL) + "\n```", costUsd: 0.01 }),
  });
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function dirs() {
  const root = await mkdtemp(join(tmpdir(), "assetgrove-sheet-"));
  const targetDir = join(root, "target");
  await mkdir(targetDir);
  return { root, importsDir: join(root, "imports"), targetDir };
}

test("an imported sheet is sliced, cleaned to soft alpha, grouped by proposal, and written per confirmed family", async () => {
  const sheet = syntheticSheet();
  const { importsDir, targetDir } = await dirs();
  const provider = groupingProvider();
  const call = new Caller({
    provider,
    providerName: "scripted",
    budget: new Budget(5),
    routes: defaultRoutes,
  });
  const profile = painterlyProfile();

  // 1. It finds every figure and cleans it; the labels are stripped.
  const { record, importDir, grouping } = await importSheet({
    digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
    sheet: sheet.png,
    sheetPath: "sheets/jimothy-like.png",
    tool: "ChatGPT image generation",
    assetId: "stevie",
    profile,
    importsDir,
    importId: "imp1",
    propose: { call, hints: ["idle", "walk-right", "walk-left"] },
  });
  assert.equal(record.slice.mode, "grid");
  assert.equal(record.frames.length, 16);
  assert.deepEqual(
    record.frames.map((f) => [f.cell.row, f.cell.column]),
    sheet.figures.map((f) => [f.row, f.column]),
  );
  for (const f of record.frames) {
    assert.ok(
      f.checks.every((c) => c.passed),
      `frame ${f.id}: ${JSON.stringify(f.checks)}`,
    );
    assert.ok(f.transforms.some((t) => t.op === "strip-labels"));
    assert.ok(await exists(join(importDir, f.file)));
  }
  assert.ok(await exists(join(importDir, "contact.png")));

  // 3. The vision model proposed families from the numbered contact sheet; nothing is accepted.
  const vision = provider.calls.find((c) => c.kind === "vision")!.request as VisionRequest;
  assert.deepEqual(
    Buffer.from(vision.images[0]!.bytes),
    await readFile(join(importDir, "contact.png")),
  );
  assert.match(vision.prompt, /walk-right/);
  assert.equal(grouping.status, "proposed");
  assert.deepEqual(
    grouping.families.map((f) => f.name),
    ["idle", "walk-right", "walk-left"],
  );
  assert.equal(record.calls.length, 1);
  const saved = JSON.parse(await readFile(join(importDir, GROUPING_FILE), "utf8")) as Grouping;
  assert.equal(saved.status, "proposed");

  // An unconfirmed proposal never reaches the target.
  await assert.rejects(writeFamilies({ importDir, grouping: saved, targetDir }), /confirmed/);
  assert.equal(await exists(join(targetDir, "assets")), false);

  // 4. The author confirms, choosing to mirror walk-right for walk-left.
  const confirmed: Grouping = {
    ...saved,
    status: "confirmed",
    families: [
      saved.families[0]!,
      saved.families[1]!,
      { name: "walk-left", mirrorOf: "walk-right", reason: "mirror of walk-right" },
    ],
  };

  // 5. One strip, manifest and provenance per family, review pending, validator accepting.
  const written = await writeFamilies({ importDir, grouping: confirmed, targetDir });
  assert.deepEqual(
    written.families.map((f) => [f.name, f.frames.length, f.mirrored]),
    [
      ["idle", 4, false],
      ["walk-right", 6, false],
      ["walk-left", 6, true],
    ],
  );
  for (const family of written.families) {
    assert.equal(family.result.validator?.accepted, true, family.result.validator?.output);
    assert.ok(family.jitterPx <= 1, `${family.name} jitter ${family.jitterPx}`);
    const manifest = JSON.parse(await readFile(family.result.manifestPath, "utf8"));
    assert.equal(manifest.review.status, "pending");
    assert.equal(manifest.animationFamily, family.name);
    assert.deepEqual(manifest.frames, {
      count: family.frames.length,
      width: 32,
      height: 32,
      durationMs: 250,
    });
    assert.equal(manifest.palette, undefined, "full colour declares no palette");
    const bytes = await readFile(family.result.mediaPath);
    assert.equal(manifest.contentHash, sha256(bytes));
    const strip = decodePng(bytes);
    assert.equal(strip.width, 32 * family.frames.length);

    // Soft 8-bit alpha, no palette quantization.
    const alphas = new Set<number>();
    const colours = new Set<string>();
    for (let i = 0; i < strip.data.length; i += 4) {
      alphas.add(strip.data[i + 3]!);
      if (strip.data[i + 3]) colours.add(strip.data.slice(i, i + 3).join());
    }
    assert.ok([...alphas].filter((a) => a > 0 && a < 255).length > 10, "soft alpha kept");
    assert.ok(colours.size > PALETTE.length * 4, `full colour kept (${colours.size})`);

    // The loop doesn't jitter: every frame's feet and centre sit on the anchor.
    const frames = Array.from({ length: family.frames.length }, (_, f) => {
      const r = { width: 32, height: 32, data: new Uint8Array(32 * 32 * 4) };
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          r.data.set(getPixel(strip, f * 32 + x, y), (y * 32 + x) * 4);
        }
      }
      return r;
    });
    assert.ok(jitterOf(frames, { x: 16, y: 31 }).maxPx <= 1);

    // Provenance per frame: sheet hash, cell, transforms and the tool that made the sheet.
    const provenance = manifest.provenance.generated;
    assert.equal(provenance.generator, "sheet-import");
    assert.equal(provenance.sheet.sha256, sha256(sheet.png));
    assert.equal(provenance.sheet.tool, "ChatGPT image generation");
    assert.ok(provenance.models.includes("ChatGPT image generation"));
    assert.equal(provenance.frames.length, family.frames.length);
    provenance.frames.forEach((fp: FrameProvenance, i: number) => {
      assert.equal(fp.index, i);
      assert.equal(fp.frame, family.frames[i]);
      assert.equal(fp.sheetSha256, sha256(sheet.png));
      assert.equal(fp.tool, "ChatGPT image generation");
      const truth = sheet.figures[fp.frame - 1]!;
      assert.deepEqual([fp.cell.row, fp.cell.column], [truth.row, truth.column]);
      const ops = fp.transforms.map((t) => t.op);
      for (const op of ["crop", "strip-labels", "matte", "normalize-scale", "scale", "place"]) {
        assert.ok(ops.includes(op), `frame ${fp.frame} lacks ${op}: ${ops.join(",")}`);
      }
      assert.equal(ops.includes("mirror"), family.mirrored);
    });
  }
  const preview = await readFile(written.previewPath, "utf8");
  for (const name of ["idle", "walk-right", "walk-left"]) assert.match(preview, new RegExp(name));

  // A later write with another grouping reuses the import's common scale, so families match in size.
  const scaleOf = async (path: string) =>
    JSON.parse(await readFile(path, "utf8")).provenance.generated.parameters.commonScale as number;
  const first = await scaleOf(written.families[0]!.result.manifestPath);
  const stored = JSON.parse(await readFile(join(importDir, "import.json"), "utf8")).scale;
  assert.equal(stored, first);
  const again = await writeFamilies({
    importDir,
    grouping: { ...confirmed, families: [{ ...saved.families[0]!, name: "idle-only" }] },
    targetDir: await mkdtemp(join(tmpdir(), "af-target-")),
  });
  assert.equal(await scaleOf(again.families[0]!.result.manifestPath), first);
});

test("a family over the jitter bound is refused, and nothing is written", async () => {
  const sheet = syntheticSheet();
  const { importsDir, targetDir } = await dirs();
  const { importDir } = await importSheet({
    digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
    sheet: sheet.png,
    sheetPath: "sheet.png",
    tool: "hand drawn",
    assetId: "stevie",
    profile: painterlyProfile(),
    importsDir,
  });
  const grouping: Grouping = {
    status: "confirmed",
    families: [{ name: "idle", frames: [1, 2, 3, 4], reason: "author's grouping" }],
    unassigned: [],
  };
  await assert.rejects(
    writeFamilies({ importDir, grouping, targetDir, jitterBoundPx: 0.001 }),
    /jitter over the 0.001 px bound in idle/,
  );
  assert.equal(await exists(join(targetDir, "assets")), false);
});

test("a gridless sheet imports by connected components, and a pixel-art profile gets binary alpha and its palette", async () => {
  const sheet = syntheticSheet({ layout: "scatter" });
  const { importsDir, targetDir } = await dirs();
  const { record, importDir } = await importSheet({
    digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
    sheet: sheet.png,
    sheetPath: "scatter.png",
    tool: "hand drawn",
    assetId: "stevie",
    profile: pixelArtProfile(),
    importsDir,
  });
  assert.equal(record.slice.mode, "components");
  assert.equal(record.frames.length, 16);
  const grouping: Grouping = {
    status: "confirmed",
    families: [{ name: "walk-right", frames: [5, 6, 7, 8, 9, 10], reason: "author's grouping" }],
    unassigned: [],
  };
  const written = await writeFamilies({ importDir, grouping, targetDir });
  const family = written.families[0]!;
  assert.equal(family.result.validator?.accepted, true, family.result.validator?.output);
  const strip = decodePng(await readFile(family.result.mediaPath));
  for (let i = 0; i < strip.data.length; i += 4) {
    assert.ok(strip.data[i + 3] === 0 || strip.data[i + 3] === 255);
  }
  const manifest = JSON.parse(await readFile(family.result.manifestPath, "utf8"));
  assert.ok(manifest.palette.every((hex: string) => PALETTE.includes(hex)));
});

test("sheet generation: one request for the whole cycle within the cap, then the same import path", async () => {
  const world = await syntheticWorld();
  const { importsDir, targetDir } = await dirs();
  const sheet = syntheticSheet({
    families: [{ name: "walk-right", count: 6, facing: 1, walk: true }],
    columns: 3,
  });
  const spec: AssetSpec = {
    kind: "sprite-sheet",
    assetId: "stevie",
    animationFamily: "walk",
    frames: { count: 6 },
    // Target fields the spec carries for its family; write-families must hand them to the templates.
    fields: {
      semantic: { role: "actor", entity: "grove.stevie" },
      accessibilityLabel: "Stevie walking",
    },
  };
  const options = {
    spec,
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile: painterlyProfile(),
    routes: defaultRoutes,
    providerName: "scripted",
    importsDir,
  };

  // Refused before any provider call when the sheet and its grouping would exceed the cap.
  const refusedProvider = groupingProvider(sheet.png);
  await assert.rejects(
    generateSheet({ ...options, provider: refusedProvider, capUsd: 0.1 }),
    BudgetExceededError,
  );
  assert.equal(refusedProvider.calls.length, 0);

  const provider = new ScriptedProvider({
    image: () => ({ images: [{ mediaType: "image/png", bytes: sheet.png }], costUsd: 0.21 }),
    vision: () => ({
      text: JSON.stringify({
        families: [{ name: "walk", frames: [1, 2, 3, 4, 5, 6], reason: "one walk cycle" }],
        unassigned: [],
      }),
      costUsd: 0.01,
    }),
  });
  const { record, importDir, grouping, spentUsd } = await generateSheet({ ...options, provider });
  assert.ok(spentUsd <= 5);
  const images = provider.calls.filter((c) => c.kind === "image");
  assert.equal(images.length, 1, "one request for the whole cycle");
  const request = images[0]!.request as ImageRequest;
  assert.equal(request.model, defaultRoutes.sheet.model);
  assert.match(request.prompt, /"walk" animation cycle of 6 frames/);
  // The family's motion template is stated; a walk moves, so no held-pose line.
  assert.match(request.prompt, /Motion: a walk cycle/);
  assert.doesNotMatch(request.prompt, /Hold the pose/);
  assert.match(request.prompt, /grey adult raccoon/);
  for (const hex of PALETTE) assert.ok(request.prompt.includes(hex));
  // The bible's subject references, perspective sample and palette swatch, exactly and in order.
  const inputs = await loadBibleInputs(options.spec, world.bible, world.bibleDir);
  assert.deepEqual(
    request.references.map((r) => sha256(r.bytes)),
    [...inputs.subject, inputs.perspective, inputs.palette].map((r) => r.sha256),
  );
  assert.equal(record.frames.length, 6);
  assert.equal(record.sheet.tool, defaultRoutes.sheet.model);
  assert.equal(grouping.status, "proposed");

  const written = await writeFamilies({
    importDir,
    grouping: { ...grouping, status: "confirmed" },
    targetDir,
  });
  const family = written.families[0]!;
  assert.equal(family.result.validator?.accepted, true, family.result.validator?.output);
  const manifest = JSON.parse(await readFile(family.result.manifestPath, "utf8"));
  const provenance = manifest.provenance.generated;
  assert.deepEqual(provenance.models, [defaultRoutes.sheet.model, defaultRoutes.vision.model]);
  assert.match(provenance.prompt, /contact sheet/);
  assert.equal(provenance.calls.length, 2);
  assert.equal(provenance.costUsd, 0.22);
  assert.equal(provenance.frames[0].tool, defaultRoutes.sheet.model);
  // The spec's fields reach the family it asked for, not a generic default.
  assert.equal(manifest.accessibilityLabel, "Stevie walking");
  assert.deepEqual(manifest.semantic, { role: "actor", entity: "grove.stevie" });
});

test("sheet generation refuses a sheet with another frame count and keeps it", async () => {
  const world = await syntheticWorld();
  const { importsDir } = await dirs();
  // The model drew 6 figures; the spec asks for 8.
  const sheet = syntheticSheet({
    families: [{ name: "walk-right", count: 6, facing: 1, walk: true }],
    columns: 3,
  });
  const provider = groupingProvider(sheet.png);
  await assert.rejects(
    generateSheet({
      spec: {
        kind: "sprite-sheet",
        assetId: "stevie",
        animationFamily: "walk",
        frames: { count: 8 },
      },
      specDir: world.dir,
      bible: world.bible,
      bibleDir: world.bibleDir,
      profile: painterlyProfile(),
      routes: defaultRoutes,
      provider,
      providerName: "scripted",
      importsDir,
      importId: "short",
    }),
    (error: unknown) => {
      assert.ok(error instanceof SliceError);
      assert.equal(error.found, 6);
      assert.equal(error.expected, 8);
      assert.equal(error.spentUsd, 0.21);
      assert.equal(error.kept, join(importsDir, "short", "sheet.png"));
      assert.match(error.message, /found 6 figures on the sheet where 8 are asked for/);
      return true;
    },
  );
  // No grouping call was made for a sheet that cannot be used.
  assert.deepEqual(
    provider.calls.map((c) => c.kind),
    ["image"],
  );
  assert.ok(await exists(join(importsDir, "short", "sheet.png")));
  assert.equal(await exists(join(importsDir, "short", "import.json")), false);
  const kept = JSON.parse(await readFile(join(importsDir, "short", "sheet.json"), "utf8"));
  assert.equal(kept.sheet.sha256, sha256(sheet.png));
  assert.equal(kept.generation.calls.length, 1);
  assert.deepEqual([kept.slice.found, kept.slice.expected], [6, 8]);
});

test("the sheet prompt states a held family's motion and the author's brief", () => {
  const shelter = templateFor("shelter", templatesFor());
  const brief = sheetBrief({
    purpose: "animation strip: the shelter family, one looping cycle",
    appearsIn: "the yard at dusk in the rain",
    context:
      "Rain has started; the raccoon hunkers down, hunched low, a small shiver, tail wrapped close.",
  });
  const lines = motionLines(shelter, brief).join("\n");
  assert.match(
    lines,
    /Motion: huddled in cover, a small tremble\. Beats, in order: huddle from the first frame, then tremble about 50% through\./,
  );
  assert.match(lines, /Hold the pose for the whole cycle/);
  assert.match(lines, /The cycle loops/);
  assert.match(lines, /Purpose: animation strip/);
  assert.match(lines, /Seen in: the yard at dusk/);
  assert.match(lines, /What happens: Rain has started; .*a small shiver/);
  // No template and no brief: nothing added.
  assert.deepEqual(motionLines(undefined, undefined), []);
  // A brief is checked as plan checks it.
  assert.throws(() => sheetBrief({ style: "flat" }), /unsupported brief field style/);
  assert.throws(() => sheetBrief({ context: 3 }), /brief context must be a string/);
  assert.throws(() => sheetBrief(["x"]), /brief must be an object/);
});
