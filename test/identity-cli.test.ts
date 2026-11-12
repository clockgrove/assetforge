import "./fixtures/spend-env.ts";
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

const env = (scores: string, vision = '{"consistent": true, "conflicts": []}') => ({
  ...process.env,
  AI_GATEWAY_API_KEY: "",
  IDENTITY_TEST_SCORES: scores,
  IDENTITY_TEST_VISION: vision,
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
    /identity lock filtered this sheet: identity 0\.25 < threshold 0\.68 against "stevie" lock stevie-3/,
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

test("plan --identity-mode enforce, then apply: a strip below the threshold is filtered and the person sees why", async () => {
  const f = await fixture();
  const fixtureModule = fileURLToPath(new URL("./fixtures/synthetic.ts", import.meta.url));
  const rasterModule = fileURLToPath(new URL("../src/image/raster.ts", import.meta.url));
  const script = join(f.root, "provider.mjs");
  await writeFile(
    script,
    `import { pathToFileURL } from "node:url";
const { drawSubject } = await import(pathToFileURL(${JSON.stringify(fixtureModule)}));
const { encodePng } = await import(pathToFileURL(${JSON.stringify(rasterModule)}));
export default {
  image: () => ({ images: [{ mediaType: "image/png", bytes: encodePng(drawSubject(96)) }] }),
  vision: (request) => {
    if (request.prompt.includes('"violations":[]')) throw new Error("no compiler offline");
    if (request.prompt.includes("source of truth")) return { text: '{"consistent": true, "conflicts": []}' };
    return { text: JSON.stringify({ styleScore: 1, passed: true, reason: "constitution matches" }) };
  },
  decide: (_request, index) => ({ answer: { type: "score", score: [1, 4][index] }, confidence: 0.7 }),
};
`,
  );
  await writeFile(join(f.root, "key.png"), encodePng(createRaster(16, 16)));
  const spec = join(f.root, "spec.json");
  await writeFile(
    spec,
    JSON.stringify({
      kind: "sprite-strip",
      assetId: "stevie-idle",
      subject: "stevie",
      animationFamily: "idle",
      keyPose: "key.png",
      frames: { count: 2, width: 16, height: 16 },
    }),
  );
  const template = join(f.root, "template.md");
  await writeFile(template, "# Prompt template v1\n{{constitution}}\n{{spec}}\n");
  const settings = join(f.root, "settings.json");
  await writeFile(settings, JSON.stringify({ candidates: 2, capUsd: 5, strictness: 0.5 }));
  const plan = join(f.root, "plan.json");
  const planned = await exec(
    process.execPath,
    [
      CLI,
      "plan",
      "--spec",
      spec,
      "--bible",
      f.bible,
      "--profile",
      join(f.root, "profile.json"),
      "--settings",
      settings,
      "--template",
      template,
      "--out",
      plan,
      "--identity-mode",
      "enforce",
      "--provider-script",
      script,
      "--json",
    ],
    { env: env("") },
  );
  const { plan: saved } = JSON.parse(planned.stdout);
  assert.equal(saved.identityCheck.mode, "enforce");
  assert.equal(saved.identityCheck.route.model, "perplexity/pplx-decider-v1.2");
  const applied = await exec(
    process.execPath,
    [
      CLI,
      "apply",
      plan,
      "--auto-approve",
      "--out",
      join(f.root, "runs"),
      "--provider-script",
      script,
    ],
    { env: env("") },
  );
  assert.match(
    applied.stdout,
    /candidate 1 filtered: identity-lock: identity 0\.25 < threshold 0\.68 against "stevie" lock stevie-3/,
  );
  assert.match(applied.stdout, /identity-lock \[decision\]: identity 1\.00 >= threshold 0\.68/);
  assert.match(
    applied.stdout,
    /identity enforce against "stevie" lock stevie-3 \(threshold 0\.68\): 2 scored, agrees with QA on 1 of 2/,
  );
  assert.match(applied.stderr, /identity perplexity\/pplx-decider-v1\.2: .*confidence 0\.70/);
});

test("identity-check exits 0 when every record agrees with its references and 1 when one does not", async () => {
  const f = await fixture();
  const args = [CLI, "identity-check", "--bible", f.bible, "--provider-script", SCRIPT, "--json"];
  const ok = await exec(process.execPath, args, { env: env("") });
  const agreed = JSON.parse(ok.stdout);
  assert.equal(agreed.ok, true);
  assert.equal(agreed.checks[0].subject, "stevie");
  assert.match(agreed.checks[0].reason, /record "stevie" lock stevie-3 agrees with its references/);

  const conflicted =
    '{"consistent": false, "conflicts": [{"field": "proportions", "text": "round body", "observed": "long and thin"}]}';
  const bad = await exec(process.execPath, [...args, "--subject", "stevie"], {
    env: env("", conflicted),
  }).then(
    () => assert.fail("expected exit 1"),
    (error: { code: number; stdout: string }) => error,
  );
  assert.equal(bad.code, 1);
  assert.match(
    JSON.parse(bad.stdout).checks[0].reason,
    /disagrees with its references: proportions "round body" vs "long and thin"/,
  );

  // An answer that cannot be read leaves the record unchecked, which is not trusted either.
  const garbled = await exec(process.execPath, args, { env: env("", "no json") }).then(
    () => assert.fail("expected exit 1"),
    (error: { code: number; stdout: string }) => error,
  );
  assert.equal(garbled.code, 1);
  assert.equal(JSON.parse(garbled.stdout).checks[0].checked, false);

  const unknown = await exec(process.execPath, [...args, "--subject", "nobody"], {
    env: env(""),
  }).then(
    () => assert.fail("expected a refusal"),
    (error: { code: number }) => error,
  );
  assert.equal(unknown.code, 2);
});

test("identity-eval prints the per-medium breakdown, the bar and the record checks", async () => {
  const f = await fixture();
  for (const name of ["a", "b"]) await writeFile(join(f.root, `${name}.png`), syntheticSheet().png);
  await writeFile(
    join(f.root, "cases.json"),
    JSON.stringify([
      { image: "a.png", subject: "stevie", same: true, bible: "art/BIBLE.md" },
      {
        image: "b.png",
        subject: "stevie",
        same: false,
        kind: "drift",
        bible: "art/BIBLE.md",
        medium: "3d",
      },
    ]),
  );
  const result = await exec(
    process.execPath,
    [CLI, "identity-eval", "--cases", join(f.root, "cases.json"), "--provider-script", SCRIPT],
    { env: env("4,0") },
  );
  assert.match(result.stdout, /^2D at threshold 0\.68:$/m);
  assert.match(
    result.stdout,
    /^3D \(provisional, no threshold rests on it\) at threshold 0\.68:$/m,
  );
  assert.match(result.stdout, /kind same: 1 cases, false accepts 0%, false rejects 0%/);
  assert.match(result.stdout, /cast Synthetic: /);
  // One positive and no 2D negative: the 2D groups cannot be measured, so the bar is not met.
  assert.match(
    result.stdout,
    /enforce bar \(provisional\): not met: overall: not measured \(no negatives\); cast Synthetic: not measured \(no negatives\)/,
  );
  assert.match(result.stdout, /enforce bar: not judged on provisional 3D/);
  assert.match(result.stdout, /record check: record "stevie" lock stevie-3 agrees/);
});
