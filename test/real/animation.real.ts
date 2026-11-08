/**
 * Opt-in proof on the owner's real art, which is never committed here. Set:
 * - JIMOTHY_SHEET: a local copy of Clockgrove's `docs/design/reference/jimothy-sprite-sheet.png`;
 * - JIMOTHY_GROUPING: an author-confirmed grouping.json for that sheet (status "confirmed");
 * - JIMOTHY_OUT (optional): where the QA reports, onion-skin sheets and loop previews go
 *   (default: a temporary directory, printed).
 * Without JIMOTHY_SHEET and JIMOTHY_GROUPING the test skips. With AI_GATEWAY_API_KEY as well, it
 * runs the identity-flicker check on one family and one per-frame fix, within a $2 cap in total.
 * Run with `pnpm test:real`.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importTargets, runAnimationQa, runFixFrame } from "../../src/animation/commands.ts";
import { VercelGateway } from "../../src/gateway/vercel.ts";
import { defaultRoutes } from "../../src/routes.ts";
import { importSheet, writeFamilies } from "../../src/sheet/import.ts";
import type { TargetProfile } from "../../src/types.ts";

const sheetPath = process.env["JIMOTHY_SHEET"];
const groupingPath = process.env["JIMOTHY_GROUPING"];
const skip = sheetPath && groupingPath ? false : "JIMOTHY_SHEET and JIMOTHY_GROUPING not both set";
const real = Boolean(process.env["AI_GATEWAY_API_KEY"]);
const CAP_USD = 2;

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
  // Jimothy's crouch-hop matches no built-in template; the target adds one for exactly that
  // family, as data, whose contacts move (crouch, hop, land) once per cycle, so each planted
  // frame's footprint is checked against the loop's mean.
  animation: {
    templates: [
      {
        name: "crouch-hop",
        description: "crouch, hop and land; the feet leave the ground between contacts",
        loop: true,
        frames: { min: 3, max: 16 },
        beats: [
          { name: "crouch", at: 0, contact: true },
          { name: "airborne", at: 0.4 },
          { name: "land", at: 0.8, contact: true },
        ],
        contact: "beats",
        silhouette: { min: 0.01, max: 0.5 },
        footprint: "moving",
        footprintDriftPx: 8,
      },
    ],
  },
};

test(
  "real art: Jimothy's families through animation QA, previews and a fix",
  { skip },
  async () => {
    const out = process.env["JIMOTHY_OUT"] ?? (await mkdtemp(join(tmpdir(), "assetforge-anim-")));
    await mkdir(out, { recursive: true });
    const { importDir } = await importSheet({
      sheet: new Uint8Array(await readFile(sheetPath as string)),
      sheetPath: sheetPath as string,
      tool: "ChatGPT image generation",
      digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
      assetId: "jimothy",
      subject: "jimothy",
      profile,
      importsDir: join(out, "imports"),
    });
    const grouping: unknown = JSON.parse(await readFile(groupingPath as string, "utf8"));
    const written = await writeFamilies({ importDir, grouping, targetDir: join(out, "target") });
    for (const f of written.families) {
      console.log(`${f.name}: onion ${f.onionPath}, preview ${f.loopPreviewPath}`);
      for (const r of f.animation.reasons.filter((x) => !x.passed)) {
        console.log(`  ${r.check}: ${r.reason}`);
      }
    }

    const targets = await importTargets(importDir);
    const qaDir = join(out, "qa");
    const offline = await runAnimationQa({
      targets,
      outDir: qaDir,
      routes: defaultRoutes,
      capUsd: 0,
    });
    assert.equal(offline.results.length, written.families.length);
    assert.equal(offline.spentUsd, 0);
    if (!real) return;

    const provider = { provider: VercelGateway.fromEnv(), name: "vercel-ai-gateway" };
    const first = targets[0];
    assert.ok(first);
    const flicker = await runAnimationQa({
      targets: [first],
      outDir: qaDir,
      routes: defaultRoutes,
      capUsd: 1,
      provider,
    });
    const decisions = flicker.results[0]?.decisions ?? [];
    for (const d of decisions) {
      console.log(
        `flicker ${d.pair.join("→")}: ${d.label} ${d.confidence} (${d.model}, ${d.requestId})`,
      );
    }
    // Fix the frame the QA flagged first, else frame 2, from its previous neighbour.
    const report = flicker.results[0]?.report;
    const flagged = report?.reasons.find((r) => !r.passed && r.frames?.length)?.frames;
    const index = flagged?.[flagged.length - 1] ?? 2;
    const fixed = await runFixFrame({
      target: first,
      index,
      from: { neighbour: index > 1 ? index - 1 : 2 },
      outDir: join(out, "fix"),
      routes: defaultRoutes,
      capUsd: CAP_USD - flicker.spentUsd,
      provider,
    });
    console.log(
      `fixed ${first.family} frame ${index}: ${fixed.stripPath} ($${fixed.spentUsd.toFixed(4)}, ${fixed.fix.requestId})`,
    );
    assert.ok(flicker.spentUsd + fixed.spentUsd <= CAP_USD);
  },
);
