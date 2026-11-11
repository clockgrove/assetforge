import "./fixtures/spend-env.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const temporaryRoots: string[] = [];
after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/synthetic.ts", import.meta.url));
const raster = fileURLToPath(new URL("../src/image/raster.ts", import.meta.url));

async function cli(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env, timeout: 20_000 },
      (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "assetforge-planning-cli-"));
  temporaryRoots.push(dir);
  const init = await cli([
    "bible",
    "init",
    "--directory",
    dir,
    "--world",
    "Synthetic Grove",
    "--preset",
    "flat-cartoon-kids",
    "--json",
  ]);
  assert.equal(init.code, 0, init.stderr);
  const paths = JSON.parse(init.stdout) as {
    biblePath: string;
    templatePath: string;
    skillPath: string;
  };
  const spec = join(dir, "spec.json");
  const profile = join(dir, "profile.json");
  const settings = join(dir, "settings.json");
  const plan = join(dir, "plan.json");
  const script = join(dir, "provider.mjs");
  const events = join(dir, "events.jsonl");
  await writeFile(
    spec,
    JSON.stringify({ kind: "still", assetId: "icon", subject: "icon", animationFamily: "still" }),
  );
  await writeFile(profile, JSON.stringify(syntheticProfile()));
  await writeFile(settings, JSON.stringify({ candidates: 1, capUsd: 2, strictness: 0.5 }));
  await writeFile(
    script,
    `
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { drawSubject } = await import(pathToFileURL(${JSON.stringify(fixture)}));
const { encodePng } = await import(pathToFileURL(${JSON.stringify(raster)}));
export default {
  image(request) {
    appendFileSync(${JSON.stringify(events)}, JSON.stringify({kind:'image',request})+'\\n');
    return {images:[{mediaType:'image/png',bytes:encodePng(drawSubject(96))}]};
  },
  vision(request) {
    appendFileSync(${JSON.stringify(events)}, JSON.stringify({kind:'vision',request})+'\\n');
    return {text:JSON.stringify({prompt:'A friendly round icon, flat cel shading, bold outlines.',negativePrompt:'No text or photographic textures.',violations:[],clamps:[],styleScore:1,passed:true,reason:'scripted match',checks:['transparency','frame-count','identity','perspective','style'].map(check=>({check,passed:true,reason:'scripted match'}))})};
  }
};`,
  );
  const args = [
    "--spec",
    spec,
    "--bible",
    paths.biblePath,
    "--profile",
    profile,
    "--settings",
    settings,
    "--out",
    plan,
    "--provider-script",
    script,
    "--json",
  ];
  return { dir, ...paths, spec, profile, settings, plan, script, events, args };
}

test("CLI initializes a skill, describes axes and compiles a plan without image generation", async () => {
  const f = await setup();
  assert.match(await readFile(f.skillPath, "utf8"), /generating or reviewing art/i);
  const described = await cli(["bible", "describe", "--bible", f.biblePath, "--json"]);
  assert.equal(described.code, 0, described.stderr);
  const data = JSON.parse(described.stdout) as Record<string, unknown>;
  assert.equal(data["ok"], true);
  assert.ok(data["presets"]);
  const result = await cli(["plan", ...f.args]);
  assert.equal(result.code, 0, result.stderr);
  const saved = JSON.parse(await readFile(f.plan, "utf8")) as Record<string, unknown>;
  const output = JSON.parse(result.stdout) as { plan: unknown; planPath: string };
  assert.deepEqual(output.plan, saved);
  assert.equal(output.planPath, f.plan);
  assert.equal(saved["approved"], false);
  assert.match(JSON.stringify(saved), /friendly round icon/);
  assert.doesNotMatch(await readFile(f.events, "utf8"), /"kind":"image"/);
});

