import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { InputError } from "../src/errors.ts";
import { imageGenerators } from "../src/generators/image.ts";
import { pick } from "../src/handoff.ts";
import { combineGrants, LicenseError } from "../src/license.ts";
import { stage } from "../src/loop.ts";
import { defaultRoutes, loadRoutes } from "../src/routes.ts";
import type { Routes } from "../src/routes.ts";
import type { OutputGrant, TargetProfile } from "../src/types.ts";
import { scriptedProvider, shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";
import type { World } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));

/** Meshy's free plan: CC BY 4.0, commercial use with credit. */
const CC_BY: OutputGrant = {
  license: "CC-BY-4.0",
  plan: "free",
  commercial: true,
  relabel: false,
  attribution: "Model by Meshy (meshy.ai)",
};
/** Tripo's free plan: Tripo keeps all rights, no commercial use. */
const NON_COMMERCIAL: OutputGrant = {
  license: "LicenseRef-tripo-free",
  plan: "free",
  commercial: false,
  relabel: false,
};
const OWNED: OutputGrant = {
  license: "LicenseRef-meshy-pro",
  plan: "pro",
  commercial: true,
  relabel: true,
};

/** The default routes with every image route made under `grant`; vision keeps its default. */
function routesWith(grant: OutputGrant): Routes {
  return {
    ...defaultRoutes,
    still: { ...defaultRoutes.still, outputGrant: grant },
    edit: { ...defaultRoutes.edit, outputGrant: grant },
    sheet: { ...defaultRoutes.sheet, outputGrant: grant },
  };
}

async function staged(world: World, routes: Routes, profile: TargetProfile = world.profile) {
  return stage({
    spec: shelterSpec,
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile,
    routes,
    provider: scriptedProvider(),
    providerName: "scripted",
    generators: imageGenerators,
    runsDir: world.runsDir,
  });
}

test("an output made on routes that give ownership is declared under the target's MIT licence", async () => {
  const world = await syntheticWorld();
  const { run, runDir } = await staged(world, defaultRoutes);
  const candidate = run.candidates[0]!;
  const p = candidate.provenance;
  assert.equal(p.license, "MIT");
  assert.deepEqual(p.outputGrant, {
    license: "LicenseRef-bfl-api AND LicenseRef-google-api",
    plan: "api",
    commercial: true,
    relabel: true,
  });
  for (const call of p.calls) {
    assert.equal(call.outputGrant?.plan, "api");
    assert.equal(call.outputGrant?.relabel, true);
  }
  await pick({ runDir, candidateId: candidate.id, targetDir: world.targetDir });
  const manifest = JSON.parse(
    await readFile(join(world.targetDir, "assets/manifests/stevie/shelter.json"), "utf8"),
  );
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.provenance.generated.license, "MIT");
});

test("a CC BY output is refused by a target that does not accept CC BY, and nothing is written", async () => {
  const world = await syntheticWorld();
  const { run, runDir } = await staged(world, routesWith(CC_BY));
  const p = run.candidates[0]!.provenance;
  // Staging is unaffected: it records the grant and the licence the output really has.
  assert.equal(p.license, "CC-BY-4.0");
  assert.deepEqual(p.outputGrant, {
    license: "CC-BY-4.0",
    plan: "free + api",
    commercial: true,
    relabel: false,
    attribution: CC_BY.attribution,
  });
  await assert.rejects(
    pick({ runDir, candidateId: "c1", targetDir: world.targetDir }),
    (error: unknown) =>
      error instanceof LicenseError &&
      /CC-BY-4\.0/.test(error.message) &&
      /acceptedLicenses/.test(error.message) &&
      /Model by Meshy/.test(error.message),
  );
  assert.deepEqual(await readdir(world.targetDir), []);
});

