import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendDecisionLog,
  buildFlickerPrompt,
  checkFlicker,
  flickerPairs,
  parseFlickerReply,
  planFlicker,
} from "../src/animation/flicker.ts";
import { Budget, BudgetExceededError } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { flattenFrame } from "../src/animation/preview.ts";
import { createRaster, decodePng, encodePng, setPixel } from "../src/image/raster.ts";
import { defaultRoutes, type Routes } from "../src/routes.ts";

function frames(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const r = createRaster(4, 4);
    setPixel(r, i % 4, 0, [200, 10 * i, 30, 255]);
    return r;
  });
}

function setup(replies: string[], cap = 1, routes: Routes = defaultRoutes) {
  const provider = new ScriptedProvider({
    image: () => {
      throw new Error("no image calls expected");
    },
    vision: (_request, index) => ({ text: replies[index] ?? "" }),
  });
  const call = new Caller({
    provider,
    providerName: "scripted",
    budget: new Budget(cap),
    routes,
  });
  return { provider, call };
}

const reply = (label: string, confidence: number) =>
  JSON.stringify({ label, confidence, reason: "the ears changed" });
const base = { family: "walk", subject: "a fox", cutoff: 0.7 };

test("pairs are consecutive, plus the seam for a loop of more than two frames", () => {
  assert.deepEqual(flickerPairs(4, false), [
    [1, 2],
    [2, 3],
    [3, 4],
  ]);
  assert.deepEqual(flickerPairs(3, true).at(-1), [3, 1]);
  assert.equal(flickerPairs(2, true).length, 1);
});

test("a confident flicker flags the pair and names the frames", async () => {
  const { call } = setup([reply("flicker", 0.9)]);
  const { reasons, decisions } = await checkFlicker({
    ...base,
    frames: frames(2),
    loop: false,
    call,
  });
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0]?.passed, false);
  assert.equal(reasons[0]?.source, "vision");
  assert.deepEqual(reasons[0]?.frames, [1, 2]);
  assert.match(
    reasons[0]?.reason ?? "",
    /frame 1 → frame 2: flicker \(confidence 0\.9 ≥ cutoff 0\.7\)/,
  );
  assert.equal(decisions[0]?.flagged, true);
});

test("a flicker under the cutoff passes but is logged with label and confidence", async () => {
  const { call } = setup([reply("flicker", 0.6)]);
  const { reasons, decisions } = await checkFlicker({
    ...base,
    frames: frames(2),
    loop: false,
    call,
  });
  assert.equal(reasons[0]?.passed, true);
  assert.equal(decisions[0]?.label, "flicker");
  assert.equal(decisions[0]?.confidence, 0.6);
  assert.equal(decisions[0]?.flagged, false);
});

test("an unreadable reply flags", async () => {
  const { call } = setup(["not json", reply("same", 2)]);
  const { reasons } = await checkFlicker({ ...base, frames: frames(3), loop: false, call });
  assert.deepEqual(
    reasons.map((r) => r.passed),
    [false, false],
  );
  assert.equal(parseFlickerReply("```json\n" + reply("same", 0.95) + "\n```").label, "same");
});

test("the decision log has one line per call", async () => {
  const { call } = setup([reply("same", 0.95), reply("flicker", 0.8), reply("same", 0.9)]);
  const { decisions } = await checkFlicker({ ...base, frames: frames(3), loop: true, call });
  const dir = await mkdtemp(join(tmpdir(), "flicker-"));
  const path = join(dir, "nested", "flicker.jsonl");
  await appendDecisionLog(path, decisions);
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 3);
  const second = JSON.parse(lines[1] ?? "{}");
  assert.equal(second.model, "google/gemini-3-flash");
  assert.equal(second.requestId, "scripted-vision-1");
  assert.equal(second.label, "flicker");
  assert.equal(second.confidence, 0.8);
  assert.equal(second.cutoff, 0.7);
});

test("a cap too small refuses before any provider call", async () => {
  const { call, provider } = setup([reply("same", 0.9)], 0.01);
  await assert.rejects(
    checkFlicker({ ...base, frames: frames(2), loop: false, call }),
    BudgetExceededError,
  );
  assert.equal(provider.calls.length, 0);
});

test("a routes override changes the model, and the plan reports it", async () => {
  const routes: Routes = {
    ...defaultRoutes,
    flicker: { ...defaultRoutes.flicker, model: "other/judge" },
  };
  const { call } = setup([reply("same", 0.9)], 1, routes);
  await checkFlicker({ ...base, frames: frames(2), loop: false, call });
  assert.equal(call.records[0]?.model, "other/judge");
  const plan = planFlicker(4, true, routes);
  assert.equal(plan.calls, 4);
  assert.equal(plan.model, "other/judge");
  assert.ok(Math.abs(plan.estimatedCostUsd - 0.08) < 1e-9);
});

test("the images sent are the two frames as PNG, flattened over the preview backdrop", async () => {
  const { call, provider } = setup([reply("same", 0.9)]);
  const fs = frames(2);
  await checkFlicker({ ...base, frames: fs, loop: false, call });
  const sent = provider.calls[0]?.request;
  assert.ok(sent && "images" in sent);
  assert.deepEqual(
    sent.images.map((i) => i.bytes),
    fs.map((f) => encodePng(flattenFrame(f))),
  );
  // Opaque everywhere: a transparent pixel (a matte hole) shows the backdrop, not hidden colour.
  for (const image of sent.images) {
    const r = decodePng(image.bytes);
    for (let i = 3; i < r.data.length; i += 4) assert.equal(r.data[i], 255);
  }
  assert.deepEqual([...decodePng(sent.images[0]!.bytes).data.subarray(4, 8)], [236, 236, 236, 255]);
  assert.match(sent.prompt, /image 1 is frame 1 and image 2 is frame 2/i);
  assert.match(buildFlickerPrompt({ ...base, pair: [3, 1] }), /frame 3/);
});

test("a texture reply passes: the identity holds, only painterly texture differs", async () => {
  const { call } = setup([
    JSON.stringify({ label: "texture", confidence: 0.95, reason: "fur strokes differ" }),
    reply("flicker", 0.9),
  ]);
  const { reasons, decisions } = await checkFlicker({
    ...base,
    frames: frames(3),
    loop: false,
    call,
  });
  assert.deepEqual(
    reasons.map((r) => r.passed),
    [true, false],
  );
  assert.match(
    reasons[0]!.reason,
    /^frame 1 → frame 2: same identity, only painterly texture differs \(0\.95\): fur strokes differ$/,
  );
  assert.equal(decisions[0]?.label, "texture");
  assert.equal(decisions[0]?.flagged, false);
  const prompt = buildFlickerPrompt({ ...base, pair: [1, 2] });
  assert.match(prompt, /"label":"same"\|"texture"\|"flicker"/);
  assert.match(prompt, /That is texture, not identity/);
  assert.match(
    prompt,
    /a marking appears, disappears, moves or takes a clearly different overall shape/,
  );
});
