import "./fixtures/spend-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Budget, BudgetExceededError } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { InputError, ProviderError } from "../src/errors.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { defaultRoutes } from "../src/routes.ts";
import {
  DEFAULT_DAILY_LIMIT_USD,
  DEFAULT_WORK_ITEM_LIMIT_USD,
  SpendLedger,
  SpendLimitError,
  isPaidProvider,
} from "../src/spend.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
const spendModule = pathToFileURL(join(root, "src/spend.ts")).href;

async function ledgerPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "assetforge-spend-test-")), "spend.jsonl");
}

function ledger(path: string, env: NodeJS.ProcessEnv = {}, now?: () => Date): SpendLedger {
  return SpendLedger.fromEnv(
    { ASSETFORGE_SPEND_LEDGER: path, ...env },
    now !== undefined ? { now } : {},
  );
}

function limit(l: SpendLedger, name: string) {
  return l.status().limits.find((s) => s.limit === name);
}

test("with nothing set, the daily default applies and no work item means no work-item limit", async () => {
  const l = ledger(await ledgerPath());
  const status = l.status();
  assert.equal(status.workItem, null);
  assert.deepEqual(status.limits, [
    {
      limit: "daily",
      limitUsd: DEFAULT_DAILY_LIMIT_USD,
      source: "default",
      spentUsd: 0,
      remainingUsd: DEFAULT_DAILY_LIMIT_USD,
    },
  ]);
  const named = ledger(await ledgerPath(), { ASSETFORGE_WORK_ITEM: "obj-72" });
  assert.deepEqual(limit(named, "work-item"), {
    limit: "work-item",
    workItem: "obj-72",
    limitUsd: DEFAULT_WORK_ITEM_LIMIT_USD,
    source: "default",
    spentUsd: 0,
    remainingUsd: DEFAULT_WORK_ITEM_LIMIT_USD,
  });
});

test("the default ledger is under XDG_STATE_HOME, else ~/.local/state", () => {
  assert.equal(
    SpendLedger.fromEnv({ XDG_STATE_HOME: "/state" }).path,
    join("/state", "assetforge", "spend.jsonl"),
  );
  assert.match(
    SpendLedger.fromEnv({}).path,
    /[/\\]\.local[/\\]state[/\\]assetforge[/\\]spend\.jsonl$/,
  );
});

test("a Factory worker's default ledger is in its stage's TMPDIR, which persists across its commands", () => {
  const worker = { FACTORY_ISSUE: "108", XDG_STATE_HOME: "/state" };
  assert.equal(
    SpendLedger.fromEnv({ ...worker, TMPDIR: "/run/stage-tmp" }).path,
    join("/run/stage-tmp", "assetforge-spend.jsonl"),
  );
  assert.equal(SpendLedger.fromEnv(worker).path, join(tmpdir(), "assetforge-spend.jsonl"));
  // An explicit ledger still wins.
  assert.equal(
    SpendLedger.fromEnv({ ...worker, ASSETFORGE_SPEND_LEDGER: "/shared/ledger.jsonl" }).path,
    resolve("/shared/ledger.jsonl"),
  );
});

test("environment and profile limits: the stricter applies; bad values are invalid input", async () => {
  const path = await ledgerPath();
  const env = { ASSETFORGE_WORK_ITEM: "w", ASSETFORGE_DAILY_LIMIT_USD: "3" };
  const l = ledger(path, env).forProfile({ spend: { dailyLimitUsd: 8, workItemLimitUsd: 2 } });
  assert.deepEqual(
    l.status().limits.map((s) => [s.limit, s.limitUsd, s.source]),
    [
      ["daily", 3, "environment"],
      ["work-item", 2, "profile"],
    ],
  );
  const raised = ledger(path).forProfile({ spend: { dailyLimitUsd: 50 } });
  assert.equal(limit(raised, "daily")?.limitUsd, 50);
  assert.throws(() => ledger(path, { ASSETFORGE_DAILY_LIMIT_USD: "lots" }), InputError);
  assert.throws(() => ledger(path, { ASSETFORGE_WORK_ITEM_LIMIT_USD: "-1" }), InputError);
  assert.throws(() => ledger(path, { ASSETFORGE_DAILY_LIMIT_USD: "Infinity" }), InputError);
  assert.throws(
    () => ledger(path).forProfile({ spend: { workItemLimitUsd: "5" as unknown as number } }),
    InputError,
  );
});

