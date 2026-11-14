import { join, resolve } from "node:path";
import { Budget } from "../budget.ts";
import { Caller } from "../calls.ts";
import { declarationOption, lockFor, readBytes, readJson, sliceOptions } from "../inputs.ts";
import { DEFAULT_CAP_USD } from "../loop.ts";
import { providerFor, spendLedger } from "../providers/index.ts";
import { loadBibleInputs } from "../request.ts";
import { loadRoutes } from "../routes.ts";
import { CONTACT_FILE, GROUPING_FILE, importSheet } from "../sheet/import.ts";
import type { ImportOptions, ImportRecord } from "../sheet/import.ts";
import type { Grouping } from "../sheet/types.ts";
import { ledgerFor } from "../spend.ts";
import type { AssetSpec, StyleBible, TargetProfile } from "../types.ts";
import { defineCommand } from "./types.ts";

/** The identity score of an import as text lines. */
export function formatIdentity(record: ImportRecord): string[] {
  const score = record.identity;
  if (!score) return [];
  return [
    `identity ${score.mode} (${score.model}): ${score.reason}`,
    ...(score.filtered ? ["  write-families will refuse this sheet"] : []),
  ];
}

/** An import as text: the frames, their failed checks and the proposed grouping. */
export function formatImport(record: ImportRecord, importDir: string, grouping: Grouping): string {
  const lines = [
    `import ${record.importId}: ${record.frames.length} frames (${record.slice.mode}) from ${record.sheet.path}`,
    `staged in ${importDir}; contact sheet ${join(importDir, CONTACT_FILE)}`,
    ...formatIdentity(record),
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
    `  assetgrove write-families --import ${importDir} --target <dir>`,
  );
  return lines.join("\n");
}

interface ImportArgs {
  sheet: string;
  profile: string;
  asset: string;
  tool: string;
  digitalSourceType?: string;
  bible?: string;
  subject?: string;
  hints?: string;
  frames?: number;
  grid?: number;
  components?: boolean;
  noPropose?: boolean;
  lockBible?: string;
  identityMode?: string;
  cap?: number;
  routes?: string;
  imports?: string;
  workItem?: string;
  providerScript?: string;
}

