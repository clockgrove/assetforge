import "./fixtures/spend-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const FIVE_MINUTES = 5 * 60 * 1000;

test(
  "the packed tarball installs and its bin runs without TypeScript stripping",
  { timeout: FIVE_MINUTES },
  async () => {
    const temps: string[] = [];
    const temp = async () => {
      const dir = await mkdtemp(join(tmpdir(), "assetforge-pkg-"));
      temps.push(dir);
      return dir;
    };
    try {
      // Pack the way a publish does: no prebuilt dist/, so the tarball's dist/ can only come
      // from the package's own prepack script.
      await rm(join(root, "dist"), { recursive: true, force: true });
      const packDir = await temp();
      const { stdout } = await exec("npm", ["pack", "--json", "--pack-destination", packDir], {
        cwd: root,
      });
      const [packed] = JSON.parse(stdout) as Array<{ filename: string; files: { path: string }[] }>;
      assert.ok(packed);
      const paths = packed.files.map((f) => f.path);
      for (const wanted of [
        "package.json",
        "README.md",
        "LICENSE",
        "dist/cli.js",
        "skills/assetforge/SKILL.md",
      ]) {
        assert.ok(paths.includes(wanted), `tarball lacks ${wanted}`);
      }
      assert.deepEqual(
        paths.filter((p) => p.endsWith(".ts") || p.startsWith("src/") || p.startsWith("test/")),
        [],
      );

      const install = await temp();
      await writeFile(join(install, "package.json"), JSON.stringify({ private: true }));
      await exec(
        "npm",
        [
          "install",
          "--no-audit",
          "--no-fund",
          "--ignore-scripts",
          "--no-package-lock",
          join(packDir, packed.filename),
        ],
        { cwd: install },
      );
      await stat(join(install, "node_modules/.bin/assetforge"));

      const env = { ...process.env };
      delete env["AI_GATEWAY_API_KEY"];
      const bin = join(install, "node_modules/@clockgrove/assetforge/dist/cli.js");
      const run = (args: string[]) =>
        exec(process.execPath, ["--no-experimental-strip-types", bin, ...args], {
          cwd: install,
          env,
        });

      const help = await run(["--help"]);
      assert.match(help.stdout, /stage/);
      assert.match(help.stdout, /pick/);

      const world = await syntheticWorld();
      temps.push(world.dir);
      const spec = join(install, "spec.json");
      const bible = join(world.bibleDir, "bible.json");
      const profile = join(install, "profile.json");
      const script = join(install, "script.mjs");
      await writeFile(spec, JSON.stringify(shelterSpec));
      await writeFile(bible, JSON.stringify(world.bible));
      await writeFile(profile, JSON.stringify(world.profile));
      await writeFile(
        script,
        `export default { image() { throw new Error("no"); }, vision() { throw new Error("no"); } };`,
      );
      const dry = await run([
        "stage",
        "--spec",
        spec,
        "--bible",
        bible,
        "--profile",
        profile,
        "--provider-script",
        script,
        "--dry-run",
        "--json",
      ]);
      const doc = JSON.parse(dry.stdout);
      assert.equal(doc.ok, true);
      assert.ok(doc.plan.calls > 0);

      const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      const version = await run(["--version"]);
      assert.equal(version.stdout.trim(), pkg.version);
    } finally {
      await rm(join(root, "dist"), { recursive: true, force: true });
      for (const dir of temps) await rm(dir, { recursive: true, force: true });
    }
  },
);
