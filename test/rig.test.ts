import assert from "node:assert/strict";
import { test } from "node:test";
import { validateBytes } from "gltf-validator";
import { InputError } from "../src/errors.ts";
import { parseGlb, writeGlb } from "../src/model3d/glb.ts";
import type { Glb } from "../src/model3d/glb.ts";
import { normalize } from "../src/model3d/scene.ts";
import { buildRiggedGlb } from "../src/model3d/rig/build.ts";
import { bakeMesh, fitSkeleton, skinWeights, soles } from "../src/model3d/rig/fit.ts";
import { generateGait } from "../src/model3d/rig/gait.ts";
import type { GeneratedClip } from "../src/model3d/rig/gait.ts";
import { quatMul, rotX } from "../src/model3d/rig/math.ts";
import { contactCheck, jointLimitCheck, sampleClip, skinningCheck } from "../src/model3d/rig/qa.ts";
import { rigCharacter } from "../src/model3d/rig/rig.ts";
import { DEFAULT_RIG_QA, parseGait, parseTemplate } from "../src/model3d/rig/template.ts";
import type { GaitProfile, LoadedRig, SkeletonTemplate } from "../src/model3d/rig/template.ts";
import {
  QUADRUPED_JOINTS,
  quadrupedTemplate,
  syntheticQuadruped,
  walkGait,
} from "./fixtures/quadruped.ts";
import type { QuadrupedOptions } from "./fixtures/quadruped.ts";

function model(options: QuadrupedOptions = {}, heightM?: number): Glb {
  const glb = parseGlb(syntheticQuadruped(options));
  normalize(glb, { sourceForward: "+z", forward: "+z", ...(heightM && { heightM }) });
  return glb;
}

function loaded(template: SkeletonTemplate, gait: GaitProfile): LoadedRig {
  return {
    templatePath: "template.json",
    kind: "synthetic-quadruped",
    template,
    templateSha256: "0".repeat(64),
    gaits: { walk: gait },
    gaitSha256: { walk: "1".repeat(64) },
    qa: DEFAULT_RIG_QA,
    baseDir: ".",
  };
}

const checksOf = (reasons: Array<{ check: string; passed: boolean; reason: string }>) =>
  Object.fromEntries(reasons.map((r) => [r.check, r]));

/** Everything the QA needs for one character, with a hook to spoil the generated clip. */
function pipeline(
  options: QuadrupedOptions,
  template: SkeletonTemplate,
  gait: GaitProfile,
  spoil?: (clip: GeneratedClip, names: string[]) => void,
) {
  const source = model(options);
  const mesh = bakeMesh(source, 0);
  const skeleton = fitSkeleton(template, mesh);
  const skin = skinWeights(skeleton, mesh);
  const sole = soles(skeleton, mesh, skin);
  const clip = generateGait("walk", gait, skeleton, mesh, sole);
  spoil?.(clip, skeleton.names);
  const glb = parseGlb(writeGlb(buildRiggedGlb(source, mesh, skeleton, skin, [clip])));
  const samples = sampleClip(glb, 0, clip, skeleton, 0);
  return {
    contact: contactCheck("walk", samples, clip, skeleton, sole, DEFAULT_RIG_QA),
    limits: jointLimitCheck("walk", samples, clip, skeleton),
    skinning: skinningCheck("walk", samples, skeleton, mesh, skin, DEFAULT_RIG_QA),
  };
}