test("CLI without an available LLM records a usable template fallback without generation", async () => {
  const f = await setup();
  const result = await cli([
    "plan",
    "--spec",
    f.spec,
    "--profile",
    f.profile,
    "--bible",
    f.biblePath,
    "--settings",
    f.settings,
    "--out",
    f.plan,
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const { plan } = JSON.parse(result.stdout);
  assert.equal(plan.compiler.mode, "template-fallback");
  assert.equal(plan.compiler.templateVersion, "1");
  assert.match(plan.prompt, /lighting key/);
  assert.doesNotMatch(plan.prompt, /Return (?:ONLY )?JSON/i);
  await assert.rejects(readFile(f.events), { code: "ENOENT" });
});

test("CLI apply requires explicit approval, auto-approve generates, stale template refuses", async () => {
  const f = await setup();
  const planned = await cli(["plan", ...f.args]);
  assert.equal(planned.code, 0, planned.stderr);
  const out = join(f.dir, "runs");
  const apply = ["apply", f.plan, "--provider-script", f.script, "--out", out, "--json"];
  const refused = await cli(apply);
  assert.equal(refused.code, 2, refused.stderr);
  assert.doesNotMatch(await readFile(f.events, "utf8"), /"kind":"image"/);
  const applied = await cli([...apply, "--auto-approve"]);
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(await readFile(f.events, "utf8"), /"kind":"image"/);
  assert.ok((await readdir(out)).length > 0);
  const { run, runDir } = JSON.parse(applied.stdout);
  const candidate = run.candidates[0];
  const { DIGITAL_SOURCE_TYPES, readDigitalSourceType } = await import("../src/metadata.ts");
  assert.equal(candidate.provenance.digitalSourceType, DIGITAL_SOURCE_TYPES.generated);
  assert.equal(
    readDigitalSourceType(await readFile(join(runDir, candidate.file)), "image/png"),
    DIGITAL_SOURCE_TYPES.generated,
  );
  const { pick } = await import("../src/handoff.ts");
  const picked = await pick({
    runDir,
    candidateId: candidate.id,
    targetDir: join(f.dir, "target"),
  });
  assert.equal(
    readDigitalSourceType(await readFile(picked.mediaPath), "image/png"),
    DIGITAL_SOURCE_TYPES.generated,
  );
  await writeFile(
    f.templatePath,
    `${await readFile(f.templatePath, "utf8")}\nChanged after planning.\n`,
  );
  const before = await readFile(f.events, "utf8");
  const stale = await cli([...apply, "--auto-approve"]);
  assert.equal(stale.code, 2, stale.stderr);
  assert.match(stale.stderr, /stale|changed/i);
  assert.equal(await readFile(f.events, "utf8"), before);
});

test("CLI preset switching changes subsequent plans and makes the prior plan stale", async () => {
  const f = await setup();
  const first = await cli(["plan", ...f.args]);
  assert.equal(first.code, 0, first.stderr);
  const before = JSON.parse(await readFile(f.plan, "utf8")) as { prompt: string };
  assert.match(before.prompt, /flat-cartoon/);
  const switched = await cli([
    "bible",
    "preset",
    "--bible",
    f.biblePath,
    "--preset",
    "cozy-storybook",
    "--json",
  ]);
  assert.equal(switched.code, 0, switched.stderr);
  const next = JSON.parse(switched.stdout) as { preset: string };
  assert.equal(next.preset, "cozy-storybook");
  const refused = await cli([
    "apply",
    f.plan,
    "--auto-approve",
    "--provider-script",
    f.script,
    "--json",
  ]);
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(refused.stderr, /stale|changed/i);
  assert.doesNotMatch(await readFile(f.events, "utf8"), /"kind":"image"/);
  const second = await cli(["plan", ...f.args]);
  assert.equal(second.code, 0, second.stderr);
  const after = JSON.parse(await readFile(f.plan, "utf8")) as { prompt: string };
  assert.match(after.prompt, /painterly/);
  assert.notEqual(after.prompt, before.prompt);
});

test("MCP exposes and runs the same plan/apply flow over stdio", async () => {
  const f = await setup();
  const child = spawn(process.execPath, ["src/cli.ts", "mcp", "--provider-script", f.script], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const responses = createInterface({ input: child.stdout });
  const iterator = responses[Symbol.asyncIterator]();
  let nextId = 0;
  async function call(method: string, params: unknown = {}) {
    const id = ++nextId;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const response = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP timed out: ${errors}`)), 15_000);
        timer.unref();
      }),
    ]);
    assert.equal(response.done, false, errors);
    const doc = JSON.parse(response.value!) as {
      id: number;
      result: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] };
    };
    assert.equal(doc.id, id);
    return doc.result;
  }
  try {
    await call("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const listed = await call("tools/list");
    assert.deepEqual(
      listed.tools?.map((t) => t.name),
      ["bible_describe", "bible_init", "bible_preset", "plan", "apply"],
    );
    const planned = await call("tools/call", {
      name: "plan",
      arguments: {
        spec: f.spec,
        bible: f.biblePath,
        profile: f.profile,
        settings: f.settings,
        out: f.plan,
      },
    });
    assert.equal(planned.isError, false, planned.content?.[0]?.text);
    const applied = await call("tools/call", {
      name: "apply",
      arguments: { plan: f.plan, autoApprove: true, out: join(f.dir, "mcp-runs") },
    });
    assert.equal(applied.isError, false, applied.content?.[0]?.text);
    const result = JSON.parse(applied.content![0]!.text) as { run: { candidates: unknown[] } };
    assert.equal(result.run.candidates.length, 1);
    const switched = await call("tools/call", {
      name: "bible_preset",
      arguments: { bible: f.biblePath, preset: "cozy-storybook" },
    });
    assert.equal(switched.isError, false, switched.content?.[0]?.text);
    const description = JSON.parse(switched.content![0]!.text) as { preset: string };
    assert.equal(description.preset, "cozy-storybook");
  } finally {
    child.stdin.end();
    responses.close();
    child.kill();
  }
});
