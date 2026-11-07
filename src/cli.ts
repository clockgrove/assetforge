#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { VercelGateway } from "./gateway/vercel.ts";
import { imageGenerators } from "./generators/image.ts";
import { pick } from "./handoff.ts";
import { DEFAULT_CANDIDATES, DEFAULT_CAP_USD, readJson, stage } from "./loop.ts";
import type { RunRecord } from "./loop.ts";
import { Budget } from "./budget.ts";
import { Caller } from "./calls.ts";
import { loadBibleInputs } from "./request.ts";
import { loadRoutes } from "./routes.ts";
import { generateSheet } from "./sheet/generate.ts";
import {
  CONTACT_FILE,
  DEFAULT_JITTER_BOUND_PX,
  GROUPING_FILE,
  importSheet,
  writeFamilies,
} from "./sheet/import.ts";
import type { ImportOptions, ImportRecord } from "./sheet/import.ts";
import type { Grouping, SliceOptions } from "./sheet/types.ts";
import type { AssetSpec, StyleBible, TargetProfile } from "./types.ts";

const USAGE = `Usage:
  assetforge stage --spec <spec.json> --bible <bible.json> --profile <profile.json>
                   [--candidates ${DEFAULT_CANDIDATES}] [--cap ${DEFAULT_CAP_USD}] [--routes <routes.json>]
                   [--runs .assetforge/runs] [--json]
  assetforge pick --run <run directory> --candidate <id> --target <target directory> [--json]
  assetforge import --sheet <sheet.png> --profile <profile.json> --asset <id> --tool <name>
                   [--bible <bible.json>] [--subject <name>] [--hints idle,walk-right,...]
                   [--grid <columns>] [--components] [--no-propose] [--cap ${DEFAULT_CAP_USD}]
                   [--routes <routes.json>] [--imports .assetforge/imports] [--json]
  assetforge generate-sheet --spec <spec.json> --bible <bible.json> --profile <profile.json>
                   [--cap ${DEFAULT_CAP_USD}] [--routes <routes.json>] [--imports .assetforge/imports] [--json]
  assetforge write-families --import <import directory> --target <target directory>
                   [--grouping <import>/grouping.json] [--jitter-bound ${DEFAULT_JITTER_BOUND_PX}] [--json]

stage generates candidates through the Vercel AI Gateway (AI_GATEWAY_API_KEY from the
environment) within the cost cap in USD, and stages only the ones that pass QA.
pick writes the chosen candidate and its manifest into the target with review pending.
A sprite-strip spec needs an approved keyPose: stage a still of the pose first, choose one
of its staged candidates, and name that file as keyPose in the strip spec.

import slices a contact sheet (from any tool; --tool names it, for example "ChatGPT image
generation"), removes the background to the profile's style, and has a vision model propose
families in <import>/grouping.json with status "proposed" (--no-propose skips the model).
generate-sheet asks the model for a whole cycle as one sheet within the cap, then imports it.
Review the proposal against contact.png, edit families, order, mirrors and frames, set its
status to "confirmed", then write-families writes one strip and manifest per family into the
target with review pending, registered within the jitter bound.`;

function formatImport(record: ImportRecord, importDir: string, grouping: Grouping): string {
  const lines = [
    `import ${record.importId}: ${record.frames.length} frames (${record.slice.mode}) from ${record.sheet.path}`,
    `staged in ${importDir}; contact sheet ${join(importDir, CONTACT_FILE)}`,
  ];
  for (const f of record.frames) {
    for (const c of f.checks.filter((c) => !c.passed)) {
      lines.push(`  frame ${f.id} ${c.check}: ${c.reason}`);
    }
  }
  lines.push("", `proposed grouping (${join(importDir, GROUPING_FILE)}):`);
  for (const f of grouping.families) {
    const frames = f.mirrorOf ? `mirror of ${f.mirrorOf}` : (f.frames ?? []).join(" ");
    lines.push(`  ${f.name}: ${frames}  (${f.reason})`);
  }
  if (grouping.unassigned.length > 0) lines.push(`  unassigned: ${grouping.unassigned.join(" ")}`);
  if (grouping.notes) lines.push(`  notes: ${grouping.notes}`);
  lines.push(
    "",
    'review it, edit it, set "status": "confirmed", then run:',
    `  assetforge write-families --import ${importDir} --target <dir>`,
  );
  return lines.join("\n");
}