test("reservations count at their estimate until settled, then at their cost; a refused one is cancelled", async () => {
  const path = await ledgerPath();
  const l = ledger(path, { ASSETFORGE_WORK_ITEM: "w", ASSETFORGE_WORK_ITEM_LIMIT_USD: "1" });
  const a = l.reserve(0.6, "the still call", "scripted:still:m");
  assert.equal(limit(l, "work-item")?.spentUsd, 0.6);
  assert.throws(
    () => l.reserve(0.5, "the edit call", "scripted:edit:m"),
    (error: unknown) =>
      error instanceof SpendLimitError &&
      error instanceof BudgetExceededError &&
      error.limit === "work-item" &&
      error.limitUsd === 1 &&
      error.spentUsd === 0.6 &&
      error.requestedUsd === 0.5,
  );
  l.settle(a, 0.2);
  assert.equal(limit(l, "work-item")?.spentUsd, 0.2);
  assert.equal(limit(l, "daily")?.spentUsd, 0.2);
  l.check(0.8, "the run");
  assert.throws(() => l.check(0.81, "the run"), SpendLimitError);
  // Another work item has its own limit but shares the daily one.
  const other = ledger(path, { ASSETFORGE_WORK_ITEM: "v", ASSETFORGE_DAILY_LIMIT_USD: "0.5" });
  assert.equal(limit(other, "work-item")?.spentUsd, 0);
  assert.throws(() => other.check(0.31, "the run"), /\$0\.50 daily limit/);
  // A run that spends nothing is never refused, even past a limit.
  ledger(path, { ASSETFORGE_DAILY_LIMIT_USD: "0.1" }).check(0, "a run with no paid calls");

  const lines = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  assert.deepEqual(
    lines.map((e) => [e.op, e.route ?? null, e.amountUsd ?? e.costUsd]),
    [
      ["reserve", "scripted:still:m", 0.6],
      ["reserve", "scripted:edit:m", 0.5],
      ["settle", null, 0], // the refused reservation, cancelled
      ["settle", null, 0.2],
    ],
  );
  assert.ok(lines.every((e) => typeof e.at === "string" && typeof e.id === "string"));
});

test("the daily limit counts the last 24 hours; the work-item limit counts all time", async () => {
  const path = await ledgerPath();
  const t0 = Date.parse("2026-11-10T08:00:00Z");
  const env = { ASSETFORGE_WORK_ITEM: "w", ASSETFORGE_WORK_ITEM_LIMIT_USD: "20" };
  const then = ledger(path, env, () => new Date(t0));
  then.settle(then.reserve(4, "a call", "r"), 4);
  const later = ledger(path, env, () => new Date(t0 + 25 * 60 * 60 * 1000));
  assert.equal(limit(later, "daily")?.spentUsd, 0);
  assert.equal(limit(later, "work-item")?.spentUsd, 4);
});

test("concurrent runs never reserve past a limit: exactly as many as fit succeed", async () => {
  const path = await ledgerPath();
  const code = `import { SpendLedger } from ${JSON.stringify(spendModule)};
try { SpendLedger.fromEnv().reserve(1, "a call", "r"); console.log("ok"); }
catch (e) { if (e.name !== "SpendLimitError") throw e; console.log("refused"); }`;
  const env = {
    ...process.env,
    ASSETFORGE_SPEND_LEDGER: path,
    ASSETFORGE_WORK_ITEM: "w",
    ASSETFORGE_WORK_ITEM_LIMIT_USD: "3",
  };
  const results = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise<string>((resolve, reject) =>
          execFile(
            process.execPath,
            ["--input-type=module", "-e", code],
            { env },
            (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve(stdout.trim())),
          ),
        ),
    ),
  );
  assert.equal(results.filter((r) => r === "ok").length, 3);
  assert.equal(results.filter((r) => r === "refused").length, 5);
  assert.equal(limit(ledger(path, { ASSETFORGE_WORK_ITEM: "w" }), "work-item")?.spentUsd, 3);
});

test("paid providers are told apart from the scripted one by name alone", () => {
  assert.equal(isPaidProvider("scripted"), false);
  for (const name of ["vercel-ai-gateway", "tripo+vercel-ai-gateway", "scripted-paid", undefined])
    assert.equal(isPaidProvider(name), true);
});

