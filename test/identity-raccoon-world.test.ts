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
  assert.ok(url.includes(`/${manifest.repository}/${manifest.commit}/references/`), url);
  const raster = createRaster(12, 10);
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 12; x++) setPixel(raster, x, y, [40 + x * 10, 90 + y * 5, 150, 255]);
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
  assert.equal(bible.data.identities["stevie"]?.version, "2");
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
  const drift = cases.filter((c) => c.kind === "drift");
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

test("every manifest path is in a listed reference folder and no lock reference is a same-subject candidate", () => {
  const folders = ["stevie", "gracie", "jimothy", "poses"].map((f) => `references/${f}/`);
  const paths = [
    ...manifest.images.map((i) => i.path),
    ...manifest.drift.map((d) => d.from),
    ...manifest.conflict.positives,
    ...manifest.conflict.negatives,
  ];
  for (const p of paths)
    assert.ok(
      folders.some((f) => p.startsWith(f)),
      p,
    );
  for (const [name, lock] of Object.entries(manifest.bible.identities)) {
    const refs = [lock.turnaround, ...(lock.references ?? [])].map((r) => r.replace("../", ""));
    for (const i of manifest.images)
      if (i.subject === name) assert.ok(!refs.includes(i.path), i.path);
  }
});
