import "./fixtures/spend-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRaster, decodePng, encodePng, getPixel, setPixel } from "../src/image/raster.ts";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Run {
  code: number;
  stdout: string;
}

async function cli(...args: string[]): Promise<Run> {
  try {
    const { stdout } = await exec(process.execPath, [CLI, ...args]);
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { code: number; stdout: string };
    return { code: e.code, stdout: e.stdout };
  }
}

const workdir = () => mkdtemp(join(tmpdir(), "assetforge-transform-cli-"));

/** A dark filled ellipse on an opaque pale background. */
function ellipsePng(): Uint8Array {
  const r = createRaster(40, 40);
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const inside = ((x - 19.5) / 12) ** 2 + ((y - 19.5) / 10) ** 2 <= 1;
      setPixel(r, x, y, inside ? [40, 30, 60, 255] : [235, 230, 220, 255]);
    }
  }
  return encodePng(r);
}

/** An opaque block inside a transparent border. */
function borderedPng(): Uint8Array {
  const r = createRaster(24, 24);
  for (let y = 6; y < 18; y++) for (let x = 4; x < 20; x++) setPixel(r, x, y, [200, 40, 40, 255]);
  return encodePng(r);
}

test("op matte makes the background transparent and records one raster-engine step", async () => {
  const dir = await workdir();
  await writeFile(join(dir, "in.png"), ellipsePng());
  const out = join(dir, "out.png");
  const run = await cli("op", "matte", join(dir, "in.png"), "--out", out, "--json");
  assert.equal(run.code, 0);
  const doc = JSON.parse(run.stdout) as { ok: boolean; command: string };
  assert.equal(doc.ok, true);
  assert.equal(doc.command, "op");
  const raster = decodePng(new Uint8Array(await readFile(out)));
  assert.equal(getPixel(raster, 0, 0)[3], 0);
  assert.equal(getPixel(raster, 39, 39)[3], 0);
  assert.equal(getPixel(raster, 20, 20)[3], 255);
  const prov = JSON.parse(await readFile(`${out}.provenance.json`, "utf8")) as {
    steps: { op: string; engine: { name: string } }[];
  };
  assert.equal(prov.steps.length, 2);
  assert.equal(prov.steps[1]?.op, "embed-digital-source-type");
  assert.equal(prov.steps[0]?.engine.name, "assetforge-raster");
});

test("recipe runs trim, pad, renditions and convert to webp, byte-identically twice", async () => {
  const dir = await workdir();
  await writeFile(join(dir, "hero.png"), borderedPng());
  const recipe = {
    steps: [
      { op: "trim" },
      { op: "pad", params: { top: 2, right: 2, bottom: 2, left: 2 } },
      { op: "renditions", params: { scales: [1, 2] } },
      { op: "convert", params: { format: "webp" } },
    ],
  };
  await writeFile(join(dir, "recipe.json"), JSON.stringify(recipe));
  const outputs: Uint8Array[][] = [];
  for (const name of ["a", "b"]) {
    const out = join(dir, name);
    const run = await cli("recipe", join(dir, "recipe.json"), join(dir, "hero.png"), "--out", out);
    assert.equal(run.code, 0);
    const files: Uint8Array[] = [];
    for (const f of ["hero@1x.webp", "hero@2x.webp"]) {
      const bytes = new Uint8Array(await readFile(join(out, f)));
      assert.equal(Buffer.from(bytes.subarray(0, 4)).toString("latin1"), "RIFF");
      assert.equal(Buffer.from(bytes.subarray(8, 12)).toString("latin1"), "WEBP");
      files.push(bytes);
    }
    outputs.push(files);
    const prov = JSON.parse(await readFile(join(out, "provenance.json"), "utf8")) as {
      steps: { op: string }[];
    };
    assert.equal(prov.steps.length, 6);
    assert.deepEqual(
      prov.steps.slice(4).map((s) => s.op),
      ["embed-digital-source-type", "embed-digital-source-type"],
    );
  }
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(outputs[0]?.[i], outputs[1]?.[i]);
  }
});

test("an unknown operation and a bad parameter are invalid input", async () => {
  const dir = await workdir();
  await writeFile(join(dir, "in.png"), borderedPng());
  const input = join(dir, "in.png");
  const out = join(dir, "out.png");
  const cases = [
    ["op", "frobnicate", input, "--out", out, "--json"],
    ["op", "trim", input, "--out", out, "--params", '{"nope":1}', "--json"],
    ["op", "trim", input, "--out", out, "--params", "[1]", "--json"],
    ["op", "trim", "--out", out, "--json"],
  ];
  for (const args of cases) {
    const run = await cli(...args);
    assert.equal(run.code, 2, args.join(" "));
    const doc = JSON.parse(run.stdout) as {
      ok: boolean;
      exitCode: number;
      error: { code: string };
    };
    assert.equal(doc.ok, false);
    assert.equal(doc.exitCode, 2);
    assert.equal(doc.error.code, "invalid_input");
  }
});

test("ops lists the operations", async () => {
  const run = await cli("ops", "--json");
  assert.equal(run.code, 0);
  const doc = JSON.parse(run.stdout) as { operations: { name: string }[] };
  const names = doc.operations.map((o) => o.name);
  for (const n of ["matte", "slice", "join", "convert"]) assert.ok(names.includes(n), n);
});

test("CLI declarations validate the IPTC vocabulary and record the declarant without guessing", async () => {
  const root = await mkdtemp(join(tmpdir(), "iptc-cli-declaration-"));
  const input = join(root, "input.png"),
    out = join(root, "out.png");
  await writeFile(input, encodePng(createRaster(2, 2)));
  const staged = await cli("op", "flip", input, "--out", out, "--json");
  assert.equal(staged.code, 0);
  assert.equal(JSON.parse(staged.stdout).outputs[0].digitalSourceType, "undeclared");
  const invalid = await cli(
    "op",
    "flip",
    input,
    "--out",
    out,
    "--digital-source-type",
    "imaginary",
    "--json",
  );
  assert.equal(invalid.code, 2);
  assert.match(invalid.stdout, /invalid --digital-source-type/);
  for (const code of [
    "digitalCreation",
    "digitalCapture",
    "computationalCapture",
    "humanEdits",
    "softwareImage",
  ]) {
    const result = await cli(
      "op",
      "flip",
      input,
      "--out",
      out,
      "--digital-source-type",
      code,
      "--json",
    );
    assert.equal(result.code, 0, result.stdout);
    const record = JSON.parse(result.stdout);
    const uri = `http://cv.iptc.org/newscodes/digitalsourcetype/${code}`;
    assert.equal(record.outputs[0].digitalSourceType, uri);
    assert.deepEqual(record.sourceDeclaration, {
      value: uri,
      declaredBy: (await import("node:os")).userInfo().username,
    });
    const { readDigitalSourceType } = await import("../src/metadata.ts");
    assert.equal(readDigitalSourceType(await readFile(out), "image/png"), uri);
  }
});
