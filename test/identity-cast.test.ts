import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadBible } from "../src/bible.ts";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import {
  identityCastPrompt,
  identitySettings,
  parseCastAnswer,
  scoreIdentity,
  type CastMember,
} from "../src/identity.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import { sha256 } from "../src/request.ts";
import { defaultRoutes } from "../src/routes.ts";
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

test("held-out animation poses: each bird has one on-model frame and one drift per pose, the pose named and the drift not", async () => {
  const { set } = await build();
  for (const run of ["#104 run 6", "#104 run 7"]) {
    const held = set.cases.filter((c) => c.heldOut === run);
    for (const name of Object.keys(BIRDS)) {
      const mine = held.filter((c) => c.subject === name);
      assert.equal(mine.filter((c) => c.kind === "same").length, 4, name);
      assert.equal(mine.filter((c) => c.kind === "drift").length, 4, name);
      for (const c of mine) {
        assert.match(c.describe ?? "", /^a frame of one character's "[a-z-]+" animation$/);
        // A posed positive keeps every feature the record names; posed drift changes one.
        if (c.kind === "same") assert.deepEqual(paramsOf(c.note), BIRDS[name]);
        else assert.notDeepEqual(paramsOf(c.note), BIRDS[name]);
      }
    }
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

function member(subject: string): CastMember {
  const bytes = encodePng(createRaster(8, 8));
  return {
    record: {
      subject,
      version: `${subject}-1`,
      sha256: sha256(Buffer.from(subject)),
      fingerprint: {
        signatureFeatures: ["ringed tail"],
        proportions: "stocky",
        palette: ["#808080"],
      },
      references: [],
    },
    references: [
      {
        role: "identity:approved-reference",
        path: `${subject}.png`,
        mediaType: "image/png",
        bytes,
        sha256: sha256(bytes),
      },
    ],
  };
}

test("the cast prompt accepts posture and animation differences, asks for them apart, and still counts drift", () => {
  const prompt = identityCastPrompt(
    [member("mina")],
    "mina",
    'a numbered contact sheet of 8 frames of one character, from its "walk" animation',
  );
  assert.match(prompt, /from its "walk" animation/);
  assert.match(prompt, /may name its animation/);
  assert.match(prompt, /as it would look if the candidate stood in the references' pose/);
  assert.match(prompt, /a back arched or hunched mid-stride/);
  assert.match(prompt, /a tail lowered, raised, swung, curled or foreshortened/);
  assert.match(prompt, /is NOT a deviation/);
  assert.match(prompt, /do not let them lower onModel/);
  assert.match(prompt, /variation between two drawings of the same model/);
  // Drift still counts: markings, colours, counts, proportions beyond the pose, signature features.
  assert.match(prompt, /a clearly different number of repeated marks/);
  assert.match(prompt, /proportions no pose can produce/);
  assert.match(prompt, /a signature feature missing, added or changed/);
  assert.match(prompt, /is missing, not hidden/);
  assert.match(prompt, /a region or marking in a different hue/);
  assert.match(
    prompt,
    /a marking missing, added or moved; a see-through hole inside the body or face/,
  );
  assert.match(prompt, /the approved references are the source of truth/);
  assert.match(prompt, /"poseDifferences": \["<each difference the pose or view explains>"\]/);
});

test("the cast answer parser accepts poseDifferences and still parses an answer without them", () => {
  const withPose = parseCastAnswer(
    '{"choice": "mina", "onModel": 0.9, "poseDifferences": ["back arched mid-stride", " ", 3], "deviations": []}',
    ["mina"],
  );
  assert.deepEqual(withPose.poseDifferences, ["back arched mid-stride"]);
  assert.equal(withPose.onModel, 0.9);
  assert.equal(withPose.deviations, undefined);
  const without = parseCastAnswer('{"choice": "mina", "onModel": 0.9}', ["mina"]);
  assert.equal(without.poseDifferences, undefined);
  assert.equal(
    parseCastAnswer('{"choice": "mina", "poseDifferences": "tail"}', ["mina"]).poseDifferences,
    undefined,
  );
});

test("an answer that lists pose differences with a high onModel passes and the score ignores them", async () => {
  const cast = [member("mina"), member("otto")];
  const provider = new ScriptedProvider({
    image: () => {
      throw new Error("no images");
    },
    vision: () => ({
      text: '{"probabilities": {"mina": 0.95, "otto": 0.03, "neither": 0.02}, "choice": "mina", "onModel": 0.95, "deviations": [], "poseDifferences": ["back arched mid-stride", "tail lowered"], "reason": "mina walking"}',
      costUsd: 0.001,
    }),
  });
  const bytes = encodePng(createRaster(16, 8));
  const score = await scoreIdentity({
    caller: new Caller({
      provider,
      providerName: "scripted",
      budget: new Budget(1),
      routes: defaultRoutes,
    }),
    ...cast[0]!,
    candidate: {
      role: "candidate",
      path: "(candidate)",
      mediaType: "image/png",
      bytes,
      sha256: sha256(bytes),
    },
    describe: 'a sprite strip of 8 frames side by side, from its "walk" animation',
    settings: identitySettings({
      identity: { question: "cast", mode: "enforce", threshold: 0.68 },
    }),
    cast,
    recordCheck: {
      subject: "mina",
      lockVersion: cast[0]!.record.version,
      lockSha256: cast[0]!.record.sha256,
      checked: true,
      consistent: true,
      conflicts: [],
      reason: "agrees",
      model: "test",
      costUsd: 0,
    },
  });
  assert.ok(Math.abs(score.score! - 0.9025) < 1e-9);
  assert.equal(score.passed, true);
  assert.doesNotMatch(score.reason, /off-model/);
});
