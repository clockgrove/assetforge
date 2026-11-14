import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import type { Grouping } from "../src/sheet/types.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("the CLI imports a sheet, refuses an unconfirmed grouping and writes the confirmed families", async () => {
  const root = await mkdtemp(join(tmpdir(), "assetgrove-cli-"));
  const target = join(root, "target");
  await mkdir(target);
  await writeFile(join(root, "sheet.png"), syntheticSheet().png);
  const base = syntheticProfile();
  const profile = {
    ...base,
    style: { alpha: { mode: "soft" }, color: { rule: "full" } },
    manifest: {
      ...(base.manifest as Record<string, unknown>),
      style: "{{profile.style?}}",
    },
  };
  await writeFile(join(root, "profile.json"), JSON.stringify(profile));
  const env = { ...process.env, AI_GATEWAY_API_KEY: "" };

  await assert.rejects(
    exec(
      process.execPath,
      [
        CLI,
        "import",
        "--sheet",
        join(root, "sheet.png"),
        "--profile",
        join(root, "profile.json"),
        "--asset",
        "fern",
        "--tool",
        "hand drawn",
        "--no-propose",
        "--digital-source-type",
        "unknown",
      ],
      { env },
    ),
    /invalid --digital-source-type/,
  );

  const imported = await exec(
    process.execPath,
    [
      CLI,
      "import",
      ...["--sheet", join(root, "sheet.png"), "--profile", join(root, "profile.json")],
      ...[
        "--asset",
        "fern",
        "--tool",
        "hand drawn",
        "--no-propose",
        "--digital-source-type",
        "digitalCreation",
      ],
      ...["--imports", join(root, "imports"), "--json"],
    ],
    { env },
  );
  const record = JSON.parse(imported.stdout) as {
    importDir: string;
    frames: unknown[];
    digitalSourceType: string;
  };
  assert.equal(record.frames.length, 16);
  assert.equal(record.digitalSourceType, DIGITAL_SOURCE_TYPES.human);
  const groupingPath = join(record.importDir, "grouping.json");
  const proposal = JSON.parse(await readFile(groupingPath, "utf8")) as Grouping;
  assert.equal(proposal.status, "proposed");

  const write = (grouping: string) =>
    exec(
      process.execPath,
      [
        CLI,
        "write-families",
        ...["--import", record.importDir, "--target", target, "--grouping", grouping],
      ],
      { env },
    );
  await assert.rejects(write(groupingPath), /confirmed/);

  const confirmed: Grouping = {
    ...proposal,
    status: "confirmed",
    families: [
      { name: "walk-right", frames: [5, 6, 7, 8, 9, 10], reason: "legs swing, facing right" },
      { name: "walk-left", mirrorOf: "walk-right", reason: "mirror of walk-right" },
    ],
  };
  const confirmedPath = join(root, "confirmed.json");
  await writeFile(confirmedPath, JSON.stringify(confirmed));
  const { stdout } = await write(confirmedPath);
  assert.match(stdout, /walk-right: 6 frames, jitter 0\.\d\d px/);
  assert.match(stdout, /walk-left: 6 frames \(mirrored\)/);
  assert.match(stdout, /target validator accepted it/);
  assert.doesNotMatch(stdout, /REJECTED/);
  const manifest = JSON.parse(
    await readFile(join(target, "assets/manifests/fern/walk-left.json"), "utf8"),
  );
  assert.equal(manifest.review.status, "pending");
  assert.equal(manifest.provenance.generated.digitalSourceType, DIGITAL_SOURCE_TYPES.human);
});

test("import --frames refuses a sheet that slices into another count (exit 2)", async () => {
  const root = await mkdtemp(join(tmpdir(), "assetgrove-cli-"));
  await writeFile(join(root, "sheet.png"), syntheticSheet().png);
  await writeFile(join(root, "profile.json"), JSON.stringify(syntheticProfile()));
  const run = (frames: string) =>
    exec(process.execPath, [
      CLI,
      "import",
      ...["--sheet", join(root, "sheet.png"), "--profile", join(root, "profile.json")],
      ...["--asset", "fern", "--tool", "hand drawn", "--no-propose", "--frames", frames],
      ...["--imports", join(root, "imports"), "--json"],
    ]);
  const ok = JSON.parse((await run("16")).stdout) as { frames: unknown[] };
  assert.equal(ok.frames.length, 16);
  await assert.rejects(run("17"), (error: { code: number; stdout: string }) => {
    assert.equal(error.code, 2);
    const doc = JSON.parse(error.stdout) as { error: { code: string; message: string } };
    assert.equal(doc.error.code, "invalid_input");
    assert.match(doc.error.message, /found 16 figures on the sheet where 17 are asked for/);
    return true;
  });
});
