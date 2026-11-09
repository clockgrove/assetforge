import assert from "node:assert/strict";
import test from "node:test";
import { edgeHaloReasons, frameHalo } from "../src/animation/halo.ts";
import {
  buildHolesPrompt,
  checkHoles,
  enclosedAreas,
  holeView,
  parseHolesReply,
  planHoles,
} from "../src/animation/holes.ts";
import { animationQa } from "../src/animation/qa.ts";
import { thresholdsFor } from "../src/animation/templates.ts";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { createRaster, getPixel, setPixel } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { defaultRoutes } from "../src/routes.ts";
import { resolveStyle } from "../src/style.ts";

const thresholds = thresholdsFor(undefined);

/**
 * A soft-edged disc of fur with a pale blaze in its middle; optionally a hole punched in the blaze
 * and an orange fringe on the faint edge (what unmixing a cool background used to leave).
 */
function disc(options: { hole?: boolean; fringe?: boolean } = {}): Raster {
  const size = 48;
  const r = createRaster(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const cover = Math.max(0, Math.min(1, 16 - d));
      if (cover === 0) continue;
      const blaze = Math.abs(x + 0.5 - c) < 6 && Math.abs(y + 0.5 - c) < 4;
      const colour: [number, number, number] = blaze
        ? [240, 236, 228]
        : cover < 1 && options.fringe
          ? [210, 90, 30]
          : [116, 88, 73];
      setPixel(r, x, y, [...colour, Math.round(cover * 255)]);
    }
  }
  if (options.hole) {
    for (let y = c - 2; y < c + 1; y++)
      for (let x = c - 3; x < c + 2; x++) setPixel(r, x, y, [0, 0, 0, 0]);
  }
  return r;
}

test("a soft edge in the figure's own colours passes edge-halo; an orange fringe fails it", () => {
  const clean = frameHalo(disc());
  assert.ok(clean.edgePixels > 20);
  assert.equal(clean.haloPixels, 0);
  const fringed = frameHalo(disc({ fringe: true }));
  assert.ok(fringed.haloPixels / fringed.edgePixels > 0.5);
  const [ok] = edgeHaloReasons([disc(), disc()], thresholds);
  assert.equal(ok!.passed, true);
  const failed = edgeHaloReasons([disc(), disc({ fringe: true })], thresholds);
  assert.deepEqual(
    failed.map((r) => [r.check, r.passed, r.frames]),
    [["edge-halo", false, [2]]],
  );
  assert.match(failed[0]!.reason, /^frame 2: \d+ of \d+ soft edge pixels/);
});

test("transparent pixels that keep a colour count as halo", () => {
  const frame = disc();
  for (let x = 0; x < 48; x++) setPixel(frame, x, 0, [230, 240, 238, 0]);
  const h = frameHalo(frame);
  assert.equal(h.colouredTransparent, 48);
  const [reason] = edgeHaloReasons([frame], thresholds);
  assert.equal(reason!.passed, false);
  assert.match(reason!.reason, /48 transparent pixels keep a colour/);
});

test("the deterministic report has an edge-halo check, so a fringed strip fails for it", () => {
  const frames = [disc(), disc({ fringe: true })];
  const report = animationQa(
    { frames, frame: { width: 48, height: 48 }, anchor: { x: 24, y: 47 }, family: "spin" },
    {},
    resolveStyle(undefined),
  );
  const halo = report.reasons.filter((r) => r.check === "edge-halo");
  assert.deepEqual(
    halo.map((r) => [r.passed, r.frames]),
    [[false, [2]]],
  );
});

test("enclosed see-through areas are found; the outside and specks below the minimum are not", () => {
  assert.deepEqual(enclosedAreas(disc(), { threshold: 128, minPx: 3 }).areas, []);
  const { areas, marked } = enclosedAreas(disc({ hole: true }), { threshold: 128, minPx: 3 });
  assert.deepEqual(areas, [{ area: 15, x: 21, y: 22, width: 5, height: 3 }]);
  assert.equal(marked[23 * 48 + 22], 1);
  assert.equal(marked[0], 0);
  assert.deepEqual(enclosedAreas(disc({ hole: true }), { threshold: 128, minPx: 16 }).areas, []);
});

