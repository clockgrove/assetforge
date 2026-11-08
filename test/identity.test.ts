import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BIBLE_PRESETS, loadBible, serializeBible } from "../src/bible.ts";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import type { Script } from "../src/gateway/scripted.ts";
import {
  DEFAULT_IDENTITY_THRESHOLD,
  IDENTITY_LEVELS,
  MIN_DECISION_EDGE,
  agreement,
  forDecision,
  identityReason,
  identitySettings,
  loadIdentity,
  scoreIdentity,
  sweepThresholds,
} from "../src/identity.ts";
import { evaluateIdentity } from "../src/identity-eval.ts";
import { createRaster, decodeImage, encodePng, setPixel } from "../src/image/raster.ts";
import { sha256 } from "../src/request.ts";
import { defaultRoutes } from "../src/routes.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function png(width: number, height: number): Uint8Array {
  const r = createRaster(width, height);
  setPixel(r, 0, 0, [200, 100, 50, 255]);
  return encodePng(r);
}

/** A synthetic bible with one locked character, `fox`, and its turnaround. */
async function lockedBible(lockVersion = "fox-1") {
  const root = await mkdtemp(join(tmpdir(), "identity-"));
  roots.push(root);
  const dir = join(root, "art");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "fox-turnaround.png"), png(32, 16));
  await writeFile(join(dir, "fox-side.png"), png(500, 400));
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  data.world = "Synthetic";
  data.identities = {
    fox: {
      version: lockVersion,
      approved: true,
      turnaround: "fox-turnaround.png",
      references: ["fox-side.png"],
      signatureFeatures: ["white-tipped tail", "green scarf"],
      proportions: "two heads tall",
      palette: ["#c86432"],
    },
  };
  const biblePath = join(dir, "BIBLE.md");
  await writeFile(biblePath, serializeBible(data, "# Synthetic\n\n## Do's and Don'ts\nDo.\n"));
  return { root, dir, biblePath };
}

function scripted(answer: Script["decide"]): ScriptedProvider {
  return new ScriptedProvider({
    image: () => {
      throw new Error("no images in identity tests");
    },
    vision: () => {
      throw new Error("no vision in identity tests");
    },
    ...(answer && { decide: answer }),
  });
}

function caller(provider: ScriptedProvider, log?: (m: string) => void) {
  return new Caller({
    provider,
    providerName: "scripted",
    budget: new Budget(1),
    routes: defaultRoutes,
    ...(log && { log }),
  });
}

const candidate = (bytes = png(64, 32)) => ({
  role: "candidate",
  path: "(candidate)",
  mediaType: "image/png",
  bytes,
  sha256: sha256(bytes),
});

test("identity settings default to shadow mode and the recorded threshold; bad values refuse", () => {
  const profile = syntheticProfile();
  assert.deepEqual(identitySettings(profile), {
    mode: "shadow",
    threshold: DEFAULT_IDENTITY_THRESHOLD,
    question: "score",
  });
  assert.equal(identitySettings(profile, "enforce").mode, "enforce");
  const configured = { ...profile, identity: { mode: "enforce" as const, threshold: 0.8 } };
  assert.equal(identitySettings(configured).threshold, 0.8);
  assert.equal(identitySettings(configured, "shadow").mode, "shadow");
  assert.throws(() => identitySettings(profile, "loud"), /identity mode/);
  assert.throws(() => identitySettings({ ...profile, identity: { threshold: 2 } }), /threshold/);
});

test("the identity record holds the approved references and fingerprint, versioned with the lock", async () => {
  const f = await lockedBible();
  const doc = await loadBible(f.biblePath);
  const loaded = await loadIdentity(doc, "fox");
  assert.ok(loaded);
  assert.equal(loaded.record.version, "fox-1");
  assert.deepEqual(
    loaded.record.references.map((r) => r.role),
    ["identity:approved-turnaround", "identity:approved-reference"],
  );
  assert.deepEqual(loaded.record.fingerprint.signatureFeatures, [
    "white-tipped tail",
    "green scarf",
  ]);
  assert.equal(await loadIdentity(doc, "badger"), undefined);
  const bumped = await loadIdentity(await loadBible((await lockedBible("fox-2")).biblePath), "fox");
  assert.equal(bumped?.record.version, "fox-2");
  assert.notEqual(bumped?.record.sha256, loaded.record.sha256);
});

