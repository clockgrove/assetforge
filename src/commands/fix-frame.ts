import { resolve } from "node:path";
import {
  DEFAULT_FIX_CAP_USD,
  parseAnchor,
  planFrameFix,
  runFixFrame,
  stripTarget,
} from "../animation/commands.ts";
import { formatReport } from "../animation/run.ts";
import { InputError } from "../errors.ts";
import { readJson, specForQa } from "../inputs.ts";
import { dryRunProvider, providerFor, spendLedger } from "../providers/index.ts";
import { loadRoutes } from "../routes.ts";
import type { StyleBible, TargetProfile } from "../types.ts";
import { dryRunOutcome, usd } from "./result.ts";
import { defineCommand } from "./types.ts";

interface FixFrameArgs {
  strip: string;
  family: string;
  profile: string;
  frame: number;
  from?: number;
  keyPose?: string;
  out: string;
  subject?: string;
  spec?: string;
  note?: string;
  provenance?: string;
  bible?: string;
  anchor?: string;
  cap?: number;
  routes?: string;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
}

export const fixFrameCommand = defineCommand<FixFrameArgs>({
  name: "fix-frame",
  tool: null,
  summary: "regenerate one bad frame of a strip by a reference-guided edit within a cost cap",
  details: `Edits frame <n> (1-based) with one reference-guided edit call, from an approved neighbour
frame (--from) or the approved key pose (--key-pose), within the cost cap in USD. Only that
frame changes. Writes the fixed strip, its provenance (the strip's own, with the call and a
fixes entry added) and its QA report and previews into --out. --provenance (default
<strip>.provenance.json when it exists) is the strip's own provenance or the record recipe or op
wrote for it; any other file is refused (exit 2) before the call. Never writes into a target and
never sets a review value. --spec reads the asset spec's gait (and subject) for that QA.
Give exactly one of --from and --key-pose.
--dry-run prints the planned call, the forecast and the spend left under the daily and work-item
limits, and needs no key.`,
  input: {
    type: "object",
    properties: {
      strip: {
        type: "string",
        description: "the sprite strip holding the bad frame",
        placeholder: "<strip.png>",
      },
      family: {
        type: "string",
        description: "the animation family of the strip",
        placeholder: "<name>",
      },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      frame: {
        type: "integer",
        minimum: 1,
        description: "the frame to regenerate, counted from 1",
        placeholder: "<n>",
      },
      from: {
        type: "integer",
        minimum: 1,
        description: "the approved neighbour frame to edit from",
        placeholder: "<n>",
      },
      keyPose: {
        type: "string",
        description: "the approved key pose to edit from",
        placeholder: "<image>",
      },
      out: {
        type: "string",
        description: "where the fixed strip and reports are written",
        placeholder: "<directory>",
      },
      subject: {
        type: "string",
        description: "the subject the strip shows",
        placeholder: "<name>",
      },
      spec: {
        type: "string",
        description: "the asset spec; supplies the gait and subject",
        placeholder: "<spec.json>",
      },
      note: { type: "string", description: "a note for the edit call", placeholder: "<text>" },
      provenance: {
        type: "string",
        description: "the strip's own provenance record",
        placeholder: "<strip>.provenance.json",
      },
      bible: { type: "string", description: "the style bible", placeholder: "<bible.json>" },
      anchor: { type: "string", description: "the anchor point of the frames", placeholder: "x,y" },
      cap: {
        type: "number",
        description: "the run's cost cap in USD",
        default: DEFAULT_FIX_CAP_USD,
      },
      routes: { type: "string", description: "model routes", placeholder: "<routes.json>" },
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
      dryRun: { type: "boolean", description: "print the plan and forecast; spend nothing" },
    },
    required: ["strip", "family", "profile", "frame", "out"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "out" },
  async run(args) {
    const index = args.frame;
    const neighbour = args.from;
    const keyPose = args.keyPose;
    if ((neighbour === undefined) === (keyPose === undefined)) {
      throw new InputError("give exactly one of --from <frame> or --key-pose <image>");
    }
    const capUsd = args.cap ?? DEFAULT_FIX_CAP_USD;
    const routes = await loadRoutes(args.routes);
    const profile = await readJson<TargetProfile>(args.profile);
    const anchor = parseAnchor(args.anchor);
    const spec = await specForQa(args.spec);
    const subject = args.subject ?? spec.subject;
    const target = stripTarget({
      path: args.strip,
      family: args.family,
      profile: profile.value,
      ...(subject !== undefined && { subject }),
      ...(anchor !== undefined && { anchor }),
      ...(spec.gait !== undefined && { gait: spec.gait }),
    });
    if (args.dryRun) {
      const providerName = await dryRunProvider(args.providerScript);
      const plan = planFrameFix(routes, capUsd);
      const human = [
        `dry run: fix frame ${index}, ${plan.calls} planned call(s), nothing spent`,
        ...plan.perCall.map((c) => `  ${c.operation}  ${c.model}  ~${usd(c.estimatedCostUsd)}`),
        `forecast ${usd(plan.estimateUsd)} against a $${capUsd.toFixed(2)} cap` +
          (plan.withinCap ? "" : " (over the cap)"),
      ].join("\n");
      return dryRunOutcome(
        plan,
        human,
        spendLedger(args.workItem).forProfile(profile.value),
        providerName,
      );
    }
    const bible =
      args.bible !== undefined ? (await readJson<StyleBible>(args.bible)).value : undefined;
    const result = await runFixFrame({
      target,
      index,
      from: keyPose !== undefined ? { keyPose } : { neighbour: neighbour as number },
      ...(args.note !== undefined && { note: args.note }),
      ...(args.provenance !== undefined && { provenancePath: args.provenance }),
      ...(bible !== undefined && { bible: { version: bible.version, palette: bible.palette } }),
      outDir: resolve(args.out),
      routes,
      capUsd,
      ledger: spendLedger(args.workItem),
      provider: await providerFor(args.providerScript),
    });
    const human = [
      `fixed frame ${index} of ${target.family} with ${result.fix.model} (request ${result.fix.requestId}), $${result.spentUsd.toFixed(4)} spent`,
      `wrote ${result.stripPath}`,
      `wrote ${result.provenancePath}`,
      ...formatReport(result.qa.report),
      `  onion skin ${result.qa.files.onion}`,
      `  preview ${result.qa.files.preview}`,
    ].join("\n");
    return {
      exitCode: 0,
      fields: {
        stripPath: result.stripPath,
        provenancePath: result.provenancePath,
        fix: result.fix,
        spentUsd: result.spentUsd,
        qa: { ...result.qa.report, files: result.qa.files },
      },
      human,
    };
  },
});