test("the judged view is enlarged, opaque, green outside and magenta in the enclosed areas", () => {
  const frame = disc({ hole: true });
  const { marked } = enclosedAreas(frame, { threshold: 128, minPx: 3 });
  const view = holeView(frame, marked);
  assert.equal(view.width, 384);
  const zoom = view.width / frame.width;
  assert.deepEqual(getPixel(view, 0, 0), [46, 120, 52, 255]);
  assert.deepEqual(getPixel(view, 22 * zoom, 23 * zoom), [255, 0, 255, 255]);
  assert.deepEqual(getPixel(view, 24 * zoom, 30 * zoom), [116, 88, 73, 255]);
});

test("holes replies are parsed strictly", () => {
  const hole = parseHolesReply(
    '```json\n{"holes":true,"areas":[{"where":"the white blaze","kind":"hole"},{"where":"legs","kind":"opening"}],"confidence":0.9}\n```',
  );
  assert.deepEqual([hole.label, hole.confidence, hole.where], ["holes", 0.9, ["the white blaze"]]);
  assert.equal(
    parseHolesReply('{"holes":false,"areas":[{"where":"legs","kind":"opening"}],"confidence":0.8}')
      .label,
    "openings",
  );
  assert.equal(parseHolesReply("no").label, "unreadable");
  assert.equal(parseHolesReply('{"holes":"yes","confidence":1}').label, "unreadable");
  assert.equal(parseHolesReply('{"holes":true,"confidence":3}').label, "unreadable");
  assert.match(
    buildHolesPrompt({ subject: "a fox", family: "walk", frame: 4, areas: 2 }),
    /frame 4/,
  );
});

function caller(replies: string[]) {
  const seen: Array<{ prompt: string; images: number }> = [];
  const provider = new ScriptedProvider({
    image: () => {
      throw new Error("no image calls expected");
    },
    vision: (request, index) => {
      seen.push({ prompt: request.prompt, images: request.images.length });
      return { text: replies[index] ?? "", costUsd: 0.003 };
    },
  });
  const call = new Caller({
    provider,
    providerName: "scripted",
    budget: new Budget(1),
    routes: defaultRoutes,
  });
  return { call, seen };
}

const base = { family: "idle", subject: "a fox", threshold: 128, minPx: 3, cutoff: 0.7 };

test("only frames with an enclosed area are judged; a hole fails that frame for holes", async () => {
  const frames = [disc(), disc({ hole: true }), disc({ hole: true })];
  const plan = planHoles(frames, base, defaultRoutes);
  assert.deepEqual([plan.calls, plan.estimatedCostUsd], [2, 0.02]);
  const { call, seen } = caller([
    JSON.stringify({
      holes: true,
      areas: [{ where: "the pale blaze", kind: "hole" }],
      confidence: 0.95,
    }),
    JSON.stringify({ holes: false, areas: [{ where: "x", kind: "opening" }], confidence: 0.9 }),
  ]);
  const { reasons, decisions } = await checkHoles({ ...base, frames, call });
  assert.equal(seen.length, 2);
  assert.match(seen[0]!.prompt, /frame 2 of a "idle" animation/);
  assert.equal(seen[0]!.images, 1);
  assert.deepEqual(
    reasons.map((r) => [r.check, r.passed, r.source, r.frames]),
    [
      ["holes", false, "vision", [2]],
      ["holes", true, "vision", [3]],
    ],
  );
  assert.match(
    reasons[0]!.reason,
    /^frame 2: 1 see-through area\(s\) inside the outline, 15 px; hole\(s\): the pale blaze/,
  );
  assert.deepEqual(
    decisions.map((d) => [d.frame, d.label, d.flagged, d.areas.length]),
    [
      [2, "holes", true, 1],
      [3, "openings", false, 1],
    ],
  );
});

test("an unsure hole passes below the cutoff; an unreadable reply fails", async () => {
  const frames = [disc({ hole: true }), disc({ hole: true })];
  const { call } = caller([
    JSON.stringify({ holes: true, areas: [], confidence: 0.5 }),
    "not json",
  ]);
  const { reasons } = await checkHoles({ ...base, frames, call });
  assert.deepEqual(
    reasons.map((r) => r.passed),
    [true, false],
  );
  assert.match(reasons[1]!.reason, /unreadable/);
});

test("a strip without enclosed areas makes no call and passes holes on pixels", async () => {
  const { call, seen } = caller([]);
  const { reasons, decisions } = await checkHoles({ ...base, frames: [disc(), disc()], call });
  assert.equal(seen.length, 0);
  assert.deepEqual(decisions, []);
  assert.deepEqual(
    reasons.map((r) => [r.check, r.passed, r.source]),
    [["holes", true, "deterministic"]],
  );
});
