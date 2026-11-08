import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/identity-script.ts", import.meta.url));
const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "identity-cli-"));
  roots.push(root);
  const art = join(root, "art");
  await mkdir(art, { recursive: true });
  const ref = createRaster(24, 24);
  setPixel(ref, 3, 3, [180, 90, 40, 255]);
  await writeFile(join(art, "stevie-turnaround.png"), encodePng(ref));
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  data.world = "Synthetic";
  data.identities = {
    stevie: {
      version: "stevie-3",
      approved: true,
      turnaround: "stevie-turnaround.png",
      signatureFeatures: ["striped tail"],
      proportions: "round body",
      palette: ["#b45a28"],
    },
  };
  const bible = join(art, "BIBLE.md");
  await writeFile(bible, serializeBible(data, "# Synthetic\n\n## Do's and Don'ts\nDo.\n"));
  await writeFile(join(root, "sheet.png"), syntheticSheet().png);
  await writeFile(join(root, "profile.json"), JSON.stringify(syntheticProfile()));
  return { root, bible };
}

const env = (scores: string) => ({
  ...process.env,
  AI_GATEWAY_API_KEY: "",
  IDENTITY_TEST_SCORES: scores,
});

function importArgs(root: string, asset: string, extra: string[]) {
  return [
    CLI,
    "import",
    "--sheet",
    join(root, "sheet.png"),
    "--profile",
    join(root, "profile.json"),
    "--asset",
    asset,
    "--tool",
    "hand drawn",
    "--no-propose",
    "--imports",
    join(root, "imports"),
    "--provider-script",
    SCRIPT,
    "--json",
    ...extra,
  ];
}

test("import scores a locked character's sheet; enforce mode makes write-families refuse it with the reason", async () => {
  const f = await fixture();
  const imported = await exec(
    process.execPath,
    importArgs(f.root, "stevie", ["--lock-bible", f.bible, "--identity-mode", "enforce"]),
    { env: env("1") },
  );
  const out = JSON.parse(imported.stdout);
  assert.equal(out.identity.lockVersion, "stevie-3");
  assert.equal(out.identity.score, 0.25);
  assert.equal(out.identity.filtered, true);
  // Every decision call logs its label, confidence, latency and cost on stderr.
  assert.match(
    imported.stderr,
    /identity perplexity\/pplx-decider-v1\.2: .*confidence 0\.62, \d+ ms, \$0\.000030/,
  );
  const grouping = join(f.root, "grouping.json");
  await writeFile(grouping, JSON.stringify({ status: "confirmed", families: [], unassigned: [] }));
  const target = join(f.root, "target");
  await mkdir(target);
  await assert.rejects(
    exec(
      process.execPath,
      [
        CLI,
        "write-families",
        "--import",
        out.importDir,
        "--target",
        target,
        "--grouping",
        grouping,
      ],
      { env: env("1") },
    ),
    /identity lock filtered this sheet: identity 0\.25 < threshold 0\.625 against "stevie" lock stevie-3/,
  );
});

test("import in the default shadow mode records the score and filters nothing; unlocked characters are unaffected", async () => {
  const f = await fixture();
  const shadow = JSON.parse(
    (
      await exec(process.execPath, importArgs(f.root, "stevie", ["--lock-bible", f.bible]), {
        env: env("1"),
      })
    ).stdout,
  );
  assert.equal(shadow.identity.mode, "shadow");
  assert.equal(shadow.identity.filtered, false);
  assert.match(shadow.identity.reason, /shadow mode, not filtered/);
  const unlocked = JSON.parse(
    (
      await exec(process.execPath, importArgs(f.root, "badger", ["--lock-bible", f.bible]), {
        env: env("1"),
      })
    ).stdout,
  );
  assert.equal(unlocked.identity, undefined);
  assert.deepEqual(unlocked.calls, []);
  await assert.rejects(
    exec(process.execPath, importArgs(f.root, "stevie", ["--identity-mode", "enforce"]), {
      env: env("1"),
    }),
    /--identity-mode needs --lock-bible/,
  );
});

test("identity-eval reports accuracy per threshold, the recommendation and agreement with QA", async () => {
  const f = await fixture();
  const cases = [
    { image: "sheet.png", subject: "stevie", same: true, qa: true },
    { image: "sheet.png", subject: "stevie", same: true, qa: true },
    { image: "sheet.png", subject: "stevie", same: false, qa: true },
    { image: "sheet.png", subject: "stevie", same: false, qa: false },
  ];
  await writeFile(join(f.root, "cases.json"), JSON.stringify(cases));
  const log = join(f.root, "eval.jsonl");
  const result = await exec(
    process.execPath,
    [
      CLI,
      "identity-eval",
      "--bible",
      f.bible,
      "--cases",
      join(f.root, "cases.json"),
      "--log",
      log,
      "--provider-script",
      SCRIPT,
      "--json",
    ],
    { env: env("4,3,1,0") },
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.scored, 4);
  assert.equal(report.recommended.accuracy, 1);
  assert.equal(report.qaAgreement.rate, 0.75);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 4);
});
