import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { applyPlan, createPlan } from "../src/planning.ts";
import { IDENTITY_CHECK_OPERATION, defaultRoutes } from "../src/routes.ts";
import type { Routes } from "../src/routes.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import type { DecisionRequest } from "../src/gateway/provider.ts";
import { createRaster, decodeImage, encodePng, setPixel } from "../src/image/raster.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";
import type { TargetProfile } from "../src/types.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const spec = { kind: "still", assetId: "den" };

async function fixture(withLock = true) {
  const root = await mkdtemp(join(tmpdir(), "identity-plan-"));
  roots.push(root);
  const dir = join(root, ".assetforge/art-direction");
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, ".assetforge/prompts"), { recursive: true });
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  data.world = "Woodland";
  if (withLock) {
    await writeFile(join(dir, "turn.png"), encodePng(createRaster(2, 2)));
    data.identities["den"] = {
      version: "7",
      approved: true,
      turnaround: "turn.png",
      signatureFeatures: ["white muzzle"],
      proportions: "round",
      palette: ["#292433"],
    };
  }
  const biblePath = join(dir, "BIBLE.md");
  await writeFile(
    biblePath,
    serializeBible(data, "## Do's and Don'ts\nDo preserve identity. Don't add text.\n"),
  );
  await writeFile(
    join(root, ".assetforge/prompts/default.md"),
    "# Prompt template v1\nCreate original art.\n{{constitution}}\n{{spec}}\n{{brief}}\n{{settings}}\n{{family}}\n",
  );
  return { root, biblePath };
}

/** Candidate n gets the n-th answer, on the 0..4 rubric; a number below 0 makes the call fail. */
function scripted(answers: number[]) {
  const image = createRaster(4, 4);
  setPixel(image, 1, 1, [120, 90, 80, 255]);
  return new ScriptedProvider({
    image: () => ({ images: [{ mediaType: "image/png", bytes: encodePng(image) }] }),
    vision: (request) => ({
      // Enforce mode first checks the record against its references (#92); this one agrees.
      text: request.prompt.includes("For each written claim")
        ? JSON.stringify({ consistent: true, conflicts: [] })
        : JSON.stringify({ styleScore: 1, passed: true, reason: "constitution matches" }),
    }),
    decide: (_request, index) => {
      const score = answers[index] as number;
      if (score < 0) throw new Error("decision model offline");
      return { answer: { type: "score", score }, confidence: 0.8 };
    },
  });
}

async function run(
  answers: number[],
  options: {
    profile?: Partial<TargetProfile>;
    withLock?: boolean;
    identityMode?: string;
    routes?: Routes;
  } = {},
) {
  const f = await fixture(options.withLock ?? true);
  const provider = scripted(answers);
  const plan = await createPlan({
    biblePath: f.biblePath,
    spec,
    settings: { candidates: answers.length, capUsd: 5 },
    profile: syntheticProfile(options.profile),
    ...(options.identityMode && { identityMode: options.identityMode }),
    ...(options.routes && { routes: options.routes }),
  });
  const logs: string[] = [];
  const result = await applyPlan(plan, {
    provider,
    autoApprove: true,
    outDir: join(f.root, "runs"),
    log: (m) => logs.push(m),
  });
  return { plan, provider, logs, ...result };
}

test("shadow mode, the default, scores a below-threshold candidate without filtering it", async () => {
  const { plan, run: record, provider, logs } = await run([0.5, 3.6]);
  assert.equal(plan.identityCheck?.mode, "shadow");
  assert.equal(record.candidates.length, 2);
  assert.equal(record.filtered, 0);
  const low = record.candidates[0]!;
  assert.equal((low.fields["identity"] as { passed: boolean }).passed, false);
  assert.equal(low.provenance.identity?.lockVersion, "7");
  const reason = low.reasons.find((r) => r.check === "identity-lock")!;
  assert.equal(reason.shadow, true);
  assert.equal(reason.passed, false);
  const decision = low.provenance.calls.find((c) => c.operation === "identity")!.decision!;
  assert.ok(decision.label && decision.confidence === 0.8 && decision.latencyMs >= 0);
  assert.equal(record.identity?.lockVersion, "7");
  assert.equal(record.identity?.agreement.identityOnlyFailed, 1);
  assert.equal(record.identity?.scores, 2);
  assert.equal(provider.calls.filter((c) => c.kind === "decide").length, 2);
  assert.ok(logs.some((m) => m.startsWith("identity ")));
});

