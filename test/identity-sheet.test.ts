import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import type { IdentityRecord, IdentitySettings } from "../src/identity.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import { sha256 } from "../src/request.ts";
import { defaultRoutes } from "../src/routes.ts";
import { GROUPING_FILE, importSheet, readImport, writeFamilies } from "../src/sheet/import.ts";
import type { Grouping } from "../src/sheet/types.ts";
import type { LoadedReference } from "../src/types.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const reference: LoadedReference = (() => {
  const bytes = encodePng(createRaster(16, 16));
  return {
    role: "identity:approved-turnaround",
    path: "refs/turnaround.png",
    mediaType: "image/png",
    bytes,
    sha256: sha256(bytes),
  };
})();

const record: IdentityRecord = {
  subject: "bram",
  version: "v3",
  sha256: "0".repeat(64),
  fingerprint: {
    signatureFeatures: ["striped tail", "dark mask"],
    proportions: "long body, short legs",
    palette: ["#6c6e7a"],
  },
  references: [{ role: reference.role, path: reference.path, sha256: reference.sha256 }],
};

/** `score` is on the 0..4 rubric scale. */
function setup(score: number) {
  const provider = new ScriptedProvider({
    image: () => ({ images: [], costUsd: 0 }),
    // Enforce mode first checks the record against its references (#92); this one agrees.
    vision: (request) => ({
      text: request.prompt.includes("For each written claim")
        ? JSON.stringify({ consistent: true, conflicts: [] })
        : "",
      costUsd: 0,
    }),
    decide: () => ({ answer: { type: "score", score }, costUsd: 0.01 }),
  });
  const caller = new Caller({
    provider,
    providerName: "scripted",
    budget: new Budget(5),
    routes: defaultRoutes,
  });
  return { provider, caller };
}

async function run(
  mode: "shadow" | "enforce" | undefined,
  score: number,
  spec?: { animationFamily: string; fields: Record<string, unknown> },
) {
  const root = await mkdtemp(join(tmpdir(), "assetgrove-identity-sheet-"));
  const targetDir = join(root, "target");
  await mkdir(targetDir);
  const { provider, caller } = setup(score);
  const settings: IdentitySettings = { mode: mode ?? "shadow", threshold: 0.6, question: "score" };
  const imported = await importSheet({
    sheet: syntheticSheet().png,
    sheetPath: "sheets/synthetic.png",
    tool: "synthetic",
    digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
    assetId: "bram",
    subject: "bram",
    profile: syntheticProfile(),
    importsDir: join(root, "imports"),
    importId: "imp1",
    ...(mode && { identity: { caller, record, references: [reference], settings } }),
    ...(spec && { spec }),
  });
  return { ...imported, provider, caller, targetDir };
}

async function confirm(importDir: string): Promise<Grouping> {
  const saved = JSON.parse(await readFile(join(importDir, GROUPING_FILE), "utf8")) as Grouping;
  return {
    ...saved,
    status: "confirmed",
    families: [{ name: "idle", frames: [1, 2, 3, 4], reason: "standing" }],
    unassigned: [],
  };
}

test("shadow mode records the score and lock version but never filters", async () => {
  const { record: imp, importDir, provider, targetDir } = await run("shadow", 1);
  assert.equal(provider.calls.filter((c) => c.kind === "decide").length, 1);
  assert.equal(imp.identity?.score, 0.25);
  assert.equal(imp.identity?.lockVersion, "v3");
  assert.equal(imp.identity?.filtered, false);
  assert.equal(imp.identity?.passed, false);
  assert.equal(imp.calls.length, 1);
  assert.equal((await readImport(importDir)).identity?.lockVersion, "v3");

  const written = await writeFamilies({ importDir, grouping: await confirm(importDir), targetDir });
  assert.ok(written.families.length > 0);
  for (const family of written.families) {
    const manifest = JSON.parse(await readFile(family.result.manifestPath, "utf8"));
    const provenance = manifest.provenance.generated;
    assert.equal(provenance.identity.lockVersion, "v3");
    assert.equal(provenance.identity.filtered, false);
    assert.equal(provenance.calls.length, 1);
  }
});

test("enforce mode below the threshold keeps the import but refuses to write it", async () => {
  const { record: imp, importDir, targetDir } = await run("enforce", 1);
  assert.equal(imp.identity?.filtered, true);
  await assert.rejects(
    writeFamilies({ importDir, grouping: await confirm(importDir), targetDir }),
    (error: Error) =>
      error.message.startsWith("refused: the identity lock filtered this sheet:") &&
      error.message.includes(imp.identity!.reason),
  );
});

test("enforce mode at or above the threshold writes", async () => {
  const { record: imp, importDir, targetDir } = await run("enforce", 4);
  assert.equal(imp.identity?.filtered, false);
  const written = await writeFamilies({ importDir, grouping: await confirm(importDir), targetDir });
  assert.ok(written.families.length > 0);
});

test("without an identity option nothing is scored", async () => {
  const { record: imp, provider } = await run(undefined, 4);
  assert.equal(provider.calls.filter((c) => c.kind === "decide").length, 0);
  assert.equal("identity" in imp, false);
  assert.equal(imp.calls.length, 0);
});

test("the identity prompt names the sheet's animation family when a spec asked for it", async () => {
  const describe = (provider: ScriptedProvider) =>
    provider.calls.flatMap((c) => (c.kind === "decide" ? [c.request.prompt] : []));
  const withSpec = await run("shadow", 4, { animationFamily: "walk", fields: {} });
  const [prompt] = describe(withSpec.provider);
  assert.match(prompt!, /contact sheet of \d+ frames of one character, from its "walk" animation/);
  const [plain] = describe((await run("shadow", 4)).provider);
  assert.match(plain!, /contact sheet of \d+ frames of one character\./);
});
