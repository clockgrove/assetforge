import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BIBLE_PRESETS, loadBible, serializeBible } from "../src/bible.ts";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ProviderError } from "../src/errors.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import type { Script } from "../src/gateway/scripted.ts";
import {
  DEFAULT_IDENTITY_THRESHOLD,
  IDENTITY_LEVELS,
  MIN_DECISION_EDGE,
  IDENTITY_CAST_OPERATION,
  IDENTITY_CHECK_OPERATION,
  IDENTITY_CAST_MAX_IMAGES,
  agreement,
  capCastReferences,
  checkIdentityRecord,
  forDecision,
  identityReason,
  identitySettings,
  loadCast,
  loadIdentity,
  parseCastAnswer,
  scoreIdentity,
  sweepThresholds,
} from "../src/identity.ts";
import type { CastMember, IdentityRecordCheck } from "../src/identity.ts";
import { evaluateIdentity, rocAuc } from "../src/identity-eval.ts";
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

/** A passed record check, so enforce-mode tests need no vision call. */
const trusted = (record: {
  subject: string;
  version: string;
  sha256: string;
}): IdentityRecordCheck => ({
  subject: record.subject,
  lockVersion: record.version,
  lockSha256: record.sha256,
  checked: true,
  consistent: true,
  conflicts: [],
  reason: "agrees",
  model: "test",
  costUsd: 0,
});

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
    recordCheck: trusted(identity.record),
  });
  assert.equal(score.score, 0.75);
  assert.equal(score.label, IDENTITY_LEVELS[3]);
  assert.equal(score.confidence, 0.66);
  assert.equal(score.passed, true);
  assert.equal(score.filtered, false);
  assert.equal(score.lockVersion, "fox-1");
  assert.equal(score.model, "perplexity/pplx-decider-v1.2");
  assert.match(score.reason, /identity 0\.75 >= threshold 0\.68 against "fox" lock fox-1/);
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
    recordCheck: trusted(identity.record),
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
    recordCheck: trusted(identity.record),
  });
  assert.equal(yes.score, 0.9);
  assert.equal(yes.label, "true");
  assert.equal(yes.passed, true);
  const failing = () =>
    scripted(() => {
      throw new Error("429 rate limited");
    });
  const failedLogs: string[] = [];
  const enforce = await scoreIdentity({
    caller: caller(failing(), (m) => failedLogs.push(m)),
    ...identity,
    candidate: candidate(),
    describe: "a still",
    settings: identitySettings(profile, "enforce"),
    recordCheck: trusted(identity.record),
  });
  assert.equal(enforce.filtered, true);
  assert.equal(enforce.score, undefined);
  assert.match(enforce.error ?? "", /429 rate limited/);
  // The failed call is logged with its model, latency and the estimate it was charged.
  assert.equal(failedLogs.length, 1);
  assert.match(
    failedLogs[0]!,
    /^identity perplexity\/pplx-decider-v1\.2: failed \(\d+ ms, \$\d+\.\d{6} estimate\): .*429 rate limited/,
  );
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
    recordCheck: trusted(identity.record),
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
    provider: new ScriptedProvider({
      image: () => {
        throw new Error("no images in identity tests");
      },
      // The record check agrees, so the record is trusted and its cases are measured.
      vision: () => ({ text: CONSISTENT, costUsd: 0 }),
      decide: (_request, index) => ({
        answer: { type: "score", score: scores[index]! },
        confidence: 0.6,
        costUsd: 0.00002,
      }),
    }),
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

/** A synthetic bible with two look-alike characters, `fox` (two references) and `kit` (one). */
async function castBible() {
  const f = await lockedBible();
  const doc = await loadBible(f.biblePath);
  await writeFile(join(f.dir, "kit-turnaround.png"), png(32, 16));
  doc.data.identities["kit"] = {
    version: "kit-1",
    approved: true,
    turnaround: "kit-turnaround.png",
    signatureFeatures: ["blue scarf"],
    proportions: "two heads tall",
    palette: ["#3264c8"],
  };
  await writeFile(
    f.biblePath,
    serializeBible(doc.data, "# Synthetic\n\n## Do's and Don'ts\nDo.\n"),
  );
  return f;
}

/** Vision answers: the record check by its prompt, everything else is a cast answer. */
function visionScript(cast: string, check: string) {
  return new ScriptedProvider({
    image: () => {
      throw new Error("no images in identity tests");
    },
    vision: (request) => ({
      text: request.prompt.includes("For each written claim") ? check : cast,
      costUsd: 0.001,
    }),
  });
}

