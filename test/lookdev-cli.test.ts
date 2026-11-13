import "./fixtures/spend-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodePng } from "../src/image/raster.ts";
import { parseGlb } from "../src/model3d/glb.ts";
import { sha256 } from "../src/request.ts";
import { PALETTE, drawSubject } from "./fixtures/synthetic.ts";
import { quadrupedIdle, quadrupedPaw, quadrupedTemplate, walkGait } from "./fixtures/quadruped.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/model3d-quadruped-script.ts", import.meta.url));
const LOOKDEV_SCRIPT = fileURLToPath(new URL("./fixtures/lookdev-script.ts", import.meta.url));
const VALIDATOR = fileURLToPath(new URL("./fixtures/validator-3d.ts", import.meta.url));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<Result> {
  const env = { ...process.env, ...extraEnv };
  delete env["AI_GATEWAY_API_KEY"];
  delete env["TRIPO_API_KEY"];
  delete env["MESHY_API_KEY"];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
const doc = (r: Result): Doc => JSON.parse(r.stdout);
const checksOf = (c: Doc): Record<string, { passed: boolean; reason: string }> =>
  Object.fromEntries(c["reasons"].map((x: { check: string }) => [x.check, x]));

const GROOM = {
  // Finer than the 8 px synthetic texture, so the eye and nose masks hold texels.
  sizePx: 256,
  seasons: ["summer", "winter"],
  traits: { summer: "short, sleek, grey-brown", winter: "long, dense, frosted" },
};

/** A target with a rig template, a groom declaration and a manifest that carries the look-dev fields. */
async function world(options: { groom?: Doc | null; model3d?: boolean; motions?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "assetforge-lookdev-"));
  await mkdir(join(dir, "refs"));
  const roles = ["turnaround-front", "turnaround-side", "turnaround-back"];
  for (const [i, role] of roles.entries()) {
    await writeFile(join(dir, "refs", `${role}.png`), encodePng(drawSubject(64, i * 4)));
  }
  await mkdir(join(dir, "rig"));
  await writeFile(join(dir, "rig", "quadruped.json"), JSON.stringify(quadrupedTemplate()));
  const files = {
    spec: join(dir, "spec.json"),
    bible: join(dir, "bible.json"),
    profile: join(dir, "profile.json"),
  };
  await writeFile(
    files.spec,
    JSON.stringify({
      kind: "character-3d",
      assetId: "kit",
      subject: "kit",
      gait: "quadruped",
      clips: options.motions ? ["walk", "idle", "paw"] : ["walk"],
      heightM: 0.45,
    }),
  );
  await writeFile(
    files.bible,
    JSON.stringify({
      version: "2026-11-10",
      palette: PALETTE,
      references: roles.map((role) => ({ path: `refs/${role}.png`, role, subject: "kit" })),
      perspective: "refs/turnaround-front.png",
      subjects: { kit: { description: "a small synthetic quadruped" } },
    }),
  );
  const groom = options.groom === undefined ? GROOM : options.groom;
  await writeFile(
    files.profile,
    JSON.stringify({
      name: "synthetic-grove-lookdev",
      license: "MIT",
      frames: { width: 32, height: 32 },
      ...(options.model3d !== false && {
        model3d: {
          format: "glb",
          budgets: { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 },
          units: "m",
          turntable: { sizePx: 64 },
          rig: { template: "rig/quadruped.json", kind: "synthetic-quadruped" },
          gaits: { walk: walkGait() },
          ...(options.motions && { motions: { idle: quadrupedIdle(), paw: quadrupedPaw() } }),
          ...(groom && { groom }),
        },
      }),
      layout: {
        media: "characters/{{spec.assetId}}/{{spec.assetId}}.{{output.extension}}",
        manifest: "characters/{{spec.assetId}}/manifest.json",
      },
      manifest: {
        assetId: "{{spec.assetId}}",
        source: { path: "{{output.path}}", mediaType: "{{output.mediaType}}" },
        license: "{{profile.license}}",
        review: { status: "pending" },
        model: {
          triangles: "{{output.triangles}}",
          textureMaxPx: "{{output.textureMaxPx}}",
          materials: "{{output.materials}}",
          bones: "{{output.bones}}",
          lods: "{{output.lods}}",
          clips: "{{output.clips}}",
          bounds: "{{output.bounds}}",
          rig: "{{output.rig}}",
        },
        groom: "{{output.groom}}",
        textures: "{{output.textures}}",
        eyes: "{{output.eyes}}",
        contentHash: "{{output.sha256}}",
      },
      review: { path: "review.status", pending: "pending" },
      validator: { command: [process.execPath, VALIDATOR, "{{manifest}}"] },
    }),
  );
  const runs = join(dir, "runs");
  const target = join(dir, "target");
  await mkdir(target);
  const base = ["--spec", files.spec, "--bible", files.bible, "--profile", files.profile];
  return { dir, files, base, runs, target };
}

