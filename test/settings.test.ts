import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CAPS, isInside, loadSettings, SettingsError } from "../src/settings.ts";

function tempDir(prefix = "assetgrove-settings-test-"): string {
  return mkdtempSync(join(realpathSync(tmpdir()), prefix));
}

/** Writes `settings` to a fresh file outside any repository and returns its path. */
function settingsFile(settings: unknown, dir = tempDir()): string {
  const path = join(dir, "settings.json");
  writeFileSync(path, typeof settings === "string" ? settings : JSON.stringify(settings));
  return path;
}

function load(settings: unknown, options: { platform?: string } = {}) {
  return loadSettings({
    env: { ASSETGROVE_CONFIG: settingsFile(settings), HOME: tempDir() },
    cwd: tempDir(),
    ...options,
  });
}

const invalid = (pattern?: RegExp) => (error: unknown) => {
  assert.ok(error instanceof SettingsError, String(error));
  assert.equal(error.code, "settings_invalid");
  if (pattern) assert.match(error.message, pattern);
  return true;
};

const FORMAT = "assetgrove-settings/1";

function gitRepo(dir = tempDir()): string {
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

test("no file yields caps 5/10/5, no providers and attended mode", () => {
  const home = tempDir();
  const settings = loadSettings({
    env: { HOME: home, XDG_CONFIG_HOME: join(home, "config") },
    platform: "linux",
    cwd: home,
  });
  assert.equal(settings.exists, false);
  assert.equal(settings.path, join(home, "config", "assetgrove", "settings.json"));
  assert.deepEqual(settings.caps, { runUsd: 5, dailyUsd: 10, workItemUsd: 5 });
  assert.deepEqual(settings.caps, DEFAULT_CAPS);
  assert.deepEqual(settings.providers, {});
  assert.equal(settings.mode, "attended");
  assert.equal(settings.headless, undefined);
});

test("a minimal file gets the same defaults, and stateDir under the state home", () => {
  const home = tempDir();
  const settings = loadSettings({
    env: {
      ASSETGROVE_CONFIG: settingsFile({ format: FORMAT }),
      HOME: home,
      XDG_STATE_HOME: join(home, "state"),
    },
    platform: "linux",
    cwd: home,
  });
  assert.equal(settings.exists, true);
  assert.deepEqual(settings.caps, DEFAULT_CAPS);
  assert.equal(settings.mode, "attended");
  assert.equal(settings.stateDir, join(home, "state", "assetgrove"));
});

test("the full Phase 1 field set validates", () => {
  const stateDir = tempDir();
  const settings = load({
    format: FORMAT,
    stateDir,
    headless: { operator: "ci:example/repo" },
    caps: { runUsd: 2, dailyUsd: 8 },
    providers: {
      gateway: {
        adapter: "vercel-ai-gateway",
        keyEnv: "AI_GATEWAY_API_KEY",
        baseURL: "https://relay.example/v1",
        usdPerCredit: 0.01,
        limit: { kind: "key-budget", usd: 20, period: "monthly", acceptUnlimited: false },
      },
      local: { adapter: "local", baseURL: "http://127.0.0.1:8080/v1", free: true },
      limitOnly: { limit: { kind: "unlimited", acceptUnlimited: true } },
    },
    roles: {
      judge: {
        provider: "gateway",
        model: "m",
        outputGrant: { relabel: true },
        providerTerms: "t",
      },
    },
    routes: { "image.generate": { provider: "local", model: "m" } },
    extensions: ["@example/ext"],
    environment: { allow: ["HTTPS_PROXY"] },
    reconcile: { marginUsd: 0.05, marginPct: 5 },
    spend: { acknowledgedHolds: ["ab12"] },
    commands: {
      approved: [
        { hash: "cd34", kind: "validator", argv: ["node", "v.js"], cwd: "tools", note: "n" },
      ],
    },
    promptPolicy: { allow: ["term"] },
    confirmedBy: { caps: { method: "elicitation", at: "2026-11-14T00:00:00Z", client: "c" } },
  });
  assert.equal(settings.mode, "headless");
  assert.equal(settings.headless?.operator, "ci:example/repo");
  assert.deepEqual(settings.caps, { runUsd: 2, dailyUsd: 8, workItemUsd: 5 });
  assert.equal(settings.stateDir, stateDir);
  assert.equal(settings.providers["gateway"]?.limit?.usd, 20);
  assert.deepEqual(settings.environment.allow, ["HTTPS_PROXY"]);
  assert.equal(settings.commands.approved[0]?.kind, "validator");
});

test("a settings file inside a temporary Git repository is refused", () => {
  const repo = gitRepo();
  const path = settingsFile({ format: FORMAT }, repo);
  // Inside the cwd's repository.
  assert.throws(
    () => loadSettings({ env: { ASSETGROVE_CONFIG: path }, cwd: repo }),
    invalid(/inside the project/),
  );
  // Inside --target's repository, and inside an input file's repository.
  const elsewhere = tempDir();
  assert.throws(
    () => loadSettings({ env: { ASSETGROVE_CONFIG: path }, cwd: elsewhere, target: repo }),
    invalid(/inside the project/),
  );
  mkdirSync(join(repo, "specs"));
  assert.throws(
    () =>
      loadSettings({
        env: { ASSETGROVE_CONFIG: path },
        cwd: elsewhere,
        inputs: [join(repo, "specs", "a.json")],
      }),
    invalid(/inside the project/),
  );
  // The same file outside every project in play is fine.
  assert.equal(loadSettings({ env: { ASSETGROVE_CONFIG: path }, cwd: elsewhere }).exists, true);
});

test("containment is case-insensitive when the platform parameter is win32 or darwin", () => {
  assert.equal(isInside("/a/Repo/settings.json", "/a/repo", "darwin"), true);
  assert.equal(isInside("C:\\Users\\Me\\Repo\\s.json", "c:\\users\\me\\repo", "win32"), true);
  assert.equal(isInside("/a/Repo/settings.json", "/a/repo", "linux"), false);
  assert.equal(isInside("/a/repository/s.json", "/a/repo", "darwin"), false);

  // Through loadSettings: a repository at <tmp>/Repo and the file at <tmp>/repo/settings.json.
  // On a case-sensitive file system these are two directories, and only win32/darwin treat them as one.
  const parent = tempDir();
  const repo = gitRepo(join(parent, "Repo"));
  mkdirSync(join(parent, "repo"), { recursive: true });
  const path = settingsFile({ format: FORMAT }, join(parent, "repo"));
  const options = { env: { ASSETGROVE_CONFIG: path }, cwd: repo };
  for (const platform of ["darwin", "win32"]) {
    assert.throws(() => loadSettings({ ...options, platform }), invalid(/inside the project/));
  }
  const caseSensitive = realpathSync(join(parent, "repo")) !== realpathSync(repo);
  if (caseSensitive && process.platform === "linux") {
    assert.equal(loadSettings({ ...options, platform: "linux" }).exists, true);
  }
});

test("a missing $ASSETGROVE_CONFIG target is refused", () => {
  const missing = join(tempDir(), "nope.json");
  assert.throws(
    () => loadSettings({ env: { ASSETGROVE_CONFIG: missing } }),
    invalid(/does not exist/),
  );
  assert.throws(
    () => loadSettings({ env: { ASSETGROVE_CONFIG: "relative.json" } }),
    invalid(/absolute/),
  );
});

test("an unknown field is refused, at the top level and nested", () => {
  assert.throws(() => load({ format: FORMAT, colour: "blue" }), invalid(/colour/));
  assert.throws(() => load({ format: FORMAT, caps: { hourlyUsd: 1 } }), invalid(/hourlyUsd/));
  assert.throws(
    () => load({ format: FORMAT, providers: { p: { adapter: "a", endpoint: "x" } } }),
    invalid(/endpoint/),
  );
});

for (const field of ["apiKey", "key", "token", "secret", "APIKEY"]) {
  test(`a field named ${field} is refused anywhere in the file`, () => {
    assert.throws(
      () => load({ format: FORMAT, providers: { p: { adapter: "a", [field]: "sk-synthetic" } } }),
      invalid(new RegExp(`"${field}"`)),
    );
  });
}

test("a missing, unknown or newer format is refused", () => {
  assert.throws(() => load({}), invalid(/no format line/));
  assert.throws(() => load({ format: "assetgrove-recipe/1" }), invalid(/unknown format/));
  assert.throws(() => load({ format: "assetgrove-settings/2" }), invalid(/newer/));
  assert.throws(() => load("{not json"), invalid(/not valid JSON/));
});

test("free on a non-loopback host is refused", () => {
  assert.throws(
    () =>
      load({
        format: FORMAT,
        providers: { p: { adapter: "a", baseURL: "https://relay.example/v1", free: true } },
      }),
    invalid(/free/),
  );
  assert.throws(
    () => load({ format: FORMAT, providers: { p: { adapter: "a", free: true } } }),
    invalid(/free/),
  );
  for (const baseURL of ["http://localhost:1234", "http://127.0.0.1:1", "http://[::1]:8080/v1"]) {
    assert.equal(
      load({ format: FORMAT, providers: { p: { adapter: "a", baseURL, free: true } } }).exists,
      true,
    );
  }
});

test("an http non-loopback baseURL is refused", () => {
  assert.throws(
    () =>
      load({
        format: FORMAT,
        providers: { p: { adapter: "a", baseURL: "http://relay.example/v1" } },
      }),
    invalid(/https/),
  );
  assert.throws(
    () =>
      load({ format: FORMAT, providers: { p: { adapter: "a", baseURL: "ftp://relay.example/" } } }),
    invalid(/https/),
  );
});

test("a role or route naming a provider not in providers is refused", () => {
  assert.throws(
    () => load({ format: FORMAT, roles: { judge: { provider: "ghost", model: "m" } } }),
    invalid(/ghost/),
  );
  assert.throws(
    () => load({ format: FORMAT, routes: { "image.generate": { provider: "ghost", model: "m" } } }),
    invalid(/ghost/),
  );
});

test("stateDir inside a project or relative is refused", () => {
  const repo = gitRepo();
  const path = settingsFile({ format: FORMAT, stateDir: join(repo, "state") });
  assert.throws(
    () => loadSettings({ env: { ASSETGROVE_CONFIG: path }, cwd: repo }),
    invalid(/stateDir/),
  );
  assert.throws(() => load({ format: FORMAT, stateDir: "state" }), invalid(/stateDir/));
});

test("unlimited needs acceptUnlimited", () => {
  assert.throws(
    () => load({ format: FORMAT, providers: { p: { limit: { kind: "unlimited" } } } }),
    invalid(/acceptUnlimited/),
  );
});
