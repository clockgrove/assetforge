import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../src/errors.ts";
import { createRaster } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import {
  compareMarking,
  markingsPrompt,
  markingsReason,
  measureBox,
  parseMarkingsReply,
  toLab,
} from "../src/model3d/lookdev/markings.ts";
import type { MarkingMeasure, Patch } from "../src/model3d/lookdev/markings.ts";

function canvas(
  bg: [number, number, number],
  rects: Array<[number, number, number, number, [number, number, number]]>,
): Raster {
  const r = createRaster(100, 100);
  for (let i = 0; i < 10000; i++) r.data.set([...bg, 255], i * 4);
  for (const [x0, y0, x1, y1, c] of rects) {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) r.data.set([...c, 255], (y * 100 + x) * 4);
  }
  return r;
}

const patch = (l: number, a = 0, b = 0, spread = 0): Patch => ({
  lab: [l, a, b],
  spread,
  pixels: 100,
});

test("parse tolerates prose, bad boxes and pads", () => {
  const text = `Sure! {"markings":[
    {"name":"mask","against":"cheek","boxes":[{"mark":[500,600,100,200],"ground":[0,-1,500,2000]},{"mark":[100,100,100,500],"ground":[0,0,1000,1000]}]},
    {"name":"mixed","against":"coat","boxes":[{"mark":[237,0.4,401,0.6],"ground":[0,0,1000,1000]}]},
    {"name":42,"boxes":[]},
    {"name":"rings","against":"tail","boxes":null},
    {"name":"rim","against":"ear","boxes":[null]}
  ]} thanks`;
  const out = parseMarkingsReply(text, 3);
  assert.deepEqual(
    out.map((m) => m.name),
    ["mask", "mixed", "rim"],
  );
  assert.deepEqual(out[0]!.boxes[0], { mark: [0.2, 0.1, 0.6, 0.5], ground: [0, 0, 1, 0.5] });
  assert.equal(out[0]!.boxes[1], null);
  assert.equal(out[0]!.boxes.length, 3);
  assert.equal(out[1]!.boxes[0], null, "a box mixing fractions and 0..1000 values is dropped");
  assert.equal(out[2]!.boxes.length, 3);
});

test("parse throws only without any JSON object", () => {
  assert.throws(() => parseMarkingsReply("no markings here", 2), ProviderError);
  assert.deepEqual(parseMarkingsReply('{"other":1}', 2), []);
});

test("toLab maps white and black", () => {
  const w = toLab(255, 255, 255);
  assert.ok(Math.abs(w[0] - 100) < 0.1 && Math.abs(w[1]) < 0.1 && Math.abs(w[2]) < 0.1);
  assert.ok(Math.abs(toLab(0, 0, 0)[0]) < 0.01);
});

test("measureBox ignores background pixels", () => {
  const img = canvas([128, 128, 128], [[20, 20, 40, 40, [240, 240, 230]]]);
  const p = measureBox(img, [0.1, 0.1, 0.6, 0.6], undefined);
  assert.ok(p);
  assert.equal(p.pixels, 400);
  assert.ok(p.lab[0] > 90);
  assert.equal(measureBox(img, [0.7, 0.7, 0.9, 0.9], undefined), undefined);
  assert.equal(measureBox(img, [0.1, 0.1, 0.6, 0.6], [240, 240, 230])?.lab[0] !== undefined, true);
});

test("compareMarking passes a match and flags colour and contrast drift", () => {
  const ref = { mark: patch(20), ground: patch(60) };
  assert.equal(compareMarking(ref, { mark: patch(22), ground: patch(60) }).drifts, false);
  const colour = compareMarking(ref, { mark: patch(20, 40, 0), ground: patch(60) });
  assert.ok(colour.drifts && colour.why?.startsWith("colour ΔE 40.0"));
  const lost = compareMarking(ref, { mark: patch(25), ground: patch(40) });
  assert.ok(lost.drifts && lost.why === "contrast -40.0 → -15.0 L*");
  const flipped = compareMarking(ref, { mark: patch(62), ground: patch(40) });
  assert.equal(flipped.drifts, true);
  const flat = compareMarking(
    { mark: patch(50), ground: patch(52) },
    { mark: patch(50), ground: patch(50) },
  );
  assert.equal(flat.drifts, false);
  assert.equal(flat.contrastKind, "none");
});