test("enforce mode filters the below-threshold candidate and says why", async () => {
  const { plan, run: record } = await run([0.5, 3.6], {
    profile: { identity: { mode: "enforce" } },
  });
  assert.equal(plan.identityCheck?.mode, "enforce");
  assert.deepEqual(
    record.candidates.map((c) => c.id),
    ["c2"],
  );
  assert.equal(record.filtered, 1);
  assert.equal(record.rejections?.length, 1);
  assert.equal(record.rejections?.[0]?.candidate, 1);
  assert.equal(record.rejections?.[0]?.reasons[0]?.check, "identity-lock");
  assert.match(record.rejections![0]!.reasons[0]!.reason, /lock 7/);
  assert.equal(record.candidates[0]!.reasons.at(-1)?.passed, true);
  assert.equal(record.candidates[0]!.reasons.at(-1)?.shadow, undefined);
});

test("enforce mode checks the record against its references once per run", async () => {
  const { provider } = await run([3.6, 3.6, 3.6], {
    profile: { identity: { mode: "enforce" } },
  });
  const checks = provider.calls.filter(
    (c) => c.kind === "vision" && c.request.prompt.includes("For each written claim"),
  );
  assert.equal(checks.length, 1);
});

test("the plan records the record check's route, so a routes file applies at apply time", async () => {
  const checkRoute = {
    ...defaultRoutes[IDENTITY_CHECK_OPERATION]!,
    model: "test/record-checker",
    estimatedCostUsd: 0.05,
  };
  const shadow = await run([3.6]);
  assert.equal(shadow.plan.identityCheck?.checkRoute, undefined);
  const { plan, provider } = await run([3.6], {
    profile: { identity: { mode: "enforce" } },
    routes: { ...defaultRoutes, [IDENTITY_CHECK_OPERATION]: checkRoute },
  });
  assert.equal(plan.identityCheck?.checkRoute?.model, "test/record-checker");
  assert.ok(
    Math.abs(
      plan.forecast.generationUsd -
        shadow.plan.forecast.generationUsd -
        checkRoute.estimatedCostUsd,
    ) < 1e-9,
  );
  const checks = provider.calls.filter(
    (c) => c.kind === "vision" && c.request.prompt.includes("For each written claim"),
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0]!.request.model, "test/record-checker");
});

test("the mode option overrides the profile, and off plans no scoring", async () => {
  const enforced = await run([3.6], { identityMode: "enforce" });
  assert.equal(enforced.plan.identityCheck?.mode, "enforce");
  const off = await run([3.6], { identityMode: "off" });
  assert.equal(off.plan.identityCheck, undefined);
  assert.equal(off.run.identity, undefined);
});

test("a subject with no lock is not scored and its plan has no identity check", async () => {
  const { plan, provider, run: record } = await run([3.6], { withLock: false });
  assert.equal("identityCheck" in plan, false);
  assert.equal(provider.calls.filter((c) => c.kind === "decide").length, 0);
  assert.equal(record.candidates.length, 1);
  assert.equal(record.identity, undefined);
  assert.equal(record.candidates[0]!.provenance.identity, undefined);
});

test("the identity forecast is part of the plan's cost", async () => {
  const locked = await run([3.6]);
  const free = await run([3.6], { withLock: false });
  assert.ok(
    Math.abs(
      locked.plan.forecast.generationUsd -
        free.plan.forecast.generationUsd -
        locked.plan.identityCheck!.route.estimatedCostUsd,
    ) < 1e-9,
  );
});

test("decision images are upscaled to at least 384 px on the short side", async () => {
  const { provider } = await run([3.6]);
  const request = provider.calls.find((c) => c.kind === "decide")!.request as DecisionRequest;
  assert.ok(request.images.length >= 2);
  for (const image of request.images) {
    const raster = decodeImage(image.bytes);
    assert.ok(Math.min(raster.width, raster.height) >= 384);
  }
});

test("a failing decision filters in enforce mode and does not in shadow mode", async () => {
  const enforce = await run([-1], { profile: { identity: { mode: "enforce" } } });
  assert.equal(enforce.run.candidates.length, 0);
  assert.equal(enforce.run.filtered, 1);
  assert.match(enforce.run.rejections![0]!.reasons[0]!.reason, /failed: .*offline/);
  const shadow = await run([-1]);
  assert.equal(shadow.run.candidates.length, 1);
  assert.equal(shadow.run.candidates[0]!.reasons.at(-1)?.passed, false);
  assert.equal(shadow.run.candidates[0]!.reasons.at(-1)?.shadow, true);
});
