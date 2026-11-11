import "./fixtures/spend-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

function noKey(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["AI_GATEWAY_API_KEY"];
  return env;
}

/** Stdout must be exactly one JSON document. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function doc(result: Result): Record<string, any> {
  return JSON.parse(result.stdout);
}

async function files() {
  const world = await syntheticWorld();
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  const base = ["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir];
  return { world, base };
}

async function script(dir: string, body: string): Promise<string> {
  const path = join(dir, "script.mjs");
  await writeFile(path, `export default ${body};`);
  return path;
}

test("--help lists every command and exits 0; a command's --help prints its usage", async () => {
  for (const flag of ["--help", "-h", "help"]) {
    const r = await cli([flag]);
    assert.equal(r.code, 0);
    for (const command of ["stage", "pick", "import", "generate-sheet", "write-families"]) {
      assert.match(r.stdout, new RegExp(`^  ${command} `, "m"));
    }
  }
  const r = await cli(["stage", "--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--dry-run/);
  const v = await cli(["--version"]);
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
});

test("no command prints usage on stderr and exits 2", async () => {
  const r = await cli([]);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /stage/);
});

test("an unknown command with --json is one invalid_input document", async () => {
  const r = await cli(["bogus", "--json"]);
  assert.equal(r.code, 2);
  const d = doc(r);
  assert.deepEqual(
    [d["ok"], d["exitCode"], d["command"], d["error"].code],
    [false, 2, null, "invalid_input"],
  );
  assert.match(r.stderr, /unknown command/);
});

test("missing and malformed options are invalid_input", async () => {
  for (const args of [
    ["stage", "--json"],
    ["stage", "--json", "--nope"],
    ["pick", "--json", "--run", "x"],
  ]) {
    const r = await cli(args);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(doc(r)["error"].code, "invalid_input");
    assert.equal(doc(r)["command"], args[0]);
  }
  const { base } = await files();
  const r = await cli(["stage", ...base, "--cap", "lots", "--json"]);
  assert.equal(r.code, 2);
  assert.match(doc(r)["error"].message, /--cap/);
});

test("stage --dry-run plans without a key, a provider or writing anything", async () => {
  const { world, base } = await files();
  const r = await cli(["stage", ...base, "--dry-run", "--json"], noKey());
  assert.equal(r.code, 0, r.stderr);
  const d = doc(r);
  assert.equal(d["ok"], true);
  assert.equal(d["command"], "stage");
  assert.equal(d["dryRun"], true);
  assert.equal(d["plan"].requested, 4);
  assert.equal(d["plan"].withinCap, true);
  assert.ok(d["plan"].calls > 0 && d["plan"].estimateUsd > 0);
  assert.ok(d["plan"].perCandidate.length > 0);
  await assert.rejects(readdir(world.runsDir), { code: "ENOENT" });

  const human = await cli(["stage", ...base, "--dry-run"], noKey());
  assert.equal(human.code, 0);
  assert.match(human.stdout, /forecast/);
});

test("a dry-run forecast over the cap is cap_refused and still carries the plan", async () => {
  const { base } = await files();
  const r = await cli(["stage", ...base, "--dry-run", "--cap", "0.01", "--json"], noKey());
  assert.equal(r.code, 3);
  const d = doc(r);
  assert.equal(d["error"].code, "cap_refused");
  assert.match(d["error"].message, /cap/);
  assert.equal(d["plan"].withinCap, false);
});

test("a full run through a provider script stages candidates", async () => {
  const { world, base } = await files();
  const r = await cli(
    ["stage", ...base, "--candidates", "2", "--provider-script", passingScript, "--json"],
    noKey(),
  );
  assert.equal(r.code, 0, r.stderr);
  const d = doc(r);
  assert.equal(d["ok"], true);
  assert.equal(d["candidates"].length, 2);
  assert.ok(d["runDir"].startsWith(world.runsDir));
  assert.match(JSON.stringify(d["candidates"][0].provenance), /scripted:/);
});

test("every candidate failing to generate is provider_error", async () => {
  const { world, base } = await files();
  const s = await script(
    world.dir,
    `{ image() { throw new Error("boom"); }, vision() { throw new Error("boom"); } }`,
  );
  const r = await cli(["stage", ...base, "--candidates", "1", "--provider-script", s, "--json"]);
  assert.equal(r.code, 4);
  assert.equal(doc(r)["error"].code, "provider_error");
});

test("QA rejecting every candidate is qa_found_nothing", async () => {
  const { base } = await files();
  const r = await cli(
    [
      "stage",
      ...base,
      "--candidates",
      "1",
      "--provider-script",
      passingScript.replace("script.ts", "reject.ts"),
      "--json",
    ],
    noKey(),
  );
  assert.equal(r.code, 5, r.stderr);
  assert.equal(doc(r)["error"].code, "qa_found_nothing");
});

test("a provider script without image and vision is invalid_input", async () => {
  const { world, base } = await files();
  const s = await script(world.dir, `{}`);
  const r = await cli(["stage", ...base, "--provider-script", s, "--dry-run", "--json"]);
  assert.equal(r.code, 2);
  assert.equal(doc(r)["error"].code, "invalid_input");
});

test("stage without a key and without a script is provider_error", async () => {
  const { base } = await files();
  const r = await cli(["stage", ...base, "--json"], noKey());
  assert.equal(r.code, 4);
  assert.equal(doc(r)["error"].code, "provider_error");
  assert.match(r.stderr, /AI_GATEWAY_API_KEY is not set/);
});

test("pick reports a validator rejection as validator_rejected with the result", async () => {
  const { world, base } = await files();
  world.profile.validator = {
    command: [process.execPath, "-e", "console.error('nope'); process.exit(1)"],
  };
  await writeFile(join(world.dir, "profile.json"), JSON.stringify(world.profile));
  const staged = doc(
    await cli([
      "stage",
      ...base,
      "--candidates",
      "1",
      "--provider-script",
      passingScript,
      "--json",
    ]),
  );
  await mkdir(world.targetDir, { recursive: true });
  const r = await cli([
    "pick",
    "--run",
    staged["runDir"],
    "--candidate",
    "c1",
    "--target",
    world.targetDir,
    "--json",
  ]);
  assert.equal(r.code, 6, r.stderr);
  const d = doc(r);
  assert.equal(d["error"].code, "validator_rejected");
  assert.equal(d["validator"].accepted, false);
});

test("generate-sheet --dry-run forecasts the sheet and grouping calls without a key", async () => {
  const { world, base } = await files();
  const r = await cli(["generate-sheet", ...base.slice(0, 6), "--dry-run", "--json"], noKey());
  assert.equal(r.code, 0, r.stderr);
  const d = doc(r);
  assert.equal(d.ok, true);
  assert.equal(d.command, "generate-sheet");
  assert.deepEqual(
    d.plan.perCall.map((c: { operation: string }) => c.operation),
    ["sheet", "vision"],
  );
  assert.equal((await readdir(world.dir)).includes("imports"), false);
  const over = await cli([
    "generate-sheet",
    ...base.slice(0, 6),
    "--cap",
    "0",
    "--dry-run",
    "--json",
  ]);
  assert.equal(over.code, 3);
  assert.equal(doc(over).error.code, "cap_refused");
});

test("generate-sheet fails QA (exit 5) when the sheet holds another frame count, and keeps it", async () => {
  const { world, base } = await files();
  // The spec asks for 6 frames; the scripted model draws a 16-figure sheet.
  const png = Buffer.from(syntheticSheet().png).toString("base64");
  const provider = await script(
    world.dir,
    `{ image: () => ({ images: [{ mediaType: "image/png", bytes: Uint8Array.from(Buffer.from("${png}", "base64")) }], costUsd: 0.2 }), vision: () => ({ text: "{}" }) }`,
  );
  const imports = join(world.dir, "imports");
  const r = await cli([
    "generate-sheet",
    ...base.slice(0, 6),
    ...["--provider-script", provider, "--imports", imports, "--json"],
  ]);
  assert.equal(r.code, 5, r.stderr);
  const d = doc(r);
  assert.equal(d.error.code, "qa_found_nothing");
  assert.match(d.error.message, /found 16 figures on the sheet where 6 are asked for/);
  assert.deepEqual([d.found, d.expected, d.spentUsd], [16, 6, 0.2]);
  assert.match(d.kept, /sheet\.png$/);
  const [kept] = await readdir(imports);
  assert.deepEqual((await readdir(join(imports, kept as string))).sort(), [
    "sheet.json",
    "sheet.png",
  ]);
});

test("write-families on a missing import is one invalid_input document", async () => {
  const { world } = await files();
  const r = await cli([
    "write-families",
    ...["--import", join(world.dir, "nope"), "--target", world.targetDir, "--json"],
  ]);
  assert.equal(r.code, 2);
  const d = doc(r);
  assert.equal(d.command, "write-families");
  assert.equal(d.error.code, "invalid_input");
});

test("--help with --json is one JSON document carrying the usage", async () => {
  for (const args of [
    ["--help", "--json"],
    ["-h", "--json"],
    ["stage", "--help", "--json"],
  ]) {
    const r = await cli(args);
    assert.equal(r.code, 0, args.join(" "));
    const d = doc(r);
    assert.equal(d["ok"], true);
    assert.equal(d["exitCode"], 0);
    assert.equal(d["command"], args[0] === "stage" ? "stage" : null);
    assert.match(d["usage"], /--json|stage/);
  }
});

test("a missing or malformed routes file is invalid_input", async () => {
  const { world, base } = await files();
  const bad = join(world.dir, "bad-routes.json");
  await writeFile(bad, "{ not json");
  const list = join(world.dir, "list-routes.json");
  await writeFile(list, "[]");
  for (const routes of [join(world.dir, "nope.json"), bad, list]) {
    const r = await cli(["stage", ...base, "--routes", routes, "--dry-run", "--json"], noKey());
    assert.equal(r.code, 2, routes);
    assert.equal(doc(r)["error"].code, "invalid_input");
  }
});

test("import of a sheet that is not an image is invalid_input", async () => {
  const { world } = await files();
  const sheet = join(world.dir, "sheet.png");
  await writeFile(sheet, "not a png");
  const r = await cli([
    "import",
    "--sheet",
    sheet,
    "--profile",
    join(world.dir, "profile.json"),
    "--asset",
    "stevie",
    "--tool",
    "synthetic",
    "--no-propose",
    "--imports",
    join(world.dir, "imports"),
    "--json",
  ]);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r)["error"].code, "invalid_input");
  assert.match(doc(r)["error"].message, /cannot decode the sheet/);
});

/** A provider script that records every call in `marker`, so a test can prove none was made. */
async function recordingScript(dir: string): Promise<{ path: string; marker: string }> {
  const path = join(dir, "recording.mjs");
  const marker = join(dir, "provider-called");
  await writeFile(
    path,
    `import { appendFileSync } from "node:fs";
const record = (kind) => { appendFileSync(${JSON.stringify(marker)}, kind + "\\n"); throw new Error("no call expected"); };
export default { image: () => record("image"), vision: () => record("vision") };`,
  );
  return { path, marker };
}

