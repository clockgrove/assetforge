import assert from "node:assert/strict";
import { test } from "node:test";
import { createRaster, setPixel } from "../src/image/raster.ts";
import {
  VISION_CHECKS,
  buildVisionPrompt,
  combineQa,
  deterministicChecks,
  parseVisionVerdict,
} from "../src/qa.ts";
import type { SpecExpectation } from "../src/qa.ts";

const expected: SpecExpectation = {
  frame: { width: 4, height: 4 },
  frameCount: 3,
  palette: ["#112233", "#445566"],
};

function strip(width = 12) {
  const r = createRaster(width, 4);
  for (let f = 0; f < 3; f++) setPixel(r, f * 4 + 1, 1, [0x11, 0x22, 0x33, 255]);
  return r;
}

const byCheck = (rs: { check: string; passed: boolean; reason: string }[], name: string) =>
  rs.find((r) => r.check === name);

test("a valid strip passes every deterministic check", () => {
  const rs = deterministicChecks(strip(), expected);
  assert.deepEqual(
    rs.map((r) => r.check),
    ["transparency", "frame-count", "palette"],
  );
  assert.ok(rs.every((r) => r.passed && r.source === "deterministic" && r.reason));
  assert.match(rs[0]?.reason ?? "", /all 48 pixels have alpha 0 or 255; 45 transparent/);
});

test("soft alpha fails transparency", () => {
  const r = strip();
  setPixel(r, 0, 0, [0x11, 0x22, 0x33, 128]);
  assert.equal(byCheck(deterministicChecks(r, expected), "transparency")?.passed, false);
});

test("a fully opaque strip fails transparency when a transparent pixel is required", () => {
  const r = createRaster(12, 4);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 12; x++) setPixel(r, x, y, [0x11, 0x22, 0x33, 255]);
  assert.equal(byCheck(deterministicChecks(r, expected), "transparency")?.passed, false);
  const relaxed = deterministicChecks(r, { ...expected, requireTransparentPixel: false });
  assert.equal(byCheck(relaxed, "transparency")?.passed, true);
});

test("wrong width fails frame-count", () => {
  assert.equal(byCheck(deterministicChecks(strip(8), expected), "frame-count")?.passed, false);
});

test("an empty frame fails frame-count", () => {
  const r = strip();
  setPixel(r, 9, 1, [0, 0, 0, 0]);
  const c = byCheck(deterministicChecks(r, expected), "frame-count");
  assert.equal(c?.reason, "frame 3 of 3 is empty");
});

test("an off-palette colour fails palette", () => {
  const r = strip();
  setPixel(r, 2, 2, [0xff, 0, 0, 255]);
  const p = byCheck(deterministicChecks(r, expected), "palette");
  assert.equal(p?.passed, false);
});

test("parses fenced JSON with prose around it", () => {
  const text =
    'Here you go:\n```json\n{"checks":[{"check":"identity","passed":true,"reason":"same fox"},' +
    '{"check":"perspective","passed":false,"reason":"top-down"},' +
    '{"check":"transparency","passed":true,"reason":"clean"},' +
    '{"check":"frame-count","passed":true,"reason":"six"}]}\n```';
  const rs = parseVisionVerdict(text);
  assert.deepEqual(
    rs.map((r) => r.check),
    [...VISION_CHECKS],
  );
  assert.ok(rs.every((r) => r.source === "vision"));
  assert.equal(byCheck(rs, "identity")?.passed, true);
  assert.equal(byCheck(rs, "perspective")?.passed, false);
});

test("garbage fails all four checks without throwing", () => {
  for (const text of ["", "no json", "{broken", "{}", "[1]", "null"]) {
    const rs = parseVisionVerdict(text);
    assert.equal(rs.length, 4);
    assert.ok(rs.every((r) => !r.passed && /missing or unreadable/.test(r.reason)));
  }
});

test("a missing check or non-boolean passed fails only that check", () => {
  const rs = parseVisionVerdict(
    '{"checks":[{"check":"identity","passed":"yes","reason":"x"},' +
      '{"check":"perspective","passed":true,"reason":"ok"},' +
      '{"check":"transparency","passed":true,"reason":"ok"}]}',
  );
  assert.equal(byCheck(rs, "identity")?.passed, false);
  assert.equal(byCheck(rs, "frame-count")?.passed, false);
  assert.equal(byCheck(rs, "perspective")?.passed, true);
  assert.equal(byCheck(rs, "transparency")?.passed, true);
});

test("combineQa passes only when every reason passes", () => {
  const ok = { check: "a", passed: true, reason: "r", source: "vision" as const };
  const bad = { ...ok, passed: false };
  assert.equal(combineQa([ok], [ok]).passed, true);
  assert.equal(combineQa([ok], [bad]).passed, false);
  assert.equal(combineQa().passed, false);
  assert.equal(combineQa([ok], [bad]).reasons.length, 2);
});

test("the prompt names the frame count, every check and the references", () => {
  const p = buildVisionPrompt({
    subject: "fox",
    frameCount: 6,
    frame: { width: 48, height: 48 },
    referenceRoles: ["character", "perspective"],
  });
  assert.match(p, /6 frames/);
  assert.match(p, /48 x 48/);
  for (const c of VISION_CHECKS) assert.ok(p.includes(c), c);
  assert.match(p, /Image 2 is a reference with role "character"/);
  assert.match(p, /Image 3 is a reference with role "perspective"/);
  assert.match(p, /ONLY a JSON object/);
  assert.doesNotMatch(p, /isometric/, "no game's perspective is assumed in generic QA");
});

test("the expected perspective comes from the style bible, as data", () => {
  const p = buildVisionPrompt({
    subject: "fox",
    frameCount: 1,
    frame: { width: 48, height: 48 },
    perspectiveDescription: "side-on, flat orthographic",
    referenceRoles: ["perspective"],
  });
  assert.match(p, /perspective sample \(side-on, flat orthographic\)/);
});