const CONSISTENT = '{"consistent": true, "conflicts": []}';
const CONFLICTED =
  '{"consistent": false, "conflicts": [{"field": "proportions", "text": "lean, long legs", "observed": "stocky, short legs"}]}';

test("the cast question is one vision call over the whole cast's references", async () => {
  const f = await castBible();
  const doc = await loadBible(f.biblePath);
  const cast = await loadCast(doc);
  assert.deepEqual(
    cast.map((m) => m.record.subject),
    ["fox", "kit"],
  );
  const fox = cast[0]!;
  const provider = visionScript(
    '```json\n{"probabilities": {"fox": 0.2, "kit": 0.7, "neither": 0.1, "dog": 5}, "choice": "kit", "reason": "blue scarf"}\n```',
    CONSISTENT,
  );
  const call = caller(provider);
  const score = await scoreIdentity({
    caller: call,
    ...fox,
    candidate: candidate(),
    describe: "a still",
    settings: identitySettings({ identity: { question: "cast" } }),
    cast,
  });
  assert.equal(provider.calls.length, 1);
  const sent = provider.calls[0]!;
  assert.equal(sent.kind, "vision");
  if (sent.kind !== "vision") return;
  assert.equal(sent.request.model, "openai/gpt-6.1-terra");
  // The candidate, fox's two references, then kit's one.
  assert.equal(sent.request.images.length, 4);
  assert.match(sent.request.prompt, /Image 1 is the candidate: a still/);
  assert.match(sent.request.prompt, /Images 2–3 are approved references of "fox"/);
  assert.match(sent.request.prompt, /Image 4 is an approved reference of "kit"/);
  assert.match(sent.request.prompt, /blue scarf/);
  assert.match(sent.request.prompt, /including one of the same species or kind, is "neither"/);
  assert.equal(call.records[0]!.operation, IDENTITY_CAST_OPERATION);
  assert.equal(score.question, "cast");
  assert.ok(Math.abs(score.score! - 0.2) < 1e-9);
  assert.equal(score.label, "kit");
  assert.ok(Math.abs(score.confidence! - 0.7) < 1e-9);
  assert.equal(score.passed, false);
  assert.equal(score.costUsd, 0.001);
  assert.match(
    score.reason,
    /^identity 0\.20 < threshold 0\.68 against "fox" lock fox-1: kit \(confidence 0\.70\); looks like "kit": blue scarf; shadow mode/,
  );
  // Without the cast, the subject stands alone.
  const alone = visionScript('{"choice": "fox"}', CONSISTENT);
  const solo = await scoreIdentity({
    caller: caller(alone),
    ...fox,
    candidate: candidate(),
    describe: "a still",
    settings: identitySettings({ identity: { question: "cast" } }),
  });
  assert.equal(solo.score, 1);
  const soloCall = alone.calls[0]!;
  assert.equal(soloCall.kind === "vision" && soloCall.request.images.length, 3);
});

test("the cast question also asks whether the subject is on-model; drift scores low with the deviations", async () => {
  const f = await castBible();
  const cast = await loadCast(await loadBible(f.biblePath));
  const fox = cast[0]!;
  const provider = visionScript(
    '{"probabilities": {"fox": 0.9, "kit": 0.05, "neither": 0.05}, "choice": "fox", "onModel": 0.2, "deviations": ["scarf is red, not green", " "], "reason": "a fox with the wrong scarf"}',
    CONSISTENT,
  );
  const score = await scoreIdentity({
    caller: caller(provider),
    ...fox,
    candidate: candidate(),
    describe: "a still",
    settings: identitySettings({ identity: { question: "cast" } }),
    cast,
  });
  const sent = provider.calls[0]!;
  assert.ok(sent.kind === "vision");
  if (sent.kind !== "vision") return;
  assert.match(sent.request.prompt, /on-model for "fox", whoever you chose/);
  assert.match(sent.request.prompt, /the approved references are the source of truth/);
  assert.match(sent.request.prompt, /"onModel": p, "deviations"/);
  // Who it is (0.9) times whether it is on-model (0.2).
  assert.ok(Math.abs(score.score! - 0.18) < 1e-9);
  assert.equal(score.passed, false);
  assert.match(
    score.reason,
    /: fox \(confidence 0\.90\); off-model \(on-model 0\.20\): scarf is red, not green; shadow mode/,
  );
  assert.deepEqual(parseCastAnswer('{"choice": "fox", "onModel": 7}', ["fox"]).onModel, 1);
  assert.equal(parseCastAnswer('{"choice": "fox", "onModel": "high"}', ["fox"]).onModel, undefined);
});