function countingProvider(counts: { image: number }) {
  return new ScriptedProvider({
    image: () => {
      counts.image++;
      return { images: [{ mediaType: "image/png", bytes: new Uint8Array([1]) }], costUsd: 0.1 };
    },
    vision: () => {
      throw new Error("down");
    },
  });
}

test("every paid Caller call reserves in the budget's ledger with its route and settles at its cost", async () => {
  const path = await ledgerPath();
  const l = ledger(path, { ASSETFORGE_DAILY_LIMIT_USD: "0.3" });
  const counts = { image: 0 };
  const call = new Caller({
    provider: countingProvider(counts),
    providerName: "paid-test",
    budget: new Budget(5, l),
    routes: defaultRoutes,
  });
  await call.image("still", "a raccoon", []);
  assert.equal(limit(l, "daily")?.spentUsd, 0.1);
  // A failed call is charged its estimate, as the run's budget charges it.
  await assert.rejects(call.vision("vision", "check", []), ProviderError);
  assert.equal(limit(l, "daily")?.spentUsd, 0.1 + defaultRoutes["vision"]!.estimatedCostUsd);
  // The still route's $0.25 estimate no longer fits the $0.30 daily limit: refused, not called.
  await assert.rejects(call.image("still", "a raccoon", []), SpendLimitError);
  assert.equal(counts.image, 1);
  const routes = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x))
    .filter((e) => e.op === "reserve")
    .map((e) => e.route);
  assert.deepEqual(routes, [
    `paid-test:still:${defaultRoutes["still"]!.model}`,
    `paid-test:vision:${defaultRoutes["vision"]!.model}`,
    `paid-test:still:${defaultRoutes["still"]!.model}`,
  ]);
});

test("scripted Caller calls never reach the ledger; the run's cap still applies", async () => {
  const path = await ledgerPath();
  const l = ledger(path, { ASSETFORGE_DAILY_LIMIT_USD: "0" });
  const counts = { image: 0 };
  const budget = new Budget(0.6, l);
  const call = new Caller({
    provider: countingProvider(counts),
    providerName: "scripted",
    budget,
    routes: defaultRoutes,
  });
  await call.image("still", "a raccoon", []);
  await call.image("still", "a raccoon", []);
  assert.equal(counts.image, 2);
  assert.equal(existsSync(path), false);
  // $0.20 spent and $0.20 held: the still call's $0.25 estimate no longer fits the $0.60 cap.
  budget.reserve(0.2);
  await assert.rejects(call.image("still", "a raccoon", []), BudgetExceededError);
  assert.equal(counts.image, 2);
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], env: NodeJS.ProcessEnv): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

/**
 * A synthetic world and a passing provider script that counts every call it answers. `paid`
 * makes the CLI run it under the test-only paid name `scripted-paid`, standing in for a real
 * provider.
 */