test("a Score decision becomes a 0..1 identity score with its label, confidence, latency and cost logged", async () => {
  const f = await lockedBible();
  const identity = (await loadIdentity(await loadBible(f.biblePath), "fox"))!;
  const lines: string[] = [];
  const provider = scripted(() => ({
    answer: { type: "score", score: 3, probabilities: { "2": 0.3, "3": 0.7 } },
    confidence: 0.66,
    costUsd: 0.00003,
  }));
  const call = caller(provider, (m) => lines.push(m));
  const score = await scoreIdentity({
    caller: call,
    ...identity,
    candidate: candidate(),
    describe: "a still",
    settings: identitySettings(syntheticProfile(), "enforce"),
  });
  assert.equal(score.score, 0.75);
  assert.equal(score.label, IDENTITY_LEVELS[3]);
  assert.equal(score.confidence, 0.66);
  assert.equal(score.passed, true);
  assert.equal(score.filtered, false);
  assert.equal(score.lockVersion, "fox-1");
  assert.equal(score.model, "perplexity/pplx-decider-v1.2");
  assert.match(score.reason, /identity 0\.75 >= threshold 0\.625 against "fox" lock fox-1/);
  const record = call.records[0]!;
  assert.equal(record.operation, "identity");
  assert.equal(record.decision?.label, IDENTITY_LEVELS[3]);
  assert.equal(record.decision?.confidence, 0.66);
  assert.equal(typeof record.decision?.latencyMs, "number");
  assert.equal(record.costUsd, 0.00003);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0]!,
    /identity perplexity\/pplx-decider-v1\.2: .*confidence 0\.66, \d+ ms, \$0\.000030 provider/,
  );
  // The request is typed, carries the candidate first and every reference, all upscaled.
  const sent = provider.calls[0]!;
  assert.equal(sent.kind, "decide");
  if (sent.kind !== "decide") return;
  assert.equal(sent.request.question.type, "score");
  assert.equal(sent.request.images.length, 3);
  for (const image of sent.request.images) {
    const r = decodeImage(image.bytes);
    assert.ok(Math.min(r.width, r.height) >= MIN_DECISION_EDGE, `${r.width}x${r.height}`);
  }
  assert.match(sent.request.prompt, /white-tipped tail; green scarf/);
});

test("below the threshold: shadow mode records and marks the reason, enforce mode filters", async () => {
  const f = await lockedBible();
  const identity = (await loadIdentity(await loadBible(f.biblePath), "fox"))!;
  const low = () => scripted(() => ({ answer: { type: "score", score: 1 } }));
  const shadow = await scoreIdentity({
    caller: caller(low()),
    ...identity,
    candidate: candidate(),
    describe: "a still",
    settings: identitySettings(syntheticProfile()),
  });
  assert.equal(shadow.passed, false);
  assert.equal(shadow.filtered, false);
  assert.match(shadow.reason, /shadow mode, not filtered/);
  assert.deepEqual(
    { ...identityReason(shadow), reason: "" },
    { check: "identity-lock", passed: false, reason: "", source: "decision", shadow: true },
  );
  const enforce = await scoreIdentity({
    caller: caller(low()),
    ...identity,
    candidate: candidate(),
    describe: "a still",
    settings: identitySettings(syntheticProfile(), "enforce"),
  });
  assert.equal(enforce.filtered, true);
  assert.equal(identityReason(enforce).shadow, undefined);
});

