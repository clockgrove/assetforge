/**
 * Identity eval: scores a local labelled set against identity records, logs every call, and
 * recommends the threshold the logged scores support. The set stays local and is never committed.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadBible } from "./bible.ts";
import { Budget } from "./budget.ts";
import { Caller } from "./calls.ts";
import { InputError } from "./errors.ts";
import type { GenerationProvider } from "./gateway/provider.ts";
import {
  agreement,
  identitySettings,
  loadIdentity,
  scoreIdentity,
  sweepThresholds,
} from "./identity.ts";
import type { IdentityAgreement, IdentityScore, ThresholdRow } from "./identity.ts";
import { parseJsonFile } from "./json.ts";
import { loadReference } from "./request.ts";
import type { Routes } from "./routes.ts";
import type { TargetProfile } from "./types.ts";

/** One labelled case: an image, the character it is judged against, and whether it is that character. */
export interface EvalCase {
  /** Path relative to the cases file. */
  image: string;
  subject: string;
  /** True when the image shows the subject (the label). */
  same: boolean;
  /** The current QA's verdict on the image, when known, to measure agreement. */
  qa?: boolean;
  /** Optional description of the image for the prompt; defaults to "an image". */
  describe?: string;
}

export interface EvalCaseResult extends EvalCase {
  score?: IdentityScore;
}

export interface EvalReport {
  cases: number;
  scored: number;
  failed: number;
  model: string;
  question: "score" | "boolean";
  spentUsd: number;
  /** Accuracy of each candidate threshold over the scored cases. */
  sweep: ThresholdRow[];
  recommended?: ThresholdRow;
  /** Accuracy at the profile's configured threshold. */
  configured: ThresholdRow;
  /** Agreement between identity (at the recommended threshold) and the cases' QA verdicts. */
  qaAgreement?: IdentityAgreement;
  /** Agreement between identity (at the recommended threshold) and the labels. */
  labelAgreement?: IdentityAgreement;
  results: EvalCaseResult[];
}

export async function readEvalCases(path: string): Promise<{ cases: EvalCase[]; dir: string }> {
  const raw = await parseJsonFile(path, "identity eval cases");
  const list = Array.isArray(raw) ? raw : (raw as { cases?: unknown } | null)?.cases;
  if (!Array.isArray(list) || list.length === 0)
    throw new InputError(`${path} must be a non-empty array of cases or { "cases": [...] }`);
  const cases = list.map((item, i) => {
    const c = item as Partial<EvalCase> | null;
    if (
      !c ||
      typeof c.image !== "string" ||
      typeof c.subject !== "string" ||
      typeof c.same !== "boolean" ||
      (c.qa !== undefined && typeof c.qa !== "boolean")
    )
      throw new InputError(
        `case ${i + 1} needs "image" and "subject" strings and a boolean "same" (and optional boolean "qa")`,
      );
    return c as EvalCase;
  });
  return { cases, dir: dirname(resolve(path)) };
}

export async function evaluateIdentity(options: {
  biblePath: string;
  casesPath: string;
  profile: Pick<TargetProfile, "identity">;
  routes: Routes;
  provider: GenerationProvider;
  providerName: string;
  capUsd: number;
  /** JSON Lines log: one line per case with its score, label, confidence, latency and cost. */
  logPath?: string;
  log?: (message: string) => void;
}): Promise<EvalReport> {
  const doc = await loadBible(options.biblePath);
  const { cases, dir } = await readEvalCases(options.casesPath);
  // The eval measures; it never filters, so it runs in shadow mode at the configured threshold.
  const settings = { ...identitySettings(options.profile, "shadow") };
  const budget = new Budget(options.capUsd);
  budget.settle(
    budget.reserve(
      cases.length * options.routes.identity.estimatedCostUsd,
      `${cases.length} identity calls`,
    ),
    0,
  );
  const caller = new Caller({
    provider: options.provider,
    providerName: options.providerName,
    budget,
    routes: options.routes,
    ...(options.log && { log: options.log }),
  });
  if (options.logPath) await mkdir(dirname(resolve(options.logPath)), { recursive: true });
  const identities = new Map<string, Awaited<ReturnType<typeof loadIdentity>>>();
  const results: EvalCaseResult[] = [];
  for (const c of cases) {
    if (!identities.has(c.subject)) identities.set(c.subject, await loadIdentity(doc, c.subject));
    const identity = identities.get(c.subject);
    if (!identity) throw new InputError(`"${c.subject}" has no identity lock in ${doc.path}`);
    const candidate = await loadReference(c.image, "candidate", dir);
    const score = await scoreIdentity({
      caller,
      record: identity.record,
      references: identity.references,
      candidate,
      describe: c.describe ?? "an image",
      settings,
    });
    results.push({ ...c, score });
    if (options.logPath)
      await appendFile(
        options.logPath,
        `${JSON.stringify({ case: { image: c.image, subject: c.subject, same: c.same, qa: c.qa }, ...score })}\n`,
      );
  }
  const scored = results.filter((r) => r.score?.score !== undefined);
  const points = scored.map((r) => ({ score: r.score!.score!, same: r.same }));
  const { rows, recommended } = sweepThresholds(points);
  const at = (threshold: number): ThresholdRow => {
    const falseRejects = points.filter((p) => p.same && p.score < threshold).length;
    const falseAccepts = points.filter((p) => !p.same && p.score >= threshold).length;
    const correct = points.length - falseRejects - falseAccepts;
    return {
      threshold,
      correct,
      accuracy: points.length ? correct / points.length : 0,
      falseRejects,
      falseAccepts,
    };
  };
  const cut = recommended?.threshold ?? settings.threshold;
  const withQa = scored.filter((r) => r.qa !== undefined);
  return {
    cases: cases.length,
    scored: scored.length,
    failed: results.length - scored.length,
    model: options.routes.identity.model,
    question: settings.question,
    spentUsd: budget.spentUsd,
    sweep: rows,
    ...(recommended && { recommended }),
    configured: at(settings.threshold),
    ...(withQa.length > 0 && {
      qaAgreement: agreement(
        withQa.map((r) => ({ qa: r.qa as boolean, identity: r.score!.score! >= cut })),
      ),
    }),
    ...(scored.length > 0 && {
      labelAgreement: agreement(
        scored.map((r) => ({ qa: r.same, identity: r.score!.score! >= cut })),
      ),
    }),
    results,
  };
}
