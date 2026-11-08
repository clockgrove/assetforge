import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BIBLE_PRESETS,
  biblePalette,
  describeBible,
  doDontSection,
  initBible,
  loadBible,
  loadDesignColors,
  parseBible,
  serializeBible,
  validateBible,
  validateTokens,
} from "../src/bible.ts";

function base() {
  return structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
}

test("bible initializes all three repository-owned preset constitutions and skill links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bible-"));
  try {
    const renderings = new Set<string>();
    for (const preset of Object.keys(BIBLE_PRESETS)) {
      const root = join(directory, preset);
      const paths = await initBible({ directory: root, world: "Synthetic world", preset });
      const document = await loadBible(paths.biblePath);
      renderings.add(document.data.axes.rendering);
      assert.equal(document.data.preset, preset);
      assert.equal(document.data.world, "Synthetic world");
      assert.equal(document.hash.length, 64);
      assert.deepEqual(biblePalette(document.data), ["#292433", "#c49b70", "#7c93a8"]);
      assert.match(
        await readFile(paths.skillPath, "utf8"),
        /generating or reviewing art for Synthetic world/,
      );
      assert.match(await readFile(paths.templatePath, "utf8"), /\{\{constitution\}\}/);
      assert.match(
        await readFile(join(document.dir, "presets/flat-cartoon-kids.md"), "utf8"),
        /flat-cartoon/,
      );
      const described = await describeBible(paths.biblePath);
      assert.deepEqual(described.presets, Object.keys(BIBLE_PRESETS));
      assert.match(described.doDont, /positive anchors/);
      await assert.rejects(initBible({ directory: root, world: "Other", preset }), /overwrite/);
      assert.equal((await loadBible(paths.biblePath)).data.world, "Synthetic world");
    }
    assert.equal(renderings.size, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Markdown YAML retains unknown front matter and prose including Do's and Don'ts", () => {
  const data = base();
  data["future"] = { field: ["keep", "these"] };
  data.anchors.negative.push({ path: "anchors/avoid.png", role: "negative" });
  const prose =
    "# Rationale\n\nUnknown prose stays.\n\n## Do's and Don'ts\n\nDon't use [this image](anchors/avoid.png).\n\n## Future section\n\nKeep me.\n";
  const parsed = parseBible(serializeBible(data, prose));
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.prose, prose);
  assert.equal(doDontSection(prose), "Don't use [this image](anchors/avoid.png).");
  assert.throws(() => parseBible(serializeBible(data, "# No constraints")), /Do's and Don'ts/);
  assert.throws(() => parseBible("{}"), /YAML front matter/);
});

test("bible validates required axes, ordered bounds, audience, anchors and approved identity locks", () => {
  const invalid = [
    (b: ReturnType<typeof base>) => {
      b.axes.rendering = "oil" as never;
    },
    (b: ReturnType<typeof base>) => {
      b.axes.saturation = [0.8, 0.2];
    },
    (b: ReturnType<typeof base>) => {
      b.tone.audience = "adult" as never;
    },
    (b: ReturnType<typeof base>) => {
      b.adjustable.mood = ["grim"];
    },
    (b: ReturnType<typeof base>) => {
      b.anchors.negative = [{ path: "", role: "negative" }];
    },
    (b: ReturnType<typeof base>) => {
      b.tokens["light"] = { $type: "duration", $value: { value: 1, unit: "s" } };
    },
    (b: ReturnType<typeof base>) => {
      b.tokens["fog"] = { colour: b.tokens["light"], density: { $type: "number", $value: 1.1 } };
    },
    (b: ReturnType<typeof base>) => {
      b.identities["synthetic"] = {
        version: "1",
        approved: false as never,
        turnaround: "approved.png",
        signatureFeatures: ["long ears"],
        proportions: "small body",
        palette: ["#292433"],
      };
    },
  ];
  for (const mutate of invalid) {
    const b = base();
    mutate(b);
    assert.throws(() => validateBible(b));
  }
  const valid = base();
  valid.identities["synthetic"] = {
    version: "2",
    approved: true,
    turnaround: "approved.png",
    signatureFeatures: ["long ears"],
    proportions: "small body",
    palette: ["#292433"],
  };
  assert.deepEqual(validateBible(valid).identities["synthetic"], valid.identities["synthetic"]);
});

test("DTCG checks typed values, inherited types and aliases, duration and easing", () => {
  validateTokens({
    group: { $type: "number", a: { $value: 1 }, b: { $value: "{group.a}" } },
    time: { $type: "duration", $value: { value: 250, unit: "ms" } },
    easing: { $type: "cubicBezier", $value: [0.2, -1, 0.8, 2] },
  });
  for (const input of [
    { a: { $type: "number", $value: "not a number" } },
    { a: { $type: "color", $value: "#ffffff" } },
    { a: { $type: "color", $value: { colorSpace: "srgb", components: [1, 0, 3] } } },
    { a: { $type: "number", $value: "{b}" }, b: { $type: "number", $value: "{a}" } },
    { a: { $type: "number", $value: "{missing}" } },
    { a: { $type: "cubicBezier", $value: [-1, 0, 0, 1] } },
    { a: { $type: "duration", $value: { value: 1, unit: "seconds" } } },
  ])
    assert.throws(() => validateTokens(input));
});

test("DESIGN.md colors are UI context only and cannot mutate bible palette", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bible-design-"));
  try {
    await writeFile(
      join(directory, "DESIGN.md"),
      "---\ncolors:\n  accent: '#aabbcc'\n---\n# UI tokens\n",
    );
    assert.deepEqual(await loadDesignColors(directory, "portrait"), { accent: "#aabbcc" });
    assert.equal(await loadDesignColors(directory, "environment"), undefined);
    await writeFile(
      join(directory, "DESIGN.md"),
      "# UI tokens\n\n```yaml\ncolors:\n  accent: oklch(60% 0.2 40)\n  subtle: '{colors.accent}'\ncomponents:\n  secret: ignored\n```\n",
    );
    assert.deepEqual(await loadDesignColors(directory, "badge"), {
      accent: "oklch(60% 0.2 40)",
      subtle: "{colors.accent}",
    });
    assert.deepEqual(biblePalette(base()), ["#292433", "#c49b70", "#7c93a8"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