const LFS_POINTER =
  "version https://git-lfs.github.com/spec/v1\n" +
  "oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\n" +
  "size 12345\n";

test("generate-sheet refuses Git LFS pointer references as invalid_input with no provider call", async () => {
  const { world, base } = await files();
  for (const ref of ["stevie-sheet.png", "stevie-turnaround.png", "den.png", "perspective.png"]) {
    await writeFile(join(world.bibleDir, "refs", ref), LFS_POINTER);
  }
  await writeFile(join(world.dir, "key-pose.png"), LFS_POINTER);
  const provider = await recordingScript(world.dir);
  const r = await cli([
    "generate-sheet",
    ...base.slice(0, 6),
    ...["--provider-script", provider.path, "--imports", join(world.dir, "imports"), "--json"],
  ]);
  assert.equal(r.code, 2, r.stderr);
  const d = doc(r);
  assert.equal(d.error.code, "invalid_input");
  assert.match(d.error.message, /Git LFS pointer/);
  assert.match(d.error.message, /git lfs pull/);
  assert.equal(existsSync(provider.marker), false, "a provider call was made");
  assert.equal(existsSync(join(world.dir, "imports")), false);
});

test("stage refuses a reference that is not an image, naming the file, with no provider call", async () => {
  const { world, base } = await files();
  const perspective = join(world.bibleDir, "refs", "perspective.png");
  await writeFile(perspective, "not an image");
  const provider = await recordingScript(world.dir);
  const r = await cli([
    "stage",
    ...base,
    ...["--candidates", "2", "--provider-script", provider.path, "--json"],
  ]);
  assert.equal(r.code, 2, r.stderr);
  const d = doc(r);
  assert.equal(d.error.code, "invalid_input");
  assert.ok(d.error.message.includes(perspective), d.error.message);
  assert.equal(existsSync(provider.marker), false, "a provider call was made");
});