test("templates and gaits are validated, naming what is wrong", () => {
  const template = quadrupedTemplate();
  assert.throws(
    () =>
      parseTemplate({ ...template, joints: template.joints.map((j) => ({ ...j, parent: null })) }),
    (e: Error) => e instanceof InputError && /exactly one root/.test(e.message),
  );
  assert.throws(
    () =>
      parseTemplate({
        ...template,
        feet: [{ ...template.feet[0]!, joints: ["hip_l", "ankle_l", "knee_l", "toe_l"] }],
      }),
    /parent-to-child chain/,
  );
  assert.throws(
    () =>
      parseTemplate({
        ...template,
        joints: [{ ...template.joints[0]!, limits: { x: [5, 1] } }, ...template.joints.slice(1)],
      }),
    /limits\.x must be \[min, max\]/,
  );
  assert.throws(() => parseGait({ ...walkGait(), dutyFactor: 1.2 }, template, "g"), /dutyFactor/);
  assert.throws(
    () => parseGait({ ...walkGait(), footfall: ["hind_l", "fore_l", "hind_r"] }, template, "g"),
    /footfall must list every template foot once/,
  );
  assert.throws(
    () => parseGait({ ...walkGait(), speedBodyLengthsPerSecond: undefined }, template, "g"),
    /speedBodyLengthsPerSecond must be a number/,
  );
});

test("fitting places the template's joints on the mesh, and finds legs the template misplaced", () => {
  const mesh = bakeMesh(model(), 0);
  const fitted = fitSkeleton(quadrupedTemplate(), mesh);
  const L = fitted.bodyLength;
  for (const name of ["knee_l", "ankle_l", "elbow_r", "wrist_r", "spine"]) {
    const j = fitted.names.indexOf(name);
    const want = QUADRUPED_JOINTS[name]!;
    const got = fitted.rest[j]!.map((v, c) => (v - fitted.origin[c]!) / L);
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(got[c]! - want[c]!) < 0.01, `${name}[${c}] ${got[c]} vs ${want[c]}`);
    }
  }
  // A template whose legs sit 0.03 body lengths too wide still lands its knees and ankles on them.
  const wide = quadrupedTemplate();
  for (const joint of wide.joints) {
    if (/^(hip|knee|ankle|toe|shoulder|elbow|wrist|ftoe)_/.test(joint.name))
      joint.rest = [joint.rest[0] * 1.375, joint.rest[1], joint.rest[2]];
  }
  const refitted = fitSkeleton(wide, mesh);
  for (const name of ["knee_l", "ankle_l", "elbow_r", "wrist_r"]) {
    const x = refitted.rest[refitted.names.indexOf(name)]![0] / L;
    assert.ok(Math.abs(Math.abs(x) - 0.08) < 0.01, `${name} x ${x}`);
  }
});

test("a curled tail does not move the midline, and a splayed foot is found on the ground", () => {
  const mesh = bakeMesh(model({ curledTail: true, splayedHindL: 0.07 }), 0);
  const fitted = fitSkeleton(quadrupedTemplate(), mesh);
  const L = fitted.bodyLength;
  // The snout tip lies on the body's midline; normalisation centred the bounds instead.
  let minX = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let v = 0; v < mesh.count; v++) {
    minX = Math.min(minX, mesh.facing[v * 3]!);
    maxX = Math.max(maxX, mesh.facing[v * 3]!);
    maxZ = Math.max(maxZ, mesh.facing[v * 3 + 2]!);
  }
  const tip: number[] = [];
  for (let v = 0; v < mesh.count; v++)
    if (mesh.facing[v * 3 + 2]! > maxZ - 0.01 * L) tip.push(mesh.facing[v * 3]!);
  const midline = tip.reduce((a, b) => a + b, 0) / tip.length;
  assert.ok(Math.abs((minX + maxX) / 2 - midline) / L > 0.03, "the bounds' centre is off the body");
  assert.ok(Math.abs(fitted.origin[0] - midline) / L < 0.01, `midline ${fitted.origin[0] / L}`);
  const at = (name: string) => (fitted.rest[fitted.names.indexOf(name)]![0] - midline) / L;
  assert.ok(Math.abs(at("ankle_l") - 0.15) < 0.015, `ankle_l x ${at("ankle_l")}`);
  assert.ok(Math.abs(at("ankle_r") + 0.08) < 0.01, `ankle_r x ${at("ankle_r")}`);
  assert.ok(Math.abs(at("hip_l") - 0.08) < 0.01, `hip_l x ${at("hip_l")}`);
});

