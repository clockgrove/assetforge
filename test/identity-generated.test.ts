import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { decodeImage } from "../src/image/raster.ts";
import { generatedCases } from "./fixtures/identity-set/build.ts";
import {
  GENERATED_DIR,
  loadGeneratedManifest,
  promptFor,
} from "./fixtures/identity-set/generate.ts";
import type { GeneratedProvenance } from "./fixtures/identity-set/generate.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const manifest = await loadGeneratedManifest();
const provenance = JSON.parse(
  await readFile(new URL("provenance.json", GENERATED_DIR), "utf8"),
) as GeneratedProvenance[];
const isPng = (b: Buffer) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

test("every generated recipe is labelled from how it was made and has one provenance record", () => {
  const ids = manifest.items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of manifest.items) {
    assert.ok(["generic", "drift", "same"].includes(item.kind), item.id);
    assert.ok(item.checked, `${item.id} was checked by eye`);
    if (item.kind === "drift") {
      assert.ok(manifest.subjects.includes(item.subject!), item.id);
      // An approved reference, or a committed on-model frame of the same subject (posed drift).
      const frame = manifest.items.find((i) => item.from === `generated/${i.id}.png`);
      assert.ok(
        item.from?.startsWith(`references/${item.subject}/`) ||
          item.from?.startsWith(`crops/${item.subject}-`) ||
          (frame?.kind === "same" && frame.subject === item.subject),
        item.id,
      );
      assert.ok(item.edit && item.drift, item.id);
      assert.ok(promptFor(manifest, item).startsWith(item.edit), item.id);
    } else if (item.kind === "same") {
      // An on-model sheet frame: its subject, the sheet route, and no recipe to regenerate it.
      assert.ok(manifest.subjects.includes(item.subject!), item.id);
      assert.equal(item.route, "sheet", item.id);
      assert.throws(() => promptFor(manifest, item), /generate-sheet/);
    } else {
      assert.equal(item.subject, undefined, item.id);
      assert.equal(item.from, undefined, item.id);
      // A generic names no cast member.
      for (const name of manifest.subjects)
        assert.doesNotMatch(promptFor(manifest, item), new RegExp(name, "i"), item.id);
    }
    const records = provenance.filter((p) => p.id === item.id);
    assert.equal(records.length, 1, item.id);
    const record = records[0]!;
    if (item.kind === "same") {
      assert.ok(record.sheet?.importId && record.sheet.sheetSha256 && record.sheet.frame, item.id);
      continue;
    }
    assert.equal(record.call?.operation, item.route, item.id);
    assert.equal(record.call?.prompt, promptFor(manifest, item), item.id);
    assert.equal(record.source?.path, item.from, item.id);
  }
  // A dropped attempt is never kept under its own id.
  for (const d of manifest.dropped ?? []) assert.ok(!ids.includes(d.id), d.id);
});

test("generated images match their provenance when the LFS media is present", async (t) => {
  let checked = 0;
  for (const item of manifest.items) {
    const bytes = await readFile(new URL(`${item.id}.png`, GENERATED_DIR));
    if (!isPng(bytes)) continue;
    const record = provenance.find((p) => p.id === item.id)!;
    assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256, item.id);
    const image = decodeImage(new Uint8Array(bytes));
    assert.ok(Math.max(image.width, image.height) <= manifest.maxSide, item.id);
    checked++;
  }
  if (checked === 0) t.skip("Git LFS media not fetched");
});

test("generated cases: a generic is a negative for every cast member, drift for its own subject, a sheet frame a positive for its own", async () => {
  const dir = await mkdtemp(join(tmpdir(), "identity-generated-"));
  roots.push(dir);
  const cases = await generatedCases(dir, "art/BIBLE.md");
  const present = new Set(cases.map((c) => c.image));
  for (const c of cases) {
    const item = manifest.items.find((i) => c.image === `generated/${i.id}.png`)!;
    assert.equal(c["same"], item.kind === "same" && c["subject"] === item.subject);
    assert.equal(c["cast"], manifest.cast);
    assert.equal(c.bible, "art/BIBLE.md");
  }
  for (const item of manifest.items) {
    const mine = cases.filter((c) => c.image === `generated/${item.id}.png`);
    if (!present.has(`generated/${item.id}.png`)) continue;
    const subjects = mine.map((c) => c["subject"]).sort();
    assert.deepEqual(
      subjects,
      item.kind === "drift" ? [item.subject] : [...manifest.subjects].sort(),
    );
    for (const c of mine) {
      if (item.family)
        assert.match(String(c["describe"]), new RegExp(`"${item.family}" animation`));
      else assert.equal(c["describe"], undefined, item.id);
      assert.equal(
        c["kind"],
        item.kind !== "same" ? item.kind : c["subject"] === item.subject ? "same" : "lookalike",
      );
    }
  }
});
