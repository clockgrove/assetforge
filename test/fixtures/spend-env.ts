/**
 * Imported first by every test that runs the CLI: points the cross-run spend ledger at a fresh
 * file in a temp directory, so tests never read or write the user's own ledger. Child processes
 * inherit it through process.env.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