test("a banded marking whose median matches its neighbour is held to its banding", () => {
  // A ringed tail: dark and pale bands, so the box's median sits near the coat beside it.
  const rings = canvas(
    [128, 128, 128],
    [
      [10, 10, 20, 40, [40, 35, 30]],
      [20, 10, 30, 40, [200, 185, 160]],
      [30, 10, 40, 40, [40, 35, 30]],
      [40, 10, 50, 40, [200, 185, 160]],
    ],
  );
  const ref = measureBox(rings, [0.1, 0.1, 0.5, 0.4], undefined)!;
  assert.ok(ref.spread > 40, String(ref.spread));
  const ground = { mark: ref, ground: patch(ref.lab[0] + 2) };
  const muted = compareMarking(ground, {
    mark: patch(ref.lab[0], 0, 0, ref.spread * 0.3),
    ground: patch(ref.lab[0] + 2),
  });
  assert.equal(muted.contrastKind, "within");
  assert.ok(muted.drifts && muted.why?.startsWith("banding "), muted.why);
  const held = compareMarking(ground, { mark: { ...ref }, ground: patch(ref.lab[0] + 2) });
  assert.equal(held.drifts, false);
  // A render whose neighbour box held no figure is still held to colour and banding.
  const noGround = compareMarking(
    { mark: patch(20, 0, 0, 30), ground: patch(60) },
    { mark: patch(22, 0, 0, 5) },
  );
  assert.equal(noGround.contrastKind, "within");
  assert.equal(noGround.drifts, true);
});

test("markingsReason names drifting markings; nothing measured passes and says why", () => {
  const ok: MarkingMeasure = {
    marking: "mask",
    view: "front",
    image: "summer",
    deltaE: 6.2,
    contrastRef: -41,
    contrastRender: -38.5,
    drifts: false,
  };
  const bad: MarkingMeasure = {
    marking: "muzzle",
    view: "front",
    image: "summer",
    deltaE: 5,
    contrastRef: 30,
    contrastRender: 9,
    drifts: true,
    why: "contrast 30.0 → 9.0 L*",
  };
  const pass = markingsReason([ok], { unmeasured: [] });
  assert.equal(pass.passed, true);
  assert.match(pass.reason, /front: mask \(summer ΔE 6\.2, contrast -41\.0→-38\.5 L\*\)/);
  const fail = markingsReason([ok, bad], { unmeasured: ["back view: no reference"] });
  assert.equal(fail.passed, false);
  assert.match(fail.reason, /drifting: muzzle \(front, summer: contrast 30\.0 → 9\.0 L\*\)/);
  assert.match(fail.reason, /back view: no reference/);
  const lost: MarkingMeasure = {
    marking: "mask",
    view: "side",
    image: "winter",
    drifts: true,
    missing: "not shown in the render",
    why: "not shown in the render",
  };
  const vanished = markingsReason([ok, lost], { unmeasured: [] });
  assert.equal(vanished.passed, false);
  assert.match(vanished.reason, /side: mask \(winter not shown in the render\)/);
  assert.match(vanished.reason, /drifting: mask \(side, winter: not shown in the render\)/);
  const unreadable = markingsReason([ok], { unmeasured: [], unreadable: ["side (no JSON)"] });
  assert.equal(unreadable.passed, false);
  assert.match(unreadable.reason, /unreadable: side \(no JSON\)/);
  const empty = markingsReason([], { unmeasured: ["no views had a reference"] });
  assert.equal(empty.passed, true);
  assert.match(empty.reason, /no marking was measured.*no views had a reference/);
});

test("prompt is generic and carries the description", () => {
  const p = markingsPrompt({
    subject: "Stevie",
    description: "dark mask, cream brows",
    view: "front",
    referenceRole: "turnaround front",
    seasons: ["summer", "winter"],
  });
  assert.match(p, /Subject: Stevie, dark mask, cream brows\./);
  assert.match(p, /summer, winter/);
  assert.doesNotMatch(p, /raccoon|fur|cat|dog|animal/i);
  const single = markingsPrompt({
    subject: "S",
    view: "side",
    referenceRole: "r",
    seasons: ["default"],
  });
  assert.doesNotMatch(single, /default/);
});