test("a failing candidate of the right character names its deviations at any on-model value; a passing one does not", async () => {
  const f = await castBible();
  const cast = await loadCast(await loadBible(f.biblePath));
  const fox = cast[0]!;
  const run = async (onModel: number) =>
    scoreIdentity({
      caller: caller(
        visionScript(
          `{"probabilities": {"fox": 0.95, "kit": 0.03, "neither": 0.02}, "choice": "fox", "onModel": ${onModel}, "deviations": ["ears are rounded"], "reason": "a fox"}`,
          CONSISTENT,
        ),
      ),
      ...fox,
      candidate: candidate(),
      describe: "a still",
      settings: identitySettings({
        identity: { question: "cast", mode: "enforce", threshold: 0.68 },
      }),
      cast,
    });
  // 0.95 × 0.6 = 0.57 < 0.68: filtered, and the reason says why although on-model is above 0.5.
  const failing = await run(0.6);
  assert.equal(failing.filtered, true);
  assert.match(
    failing.reason,
    /< threshold 0\.68 .*: fox \(confidence 0\.95\); off-model \(on-model 0\.60\): ears are rounded$/,
  );
  const passing = await run(0.9);
  assert.equal(passing.passed, true);
  assert.doesNotMatch(passing.reason, /off-model/);
});

test("cast answers parse probabilities or a bare choice and refuse anything else", () => {
  const names = ["fox", "kit"];
  const p = parseCastAnswer(
    'Sure: {"probabilities": {"fox": 3, "kit": 1, "neither": -2, "x": 9}, "choice": "fox"} done',
    names,
  );
  assert.deepEqual(p.probabilities, { fox: 0.75, kit: 0.25, neither: 0 });
  assert.equal(p.choice, "fox");
  assert.deepEqual(parseCastAnswer('{"choice": "neither", "reason": "a dog"}', names), {
    choice: "neither",
    probabilities: {},
    reason: "a dog",
  });
  assert.equal(parseCastAnswer('{"probabilities": {"kit": 0.9, "fox": 0.1}}', names).choice, "kit");
  assert.throws(() => parseCastAnswer("no idea", names), ProviderError);
  assert.throws(() => parseCastAnswer('{"choice": "badger"}', names), ProviderError);
  assert.throws(() => parseCastAnswer("{}", names), ProviderError);
});

test("an unreadable cast answer is a failed score that fails closed in enforce mode", async () => {
  const f = await castBible();
  const cast = await loadCast(await loadBible(f.biblePath));
  const fox = cast[0]!;
  const score = await scoreIdentity({
    caller: caller(visionScript("I think it is the fox.", CONSISTENT)),
    ...fox,
    candidate: candidate(),
    describe: "a still",
    settings: identitySettings({ identity: { question: "cast" } }, "enforce"),
    cast,
    recordCheck: trusted(fox.record),
  });
  assert.equal(score.score, undefined);
  assert.equal(score.filtered, true);
  assert.match(score.reason, /failed: .*no JSON object/);
  assert.equal(score.costUsd, 0.001);
});

test("enforce with a record that contradicts its references scores but does not filter, and says why", async () => {
  const f = await castBible();
  const cast = await loadCast(await loadBible(f.biblePath));
  const fox = cast[0]!;
  const none = '{"choice": "neither", "reason": "a different animal"}';
  const provider = visionScript(none, CONFLICTED);
  const call = caller(provider);
  const settings = identitySettings({ identity: { question: "cast" } }, "enforce");
  const options = { caller: call, ...fox, describe: "a still", settings, cast };
  const first = await scoreIdentity({ ...options, candidate: candidate() });
  assert.equal(first.score, 0);
  assert.equal(first.mode, "shadow");
  assert.equal(first.filtered, false);
  assert.match(first.reason, /looks like none of the cast: a different animal/);
  assert.match(
    first.reason,
    /record not trusted \(record "fox" lock fox-1 disagrees with its references: proportions "lean, long legs" vs "stocky, short legs"\), not used for filtering until a person fixes the text or the references/,
  );
  assert.equal(first.recordCheck?.consistent, false);
  assert.equal(identityReason(first).shadow, true);
  // The check ran once for the caller and lock; the second candidate reuses it.
  await scoreIdentity({ ...options, candidate: candidate() });
  assert.deepEqual(
    call.records.map((r) => r.operation),
    [IDENTITY_CHECK_OPERATION, IDENTITY_CAST_OPERATION, IDENTITY_CAST_OPERATION],
  );
  // Shadow mode never runs the check.
  const shadowCall = caller(visionScript(none, CONFLICTED));
  await scoreIdentity({
    ...options,
    caller: shadowCall,
    settings: identitySettings({ identity: { question: "cast" } }),
    candidate: candidate(),
  });
  assert.deepEqual(
    shadowCall.records.map((r) => r.operation),
    [IDENTITY_CAST_OPERATION],
  );
});

