import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadBible } from "../src/bible.ts";
import { createRaster, decodeImage, encodePng, setPixel } from "../src/image/raster.ts";
import { buildRaccoonWorldSet } from "./fixtures/identity-set/raccoon-world.ts";
import type { RaccoonWorldManifest } from "./fixtures/identity-set/raccoon-world.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const manifest = JSON.parse(
  await readFile(new URL("./fixtures/identity-set/raccoon-world.json", import.meta.url), "utf8"),
) as RaccoonWorldManifest;

const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  const base = `/${manifest.repository}/${manifest.commit}/`;
  assert.ok(
    url.includes(`${base}references/`) || url.includes(`${base}docs/design/reference/`),
    url,
  );
  const raster = createRaster(12, 10);
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 12; x++) setPixel(raster, x, y, [40 + x * 10, 90 + y * 5, 150, 255]);
  if (/\/(strip|jimothy-sprite-sheet)\.png$/.test(url)) {
    const big = createRaster(1536, 1840);
    for (let i = 0; i < big.data.length; i += 4) big.data.set([90, 80, 70, 255], i);
    return new Response(encodePng(big));
  }
  return new Response(encodePng(raster));
};

async function build() {
  const dir = await mkdtemp(join(tmpdir(), "raccoon-world-"));
  roots.push(dir);
  return { dir, ...(await buildRaccoonWorldSet(dir, { fetch: fakeFetch })) };
}

test("the Raccoon World set builds from the manifest with loadable bibles and every kind", async () => {
  const { biblePath, conflictBiblePath, cases } = await build();
  const bible = await loadBible(biblePath);
  assert.equal(bible.data.identities["stevie"]?.version, "3");
  assert.ok(bible.data.identities["jimothy"]);
  const conflict = await loadBible(conflictBiblePath);
  const record = conflict.data.identities["stevie"]!;
  assert.equal(record.version, "1-text");
  assert.match(record.proportions, /lean, upright, long-bodied, long legs/);
  assert.equal(
    conflict.data.identities["stevie"]?.turnaround,
    bible.data.identities["stevie"]?.turnaround,
  );
  for (const kind of ["same", "lookalike", "generic", "drift"])
    assert.ok(
      cases.some((c) => c.kind === kind),
      kind,
    );
  assert.ok(cases.some((c) => c.medium === "3d") && cases.some((c) => c.medium === "2d"));
  assert.ok(cases.some((c) => c.cast === "raccoon-world-conflict" && c.same));
  assert.ok(cases.some((c) => c.cast === "raccoon-world-conflict" && !c.same));
});

test("drift images differ from their sources and are labelled different", async () => {
  const { dir, cases } = await build();
  // The edited drift cases (a defective crop is drift too, but it is a crop, not an edit).
  const drift = cases.filter((c) => c.kind === "drift" && !c.image.startsWith("crops/"));
  assert.equal(drift.length, manifest.drift.length);
  for (const [index, c] of drift.entries()) {
    assert.equal(c.same, false);
    const spec = manifest.drift[index]!;
    const before = decodeImage(await readFile(join(dir, spec.from)));
    const after = decodeImage(await readFile(join(dir, c.image)));
    const differs =
      before.width !== after.width ||
      before.height !== after.height ||
      Buffer.compare(Buffer.from(before.data), Buffer.from(after.data)) !== 0;
    assert.ok(differs, c.image);
    if (spec.edit === "stretch-wide") assert.ok(after.width > before.width);
    if (spec.edit === "stretch-tall") assert.ok(after.height > before.height);
  }
});

test("every manifest path is in a listed reference folder and no cast member's lock reference is a candidate", () => {
  const folders = [
    ...["stevie", "gracie", "jimothy", "poses"].map((f) => `references/${f}/`),
    "docs/design/reference/",
  ];
  const paths = [
    ...manifest.images.map((i) => i.path),
    ...manifest.drift.map((d) => d.from),
    ...manifest.crops.map((c) => c.from),
    ...manifest.conflict.positives,
    ...manifest.conflict.negatives,
  ];
  for (const p of paths)
    assert.ok(
      folders.some((f) => p.startsWith(f)),
      p,
    );
  // The cast question shows every member's lock references beside the candidate, so a lock
  // reference used as any case's candidate would be answered by image identity.
  const lockRefs = Object.values(manifest.bible.identities).flatMap((lock) =>
    [lock.turnaround, ...(lock.references ?? [])].map((r) => r.replace("../", "")),
  );
  for (const i of manifest.images) assert.ok(!lockRefs.includes(i.path), i.path);
  for (const p of [...manifest.conflict.positives, ...manifest.conflict.negatives])
    assert.ok(!lockRefs.includes(p), p);
});

test("crops yield one same case and one look-alike per other identity, at grid size, never a lock cell", async () => {
  const { dir, cases } = await build();
  const subjects = Object.keys(manifest.bible.identities);
  const total = manifest.crops.reduce((n, c) => n + c.cells.length, 0);
  const cropCases = cases.filter((c) => c.image.startsWith("crops/"));
  assert.equal(cropCases.length, total * subjects.length);
  const sheet = manifest.crops.find((c) => c.from.endsWith("jimothy-sprite-sheet.png"))!;
  assert.ok(!sheet.cells.includes(3));
  for (const crop of manifest.crops)
    for (const cell of crop.cells) {
      const image = `crops/${crop.subject}-${crop.name}-${cell}.png`;
      const mine = cropCases.filter((c) => c.image === image);
      assert.equal(mine.length, subjects.length, image);
      const own = mine.filter((c) => c.subject === crop.subject);
      assert.equal(own.length, 1);
      assert.equal(own[0]!.same, !crop.defect);
      assert.equal(own[0]!.kind, crop.defect ? "drift" : "same");
      const others = mine.filter((c) => c.subject !== crop.subject);
      assert.deepEqual(
        others.map((c) => c.subject).sort(),
        subjects.filter((s) => s !== crop.subject).sort(),
      );
      assert.ok(others.every((c) => !c.same && c.kind === "lookalike"));
      const raster = decodeImage(await readFile(join(dir, image)));
      assert.equal(raster.width, crop.grid.width);
      assert.equal(raster.height, crop.grid.height);
    }
});

test("every generated strip frame carries its own eye check; a measured defect makes it drift, with the defect in the note", async () => {
  const strips = manifest.crops.filter((c) => c.from.includes("comparison-candidates/"));
  assert.ok(strips.length > 0);
  for (const crop of strips)
    for (const cell of crop.cells)
      assert.match(
        crop.checked?.[String(cell)] ?? "",
        /^\d{4}-\d{2}-\d{2}, by eye/,
        `${crop.name} ${cell}`,
      );
  const { cases } = await build();
  const frame = cases.find((c) => c.subject === "stevie" && c.image === `crops/stevie-walk-3.png`)!;
  assert.equal(frame.same, false);
  assert.equal(frame.kind, "drift");
  assert.match(
    frame.note ?? "",
    /\(checked 2026-11-11, by eye against the turnaround: Stevie, walk frame 3.*; defect: see-through holes in the face/,
  );
});
