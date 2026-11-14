import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BIBLE_PRESETS, serializeBible, validateBible } from "../src/bible.ts";
import { createPlan } from "../src/planning.ts";
import { buildStillPrompt, loadBibleInputs } from "../src/request.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import { syntheticWorld } from "./fixtures/synthetic.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
const grid = { frame: { width: 64, height: 64 }, count: 1 };

test("a spec's look adds that look's notes and references, and no other look's", async () => {
  const world = await syntheticWorld();
  roots.push(world.dir);
  const bible = structuredClone(world.bible);
  bible.notes = ["shared: soft rim light"];
  bible.looks = {
    character: { notes: ["characters: naturalistic fur, no visible brushwork"] },
    environment: { notes: ["environment: soft visible brushwork"] },
  };
  bible.references.push(
    {
      path: "refs/fern-sheet.png",
      role: "character look anchor",
      subject: "fern",
      look: "character",
    },
    { path: "refs/den.png", role: "brushwork anchor", subject: "fern", look: "environment" },
  );
  const spec = { kind: "still", assetId: "fern-idle", subject: "fern", look: "character" };
  const refs = await loadBibleInputs(spec, bible, world.bibleDir);
  assert.deepEqual(
    refs.subject.map((r) => r.role),
    ["character sheet", "turnaround", "character look anchor"],
  );
  const prompt = buildStillPrompt(spec, bible, grid, refs);
  assert.match(prompt, /Style note: shared: soft rim light/);
  assert.match(prompt, /Style note: characters: naturalistic fur/);
  assert.doesNotMatch(prompt, /environment: soft visible brushwork/);

  // Without a look, only shared notes and untagged references apply.
  const plain = { kind: "still", assetId: "fern-idle", subject: "fern" };
  const plainRefs = await loadBibleInputs(plain, bible, world.bibleDir);
  assert.deepEqual(
    plainRefs.subject.map((r) => r.role),
    ["character sheet", "turnaround"],
  );
  assert.doesNotMatch(buildStillPrompt(plain, bible, grid, plainRefs), /characters:|environment:/);

  await assert.rejects(
    loadBibleInputs({ ...spec, look: "interiors" }, bible, world.bibleDir),
    /declares no look "interiors"/,
  );
});

test("an art bible's look overrides axes and anchors for specs that name it", async () => {
  const root = await mkdtemp(join(tmpdir(), "looks-"));
  roots.push(root);
  const dir = join(root, ".assetgrove/art-direction");
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, ".assetgrove/prompts"), { recursive: true });
  await writeFile(join(dir, "brush.png"), encodePng(createRaster(2, 2)));
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  data.world = "Woodland";
  data.looks = {
    character: { rendering: "naturalistic", texture: "smooth naturalistic coat, no brushwork" },
  };
  data.anchors.positive = [
    { path: "brush.png", role: "environment brushwork", look: "environment" },
  ];
  assert.throws(() => validateBible(data), /undeclared look environment/);
  data.looks["environment"] = {};
  assert.throws(
    () => validateBible({ ...data, looks: { character: { palette: "red" } } }),
    /looks.character.palette is not a style axis/,
  );
  const biblePath = join(dir, "BIBLE.md");
  await writeFile(biblePath, serializeBible(data, "## Do's and Don'ts\nDo stay original.\n"));
  const templatePath = join(root, ".assetgrove/prompts/default.md");
  await writeFile(templatePath, "{{constitution}}\n{{spec}}\n");
  const settings = { candidates: 1, capUsd: 2 };

  const character = await createPlan({
    biblePath,
    templatePath,
    settings,
    spec: { kind: "still", assetId: "fox", look: "character" },
  });
  assert.match(character.prompt, /"rendering":"naturalistic"/);
  assert.match(character.prompt, /smooth naturalistic coat/);
  assert.ok(!character.references.some((r) => r.role.includes("environment brushwork")));

  const environment = await createPlan({
    biblePath,
    templatePath,
    settings,
    spec: { kind: "still", assetId: "glade", look: "environment" },
  });
  assert.match(environment.prompt, /"rendering":"painterly"/);
  assert.ok(environment.references.some((r) => r.role.includes("environment brushwork")));

  await assert.rejects(
    createPlan({
      biblePath,
      templatePath,
      settings,
      spec: { kind: "still", assetId: "x", look: "sky" },
    }),
    /declares no look "sky"/,
  );
});