async function stageWorld(paid: boolean) {
  const world = await syntheticWorld();
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  const calls = join(world.dir, "calls.txt");
  const script = join(world.dir, "counting-script.mjs");
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";
import base from ${JSON.stringify(pathToFileURL(passingScript).href)};
const count = (kind) => appendFileSync(${JSON.stringify(calls)}, kind + "\\n");
export default {
  ${paid ? "paid: true," : ""}
  image: (r, i) => (count("image"), base.image(r, i)),
  vision: (r, i) => (count("vision"), base.vision(r, i)),
};`,
  );
  // One shelter candidate: six edits at $0.05 and one QA call at $0.02, $0.32 forecast.
  const args = [
    "stage",
    ...["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir],
    ...["--candidates", "1", "--work-item", "obj-72", "--provider-script", script, "--json"],
  ];
  const callCount = async () => (await readFile(calls, "utf8")).trim().split("\n").length;
  return { world, args, callCount };
}

test("two paid runs whose combined forecast crosses the work-item limit: the second is refused before any call", async () => {
  const { world, args, callCount } = await stageWorld(true);
  const path = await ledgerPath();
  const env = {
    ...process.env,
    ASSETFORGE_SPEND_LEDGER: path,
    ASSETFORGE_WORK_ITEM_LIMIT_USD: "0.5",
  };
  const first = await cli(args, env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(await callCount(), 7);
  const ledgerAfterFirst = await readFile(path, "utf8");
  assert.match(ledgerAfterFirst, /"route":"scripted-paid:edit:/);

  // The dry run shows what is left under each limit, and that the run would not fit.
  const dry = await cli([...args, "--dry-run"], env);
  assert.equal(dry.code, 3);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.withinLimits, false);
  assert.equal(plan.plan.withinCap, true);
  assert.equal(plan.spend.counted, true);
  const [daily, item] = plan.spend.limits;
  assert.equal(daily.limit, "daily");
  assert.equal(daily.source, "default");
  assert.ok(Math.abs(daily.remainingUsd - (DEFAULT_DAILY_LIMIT_USD - 0.32)) < 1e-9);
  assert.equal(item.limit, "work-item");
  assert.equal(item.workItem, "obj-72");
  assert.equal(item.source, "environment");
  assert.ok(Math.abs(item.spentUsd - 0.32) < 1e-9);
  assert.ok(Math.abs(item.remainingUsd - 0.18) < 1e-9);

  const second = await cli(args, env);
  assert.equal(second.code, 3);
  const refused = JSON.parse(second.stdout);
  assert.equal(refused.error.code, "cap_refused");
  assert.equal(refused.error.limit.name, "work-item");
  assert.equal(refused.error.limit.workItem, "obj-72");
  assert.equal(refused.error.limit.limitUsd, 0.5);
  assert.ok(Math.abs(refused.error.limit.spentUsd - 0.32) < 1e-9);
  assert.ok(Math.abs(refused.error.limit.requestedUsd - 0.32) < 1e-9);
  // Refused before any call: the script answered nothing more, the ledger is unchanged and no
  // second run directory was made.
  assert.equal(await callCount(), 7);
  assert.equal(await readFile(path, "utf8"), ledgerAfterFirst);
  assert.equal((await readdir(world.runsDir)).length, 1);

  // Another work item still has room under the daily limit.
  const other = await cli(
    args.map((a) => (a === "obj-72" ? "obj-73" : a)),
    env,
  );
  assert.equal(other.code, 0, other.stderr);
});

test("scripted runs over the limits are not refused and write nothing to the ledger", async () => {
  const { world, args, callCount } = await stageWorld(false);
  const path = await ledgerPath();
  const env = {
    ...process.env,
    ASSETFORGE_SPEND_LEDGER: path,
    ASSETFORGE_DAILY_LIMIT_USD: "0.1",
    ASSETFORGE_WORK_ITEM_LIMIT_USD: "0.1",
  };
  // Each run's $0.32 forecast alone is over both limits.
  for (let run = 1; run <= 2; run++) {
    const r = await cli(args, env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await callCount(), 7 * run);
  }
  assert.equal((await readdir(world.runsDir)).length, 2);
  assert.equal(existsSync(path), false);

  // The dry run still prints the limits, marked not counted, and is never refused by them.
  const dry = await cli([...args, "--dry-run"], env);
  assert.equal(dry.code, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.spend.counted, false);
  assert.deepEqual(
    plan.spend.limits.map((l: { limit: string; limitUsd: number }) => [l.limit, l.limitUsd]),
    [
      ["daily", 0.1],
      ["work-item", 0.1],
    ],
  );
  const human = await cli([...args.filter((a) => a !== "--json"), "--dry-run"], env);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /scripted provider: not counted/);

  // The run's own cap still refuses a scripted run.
  const capped = await cli([...args, "--cap", "0.1"], env);
  assert.equal(capped.code, 3);
  assert.equal(JSON.parse(capped.stdout).error.limit, undefined);
  assert.equal(existsSync(path), false);
});

test("a Factory worker's Objective is the work item when none is named", () => {
  const item = (env: NodeJS.ProcessEnv, workItem?: string) =>
    SpendLedger.fromEnv(env, workItem !== undefined ? { workItem } : {}).status().workItem;
  assert.equal(
    item({ FACTORY_ISSUE: "72", GITHUB_REPOSITORY: "clockgrove/assetforge" }),
    "clockgrove/assetforge#72",
  );
  assert.equal(item({ FACTORY_ISSUE: "72" }), "factory#72");
  // Named explicitly, the name wins.
  assert.equal(item({ FACTORY_ISSUE: "72", ASSETFORGE_WORK_ITEM: "campaign-a" }), "campaign-a");
  assert.equal(item({ FACTORY_ISSUE: "72" }, "obj-1"), "obj-1");
  // Only a plain issue number counts; anything else names no work item.
  assert.equal(item({ FACTORY_ISSUE: "72; rm" }), null);
  assert.equal(item({ FACTORY_ISSUE: "" }), null);
  assert.equal(item({}), null);
});