test("a target that accepts CC BY on purpose takes a CC BY output declared as CC BY, never as MIT", async () => {
  const world = await syntheticWorld();
  // The synthetic validator models a target that permits only MIT, so this target has none.
  const { validator: _validator, ...rest } = world.profile;
  void _validator;
  const profile = { ...rest, acceptedLicenses: ["CC-BY-4.0"] };
  const { run, runDir } = await staged(world, routesWith(CC_BY), profile);
  assert.equal(run.candidates[0]!.provenance.license, "CC-BY-4.0");
  await pick({ runDir, candidateId: "c1", targetDir: world.targetDir });
  const manifest = JSON.parse(
    await readFile(join(world.targetDir, "assets/manifests/stevie/shelter.json"), "utf8"),
  );
  // The template reads {{profile.license}}: at hand-off it is the declared licence.
  assert.equal(manifest.license, "CC-BY-4.0");
  const provenance = manifest.provenance.generated;
  assert.equal(provenance.license, "CC-BY-4.0");
  assert.equal(provenance.outputGrant.attribution, CC_BY.attribution);
});

test("a non-commercial output is refused even when the target lists its licence", async () => {
  const world = await syntheticWorld();
  const profile = {
    ...world.profile,
    acceptedLicenses: ["CC-BY-4.0", NON_COMMERCIAL.license],
  };
  const { run, runDir } = await staged(world, routesWith(NON_COMMERCIAL), profile);
  const p = run.candidates[0]!.provenance;
  assert.equal(p.license, NON_COMMERCIAL.license);
  assert.equal(p.outputGrant?.commercial, false);
  await assert.rejects(
    pick({ runDir, candidateId: "c1", targetDir: world.targetDir }),
    (error: unknown) =>
      error instanceof LicenseError && /without commercial use/.test(error.message),
  );
  assert.deepEqual(await readdir(world.targetDir), []);
});

test("hand-off re-derives the grant from the calls, so an edited licence cannot relabel", async () => {
  const world = await syntheticWorld();
  const { runDir } = await staged(world, routesWith(CC_BY));
  const runFile = join(runDir, "run.json");
  const record = JSON.parse(await readFile(runFile, "utf8"));
  for (const c of record.candidates) {
    c.provenance.license = "MIT";
    delete c.provenance.outputGrant;
  }
  await writeFile(runFile, JSON.stringify(record));
  await assert.rejects(
    pick({ runDir, candidateId: "c1", targetDir: world.targetDir }),
    LicenseError,
  );
});

test("the most restrictive grant wins when calls combine", () => {
  assert.equal(combineGrants([]), undefined);
  assert.deepEqual(combineGrants([OWNED, OWNED]), OWNED);
  assert.deepEqual(combineGrants([OWNED, CC_BY]), {
    license: "CC-BY-4.0",
    plan: "pro + free",
    commercial: true,
    relabel: false,
    attribution: CC_BY.attribution,
  });
  const all = combineGrants([CC_BY, NON_COMMERCIAL, OWNED])!;
  assert.equal(all.license, NON_COMMERCIAL.license);
  assert.equal(all.commercial, false);
  assert.equal(all.relabel, false);
  assert.equal(all.attribution, CC_BY.attribution);
});

test("a routes file with a malformed outputGrant is invalid input", async () => {
  const world = await syntheticWorld();
  const path = join(world.dir, "routes.json");
  await writeFile(path, JSON.stringify({ edit: { outputGrant: { license: "CC-BY-4.0" } } }));
  await assert.rejects(loadRoutes(path), InputError);
  await writeFile(path, JSON.stringify({ edit: { outputGrant: CC_BY } }));
  assert.deepEqual((await loadRoutes(path)).edit.outputGrant, CC_BY);
});

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["src/cli.ts", ...args], { cwd: root }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

test("pick of a refused output exits 7 with license_refused", async () => {
  const world = await syntheticWorld();
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  const routes = join(world.dir, "routes.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  await writeFile(
    routes,
    JSON.stringify({ still: { outputGrant: CC_BY }, edit: { outputGrant: CC_BY } }),
  );
  const s = await cli([
    "stage",
    ...["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir],
    ...["--routes", routes, "--candidates", "1", "--provider-script", passingScript, "--json"],
  ]);
  assert.equal(s.code, 0, s.stderr);
  const runDir = JSON.parse(s.stdout)["runDir"] as string;
  const r = await cli([
    "pick",
    "--run",
    runDir,
    "--candidate",
    "c1",
    "--target",
    world.targetDir,
    "--json",
  ]);
  assert.equal(r.code, 7, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.equal(d.ok, false);
  assert.equal(d.error.code, "license_refused");
  assert.match(r.stderr, /refused hand-off/);
  assert.deepEqual(await readdir(world.targetDir), []);
});