test("a Boolean decision uses the probability of true; a failed call fails closed only in enforce mode", async () => {
  const f = await lockedBible();
  const identity = (await loadIdentity(await loadBible(f.biblePath), "fox"))!;
  const profile = { ...syntheticProfile(), identity: { question: "boolean" as const } };
  const yes = await scoreIdentity({
    caller: caller(scripted(() => ({ answer: { type: "boolean", probability: 0.9 } }))),
    ...identity,
    candidate: candidate(),
    describe: "a still",
    settings: identitySettings(profile, "enforce"),
  });
  assert.equal(yes.score, 0.9);
  assert.equal(yes.label, "true");
  assert.equal(yes.passed, true);
  const failing = () =>
    scripted(() => {
      throw new Error("429 rate limited");
    });
  const enforce = await scoreIdentity({
    caller: caller(failing()),
    ...identity,
    candidate: candidate(),
    describe: "a still",
    settings: identitySettings(profile, "enforce"),
  });
  assert.equal(enforce.filtered, true);
  assert.equal(enforce.score, undefined);
  assert.match(enforce.error ?? "", /429 rate limited/);
  const shadow = await scoreIdentity({
    caller: caller(failing()),
    ...identity,
    candidate: candidate(),
    describe: "a still",
    settings: identitySettings(profile),
  });
  assert.equal(shadow.filtered, false);
  // A provider without typed decisions cannot score.
  const none = await scoreIdentity({
    caller: caller(scripted(undefined)),
    ...identity,
    candidate: candidate(),
    describe: "a still",
    settings: identitySettings(profile, "enforce"),
  });
  assert.equal(none.filtered, true);
});

test("small images are upscaled for decision models; large ones go as they are", () => {
  const small = forDecision(candidate(png(100, 20)), "crisp");
  const r = decodeImage(small.bytes);
  assert.equal(r.height, MIN_DECISION_EDGE);
  assert.equal(r.width, 1920);
  const big = candidate(png(400, 500));
  assert.equal(forDecision(big), big);
});

test("the threshold sweep recommends the cut the logged scores support", () => {
  const { rows, recommended } = sweepThresholds([
    { score: 0.25, same: false },
    { score: 0.5, same: false },
    { score: 0.75, same: true },
    { score: 1, same: true },
    { score: 0.5, same: true },
  ]);
  assert.ok(rows.length >= 3);
  assert.equal(recommended?.threshold, 0.375);
  assert.equal(recommended?.correct, 4);
  assert.equal(sweepThresholds([]).recommended, undefined);
  assert.deepEqual(
    agreement([
      { qa: true, identity: true },
      { qa: true, identity: false },
    ]),
    {
      scored: 2,
      agree: 1,
      identityOnlyFailed: 1,
      qaOnlyFailed: 0,
      rate: 0.5,
    },
  );
});

test("identity-eval scores a local labelled set, logs every call and recommends a threshold", async () => {
  const f = await lockedBible();
  const cases = [
    { image: "a.png", subject: "fox", same: true, qa: true },
    { image: "b.png", subject: "fox", same: true, qa: true },
    { image: "c.png", subject: "fox", same: false, qa: true },
    { image: "d.png", subject: "fox", same: false, qa: false },
  ];
  const scores = [4, 3, 1, 0];
  for (const c of cases) await writeFile(join(f.root, c.image), png(16, 16));
  const casesPath = join(f.root, "cases.json");
  await writeFile(casesPath, JSON.stringify({ cases }));
  const logPath = join(f.root, "log", "identity.jsonl");
  const report = await evaluateIdentity({
    biblePath: f.biblePath,
    casesPath,
    profile: syntheticProfile(),
    routes: defaultRoutes,
    provider: scripted((_request, index) => ({
      answer: { type: "score", score: scores[index]! },
      confidence: 0.6,
      costUsd: 0.00002,
    })),
    providerName: "scripted",
    capUsd: 1,
    logPath,
  });
  assert.equal(report.scored, 4);
  assert.equal(report.recommended?.accuracy, 1);
  assert.equal(report.recommended?.threshold, 0.5);
  assert.equal(report.configured.accuracy, 1);
  assert.deepEqual(report.qaAgreement, {
    scored: 4,
    agree: 3,
    identityOnlyFailed: 1,
    qaOnlyFailed: 0,
    rate: 0.75,
  });
  const lines = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  assert.deepEqual(
    Object.keys(lines[0])
      .filter((k) => ["label", "confidence", "latencyMs", "costUsd"].includes(k))
      .sort(),
    ["confidence", "costUsd", "label", "latencyMs"],
  );
  // The run reserves its whole estimate first, so a cap below it refuses before any call.
  await assert.rejects(
    evaluateIdentity({
      biblePath: f.biblePath,
      casesPath,
      profile: syntheticProfile(),
      routes: defaultRoutes,
      provider: scripted(() => ({ answer: { type: "score", score: 4 } })),
      providerName: "scripted",
      capUsd: 0.001,
    }),
    /cap/,
  );
});