test("on a model with a splayed foot and a curled tail, every foot is planted", () => {
  const r = pipeline({ curledTail: true, splayedHindL: 0.07 }, quadrupedTemplate(), walkGait());
  assert.equal(r.contact.passed, true, r.contact.reason);
  assert.equal(r.skinning.passed, true, r.skinning.reason);
});

test("joint-limit QA reports each joint at its worst frame", () => {
  const tight = quadrupedTemplate();
  for (const joint of tight.joints) if (/^wrist_/.test(joint.name)) joint.limits = { x: [-1, 1] };
  const curl = { ...walkGait(), swingCurlDeg: { fore: 50, hind: 0 } };
  const r = pipeline({}, tight, curl);
  assert.equal(r.limits.passed, false);
  const angles = [
    ...r.limits.reason.matchAll(/wrist_[lr] in any phase at [\d.]+ s: x ([-\d.]+)°/g),
  ];
  assert.equal(angles.length, 2, r.limits.reason);
  for (const [, a] of angles) assert.ok(Number(a) > 45, `worst curl reported: ${a}`);
});

for (const digitigrade of [false, true]) {
  const kind = digitigrade ? "digitigrade" : "plantigrade";
  test(`a ${kind} walk is valid glTF, deterministic, and passes contact, limits, skinning`, async () => {
    const rig = loaded(quadrupedTemplate({ digitigrade }), walkGait({ digitigrade }));
    const run = () =>
      rigCharacter({
        source: model({ digitigrade }, 0.45),
        yaw: 0,
        rig,
        families: ["walk"],
        sizePx: 64,
      });
    const first = await run();
    const second = await run();
    assert.deepEqual(first.bytes, second.bytes, "the same input makes the same file");
    const report = await validateBytes(first.bytes, { format: "glb" });
    assert.equal(report.issues.numErrors, 0);
    const checks = checksOf(first.reasons);
    for (const check of ["contact-walk", "joint-limits-walk", "skinning-walk"]) {
      assert.equal(checks[check]?.passed, true, `${check}: ${checks[check]?.reason}`);
    }
    assert.equal(first.clips[0]!.loop, true);
    assert.deepEqual(first.clips[0]!.rotations.at(-1), first.clips[0]!.rotations[0]);
    if (digitigrade) assert.doesNotMatch(checks["contact-walk"]!.reason, /heel/);
  });
}

test("the same profile gives two characters of a kind the same rig and motion style", async () => {
  const rig = loaded(quadrupedTemplate(), walkGait());
  const small = await rigCharacter({
    source: model({ scale: 0.5 }),
    yaw: 0,
    rig,
    families: ["walk"],
    sizePx: 32,
  });
  const big = await rigCharacter({
    source: model({ scale: 1.2, raisedHeels: true }),
    yaw: 0,
    rig,
    families: ["walk"],
    sizePx: 32,
  });
  const names = (g: Glb) => g.json.skins![0]!.joints.map((j) => g.json.nodes![j]!.name);
  assert.deepEqual(names(small.glb), names(big.glb));
  // Cycle time is stride over speed, both in body lengths, so it does not depend on size.
  assert.ok(Math.abs(small.clips[0]!.durationS - big.clips[0]!.durationS) < 1e-9);
  const names0 = quadrupedTemplate().joints.map((j) => j.name);
  for (const name of ["spine", "chest", "neck", "head", "tail_mid"]) {
    const j = names0.indexOf(name);
    small.clips[0]!.rotations.forEach((pose, k) => {
      const other = big.clips[0]!.rotations[k]![j]!;
      pose[j]!.forEach((v, c) => assert.ok(Math.abs(v - other[c]!) < 1e-9, `${name} key ${k}`));
    });
  }
});

test("raised, dog-like heels on a plantigrade template are planted flat in stance", async () => {
  const rig = loaded(quadrupedTemplate(), walkGait());
  const r = await rigCharacter({
    source: model({ raisedHeels: true }, 0.45),
    yaw: 0,
    rig,
    families: ["walk"],
    sizePx: 32,
  });
  const contact = checksOf(r.reasons)["contact-walk"]!;
  assert.equal(contact.passed, true, contact.reason);
  assert.match(contact.reason, /hind_l sole .* heel 0\.000\d m above toe/);
});

