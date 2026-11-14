import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { initBible } from "../src/bible.ts";
import { commandNames, commands } from "../src/commands/registry.ts";
import { cliFlags } from "../src/commands/runner.ts";

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

const skillDir = fileURLToPath(new URL("../skills/assetgrove/", import.meta.url));

/** The `--flag` names a text mentions. */
function flags(text: string): Set<string> {
  return new Set(text.match(/(?<![\w-])--[a-z][a-z0-9-]*/g) ?? []);
}

/** SKILL.md and every Markdown file of its folder it links, by path relative to the folder. */
async function shippedSkill(): Promise<Map<string, string>> {
  const entry = await readFile(join(skillDir, "SKILL.md"), "utf8");
  const files = new Map([["SKILL.md", entry]]);
  for (const m of entry.matchAll(/\]\(((?:[\w-]+\/)*[\w-]+\.md)(?:#[^)]*)?\)/g))
    files.set(m[1]!, await readFile(join(skillDir, m[1]!), "utf8"));
  return files;
}

/**
 * What the skill gets wrong about the registry: a command with no `### <name>` section, a section
 * for no command, a section that lacks one of its command's flags or names a flag the command
 * lacks, a section that does not name its command's MCP tool, and, outside the sections, a flag
 * no command takes.
 */
function referenceProblems(texts: Iterable<string>): string[] {
  const problems: string[] = [];
  const sections = new Map<string, string>();
  const rest: string[] = [];
  for (const text of texts) {
    let current: string | undefined;
    for (const line of text.split("\n")) {
      if (/^#{1,6} /.test(line)) {
        current = /^### `?([a-z0-9-]+)`?$/.exec(line)?.[1];
        if (current !== undefined) {
          if (sections.has(current)) problems.push(`the skill describes ${current} twice`);
          sections.set(current, "");
        }
      }
      if (current === undefined) rest.push(line);
      else sections.set(current, `${sections.get(current)!}${line}\n`);
    }
  }
  for (const spec of commands) {
    const section = sections.get(spec.name);
    if (section === undefined) {
      problems.push(`no section for ${spec.name}`);
      continue;
    }
    const accepted = new Set(cliFlags(spec).map((f) => `--${f}`));
    const mentioned = flags(section);
    for (const flag of accepted)
      if (flag !== "--help" && !mentioned.has(flag))
        problems.push(`the ${spec.name} section lacks ${flag}`);
    for (const flag of mentioned)
      if (!accepted.has(flag))
        problems.push(`the ${spec.name} section names ${flag}, not a flag of it`);
    if (spec.tool !== null && !section.includes(`MCP tool: \`${spec.tool}\``))
      problems.push(`the ${spec.name} section does not name its tool ${spec.tool}`);
  }
  for (const name of sections.keys())
    if (!commandNames.includes(name)) problems.push(`a section for ${name}, not a command`);
  const known = new Set([
    "--json",
    "--help",
    "--version",
    ...commands.flatMap((c) => cliFlags(c).map((f) => `--${f}`)),
  ]);
  for (const flag of flags(rest.join("\n")))
    if (!known.has(flag)) problems.push(`the skill names unknown ${flag}`);
  return problems;
}

test("the shipped skill describes every registry command with exactly its flags", async () => {
  const skill = await shippedSkill();
  assert.ok(skill.has("references/commands.md"), "SKILL.md links the command reference");
  assert.deepEqual(referenceProblems(skill.values()), []);
});

test("the reference check fails when a command has no section or a section lacks a flag", async () => {
  const skill = await shippedSkill();
  const reference = skill.get("references/commands.md")!;
  const withOut = (text: string) => referenceProblems([skill.get("SKILL.md")!, text]);
  const noSection = reference.replace(/^### `ops`$/m, "#### ops");
  assert.notEqual(noSection, reference);
  assert.ok(withOut(noSection).includes("no section for ops"));
  const noFlag = reference.replaceAll("[--dry-run] ", "").replace(/`--dry-run`/g, "dry run");
  assert.notEqual(noFlag, reference);
  assert.ok(withOut(noFlag).includes("the stage section lacks --dry-run"));
  const extraFlag = reference.replace("ops [--json]", "ops [--json] [--bogus]");
  assert.ok(withOut(extraFlag).includes("the ops section names --bogus, not a flag of it"));
});