test("enforce with a consistent record filters; an unreadable check fails closed", async () => {
  const f = await castBible();
  const cast = await loadCast(await loadBible(f.biblePath));
  const fox = cast[0]!;
  const none = '{"choice": "kit"}';
  const settings = identitySettings({ identity: { question: "cast" } }, "enforce");
  const call = caller(visionScript(none, CONSISTENT));
  const filtered = await scoreIdentity({
    caller: call,
    ...fox,
    candidate: candidate(),
    describe: "a still",
    settings,
    cast,
  });
  assert.equal(filtered.mode, "enforce");
  assert.equal(filtered.filtered, true);
  assert.equal(filtered.recordCheck, undefined);
  assert.equal(call.records[0]!.operation, IDENTITY_CHECK_OPERATION);
  const record = await checkIdentityRecord({ caller: caller(visionScript(none, "{}")), ...fox });
  assert.equal(record.checked, false);
  assert.equal(record.consistent, false);
  assert.match(record.reason, /could not be checked/);
  const fox1 = '{"choice": "fox"}';
  const unchecked = await scoreIdentity({
    caller: caller(visionScript(fox1, "garbled")),
    ...fox,
    candidate: candidate(),
    describe: "a still",
    settings,
    cast,
  });
  // The cast answer names the subject (score 1), yet a check that could not run filters it.
  assert.equal(unchecked.mode, "enforce");
  assert.equal(unchecked.filtered, true);
  assert.equal(unchecked.passed, false);
  assert.equal(unchecked.recordCheck?.checked, false);
  assert.match(unchecked.reason, /could not be checked.*fail closed/);
  // In shadow mode no check runs, so nothing changes there.
  const shadow = await scoreIdentity({
    caller: caller(visionScript(fox1, "garbled")),
    ...fox,
    candidate: candidate(),
    describe: "a still",
    settings: { ...settings, mode: "shadow" },
    cast,
  });
  assert.equal(shadow.filtered, false);
  assert.equal(shadow.passed, true);
  assert.equal(shadow.recordCheck, undefined);
});

test("the ROC AUC counts ties as half and needs both classes", () => {
  assert.equal(rocAuc([{ score: 1, same: true }]), undefined);
  assert.equal(
    rocAuc([
      { score: 0.9, same: true },
      { score: 0.1, same: false },
    ]),
    1,
  );
  assert.equal(
    rocAuc([
      { score: 0.5, same: true },
      { score: 0.5, same: false },
    ]),
    0.5,
  );
  assert.equal(
    rocAuc([
      { score: 0.2, same: true },
      { score: 0.8, same: true },
      { score: 0.5, same: false },
    ]),
    0.5,
  );
});

test("a cast call never sends more than the capped number of images", () => {
  const member = (subject: string, count: number) =>
    ({
      record: { subject },
      references: Array.from({ length: count }, (_, i) => ({ role: `${subject}-${i}` })),
    }) as unknown as CastMember;
  const small = [member("a", 3), member("b", 2)];
  assert.equal(capCastReferences(small, "a"), small);
  const room = IDENTITY_CAST_MAX_IMAGES - 1;
  // Ten references each: everyone keeps the turnaround, then one more each in turn, subject first.
  const big = capCastReferences([member("a", 10), member("b", 10), member("c", 10)], "b");
  const counts = big.map((m) => m.references.length);
  assert.equal(
    counts.reduce((x, y) => x + y, 0),
    room,
  );
  assert.deepEqual(counts, [5, 5, 5]);
  assert.equal(big[0]!.references[0]!.role, "a-0");
  const uneven = capCastReferences([member("a", 1), member("b", 30)], "a");
  assert.deepEqual(
    uneven.map((m) => m.references.length),
    [1, room - 1],
  );
  const lopsided = capCastReferences([member("a", 20), member("b", 20)], "b");
  // 15 slots over two members: the subject gets the odd one.
  assert.deepEqual(
    lopsided.map((m) => m.references.length),
    [7, 8],
  );
  assert.throws(
    () =>
      capCastReferences(
        Array.from({ length: room + 1 }, (_, i) => member(`m${i}`, 1)),
        "m0",
      ),
    /at most 15 identity records/,
  );
});
