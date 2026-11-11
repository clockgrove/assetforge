import "./fixtures/spend-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function cli(...args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await exec(process.execPath, [CLI, ...args], { timeout: 30_000 });
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { code: number; stdout: string };
    return { code: e.code, stdout: e.stdout };
  }
}

test("materials documents required options and rejects missing input through CLI", async () => {
  const help = await cli("materials", "--help", "--json");
  assert.equal(help.code, 0);
  assert.match(JSON.parse(help.stdout).usage, /--derivation/);
  const run = await cli("materials", "--json");
  assert.equal(run.code, 2);
  assert.equal(JSON.parse(run.stdout).error.code, "invalid_input");
});

// Fake-only renderer: copies albedo to prove argv/file transport, not actual target lighting quality.
test("materials CLI writes native still and animation materials with scripted lit QA", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetforge-material-cli-"));
  const renderer = join(dir, "render.mjs");
  await writeFile(
    renderer,
    `import {copyFileSync} from 'node:fs'; copyFileSync(process.argv[2],process.argv[3]);`,
  );
  const provider = join(dir, "provider.mjs");
  await writeFile(
    provider,
    `export default { image(){throw new Error('unexpected model generation')}, vision(){return {text:JSON.stringify({checks:['flat-albedo','normal-orientation','emissive-placement','dusk-rain','night'].map(check=>({check,passed:true,reason:'synthetic fixture'}))})}} };`,
  );
  for (const count of [1, 2]) {
    const raster = createRaster(count * 8, 8);
    for (let y = 1; y < 7; y++)
      for (let x = 0; x < raster.width; x++) {
        if (x % 8 > 0 && x % 8 < 7) setPixel(raster, x, y, [100, 100, 100, 255]);
      }
    const albedo = join(dir, `albedo-${count}.png`);
    await writeFile(albedo, encodePng(raster));
    await writeFile(
      join(dir, "spec.json"),
      JSON.stringify({
        kind: count === 1 ? "still" : "sprite-strip",
        assetId: "synthetic",
        frames: { count, width: 4, height: 4 },
      }),
    );
    await writeFile(
      join(dir, "profile.json"),
      JSON.stringify({
        name: "synthetic",
        license: "MIT",
        frames: { width: 4, height: 4 },
        style: {
          materials: {
            channels: ["height", "normal"],
            scales: [1, 2],
            flickerBound: 0,
            lightRig: {
              "dusk-rain": { direction: [0.5, -0.5, 1], intensity: 0.4 },
              night: { direction: [0, 0, 1], intensity: 0.1 },
            },
            preview: {
              version: "synthetic-copy-1",
              command: [process.execPath, renderer, albedo, "{{output}}"],
            },
          },
        },
      }),
    );
    await writeFile(
      join(dir, "derivation.json"),
      JSON.stringify({
        maps: {
          height: { method: "mask-extraction", version: "1", path: `albedo-${count}.png` },
          normal: { method: "height-derived-normal", version: "1" },
        },
      }),
    );
    const out = join(dir, `out-${count}`);
    const run = await cli(
      "materials",
      "--albedo",
      albedo,
      "--spec",
      join(dir, "spec.json"),
      "--profile",
      join(dir, "profile.json"),
      "--derivation",
      join(dir, "derivation.json"),
      "--out",
      out,
      "--provider-script",
      provider,
      "--json",
    );
    assert.equal(run.code, 0, run.stdout);
    const doc = JSON.parse(run.stdout) as {
      passed: boolean;
      reportPath: string;
      outputs: unknown[];
    };
    assert.equal(doc.passed, true);
    assert.ok(doc.outputs.length >= 6);
    const report = JSON.parse(await readFile(doc.reportPath, "utf8"));
    assert.equal(report.qa.passed, true);
  }
});

test("materials dry-run forecasts defaults without provider or output writes and refuses over cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetforge-material-plan-"));
  const profile = join(dir, "profile.json"),
    spec = join(dir, "spec.json"),
    derivation = join(dir, "derivation.json"),
    out = join(dir, "out");
  await writeFile(profile, JSON.stringify({ frames: { width: 4, height: 4 } }));
  await writeFile(spec, JSON.stringify({ kind: "still", assetId: "synthetic" }));
  await writeFile(
    derivation,
    JSON.stringify({
      maps: Object.fromEntries(
        ["normal", "height", "emissive", "roughness", "wind"].map((channel) => [
          channel,
          {
            method: channel === "normal" ? "height-derived-normal" : "mask-extraction",
            version: "1",
            path: "unread.png",
          },
        ]),
      ),
    }),
  );
  const args = [
    "materials",
    "--albedo",
    join(dir, "unread.png"),
    "--profile",
    profile,
    "--spec",
    spec,
    "--derivation",
    derivation,
    "--out",
    out,
    "--dry-run",
    "--json",
  ];
  const run = await cli(...args);
  assert.equal(run.code, 0, run.stdout);
  const doc = JSON.parse(run.stdout);
  assert.equal(doc.dryRun, true);
  assert.deepEqual(doc.plan.channels, ["normal", "height", "emissive", "roughness", "wind"]);
  assert.deepEqual(doc.plan.scales, [1, 2]);
  assert.equal(doc.plan.calls, 1);
  assert.equal(doc.plan.estimateUsd, 0.02);
  await assert.rejects(readFile(join(out, "materials.json")), { code: "ENOENT" });
  const refused = await cli(...args, "--cap", "0");
  assert.equal(refused.code, 3);
  assert.equal(JSON.parse(refused.stdout).error.code, "cap_refused");
  await writeFile(profile, JSON.stringify({ style: { materials: { channels: ["unknown"] } } }));
  const invalid = await cli(...args);
  assert.equal(invalid.code, 2);
  assert.equal(JSON.parse(invalid.stdout).error.code, "invalid_input");
});
