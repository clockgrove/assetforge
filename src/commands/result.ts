import { dirname, join } from "node:path";
import { BudgetExceededError } from "../budget.ts";
import { EXIT, InputError, ProviderError } from "../errors.ts";
import type { ErrorCode } from "../errors.ts";
import { LicenseError } from "../license.ts";
import type { RunRecord, StagePlan } from "../loop.ts";
import { SPEND_ENV, SpendLimitError, isPaidProvider, limitLabel } from "../spend.ts";
import type { SpendLedger, SpendStatus } from "../spend.ts";
import type { Failure, Outcome } from "./types.ts";

/** The one result document of a command: its fields, then the contract fields no field shadows. */
export function resultDocument(command: string | null, outcome: Outcome): Record<string, unknown> {
  const { exitCode, fields, error } = outcome;
  return { ...fields, ok: exitCode === 0, exitCode, command, ...(error && { error }) };
}

/** A refusal: the error code's exit, the fields and summary so far, and the code and message. */
export function refusal(
  code: ErrorCode,
  message: string,
  fields: Record<string, unknown>,
  human: string,
): Outcome {
  return { exitCode: EXIT[code], fields, human, error: { code, message } };
}

/** The error code of a thrown error; anything unrecognised is an internal error. */
export function classify(error: unknown): Failure {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof InputError) return { code: "invalid_input", message };
  if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
    return { code: "invalid_input", message };
  }
  if (error instanceof SpendLimitError) {
    const limit = {
      name: error.limit,
      ...(error.workItem !== undefined && { workItem: error.workItem }),
      limitUsd: error.limitUsd,
      spentUsd: error.spentUsd,
      requestedUsd: error.requestedUsd,
      ledger: error.ledger,
    };
    return { code: "cap_refused", message, limit };
  }
  if (error instanceof BudgetExceededError) return { code: "cap_refused", message };
  if (error instanceof ProviderError) return { code: "provider_error", message };
  if (error instanceof LicenseError) return { code: "license_refused", message };
  return { code: "internal_error", message };
}

/** The outcome of a thrown error. */
export function failureOutcome(error: unknown): Outcome {
  const failure = classify(error);
  return { exitCode: EXIT[failure.code], fields: {}, human: "", error: failure };
}

export const usd = (n: number) => `$${n.toFixed(4)}`;

function formatSpend(spend: SpendStatus, counted: boolean): string[] {
  return [
    `spend ledger ${spend.ledger}` + (counted ? "" : " (scripted provider: not counted)"),
    ...spend.limits.map(
      (l) =>
        `  ${limitLabel(l)} (${l.source}): ${usd(l.spentUsd)} spent, ${usd(l.remainingUsd)} left`,
    ),
    ...(spend.workItem === null
      ? [`  no work item named (--work-item or ${SPEND_ENV.workItem}); the daily limit applies`]
      : []),
  ];
}

/**
 * The outcome of a dry run: the plan, the spend left under each ledger limit, and a refusal (exit
 * 3) when the forecast is over the run's cap or, for a paid provider, over what is left under a
 * limit. A scripted run's calls are not counted (`spend.counted` false), so the limits never
 * refuse it.
 */
export function dryRunOutcome(
  plan: { estimateUsd: number; capUsd: number; withinCap: boolean },
  human: string,
  ledger: SpendLedger,
  providerName: string | undefined,
): Outcome {
  const counted = isPaidProvider(providerName);
  const spend = { ...ledger.status(), counted };
  const over = counted
    ? spend.limits.find((l) => plan.estimateUsd > l.remainingUsd + 1e-9)
    : undefined;
  const fields = { dryRun: true, plan, spend, withinLimits: over === undefined };
  const text = [human, ...formatSpend(spend, counted)].join("\n");
  if (!plan.withinCap)
    return refusal(
      "cap_refused",
      `forecast ${usd(plan.estimateUsd)} exceeds the $${plan.capUsd.toFixed(2)} cap`,
      fields,
      text,
    );
  if (over)
    return refusal(
      "cap_refused",
      `forecast ${usd(plan.estimateUsd)} exceeds the ${usd(over.remainingUsd)} left under the ${limitLabel(over)}`,
      fields,
      text,
    );
  return { exitCode: 0, fields, human: text };
}

/** A stage plan as dry-run text. */
export function formatPlan(plan: StagePlan): string {
  const lines = [
    `dry run: ${plan.requested} ${plan.kind} candidate(s), ${plan.calls} planned call(s), nothing spent`,
  ];
  for (const c of plan.perCandidate) {
    lines.push(`  ${c.operation}  ${c.model}  ~${usd(c.estimatedCostUsd)} per call`);
  }
  lines.push(
    `per candidate: ${plan.perCandidate.length} call(s)`,
    `forecast ${usd(plan.estimateUsd)} against a $${plan.capUsd.toFixed(2)} cap` +
      (plan.withinCap ? "" : " (over the cap)"),
  );
  return lines.join("\n");
}

/** A staged run as text: its candidates with their reasons, rejections and identity agreement. */
export function formatRun(run: RunRecord, runDir: string): string {
  const lines = [
    `run ${run.runId}: ${run.candidates.length} of ${run.requested} candidates passed QA` +
      ` ($${run.spentUsd.toFixed(4)} spent of a $${run.capUsd.toFixed(2)} cap)`,
    `staged in ${runDir}`,
  ];
  if (run.stopped) lines.push(`stopped early: ${run.stopped}`);
  for (const c of run.candidates) {
    lines.push(
      "",
      `${c.id}  ${join(runDir, c.file)}  (${c.mediaType}, ${usd(c.provenance.costUsd)})`,
    );
    for (const r of c.reasons) {
      // A shadow check is recorded beside QA: its verdict is shown, but it filtered nothing.
      const tag = r.shadow
        ? `${r.source}; ${r.passed ? "passed" : "failed"}, not filtered`
        : r.source;
      lines.push(`    ${r.check} [${tag}]: ${r.reason}`);
    }
    if (c.artifacts?.length) lines.push(`    renders: ${join(runDir, dirname(c.artifacts[0]!))}`);
  }
  for (const rejection of run.rejections ?? []) {
    for (const r of rejection.reasons.filter((reason) => !reason.passed && !reason.shadow))
      lines.push(`candidate ${rejection.candidate} filtered: ${r.check}: ${r.reason}`);
    for (const r of rejection.reasons.filter((reason) => !reason.passed && reason.shadow))
      lines.push(
        `candidate ${rejection.candidate} also failed, not filtered: ${r.check}: ${r.reason}`,
      );
    if (rejection.costUsd !== undefined)
      lines.push(`candidate ${rejection.candidate} cost ${usd(rejection.costUsd)}`);
    if (rejection.artifacts?.length)
      lines.push(
        `candidate ${rejection.candidate} renders: ${join(runDir, dirname(rejection.artifacts[0]!))}`,
      );
  }
  if (run.identity) {
    const a = run.identity.agreement;
    lines.push(
      `identity ${run.identity.mode} against "${run.identity.subject}" lock ${run.identity.lockVersion}` +
        ` (threshold ${run.identity.threshold}): ${run.identity.scores} scored,` +
        ` agrees with QA on ${a.agree} of ${a.scored} (${(a.rate * 100).toFixed(0)}%),` +
        ` identity-only failures ${a.identityOnlyFailed}, QA-only failures ${a.qaOnlyFailed}`,
    );
  }
  if (run.candidates.length > 0) {
    lines.push(
      "",
      `pick one with: assetgrove pick --run ${runDir} --candidate <id> --target <dir>`,
    );
  }
  return lines.join("\n");
}
