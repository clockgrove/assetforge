import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadBible } from "../src/bible.ts";
import { decodeImage } from "../src/image/raster.ts";
import { BIRDS, buildBirdCastSet, type BirdParams } from "./fixtures/identity-set/birds.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function build() {
  const dir = await mkdtemp(join(tmpdir(), "identity-cast-"));
  roots.push(dir);
  return { dir, set: await buildBirdCastSet(dir) };
}

const paramsOf = (note: string | undefined) =>
  JSON.parse(/params=(\{.*\})$/.exec(note ?? "")![1]!) as BirdParams;

test("the bird cast covers every kind for every subject, labelled from how each image was made", async () => {
  const { set } = await build();
  const plain = set.cases.filter((c) => !c.conflict);
  for (const subject of Object.keys(BIRDS))
    for (const kind of ["same", "drift", "generic", "lookalike"])
      assert.ok(
        plain.some((c) => c.subject === subject && c.kind === kind),
        `${subject} ${kind}`,
      );
  for (const c of set.cases) {
    assert.equal(c.same, c.kind === "same");
    assert.ok(c.note);
  }
  assert.ok(plain.every((c) => c.cast === "pebble-birds" && c.medium === "2d"));
});

test("every image decodes and none is byte-identical to a reference", async () => {
  const { dir, set } = await build();
  const { data } = await loadBible(set.biblePath);
  const refBytes = new Set<string>();
  for (const lock of Object.values(data.identities))
    for (const ref of [lock.turnaround, ...(lock.references ?? [])])
      refBytes.add((await readFile(join(dir, ref))).toString("base64"));
  assert.equal(refBytes.size, 2 * Object.keys(BIRDS).length);
  for (const c of set.cases) {
    const bytes = await readFile(join(dir, c.image));
    assert.equal(decodeImage(bytes).width, 256);
    assert.ok(!refBytes.has(bytes.toString("base64")), c.image);
  }
});

test("generic birds match no cast member's parameters", async () => {
  const { set } = await build();
  const generics = set.cases.filter((c) => c.kind === "generic");
  assert.ok(generics.length >= 9);
  for (const c of generics) {
    const p = paramsOf(c.note);
    for (const bird of Object.values(BIRDS)) assert.notDeepEqual(p, bird, c.image);
  }
});

test("the conflict bible's record contradicts its own references", async () => {
  const { set } = await build();
  const accurate = (await loadBible(set.biblePath)).data.identities["fern"]!;
  const conflicting = (await loadBible(set.conflictBiblePath)).data.identities["fern"]!;
  assert.deepEqual(conflicting.references, accurate.references);
  assert.notDeepEqual(conflicting.signatureFeatures, accurate.signatureFeatures);
  const conflictCases = set.cases.filter((c) => c.conflict);
  assert.equal(conflictCases.filter((c) => c.kind === "same").length, 2);
  assert.equal(conflictCases.filter((c) => c.kind === "lookalike").length, 2);
  assert.ok(conflictCases.every((c) => c.cast === "pebble-birds-conflict"));
});

test("the build is deterministic and the bible's references exist", async () => {
  const a = await build();
  const b = await build();
  assert.deepEqual(a.set.cases, b.set.cases);
  for (const file of ["BIBLE.md", ...a.set.cases.map((c) => c.image)])
    assert.deepEqual(await readFile(join(a.dir, file)), await readFile(join(b.dir, file)), file);
  const { data } = await loadBible(a.set.biblePath);
  assert.equal(Object.keys(data.identities).length, 3);
  for (const lock of Object.values(data.identities)) {
    assert.ok(lock.references?.length);
    for (const ref of [lock.turnaround, ...lock.references!]) await readFile(join(a.dir, ref));
  }
});