/** A rigged one-candidate run made by `rig` (the look-dev input), with its provenance in a file. */
async function riggedModel(w: Awaited<ReturnType<typeof world>>) {
  const staged = await cli(
    [
      "stage",
      ...w.base,
      "--runs",
      w.runs,
      "--candidates",
      "1",
      "--provider-script",
      SCRIPT,
      "--json",
    ],
    { SCRIPT_QUADRUPED_ATLAS: "1" },
  );
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  const c = doc(staged)["candidates"][0];
  const stagedModel = join(w.runs, doc(staged)["runId"], c.file);
  const provenance = join(w.dir, "c1.provenance.json");
  await writeFile(provenance, JSON.stringify(c.provenance));
  const rigged = await cli([
    "rig",
    "--model",
    stagedModel,
    "--provenance",
    provenance,
    "--spec",
    w.files.spec,
    "--profile",
    w.files.profile,
    "--runs",
    join(w.dir, "rigged"),
    "--json",
  ]);
  assert.equal(rigged.code, 0, rigged.stdout + rigged.stderr);
  const run = doc(rigged);
  const model = join(run["runDir"], run["candidates"][0].file);
  const riggedProvenance = join(w.dir, "rigged.provenance.json");
  await writeFile(riggedProvenance, JSON.stringify(run["candidates"][0].provenance));
  return { model, provenance: riggedProvenance, source: run["candidates"][0].provenance };
}

const lookDevArgs = (
  w: Awaited<ReturnType<typeof world>>,
  m: { model: string; provenance: string },
) => [
  "look-dev",
  "--model",
  m.model,
  "--provenance",
  m.provenance,
  ...w.base,
  "--runs",
  w.runs,
  "--provider-script",
  LOOKDEV_SCRIPT,
  "--json",
];

