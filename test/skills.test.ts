import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
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