function parseSlice(grid: string | undefined, components: boolean | undefined): SliceOptions {
  if (components) return { components: true };
  if (grid === undefined) return {};
  const columns = Number(grid);
  if (!Number.isInteger(columns) || columns < 1) throw new Error(`invalid --grid: ${grid}`);
  return { grid: { columns } };
}

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
      sheet: { type: "string" },
      asset: { type: "string" },
      tool: { type: "string" },
      subject: { type: "string" },
      hints: { type: "string" },
      grid: { type: "string" },
      components: { type: "boolean" },
      "no-propose": { type: "boolean" },
      imports: { type: "string" },
      import: { type: "string" },
      grouping: { type: "string" },
      "jitter-bound": { type: "string" },
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
  if (command === "import") {
    if (!values.sheet || !values.profile || !values.asset || !values.tool) throw new Error(USAGE);
    const profile = await readJson<TargetProfile>(values.profile);
    const bible = values.bible ? await readJson<StyleBible>(values.bible) : undefined;
    const subject = values.subject ?? values.asset;
    let propose: ImportOptions["propose"];
    if (!values["no-propose"]) {
      const call = new Caller({
        provider: VercelGateway.fromEnv(),
        providerName: "vercel-ai-gateway",
        budget: new Budget(values.cap ? Number(values.cap) : DEFAULT_CAP_USD),
        routes: await loadRoutes(values.routes),
      });
      const description = bible?.value.subjects?.[subject]?.description;
      const spec: AssetSpec = { kind: "sprite-sheet", assetId: values.asset, subject };
      const references = bible ? (await loadBibleInputs(spec, bible.value, bible.dir)).subject : [];
      propose = {
        call,
        references,
        ...(values.hints !== undefined && { hints: values.hints.split(",").map((h) => h.trim()) }),
        ...(description !== undefined && { subjectDescription: description }),
      };
    }
    const { record, importDir, grouping } = await importSheet({
      sheet: new Uint8Array(await readFile(values.sheet)),
      sheetPath: values.sheet,
      tool: values.tool,
      assetId: values.asset,
      ...(values.subject !== undefined && { subject: values.subject }),
      profile: profile.value,
      ...(bible && { bible: { version: bible.value.version, palette: bible.value.palette } }),
      importsDir: resolve(values.imports ?? ".assetforge/imports"),
      slice: parseSlice(values.grid, values.components),
      ...(propose !== undefined && { propose }),
    });
    console.log(
      values.json
        ? JSON.stringify({ importDir, ...record, grouping }, null, 2)
        : formatImport(record, importDir, grouping),
    );
    return 0;
  }
  if (command === "generate-sheet") {
    if (!values.spec || !values.bible || !values.profile) throw new Error(USAGE);
    const spec = await readJson<AssetSpec>(values.spec);
    const bible = await readJson<StyleBible>(values.bible);
    const profile = await readJson<TargetProfile>(values.profile);
    const { record, importDir, grouping, spentUsd } = await generateSheet({
      spec: spec.value,
      specDir: spec.dir,
      bible: bible.value,
      bibleDir: bible.dir,
      profile: profile.value,
      routes: await loadRoutes(values.routes),
      provider: VercelGateway.fromEnv(),
      providerName: "vercel-ai-gateway",
      importsDir: resolve(values.imports ?? ".assetforge/imports"),
      capUsd: values.cap ? Number(values.cap) : DEFAULT_CAP_USD,
    });
    console.log(
      values.json
        ? JSON.stringify({ importDir, spentUsd, ...record, grouping }, null, 2)
        : `$${spentUsd.toFixed(4)} spent\n${formatImport(record, importDir, grouping)}`,
    );
    return 0;
  }
  if (command === "write-families") {
    if (!values.import || !values.target) throw new Error(USAGE);
    const groupingPath = values.grouping ?? join(values.import, GROUPING_FILE);
    const result = await writeFamilies({
      importDir: values.import,
      grouping: JSON.parse(await readFile(groupingPath, "utf8")) as unknown,
      targetDir: values.target,
      jitterBoundPx: values["jitter-bound"]
        ? Number(values["jitter-bound"])
        : DEFAULT_JITTER_BOUND_PX,
    });
    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const f of result.families) {
        console.log(
          `${f.name}: ${f.frames.length} frames${f.mirrored ? " (mirrored)" : ""}, jitter ${f.jitterPx.toFixed(2)} px`,
        );
        console.log(`  wrote ${f.result.mediaPath}\n  wrote ${f.result.manifestPath}`);
        if (f.result.provenancePath) console.log(`  wrote ${f.result.provenancePath}`);
        if (f.result.validator) {
          console.log(
            `  target validator ${f.result.validator.accepted ? "accepted" : "REJECTED"} it` +
              (f.result.validator.output ? `: ${f.result.validator.output}` : ""),
          );
        }
      }
      console.log(`preview loop: ${result.previewPath}`);
    }
    return result.families.some((f) => f.result.validator?.accepted === false) ? 3 : 0;
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