test("look-dev forecasts its calls, refuses over the cap and needs a model3d profile", async () => {
  const w = await world();
  const none = { model: "x.glb", provenance: "x.json" };
  const r = await cli([...lookDevArgs(w, none), "--dry-run"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const plan = doc(r)["plan"];
  const count = (op: string) =>
    plan.calls.filter((c: { operation: string }) => c.operation === op).length;
  // 7 turntable views and a close-up of the head (the detail pass).
  assert.equal(count("lookdev"), 8);
  assert.equal(count("lookdev-locate"), 1);
  assert.equal(count("lookdev-groom"), 2);
  assert.equal(count("lookdev-markings"), 4);
  assert.equal(count("identity"), 1);
  assert.deepEqual(plan.seasons, ["summer", "winter"]);
  assert.equal(plan.capUsd, 3);

  const capped = await cli([...lookDevArgs(w, none), "--dry-run", "--cap", "0.5"]);
  assert.equal(capped.code, 3, capped.stdout + capped.stderr);
  assert.equal(doc(capped)["error"].code, "cap_refused");

  const bare = await world({ model3d: false });
  const refused = await cli([...lookDevArgs(bare, none), "--dry-run"]);
  assert.equal(refused.code, 2, refused.stdout + refused.stderr);
});

test("look-dev gives a rigged model its look, maps and eyes; pick hands it all off", async () => {
  const w = await world();
  const input = await riggedModel(w);
  const inputBytes = new Uint8Array(await readFile(input.model));
  const r = await cli(lookDevArgs(w, input));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const run = doc(r);
  assert.equal(run["candidates"].length, 1, JSON.stringify(run["rejections"]));
  const c = run["candidates"][0];
  const checks = checksOf(c);
  for (const check of [
    "groom-summer-masks",
    "groom-winter-masks",
    "groom-summer-render",
    "groom-winter-render",
    "lookdev-albedo-coverage",
    "lookdev-seams",
    "eyes-catch-light",
    "gltf-validator",
    "lookdev-markings",
  ]) {
    assert.equal(checks[check]?.passed, true, `${check}: ${checks[check]?.reason}`);
  }

  const fields = c.sidecars.map((s: { field: string }) => s.field);
  for (const season of ["summer", "winter"]) {
    for (const map of ["length", "direction", "density"]) {
      assert.ok(fields.includes(`groom.${season}.${map}`), `groom.${season}.${map}`);
    }
  }
  assert.ok(fields.includes("textures.tint.winter"));
  assert.ok(!fields.includes("textures.tint.summer"));
  assert.ok(fields.includes("textures.baseColor"));
  const eyes = c.sidecars.find((s: { field: string }) => s.field === "eyes");
  assert.equal(eyes.extra.material, "eyes");

  const ops = (calls: Array<{ operation: string }>) => calls.map((x) => x.operation);
  const added = ops(c.provenance.calls).slice(input.source.calls.length);
  // One markings call per turntable view with its own reference: front, side and back.
  assert.equal(c.provenance.calls.length, input.source.calls.length + 15);
  assert.deepEqual(
    added.toSorted(),
    [
      ...Array(8).fill("lookdev"),
      "lookdev-locate",
      "lookdev-groom",
      "lookdev-groom",
      ...Array(3).fill("lookdev-markings"),
      "identity",
    ].toSorted(),
  );
  // Views are restyled in turn: every view after the first starts from what earlier views painted.
  const restyles = c.provenance.calls
    .slice(input.source.calls.length)
    .filter((x: { operation: string }) => x.operation === "lookdev");
  assert.doesNotMatch(restyles[0].prompt, /already carries colour painted from other views/);
  for (const r of restyles.slice(1)) {
    assert.match(r.prompt, /already carries colour painted from other views/);
  }
  // The detail pass comes last: close-ups of the head, after the turntable views.
  assert.equal(
    restyles.filter((x: { prompt: string }) => /close-up of the character's head/.test(x.prompt))
      .length,
    1,
  );
  assert.match(restyles.at(-1).prompt, /close-up of the character's head/);
  // The markings call records the route's provider options it was sent with.
  const markingsCall = c.provenance.calls.find(
    (x: { operation: string }) => x.operation === "lookdev-markings",
  );
  assert.deepEqual(markingsCall.parameters.providerOptions, {
    google: { thinkingConfig: { thinkingLevel: "low" } },
  });
  // One preview lighting, auto-exposed, for before and after; lit renders read near the albedo.
  const lighting = c.provenance.parameters.lookdev.lighting;
  assert.equal(lighting.auto, true);
  assert.ok(lighting.exposure > 1, String(lighting.exposure));
  for (const season of ["summer", "winter"]) {
    for (const ratio of Object.values(lighting.litToUnlit[season]) as number[]) {
      assert.ok(ratio > 0.8 && ratio < 1.2, `${season} lit/unlit ${ratio}`);
    }
  }
  assert.match(checks["groom-summer-render"]!.reason, /speckle it adds: at most 0\.\d\d%/);
  assert.match(
    checks["lookdev-markings"]!.reason,
    /no marking was measured.*three-quarter \(the references have no three-quarter view\)/,
  );
  assert.equal(c.provenance.parameters.lookdev.sourceModelSha256, sha256(inputBytes));
  assert.ok(c.provenance.outputGrant);
  assert.deepEqual(c.provenance.parameters.lookdev.seasons, ["summer", "winter"]);

  const runDir = run["runDir"];
  const glb = parseGlb(new Uint8Array(await readFile(join(runDir, c.file))));
  const external = glb.json.images!.filter((i) => i.uri !== undefined);
  assert.equal(external.length, 8, "six groom maps, the winter tint and the eye mask");
  for (const image of external) assert.equal(image.bufferView, undefined);
  assert.ok(external.some((i) => i.uri === "kit.groom.summer.length.png"));
  assert.ok(glb.json.materials!.some((m) => m.name === "eyes"));
  assert.ok(
    glb.json.images!.some((i) => i.bufferView !== undefined),
    "base colour is embedded",
  );
  // The catch-light is the eye material's own emissive texture, never painted into the base colour.
  type Emissive = { name?: string; emissiveTexture?: { index: number } };
  const materials = glb.json.materials as Emissive[];
  assert.ok(materials.find((m) => m.name === "eyes")?.emissiveTexture);
  assert.ok(materials.filter((m) => m.name !== "eyes").every((m) => !m.emissiveTexture));
  assert.match(checks["eyes-catch-light"]!.reason, /catch-light in 2 of 2 eye\(s\)/);
  assert.match(
    checks["groom-summer-masks"]!.reason,
    /eyes [1-9]\d*, nose [1-9]\d*, paw pads [1-9]/,
  );
  // The synthetic references have no three-quarter view: the compare image says it borrows the front.
  assert.equal(checks["lookdev-compare"]?.passed, true);
  assert.match(
    checks["lookdev-compare"]!.reason,
    /compare-three-quarter show\(s\) the front reference/,
  );

  const renders = await readdir(join(runDir, "c1-character-3d"));
  for (const view of ["front", "three-quarter", "side", "back", "close-up"]) {
    for (const name of [
      `compare-${view}.png`,
      `before-${view}.png`,
      `after-summer-${view}.png`,
      `after-winter-${view}.png`,
    ]) {
      assert.ok(renders.includes(name), name);
    }
  }
  for (const view of ["front", "three-quarter", "side", "back"]) {
    assert.ok(renders.includes(`unlit-before-${view}.png`), view);
    assert.ok(renders.includes(`unlit-after-${view}.png`), view);
  }
  assert.equal(run["spentUsd"] > 0, true);

  // Scripted spend is not counted against the ledger.
  const status = await cli([...lookDevArgs(w, input), "--dry-run"]);
  assert.equal(doc(status)["spend"].counted, false);

  const picked = await cli([
    "pick",
    "--run",
    runDir,
    "--candidate",
    "c1",
    "--target",
    w.target,
    "--json",
  ]);
  assert.equal(picked.code, 0, picked.stdout + picked.stderr);
  assert.equal(doc(picked)["validator"].accepted, true, doc(picked)["validator"].output);
  const written = await readdir(join(w.target, "characters/kit"));
  for (const s of c.sidecars) assert.ok(written.includes(s.name), s.name);
  assert.ok(written.includes("kit.glb"));
  const manifest = JSON.parse(
    await readFile(join(w.target, "characters/kit/manifest.json"), "utf8"),
  );
  assert.equal(manifest.review.status, "pending");
  for (const season of ["summer", "winter"]) {
    for (const map of ["length", "direction", "density"]) {
      const entry = manifest.groom[season][map];
      assert.equal(entry.path, `characters/kit/kit.groom.${season}.${map}.png`);
      const bytes = await readFile(join(w.target, entry.path));
      assert.equal(entry.sha256, sha256(bytes));
    }
  }
  assert.ok(manifest.textures.tint.winter.sha256);
  assert.equal(manifest.textures.tint.summer, undefined);
  assert.ok(manifest.textures.baseColor.sha256);
  assert.ok(manifest.eyes.sha256);
});

test("look-dev reports a declared motion's clip as rig and stage do, staying put", async () => {
  const w = await world({ motions: true });
  const input = await riggedModel(w);
  const r = await cli(lookDevArgs(w, input));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const run = doc(r);
  assert.equal(run["candidates"].length, 1, JSON.stringify(run["rejections"]));
  const shape = (clips: Doc[]) =>
    clips.map((x) => [x["name"], x["loop"], x["generated"], typeof x["speedMps"]]);
  const clips = run["candidates"][0].fields.clips;
  assert.deepEqual(shape(clips), [
    ["walk", true, true, "number"],
    ["idle", true, true, "number"],
    ["paw", false, true, "number"],
  ]);
  assert.ok(clips[0].speedMps > 0);
  assert.deepEqual(
    clips.slice(1).map((x: Doc) => x["speedMps"]),
    [0, 0],
  );
});

test("without declared seasons the maps are keyed by name and there is no tint", async () => {
  const w = await world({ groom: { sizePx: 256 } });
  const input = await riggedModel(w);
  const r = await cli(lookDevArgs(w, input));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const c = doc(r)["candidates"][0];
  const fields = c.sidecars.map((s: { field: string }) => s.field);
  for (const map of ["length", "direction", "density"]) {
    assert.ok(fields.includes(`groom.${map}`), map);
  }
  assert.ok(!fields.some((f: string) => f.startsWith("textures.tint")));
  const checks = checksOf(c);
  assert.equal(checks["groom-masks"]?.passed, true, checks["groom-masks"]?.reason);
  assert.equal(checks["groom-render"]?.passed, true, checks["groom-render"]?.reason);
  assert.equal(checks["groom-summer-masks"], undefined);
  assert.ok(existsSync(join(doc(r)["runDir"], "c1.glb")));
});

test("an empty bare mask fails the groom check and is named", async () => {
  const w = await world();
  const input = await riggedModel(w);
  const r = await cli(lookDevArgs(w, input), {
    SCRIPT_LOOKDEV_EYES: JSON.stringify({
      eyes: [
        { x: 240, y: 250, r: 45 },
        { x: 270, y: 250, r: 45 },
      ],
      nose: null,
    }),
  });
  const run = doc(r);
  assert.equal(run["candidates"].length, 0, r.stdout + r.stderr);
  const reasons: Array<{ check: string; passed: boolean; reason: string }> =
    run["rejections"][0].reasons;
  for (const season of ["summer", "winter"]) {
    const check = reasons.find((x) => x.check === `groom-${season}-masks`)!;
    assert.equal(check.passed, false);
    assert.match(check.reason, /nose 0/);
    assert.match(check.reason, /the nose mask is empty \(the locate call found no nose\)/);
  }
});

test("a drifting marking is named and recorded, but the advisory check stages the candidate", async () => {
  const w = await world({ groom: { sizePx: 256 } });
  const input = await riggedModel(w);
  // The scripted reply boxes the middle of each figure: the synthetic references and the
  // restyled model differ there by more than the colour tolerance.
  const r = await cli(lookDevArgs(w, input), { SCRIPT_LOOKDEV_MARKINGS: "figure" });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const run = doc(r);
  assert.equal(run["candidates"].length, 1);
  const reasons: Array<{ check: string; passed: boolean; reason: string; shadow?: boolean }> =
    run["candidates"][0].reasons;
  const check = reasons.find((x) => x.check === "lookdev-markings")!;
  assert.equal(check.passed, false);
  assert.equal(check.shadow, true);
  assert.match(check.reason, /^advisory, never filters/);
  assert.match(check.reason, /front: patch \(default ΔE/);
  assert.match(check.reason, /drifting: patch \(front, default: colour ΔE/);
  assert.match(check.reason, /not measured: three-quarter/);
});

test("a marking the turnaround shows and the renders lost fails the advisory markings check", async () => {
  const w = await world({ groom: { sizePx: 256 } });
  const input = await riggedModel(w);
  const r = await cli(lookDevArgs(w, input), { SCRIPT_LOOKDEV_MARKINGS: "vanished" });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const reasons: Array<{ check: string; passed: boolean; reason: string }> =
    doc(r)["candidates"][0].reasons;
  const check = reasons.find((x) => x.check === "lookdev-markings")!;
  assert.equal(check.passed, false);
  assert.match(check.reason, /drifting: patch \(front, default: not shown in the render\)/);
});

test("a profile's preview lighting is used as declared, and bad lighting is refused", async () => {
  const w = await world({ groom: { sizePx: 256 } });
  const profile = JSON.parse(await readFile(w.files.profile, "utf8"));
  profile.model3d.lookdev = {
    previewLighting: { ambient: 0.3, key: 0.7, keyDirection: [0, 1, 0.2], exposure: 1.25 },
  };
  await writeFile(w.files.profile, JSON.stringify(profile));
  const input = await riggedModel(w);
  const r = await cli(lookDevArgs(w, input));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const lighting = doc(r)["candidates"][0].provenance.parameters.lookdev.lighting;
  assert.deepEqual(
    [lighting.ambient, lighting.key, lighting.keyDirection, lighting.exposure, lighting.auto],
    [0.3, 0.7, [0, 1, 0.2], 1.25, false],
  );
  profile.model3d.lookdev = { previewLighting: { keyDirection: [0, 0, 0] } };
  await writeFile(w.files.profile, JSON.stringify(profile));
  const bad = await cli([...lookDevArgs(w, { model: "x.glb", provenance: "x.json" }), "--dry-run"]);
  assert.equal(bad.code, 2, bad.stdout + bad.stderr);
  assert.match(doc(bad)["error"].message, /previewLighting.keyDirection/);
});
