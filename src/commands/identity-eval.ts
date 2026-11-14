import { evaluateIdentity } from "../identity-eval.ts";
import type { Breakdown, MediumReport } from "../identity-eval.ts";
import { readJson } from "../inputs.ts";
import { DEFAULT_CAP_USD } from "../loop.ts";
import { providerFor, spendLedger } from "../providers/index.ts";
import { loadRoutes } from "../routes.ts";
import type { TargetProfile } from "../types.ts";
import { defineCommand } from "./types.ts";

function formatMedium(medium: string, m: MediumReport, threshold: number): string[] {
  const pct = (n: number) => `${Number((n * 100).toFixed(1))}%`;
  const line = (label: string, g: Breakdown["byKind"][string]) =>
    `  ${label}: ${g.cases} cases${g.auc !== undefined ? `, AUC ${g.auc.toFixed(3)}` : ""}, false accepts ${pct(g.falseAcceptRate)}, false rejects ${pct(g.falseRejectRate)}`;
  const b = m.configured;
  return [
    `${medium.toUpperCase()}${m.provisional ? " (provisional, no threshold rests on it)" : ""} at threshold ${threshold}:`,
    line("overall", b),
    ...Object.entries(b.byKind).map(([k, g]) => line(`kind ${k}`, g)),
    ...Object.entries(b.byCast).map(([c, g]) => line(`cast ${c}`, g)),
    m.provisional
      ? "  enforce bar: not judged on provisional 3D"
      : b.bar.met
        ? "  enforce bar (provisional): met"
        : `  enforce bar (provisional): not met: ${b.bar.failures.join("; ")}`,
  ];
}

interface IdentityEvalArgs {
  bible?: string;
  cases: string;
  profile?: string;
  log?: string;
  cap?: number;
  routes?: string;
  workItem?: string;
  providerScript?: string;
}

export const identityEvalCommand = defineCommand<IdentityEvalArgs>({
  name: "identity-eval",
  tool: null,
  summary: "score a local labelled image set against identity locks and recommend a threshold",
  details: `Scores every case of a labelled set against its subject's identity lock through the identity
route. cases.json is a list (or {"cases": [...]}) of {"image", "subject", "same": true|false,
"qa": true|false (optional), "kind": same|drift|generic|lookalike, "cast", "medium": 2d|3d,
"bible": path relative to the file}, image paths relative to the file. --bible is optional when
every case names its bible. With identity.question "cast" each candidate is judged against the whole
cast of its bible; every subject's record is first checked against its own references. Each call's label, confidence,
latency and cost are logged on stderr, and one JSON line per case goes to --log. Reports accuracy
for every threshold, the recommended threshold, accuracy at the profile's threshold and agreement
with the cases' QA verdicts. Never filters or approves. Keep the set and the log local; they may
hold a game's private art. See docs/generation-knobs.md.`,
  input: {
    type: "object",
    properties: {
      bible: {
        type: "string",
        description: "the BIBLE.md holding the identity locks",
        placeholder: "<BIBLE.md>",
      },
      cases: { type: "string", description: "the labelled cases", placeholder: "<cases.json>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      log: {
        type: "string",
        description: "where one JSON line per case is written",
        placeholder: "<identity-eval.jsonl>",
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
    },
    required: ["cases"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "always", writes: "out" },
  async run(args, ctx) {
    const profile = args.profile ? (await readJson<TargetProfile>(args.profile)).value : {};
    const { provider, name } = await providerFor(args.providerScript);
    const report = await evaluateIdentity({
      ...(args.bible !== undefined && { biblePath: args.bible }),
      casesPath: args.cases,
      profile,
      routes: await loadRoutes(args.routes),
      provider,
      providerName: name,
      capUsd: args.cap ?? DEFAULT_CAP_USD,
      ledger: spendLedger(args.workItem),
      ...(args.log !== undefined && { logPath: args.log }),
      log: ctx.log,
    });
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    const lines = [
      `${report.scored} of ${report.cases} cases scored by ${report.model} (${report.question}), ${report.failed} failed, $${report.spentUsd.toFixed(6)} spent`,
      ...report.sweep.map(
        (r) =>
          `  threshold ${r.threshold.toFixed(3)}: ${r.correct} correct (${pct(r.accuracy)}), ${r.falseRejects} false rejects, ${r.falseAccepts} false accepts`,
      ),
      report.recommended
        ? `recommended threshold ${report.recommended.threshold.toFixed(3)} (${pct(report.recommended.accuracy)})`
        : "no threshold recommended: no 2D case of a trusted record was scored",
      `configured threshold ${report.configured.threshold}: ${pct(report.configured.accuracy)}`,
      ...(report.qaAgreement
        ? [
            `agreement with QA: ${report.qaAgreement.agree}/${report.qaAgreement.scored} (${pct(report.qaAgreement.rate)}), identity-only failures ${report.qaAgreement.identityOnlyFailed}, QA-only failures ${report.qaAgreement.qaOnlyFailed}`,
          ]
        : []),
      ...(["2d", "3d"] as const).flatMap((medium) => {
        const m = report.media[medium];
        return m ? formatMedium(medium, m, report.configured.threshold) : [];
      }),
      ...(report.untrusted
        ? [
            `untrusted records (kept out of the threshold and the bar): ${report.untrusted.cases} cases at threshold ${report.configured.threshold}, false accepts ${pct(report.untrusted.falseAcceptRate)}, false rejects ${pct(report.untrusted.falseRejectRate)}`,
          ]
        : []),
      ...report.recordChecks.map((c) => `record check: ${c.reason}`),
    ];
    return { exitCode: 0, fields: { ...report }, human: lines.join("\n") };
  },
});
