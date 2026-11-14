import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { EXIT, EXIT_MEANING } from "../src/errors.ts";

/** Design section 5: each exit with the error codes that map to it. */
const DESIGN: Record<number, string[]> = {
  0: [],
  1: ["internal_error"],
  2: [
    "invalid_input",
    "settings_invalid",
    "key_tracked",
    "format_unsupported",
    "extension_unavailable",
    "extension_refused",
    "extension_conflict",
    "route_unavailable",
    "plan_changed",
    "run_in_progress",
    "command_refused",
  ],
  3: ["cap_refused", "provider_limit_undeclared", "provider_limit_mismatch", "spend_hold"],
  4: ["provider_error"],
  5: ["qa_found_nothing"],
  6: ["validator_rejected", "handoff_check_failed"],
  7: ["license_refused"],
  8: ["confirmation_required", "confirmation_declined"],
  9: ["prompt_refused"],
};

/** The exit table of src/errors.ts as exit → meaning and codes. */
function table(): Map<number, { meaning: string; codes: string[] }> {
  const rows = new Map<number, { meaning: string; codes: string[] }>();
  for (const [exit, meaning] of Object.entries(EXIT_MEANING))
    rows.set(Number(exit), { meaning, codes: [] });
  for (const [code, exit] of Object.entries(EXIT)) rows.get(exit)!.codes.push(code);
  return rows;
}

test("every error code of design section 5 maps to its exit, and no other code exists", () => {
  for (const [exit, codes] of Object.entries(DESIGN))
    for (const code of codes) assert.equal(EXIT[code as keyof typeof EXIT], Number(exit), code);
  assert.deepEqual(Object.keys(EXIT).sort(), Object.values(DESIGN).flat().sort());
  assert.deepEqual(Object.keys(EXIT_MEANING).map(Number), Object.keys(DESIGN).map(Number));
});

/** The skill's exit table: `| <exit> | <meaning> | <codes> |` rows under `## Exit codes`. */
function skillExitTable(skill: string): Map<number, { meaning: string; codes: string[] }> {
  const section = skill.split(/^## Exit codes$/m)[1]?.split(/^## /m)[0] ?? "";
  const rows = new Map<number, { meaning: string; codes: string[] }>();
  for (const line of section.split("\n")) {
    const cells = /^\|\s*(\d+)\s*\|(.*)\|(.*)\|\s*$/.exec(line);
    if (!cells) continue;
    const codes = [...cells[3]!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
    rows.set(Number(cells[1]), { meaning: cells[2]!.trim(), codes });
  }
  return rows;
}

test("the exit table in SKILL.md equals src/errors.ts", async () => {
  const skill = await readFile(new URL("../skills/assetgrove/SKILL.md", import.meta.url), "utf8");
  assert.deepEqual(skillExitTable(skill), table());
});

test("the skill exit-table check fails on a copy that disagrees", async () => {
  const skill = await readFile(new URL("../skills/assetgrove/SKILL.md", import.meta.url), "utf8");
  const changed = skill.replace("`spend_hold`", "`spend_held`");
  assert.notEqual(changed, skill);
  assert.notDeepEqual(skillExitTable(changed), table());
});
