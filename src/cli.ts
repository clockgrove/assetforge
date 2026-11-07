#!/usr/bin/env node
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { VercelGateway } from "./gateway/vercel.ts";
import { imageGenerators } from "./generators/image.ts";
import { pick } from "./handoff.ts";
import { DEFAULT_CANDIDATES, DEFAULT_CAP_USD, readJson, stage } from "./loop.ts";
import type { RunRecord } from "./loop.ts";
import { loadRoutes } from "./routes.ts";
import type { AssetSpec, StyleBible, TargetProfile } from "./types.ts";

const USAGE = `Usage:
  assetforge stage --spec <spec.json> --bible <bible.json> --profile <profile.json>
                   [--candidates ${DEFAULT_CANDIDATES}] [--cap ${DEFAULT_CAP_USD}] [--routes <routes.json>]
                   [--runs .assetforge/runs] [--json]
  assetforge pick --run <run directory> --candidate <id> --target <target directory> [--json]

stage generates candidates through the Vercel AI Gateway (AI_GATEWAY_API_KEY from the
environment) within the cost cap in USD, and stages only the ones that pass QA.
pick writes the chosen candidate and its manifest into the target with review pending.`;

function formatRun(run: RunRecord, runDir: string): string {
  const lines = [
    `run ${run.runId}: ${run.candidates.length} of ${run.requested} candidates passed QA` +
      ` ($${run.spentUsd.toFixed(4)} spent of a $${run.capUsd.toFixed(2)} cap)`,
    `staged in ${runDir}`,
  ];
  if (run.stopped) lines.push(`stopped early: ${run.stopped}`);
  for (const c of run.candidates) {
    lines.push("", `${c.id}  ${join(runDir, c.file)}  (${c.mediaType})`);
    for (const r of c.reasons) lines.push(`    ${r.check} [${r.source}]: ${r.reason}`);
  }
  if (run.candidates.length > 0) {
    lines.push(
      "",
      `pick one with: assetforge pick --run ${runDir} --candidate <id> --target <dir>`,
    );
  }
  return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      spec: { type: "string" },
      bible: { type: "string" },
      profile: { type: "string" },
      candidates: { type: "string" },
      cap: { type: "string" },
      routes: { type: "string" },
      runs: { type: "string" },
      run: { type: "string" },
      candidate: { type: "string" },
      target: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  if (command === "stage") {
    if (!values.spec || !values.bible || !values.profile) throw new Error(USAGE);
    const spec = await readJson<AssetSpec>(values.spec);
    const bible = await readJson<StyleBible>(values.bible);
    const profile = await readJson<TargetProfile>(values.profile);
    const { run, runDir } = await stage({
      spec: spec.value,
      specDir: spec.dir,
      bible: bible.value,
      bibleDir: bible.dir,
      profile: profile.value,
      routes: await loadRoutes(values.routes),
      provider: VercelGateway.fromEnv(),
      providerName: "vercel-ai-gateway",
      generators: imageGenerators,
      runsDir: resolve(values.runs ?? ".assetforge/runs"),
      candidates: values.candidates ? Number(values.candidates) : DEFAULT_CANDIDATES,
      capUsd: values.cap ? Number(values.cap) : DEFAULT_CAP_USD,
    });
    console.log(values.json ? JSON.stringify({ runDir, ...run }, null, 2) : formatRun(run, runDir));
    return run.candidates.length > 0 ? 0 : 2;
  }
  if (command === "pick") {
    if (!values.run || !values.candidate || !values.target) throw new Error(USAGE);
    const result = await pick({
      runDir: values.run,
      candidateId: values.candidate,
      targetDir: values.target,
    });
    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`wrote ${result.mediaPath}\nwrote ${result.manifestPath}`);
      if (result.provenancePath) console.log(`wrote ${result.provenancePath}`);
      if (result.validator) {
        console.log(
          `target validator ${result.validator.accepted ? "accepted" : "REJECTED"} the pick` +
            (result.validator.output ? `:\n${result.validator.output}` : ""),
        );
      }
    }
    return result.validator?.accepted === false ? 3 : 0;
  }
  throw new Error(`unknown command "${command}"\n${USAGE}`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