test("contact QA fails feet that float, sink or slide", () => {
  const floating = pipeline({}, quadrupedTemplate(), walkGait(), (clip) => {
    for (const t of clip.rootTranslation) t[1] += 0.05;
  });
  assert.equal(floating.contact.passed, false);
  assert.match(floating.contact.reason, /floats/);
  const sliding = pipeline({}, quadrupedTemplate(), walkGait(), (clip) => {
    clip.speedMps *= 1.5;
  });
  assert.equal(sliding.contact.passed, false);
  assert.match(sliding.contact.reason, /slides/);
});

test("contact QA fails a plantigrade foot whose heel stays raised in stance", () => {
  // The template's feet are plantigrade, but the clip keeps the hind ankles pitched toe-down.
  const r = pipeline({}, quadrupedTemplate(), walkGait(), (clip, names) => {
    for (const name of ["ankle_l", "ankle_r"]) {
      const j = names.indexOf(name);
      for (const pose of clip.rotations) pose[j] = quatMul(pose[j]!, rotX(0.5));
    }
  });
  assert.equal(r.contact.passed, false);
  assert.match(r.contact.reason, /hind_l is plantigrade but its heel stays/);
});

test("joint limits apply by gait phase: a wrist may curl in the swing, never fold in stance", () => {
  const curl = { ...walkGait(), swingCurlDeg: { fore: 50, hind: 15 } };
  const allowed = pipeline({}, quadrupedTemplate(), curl);
  assert.equal(allowed.limits.passed, true, allowed.limits.reason);

  const noCurl = quadrupedTemplate();
  for (const joint of noCurl.joints)
    if (/^wrist_/.test(joint.name)) joint.limits = { x: [-45, 45] };
  const refused = pipeline({}, noCurl, curl);
  assert.equal(refused.limits.passed, false);
  assert.match(refused.limits.reason, /wrist_[lr] in any phase/);

  const tight = quadrupedTemplate();
  for (const joint of tight.joints)
    if (/^wrist_/.test(joint.name)) joint.stanceLimits = { x: [-2, 2] };
  const folded = pipeline({}, tight, walkGait());
  assert.equal(folded.limits.passed, false);
  assert.match(folded.limits.reason, /wrist_[lr] in stance/);
});

test("skinning QA fails volume collapsing at a bent joint", () => {
  const r = pipeline({}, quadrupedTemplate(), walkGait(), (clip, names) => {
    const j = names.indexOf("knee_l");
    for (const pose of clip.rotations) pose[j] = quatMul(pose[j]!, rotX(2.6));
  });
  assert.equal(r.skinning.passed, false, r.skinning.reason);
  assert.match(r.skinning.reason, /volume collapses at knee_l/);
});

test("families without a gait profile are reported missing, not faked", async () => {
  const rig = loaded(quadrupedTemplate(), walkGait());
  const r = await rigCharacter({
    source: model(),
    yaw: 0,
    rig,
    families: ["walk", "eat"],
    sizePx: 32,
  });
  assert.deepEqual(
    r.clips.map((c) => c.family),
    ["walk"],
  );
  assert.deepEqual(
    r.missing.map((m) => m.family),
    ["eat"],
  );
});

test("a model facing +x is rigged in its own facing frame", async () => {
  const glb = parseGlb(syntheticQuadruped({ facing: "+x" }));
  normalize(glb, { sourceForward: "+x", forward: "+x" });
  const rig = loaded(quadrupedTemplate(), walkGait());
  const r = await rigCharacter({
    source: glb,
    yaw: Math.PI / 2,
    rig,
    families: ["walk"],
    sizePx: 32,
  });
  const checks = checksOf(r.reasons);
  for (const check of ["contact-walk", "joint-limits-walk", "skinning-walk"]) {
    assert.equal(checks[check]?.passed, true, `${check}: ${checks[check]?.reason}`);
  }
  assert.ok(Math.abs(r.fit.bodyLengthM - 1) < 0.05, `body length ${r.fit.bodyLengthM}`);
});
