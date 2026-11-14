import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseDocument } from "yaml";
import { initBible } from "../src/bible.ts";

/** The Agent Skills rules every SKILL.md must meet, so each harness loads it. */
async function checkSkill(path: string): Promise<void> {
  const text = await readFile(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, `${path}: front matter`);
  const doc = parseDocument(match[1]!, { strict: true, uniqueKeys: true });
  assert.deepEqual(doc.errors, [], `${path}: strict YAML`);
  const data = doc.toJS() as { name?: unknown; description?: unknown };
  assert.equal(data.name, basename(dirname(path)), `${path}: name matches its folder`);
  assert.match(String(data.name), /^[a-z0-9-]{1,64}$/, `${path}: name characters`);
  assert.equal(typeof data.description, "string", `${path}: description`);
  assert.ok((data.description as string).length <= 1024, `${path}: description length`);
  assert.ok(text.split("\n").length < 500, `${path}: under 500 lines`);
}

test("every skill the package ships meets the Agent Skills rules", async () => {
  const root = new URL("../skills/", import.meta.url);
  const folders = await readdir(root);
  assert.ok(folders.length > 0);
  for (const folder of folders) await checkSkill(join(root.pathname, folder, "SKILL.md"));
});

test("the skill bible init writes meets the rules, where every harness reads skills", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-skills-"));
  try {
    const paths = await initBible({
      directory: dir,
      world: "Synthetic world",
      preset: "cozy-storybook",
    });
    assert.equal(paths.skillPaths.length, 2);
    for (const path of paths.skillPaths) await checkSkill(path);
    const [claude, agents] = await Promise.all(paths.skillPaths.map((p) => readFile(p, "utf8")));
    assert.equal(claude, agents);
    // The skill's links resolve from its folder to the bible init wrote.
    const link = /\]\(([^)]*BIBLE\.md)\)/.exec(claude!)![1]!;
    assert.equal(join(dirname(paths.skillPaths[0]!), link), paths.biblePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const skillDir = join(root, "skills", "assetgrove");

/** One CLI run's stdout; help needs no key and spends nothing. */
async function cliOut(args: string[]): Promise<string> {
  return (await exec(process.execPath, ["src/cli.ts", ...args], { cwd: root })).stdout;
}

/** The commands the CLI lists in its own help. */
async function cliCommands(): Promise<string[]> {
  const { usage } = JSON.parse(await cliOut(["--help", "--json"])) as { usage: string };
  const section = usage.split("\nCommands:\n")[1]!.split("\n\n")[0]!;
  return section.split("\n").map((line) => line.trim().split(/\s+/)[0]!);
}

/** The `--flag` names a text mentions. */
function flags(text: string): Set<string> {
  return new Set(text.match(/(?<![\w-])--[a-z][a-z0-9-]*/g) ?? []);
}

/**
 * The shipped skill: SKILL.md and every Markdown file of its folder that it links, split into one
 * section per command (a `### \`<command>\`` heading up to the next heading) and the rest.
 */
async function shippedSkill(): Promise<{ sections: Map<string, string>; rest: string }> {
  const entry = await readFile(join(skillDir, "SKILL.md"), "utf8");
  const linked = new Set([...entry.matchAll(/\]\(([^)#:/]+\.md)(?:#[^)]*)?\)/g)].map((m) => m[1]!));
  const texts = [entry];
  for (const file of linked) texts.push(await readFile(join(skillDir, file), "utf8"));
  const sections = new Map<string, string>();
  const rest: string[] = [];
  for (const text of texts) {
    let current: string | undefined;
    for (const line of text.split("\n")) {
      if (/^#{1,6} /.test(line)) {
        current = /^### `([a-z0-9-]+)`$/.exec(line)?.[1];
        if (current !== undefined) {
          assert.ok(!sections.has(current), `the skill describes ${current} twice`);
          sections.set(current, "");
        }
      }
      if (current === undefined) rest.push(line);
      else sections.set(current, `${sections.get(current)!}${line}\n`);
    }
  }
  return { sections, rest: rest.join("\n") };
}

test("the shipped skill describes every CLI command with exactly the options its usage lists", async () => {
  const commands = await cliCommands();
  assert.ok(commands.length > 0, "the CLI lists its commands");
  const usages = new Map(
    await Promise.all(commands.map(async (c) => [c, await cliOut([c, "--help"])] as const)),
  );
  const { sections, rest } = await shippedSkill();
  assert.deepEqual(
    [...sections.keys()].sort(),
    [...commands].sort(),
    "the skill has one command section per CLI command and no other",
  );
  for (const [command, section] of sections) {
    const usage = flags(usages.get(command)!);
    const mentioned = flags(section);
    for (const flag of mentioned)
      assert.ok(usage.has(flag), `the skill's ${command} section names ${flag}, not in its usage`);
    for (const flag of usage)
      if (flag !== "--help")
        assert.ok(mentioned.has(flag), `the skill's ${command} section lacks ${flag}`);
  }
  // Outside the command sections, a flag must be in the CLI's help or some command's usage.
  const known = flags([await cliOut(["--help"]), ...usages.values()].join("\n"));
  for (const flag of flags(rest)) assert.ok(known.has(flag), `the skill names unknown ${flag}`);
});
