/**
 * Imported first by every test that runs the CLI: points the cross-run spend ledger at a fresh
 * file in a temp directory and ASSETGROVE_CONFIG at a minimal settings file in another temp
 * directory outside any repository, so tests never read or write the user's own ledger or
 * settings. Child processes inherit both through process.env. The helpers rewrite the settings
 * file for tests that need a headless operator, approved commands, or declared limits.
 */
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FORMAT = "assetgrove-settings/1";

process.env["ASSETGROVE_SPEND_LEDGER"] = join(
  mkdtempSync(join(tmpdir(), "assetgrove-spend-")),
  "spend.jsonl",
);
// The caller's own work item and limits would change what the tests measure; a Factory worker's
// FACTORY_ISSUE would name a work item too.
for (const name of [
  "ASSETGROVE_WORK_ITEM",
  "FACTORY_ISSUE",
  "ASSETGROVE_DAILY_LIMIT_USD",
  "ASSETGROVE_WORK_ITEM_LIMIT_USD",
])
  delete process.env[name];

export const settingsPath: string = join(
  mkdtempSync(join(realpathSync(tmpdir()), "assetgrove-config-")),
  "settings.json",
);
process.env["ASSETGROVE_CONFIG"] = settingsPath;

type Settings = Record<string, unknown>;

function save(settings: Settings): Settings {
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

function load(): Settings {
  return JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
}

function child(parent: Settings, key: string): Settings {
  const existing = parent[key];
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing))
    return existing as Settings;
  const created: Settings = {};
  parent[key] = created;
  return created;
}

export function writeSettings(settings: Settings): Settings {
  return save({ format: FORMAT, ...settings });
}

export function resetSettings(): Settings {
  return writeSettings({});
}

export function useHeadless(operator = "ci:example/repo"): Settings {
  return save({ ...load(), headless: { operator } });
}

export function approveCommand(command: {
  hash: string;
  kind: string;
  argv: string[];
  cwd?: string;
  note?: string;
}): Settings {
  const settings = load();
  const commands = child(settings, "commands");
  const approved = Array.isArray(commands["approved"]) ? (commands["approved"] as unknown[]) : [];
  commands["approved"] = [...approved, command];
  return save(settings);
}

export function declareLimit(
  providerId: string,
  limit: { kind: string; usd?: number; period?: string; acceptUnlimited?: boolean },
): Settings {
  const settings = load();
  const providers = child(settings, "providers");
  providers[providerId] = { ...child(providers, providerId), limit };
  return save(settings);
}

writeSettings({});
