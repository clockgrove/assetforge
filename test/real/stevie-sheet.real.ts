/**
 * Opt-in example on the owner's real sheet, which is never committed here: point STEVIE_SHEET at a
 * local copy of Clockgrove's `docs/design/reference/stevie-sprite-sheet.png` (57 numbered frames,
 * 8 columns of 192 px cells). With AI_GATEWAY_API_KEY set as well, the vision model proposes the
 * grouping (one call, about $0.02). Run with `pnpm test:real`; it skips without STEVIE_SHEET.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget } from "../../src/budget.ts";
import { Caller } from "../../src/calls.ts";
import { VercelGateway } from "../../src/gateway/vercel.ts";
import { defaultRoutes } from "../../src/routes.ts";
import { importSheet } from "../../src/sheet/import.ts";
import type { TargetProfile } from "../../src/types.ts";

const sheetPath = process.env["STEVIE_SHEET"];
const skip = sheetPath ? false : "STEVIE_SHEET not set";
const propose = Boolean(process.env["AI_GATEWAY_API_KEY"]);

const profile: TargetProfile = {
  name: "painterly-example",
  license: "MIT",
  style: { alpha: { mode: "soft" }, color: { rule: "full" } },
  frames: { width: 128, height: 128, durationMs: 120 },
  layout: {
    media: "{{spec.assetId}}/{{spec.animationFamily}}.png",
    manifest: "{{spec.assetId}}/{{spec.animationFamily}}.json",
  },
  manifest: { review: { status: "pending" } },
  review: { path: "review.status", pending: "pending" },
};

test("real sheet: the Stevie sheet slices into 57 clean frames", { skip }, async () => {
  const importsDir = await mkdtemp(join(tmpdir(), "assetforge-stevie-"));
  const { record, importDir, grouping } = await importSheet({
    sheet: new Uint8Array(await readFile(sheetPath as string)),
    sheetPath: sheetPath as string,
    tool: "ChatGPT image generation",
    assetId: "stevie",
    profile,
    importsDir,
    ...(propose && {
      propose: {
        call: new Caller({
          provider: VercelGateway.fromEnv(),
          providerName: "vercel-ai-gateway",
          budget: new Budget(1),
          routes: defaultRoutes,
        }),
        hints: ["idle", "walk-right", "walk-left", "crouch-hop", "look", "sit-groom"],
        subjectDescription: "a raccoon",
      },
    }),
  });
  console.log(`import staged in ${importDir}`);
  assert.equal(record.frames.length, 57);
  const failing = record.frames.filter((f) => f.checks.some((c) => !c.passed));
  assert.deepEqual(
    failing.map((f) => f.id),
    [],
    JSON.stringify(failing.map((f) => f.checks)),
  );
  if (propose) assert.ok(grouping.families.length > 0);
});