export const importCommand = defineCommand<ImportArgs>({
  name: "import",
  tool: null,
  summary: "slice a contact sheet into frames and propose animation families",
  details: `Slices a contact sheet (from any tool; --tool names it, for example "ChatGPT image
generation"), removes the background to the profile's style, and has a vision model propose
families in <import>/grouping.json with status "proposed" (--no-propose skips the grouping
model; it needs no key unless --lock-bible names a locked subject, whose identity score is a
model call in shadow and enforce modes: add --identity-mode off to skip it). A human reviews the proposal against contact.png, edits it and sets its status
to "confirmed" before write-families. See docs/sheet-import.md.

With --frames, the sheet must hold exactly that many figures: slicing another number is refused
(exit 2) before any model call, naming the cells or figures behind the difference.

With --lock-bible, a subject with an identity lock in that art bible has its contact sheet scored
against the lock by the identity decision model. --identity-mode overrides the profile's
identity.mode: shadow (default) records the score, enforce makes write-families refuse a sheet
below the threshold, off skips scoring.`,
  input: {
    type: "object",
    properties: {
      sheet: { type: "string", description: "the contact sheet image", placeholder: "<sheet.png>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      asset: { type: "string", description: "the asset id", placeholder: "<id>" },
      tool: { type: "string", description: "the tool that made the sheet", placeholder: "<name>" },
      digitalSourceType: {
        type: "string",
        description: "the IPTC digital source type to declare",
        placeholder: "<IPTC code or URI>",
      },
      bible: { type: "string", description: "the style bible", placeholder: "<bible.json>" },
      subject: {
        type: "string",
        description: "the subject, when not the asset id",
        placeholder: "<name>",
      },
      hints: {
        type: "string",
        description: "family names to propose, comma separated",
        placeholder: "idle,walk-right,...",
      },
      frames: {
        type: "integer",
        minimum: 1,
        description: "how many figures the sheet must hold",
        placeholder: "<count>",
      },
      grid: {
        type: "integer",
        minimum: 1,
        description: "slice a grid of this many columns",
        placeholder: "<columns>",
      },
      components: { type: "boolean", description: "slice by connected components" },
      noPropose: { type: "boolean", description: "skip the grouping model" },
      lockBible: {
        type: "string",
        description: "score the sheet against the subject's identity lock in this art bible",
        placeholder: "<BIBLE.md>",
      },
      identityMode: {
        type: "string",
        description: "override the profile's identity mode",
        placeholder: "<off|shadow|enforce>",
      },
      cap: { type: "number", description: "the run's cost cap in USD", default: DEFAULT_CAP_USD },
      routes: { type: "string", description: "model routes", placeholder: "<routes.json>" },
      imports: {
        type: "string",
        description: "where imports are staged",
        default: ".assetgrove/imports",
      },
      workItem: {
        type: "string",
        description: "the work item the spend ledger counts against",
        placeholder: "<label>",
      },
      providerScript: {
        type: "string",
        description: "answer every model call from this module instead of a provider",
        placeholder: "<module>",
      },
    },
    required: ["sheet", "profile", "asset", "tool"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "runs" },
  async run(args, ctx) {
    const capUsd = args.cap ?? DEFAULT_CAP_USD;
    const slice = sliceOptions(args.grid, args.components, args.frames);
    const profile = await readJson<TargetProfile>(args.profile);
    const bible = args.bible ? await readJson<StyleBible>(args.bible) : undefined;
    const subject = args.subject ?? args.asset;
    const sheet = await readBytes(args.sheet, "sheet");
    const digitalSourceType = declarationOption(args.digitalSourceType);
    const lock = await lockFor(args.lockBible, args.identityMode, subject, profile.value);
    let shared: Caller | undefined;
    const caller = async (): Promise<Caller> => {
      if (!shared) {
        const routes = await loadRoutes(args.routes);
        const { provider, name } = await providerFor(args.providerScript);
        shared = new Caller({
          provider,
          providerName: name,
          budget: new Budget(capUsd, ledgerFor(spendLedger(args.workItem), name, profile.value)),
          routes,
          log: ctx.log,
        });
      }
      return shared;
    };
    let propose: ImportOptions["propose"];
    if (!args.noPropose) {
      const call = await caller();
      const description = bible?.value.subjects?.[subject]?.description;
      const spec: AssetSpec = { kind: "sprite-sheet", assetId: args.asset, subject };
      const references = bible ? (await loadBibleInputs(spec, bible.value, bible.dir)).subject : [];
      propose = {
        call,
        references,
        ...(args.hints !== undefined && { hints: args.hints.split(",").map((h) => h.trim()) }),
        ...(description !== undefined && { subjectDescription: description }),
      };
    }
    const { record, importDir, grouping } = await importSheet({
      sheet,
      sheetPath: args.sheet,
      tool: args.tool,
      ...(digitalSourceType !== undefined && { digitalSourceType }),
      assetId: args.asset,
      ...(args.subject !== undefined && { subject: args.subject }),
      profile: profile.value,
      ...(bible && { bible: { version: bible.value.version, palette: bible.value.palette } }),
      importsDir: resolve(args.imports ?? ".assetgrove/imports"),
      slice,
      ...(propose !== undefined && { propose }),
      ...(lock && {
        identity: {
          caller: await caller(),
          record: lock.record,
          references: lock.references,
          settings: lock.settings,
          ...(lock.cast && { cast: lock.cast }),
        },
      }),
    });
    return {
      exitCode: 0,
      fields: { importDir, ...record, grouping },
      human: formatImport(record, importDir, grouping),
    };
  },
});
