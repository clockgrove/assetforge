import { join, resolve } from "node:path";
import {
  importTargets,
  parseAnchor,
  planAnimationQa,
  runAnimationQa,
  stripTarget,
} from "../animation/commands.ts";
import { formatReport } from "../animation/run.ts";
import { InputError } from "../errors.ts";
import { readJson, specForQa } from "../inputs.ts";
import { DEFAULT_CAP_USD } from "../loop.ts";
import { dryRunProvider, providerFor, spendLedger } from "../providers/index.ts";
import { loadRoutes } from "../routes.ts";
import type { TargetProfile } from "../types.ts";
import { dryRunOutcome, refusal, usd } from "./result.ts";
import { defineCommand } from "./types.ts";

interface AnimationQaArgs {
  strip?: string;
  family?: string;
  profile?: string;
  import?: string;
  out?: string;
  subject?: string;
  spec?: string;
  anchor?: string;
  noVision?: boolean;
  cap?: number;
  routes?: string;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
}

export const animationQaCommand = defineCommand<AnimationQaArgs>({
  name: "animation-qa",
  tool: null,
  summary: "check strips against motion templates and for loop and continuity; write previews",
  details: `Checks each strip against its family's motion template (beats, timing, contact frames,
silhouette variation) and runs loop and continuity QA on pixels (loop seam, ground line,
anchor and footprint drift, a colour halo at the edge). Two checks need vision, within the
cost cap in USD: identity flicker, one call per pair of consecutive frames, each label and
confidence appended to flicker.jsonl; and holes, one call per frame with a see-through area
inside the figure's outline, which the model judges a hole or a natural opening between
parts. --no-vision skips both. Writes <family>.qa.json, the onion-skin
sheet <family>.onion.png and the looping preview <family>.webp into --out.
--import checks every family write-families wrote from that import.
--spec reads the asset spec's gait (and its subject, unless --subject is given); the gait
picks the motion template's footprint rule for it, over the profile's animation.gait.
--dry-run prints the planned calls, the cost forecast and the spend left under the daily and
work-item limits, writes nothing and needs no key.
Give --strip, --family and --profile for one strip, or --import for every family of an import.
Exits 5 when any check fails; every failed check names its frame.`,
  input: {
    type: "object",
    properties: {
      strip: {
        type: "string",
        description: "the sprite strip to check",
        placeholder: "<strip.png>",
      },
      family: {
        type: "string",
        description: "the animation family of the strip",
        placeholder: "<name>",
      },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      import: {
        type: "string",
        description: "check every family write-families wrote from this import",
        placeholder: "<import directory>",
      },
      out: {
        type: "string",
        description: "where reports and previews are written",
        default: ".assetgrove/animation",
      },
      subject: {
        type: "string",
        description: "the subject the strips show",
        placeholder: "<name>",
      },
      spec: {
        type: "string",
        description: "the asset spec; supplies the gait and subject",
        placeholder: "<spec.json>",
      },
      anchor: { type: "string", description: "the anchor point of the frames", placeholder: "x,y" },
      noVision: {
        type: "boolean",
        description: "skip the flicker and holes checks that need vision",
      },
      cap: { type: "number", description: "the run's cost cap in USD", default: DEFAULT_CAP_USD },
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
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "out" },
  async run(args) {
    const capUsd = args.cap ?? DEFAULT_CAP_USD;
    const routes = await loadRoutes(args.routes);
    const vision = !args.noVision;
    const spec = await specForQa(args.spec);
    let targets;
    if (typeof args.import === "string") {
      if (args.strip !== undefined) throw new InputError("give --strip or --import, not both");
      targets = await importTargets(args.import);
    } else {
      const missing = (["strip", "family", "profile"] as const).filter((n) => !args[n]);
      if (missing.length > 0) {
        throw new InputError(`missing required option ${missing.map((n) => `--${n}`).join(", ")}`);
      }
      const profile = await readJson<TargetProfile>(args.profile as string);
      const anchor = parseAnchor(args.anchor);
      targets = [
        stripTarget({
          path: args.strip as string,
          family: args.family as string,
          profile: profile.value,
          ...(args.subject !== undefined && { subject: args.subject }),
          ...(anchor !== undefined && { anchor }),
        }),
      ];
    }
    const subject = args.subject ?? spec.subject;
    for (const t of targets) {
      if (subject !== undefined) t.subject = subject;
      if (spec.gait !== undefined) t.gait = spec.gait;
    }
    if (args.dryRun) {
      const providerName = await dryRunProvider(args.providerScript);
      const plan = await planAnimationQa(targets, routes, capUsd, vision);
      const human = [
        `dry run: ${targets.length} strip(s), ${plan.calls} planned vision call(s), nothing spent`,
        ...plan.perFamily.map(
          (f) =>
            `  ${f.family}: ${f.flickerCalls} flicker call(s)  ${plan.model}; ${f.holeCalls} holes call(s)  ${plan.holesModel}`,
        ),
        `forecast ${usd(plan.estimateUsd)} against a $${capUsd.toFixed(2)} cap` +
          (plan.withinCap ? "" : " (over the cap)"),
      ].join("\n");
      const ledger = targets.reduce((l, t) => l.forProfile(t.profile), spendLedger(args.workItem));
      return dryRunOutcome(plan, human, ledger, providerName);
    }
    const outDir = resolve(args.out ?? ".assetgrove/animation");
    const { results, spentUsd } = await runAnimationQa({
      targets,
      outDir,
      routes,
      capUsd,
      ledger: spendLedger(args.workItem),
      ...(vision && { provider: await providerFor(args.providerScript) }),
    });
    const lines: string[] = [];
    for (const r of results) {
      lines.push(...formatReport(r.report));
      lines.push(`  onion skin ${r.files.onion}`, `  preview ${r.files.preview}`);
    }
    if (vision)
      lines.push(`$${spentUsd.toFixed(4)} spent; decisions in ${join(outDir, "flicker.jsonl")}`);
    const fields = {
      outDir,
      spentUsd,
      families: results.map((r) => ({
        ...r.report,
        decisions: r.decisions,
        holeDecisions: r.holeDecisions,
        files: r.files,
      })),
    };
    const human = lines.join("\n");
    const failed = results.filter((r) => !r.report.passed).map((r) => r.report.family);
    if (failed.length > 0) {
      return refusal(
        "qa_found_nothing",
        `animation QA failed for ${failed.join(", ")}`,
        fields,
        human,
      );
    }
    return { exitCode: 0, fields, human };
  },
});
