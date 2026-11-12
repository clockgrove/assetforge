/**
 * Identity eval: scores a local labelled set against identity records, logs every call, and
 * recommends the threshold the logged scores support. The set stays local and is never committed.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadBible } from "./bible.ts";
import type { BibleDocument } from "./bible.ts";
import { Budget } from "./budget.ts";
import { ledgerFor } from "./spend.ts";
import type { SpendLedger } from "./spend.ts";
import { Caller } from "./calls.ts";
import { InputError } from "./errors.ts";
import type { GenerationProvider } from "./gateway/provider.ts";
import {
  agreement,
  checkIdentityRecord,
  identitySettings,
  loadCast,
  loadIdentity,
  scoreIdentity,
  sweepThresholds,
} from "./identity.ts";
import type {
  CastMember,
  IdentityAgreement,
  IdentityQuestionKind,
  IdentityRecordCheck,
  IdentityScore,
  ThresholdRow,
} from "./identity.ts";
import { parseJsonFile } from "./json.ts";
import { loadReference } from "./request.ts";
import { IDENTITY_CAST_OPERATION, IDENTITY_CHECK_OPERATION } from "./routes.ts";
import type { Routes } from "./routes.ts";
import type { TargetProfile } from "./types.ts";

export const EVAL_KINDS = ["same", "drift", "generic", "lookalike"] as const;
export type EvalKind = (typeof EVAL_KINDS)[number];
export const EVAL_MEDIA = ["2d", "3d"] as const;
export type EvalMedium = (typeof EVAL_MEDIA)[number];

/**
 * The bar a configuration must clear for identity to be enforced: AUC, false-accept and
 * false-reject rates overall and in every kind and cast. Provisional: reported, never enforced.
 * Part 2 of #92 sets it once in docs/decisions.md.
 */
export const IDENTITY_ENFORCE_BAR = { auc: 0.95, falseAcceptRate: 0.05, falseRejectRate: 0.1 };

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
  /** What the case tests; defaults to "same" or, for a different character, "other". */
  kind?: EvalKind;
  /** The cast the case belongs to; defaults to the bible's world. */
  cast?: string;
  /** Defaults to "2d". 3D results are provisional and never set the recommended threshold. */
  medium?: EvalMedium;
  /** Path relative to the cases file; overrides the run's bible for this case. */
  bible?: string;
}

export interface EvalCaseResult extends Omit<EvalCase, "kind"> {
  kind: EvalKind | "other";
  cast: string;
  medium: EvalMedium;
  score?: IdentityScore;
  /** True when the subject's record disagrees with its references, or could not be checked. */
  untrustedRecord?: boolean;
}

export interface Group {
  cases: number;
  positives: number;
  negatives: number;
  auc?: number;
  falseAccepts: number;
  falseRejects: number;
  falseAcceptRate: number;
  falseRejectRate: number;
}

export interface Breakdown extends Group {
  byKind: Record<string, Group>;
  byCast: Record<string, Group>;
  bar: { met: boolean; failures: string[] };
}

export interface MediumReport {
  /** True for 3D: no threshold rests on it. */
  provisional: boolean;
  /** At the profile's configured threshold. */
  configured: Breakdown;
  /** At the 2D recommended threshold, when there is one. */
  recommended?: Breakdown;
}

/** Area under the ROC curve by Mann-Whitney U, ties counting half; undefined without both classes. */
export function rocAuc(points: Array<{ score: number; same: boolean }>): number | undefined {
  const positives = points.filter((p) => p.same);
  const negatives = points.filter((p) => !p.same);
  if (positives.length === 0 || negatives.length === 0) return undefined;
  let wins = 0;
  for (const p of positives)
    for (const n of negatives) wins += p.score > n.score ? 1 : p.score === n.score ? 0.5 : 0;
  return wins / (positives.length * negatives.length);
}

function group(
  positives: Array<{ score: number }>,
  negatives: Array<{ score: number }>,
  threshold: number,
): Group {
  const falseRejects = positives.filter((p) => p.score < threshold).length;
  const falseAccepts = negatives.filter((n) => n.score >= threshold).length;
  const auc = rocAuc([
    ...positives.map((p) => ({ score: p.score, same: true })),
    ...negatives.map((n) => ({ score: n.score, same: false })),
  ]);
  return {
    cases: positives.length + negatives.length,
    positives: positives.length,
    negatives: negatives.length,
    ...(auc !== undefined && { auc }),
    falseAccepts,
    falseRejects,
    falseAcceptRate: negatives.length ? falseAccepts / negatives.length : 0,
    falseRejectRate: positives.length ? falseRejects / positives.length : 0,
  };
}

/** Errors at `threshold` overall, per kind of case and per cast, and whether the bar is met. */
export function breakdown(
  points: Array<{ score: number; same: boolean; kind: string; cast: string }>,
  threshold: number,
): Breakdown {
  const positives = points.filter((p) => p.same);
  const negatives = points.filter((p) => !p.same);
  const byKind: Record<string, Group> = {};
  for (const kind of new Set(points.map((p) => p.kind)))
    byKind[kind] = group(
      positives,
      negatives.filter((p) => p.kind === kind),
      threshold,
    );
  // The "same" group holds no negatives of its own: it reports the false-reject rate alone.
  if (byKind["same"]) byKind["same"] = group(positives, [], threshold);
  const byCast: Record<string, Group> = {};
  for (const cast of new Set(points.map((p) => p.cast)))
    byCast[cast] = group(
      positives.filter((p) => p.cast === cast),
      negatives.filter((p) => p.cast === cast),
      threshold,
    );
  const overall = group(positives, negatives, threshold);
  const bar = IDENTITY_ENFORCE_BAR;
  const pct = (n: number) => `${Number((n * 100).toFixed(1))}%`;
  const failures: string[] = [];
  // A group the set cannot measure never passes: it is listed as not measured.
  const judge = (label: string, g: Group, needsNegatives = true) => {
    const missing = [
      ...(g.positives === 0 ? ["no positives"] : []),
      ...(needsNegatives && g.negatives === 0 ? ["no negatives"] : []),
    ];
    if (missing.length > 0) {
      failures.push(`${label}: not measured (${missing.join(", ")})`);
      return;
    }
    if (g.auc !== undefined && g.auc < bar.auc)
      failures.push(`${label}: AUC ${g.auc.toFixed(3)} < ${bar.auc}`);
    if (g.falseAcceptRate > bar.falseAcceptRate)
      failures.push(
        `${label}: false accepts ${pct(g.falseAcceptRate)} > ${pct(bar.falseAcceptRate)}`,
      );
    if (g.falseRejectRate > bar.falseRejectRate)
      failures.push(
        `${label}: false rejects ${pct(g.falseRejectRate)} > ${pct(bar.falseRejectRate)}`,
      );
  };
  judge("overall", overall);
  // The "same" kind measures false rejects alone, so it needs positives only.
  for (const [k, g] of Object.entries(byKind)) judge(`kind ${k}`, g, k !== "same");
  for (const [c, g] of Object.entries(byCast)) judge(`cast ${c}`, g);
  return { ...overall, byKind, byCast, bar: { met: failures.length === 0, failures } };
}

export interface EvalReport {
  cases: number;
  scored: number;
  failed: number;
  model: string;
  question: IdentityQuestionKind;
  spentUsd: number;
  /**
   * Accuracy of each candidate threshold over the scored 2D cases of trusted records; empty, with
   * no recommendation, when there are none (3D never sets a threshold).
   */
  sweep: ThresholdRow[];
  recommended?: ThresholdRow;
  /** Accuracy at the profile's configured threshold. */
  configured: ThresholdRow;
  /** AUC of the 2D cases of trusted records. */
  auc?: number;
  /** Agreement between identity (at the recommended threshold) and the cases' QA verdicts. */
  qaAgreement?: IdentityAgreement;
  /** Agreement between identity (at the recommended threshold) and the labels. */
  labelAgreement?: IdentityAgreement;
  /** Cases of trusted records only, by medium. */
  media: { "2d"?: MediumReport; "3d"?: MediumReport };
  /**
   * Cases scored against a record that disagrees with its references or could not be checked, at
   * the configured threshold. They are kept out of the sweep, the AUC, the media and the bar.
   */
  untrusted?: Group;
  /** One check per (bible, subject) used: does its record agree with its own references. */
  recordChecks: IdentityRecordCheck[];
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
        `case ${i + 1} needs "image" and "subject" strings and a boolean "same" (and optional boolean "qa", "kind", "cast", "medium", "bible")`,
      );
    const kind = c.kind as unknown;
    const medium = c.medium as unknown;
    if (kind !== undefined && !EVAL_KINDS.includes(kind as EvalKind))
      throw new InputError(`case ${i + 1}: "kind" must be one of ${EVAL_KINDS.join(", ")}`);
    if (medium !== undefined && !EVAL_MEDIA.includes(medium as EvalMedium))
      throw new InputError(`case ${i + 1}: "medium" must be one of ${EVAL_MEDIA.join(", ")}`);
    if (c.same && kind !== undefined && kind !== "same")
      throw new InputError(`case ${i + 1}: a same-character case cannot have kind "${kind}"`);
    if (!c.same && kind === "same")
      throw new InputError(`case ${i + 1}: a different-character case cannot have kind "same"`);
    for (const field of ["cast", "bible"] as const)
      if (c[field] !== undefined && typeof c[field] !== "string")
        throw new InputError(`case ${i + 1}: "${field}" must be a string`);
    return c as EvalCase;
  });
  return { cases, dir: dirname(resolve(path)) };
}

export async function evaluateIdentity(options: {
  /** The bible of every case that names none. */
  biblePath?: string;
  casesPath: string;
  profile: Pick<TargetProfile, "identity" | "spend">;
  routes: Routes;
  provider: GenerationProvider;
  providerName: string;
  capUsd: number;
  /** The cross-run spend ledger every paid call also reserves against (src/spend.ts). */
  ledger?: SpendLedger;
  /** JSON Lines log: one line per case with its score, label, confidence, latency and cost. */
  logPath?: string;
  log?: (message: string) => void;
}): Promise<EvalReport> {
  const { cases, dir } = await readEvalCases(options.casesPath);
  // The eval measures; it never filters, so it runs in shadow mode at the configured threshold.
  const settings = { ...identitySettings(options.profile, "shadow") };
  const operation = settings.question === "cast" ? IDENTITY_CAST_OPERATION : "identity";

  const docs = new Map<string, BibleDocument>();
  const casts = new Map<string, Promise<CastMember[]>>();
  const bibleOf = async (c: EvalCase): Promise<BibleDocument> => {
    const path = c.bible !== undefined ? resolve(dir, c.bible) : options.biblePath;
    if (path === undefined)
      throw new InputError(`case "${c.image}" names no bible and no --bible was given`);
    let doc = docs.get(path);
    if (!doc) docs.set(path, (doc = await loadBible(path)));
    return doc;
  };
  const identities = new Map<string, NonNullable<Awaited<ReturnType<typeof loadIdentity>>>>();
  const prepared: Array<{ c: EvalCase; doc: BibleDocument; key: string }> = [];
  for (const c of cases) {
    const doc = await bibleOf(c);
    const key = `${doc.path}\0${c.subject}`;
    if (!identities.has(key)) {
      const identity = await loadIdentity(doc, c.subject);
      if (!identity) throw new InputError(`"${c.subject}" has no identity lock in ${doc.path}`);
      identities.set(key, identity);
    }
    prepared.push({ c, doc, key });
  }

  const budget = new Budget(
    options.capUsd,
    ledgerFor(options.ledger, options.providerName, options.profile),
  );
  budget.check(
    cases.length * options.routes[operation]!.estimatedCostUsd +
      identities.size * options.routes[IDENTITY_CHECK_OPERATION]!.estimatedCostUsd,
    `${cases.length} identity calls and ${identities.size} record checks`,
  );
  const caller = new Caller({
    provider: options.provider,
    providerName: options.providerName,
    budget,
    routes: options.routes,
    ...(options.log && { log: options.log }),
  });
  if (options.logPath) await mkdir(dirname(resolve(options.logPath)), { recursive: true });

  const checks = new Map<string, IdentityRecordCheck>();
  for (const [key, identity] of identities)
    checks.set(key, await checkIdentityRecord({ caller, ...identity }));
  const untrusted = (key: string) => {
    const check = checks.get(key)!;
    return !(check.checked && check.consistent);
  };

  const results: EvalCaseResult[] = [];
  for (const { c, doc, key } of prepared) {
    const identity = identities.get(key)!;
    const candidate = await loadReference(c.image, "candidate", dir);
    let cast: Promise<CastMember[]> | undefined;
    if (settings.question === "cast") {
      cast = casts.get(doc.path);
      if (!cast) casts.set(doc.path, (cast = loadCast(doc)));
    }
    const score = await scoreIdentity({
      caller,
      record: identity.record,
      references: identity.references,
      candidate,
      describe: c.describe ?? "an image",
      settings,
      recordCheck: checks.get(key)!,
      ...(cast && { cast: await cast }),
    });
    const resolved = {
      ...c,
      kind: (c.kind ?? (c.same ? "same" : "other")) as EvalCaseResult["kind"],
      cast: c.cast ?? doc.data.world,
      medium: c.medium ?? "2d",
    };
    results.push({ ...resolved, score, ...(untrusted(key) && { untrustedRecord: true }) });
    if (options.logPath)
      await appendFile(
        options.logPath,
        `${JSON.stringify({
          case: {
            image: c.image,
            subject: c.subject,
            same: c.same,
            qa: c.qa,
            kind: resolved.kind,
            cast: resolved.cast,
            medium: resolved.medium,
          },
          ...score,
        })}\n`,
      );
  }

  const scored = results.filter((r) => r.score?.score !== undefined);
  // A record that disagrees with its references does not filter, so nothing is measured on it:
  // its cases are reported as their own group, apart from the threshold and the bar.
  const trusted = scored.filter((r) => !r.untrustedRecord);
  const untrustedCases = scored.filter((r) => r.untrustedRecord);
  // Thresholds rest on 2D cases only; 3D is reported apart and provisional, and a set with no
  // 2D case recommends nothing.
  const basis = trusted.filter((r) => r.medium === "2d");
  const points = basis.map((r) => ({ score: r.score!.score!, same: r.same }));
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
  const withQa = basis.filter((r) => r.qa !== undefined);
  const media: EvalReport["media"] = {};
  for (const medium of EVAL_MEDIA) {
    const of = trusted
      .filter((r) => r.medium === medium)
      .map((r) => ({ score: r.score!.score!, same: r.same, kind: r.kind, cast: r.cast }));
    if (of.length === 0) continue;
    media[medium] = {
      provisional: medium === "3d",
      configured: breakdown(of, settings.threshold),
      ...(recommended && { recommended: breakdown(of, recommended.threshold) }),
    };
  }
  const auc = rocAuc(points);
  return {
    cases: cases.length,
    scored: scored.length,
    failed: results.length - scored.length,
    model: options.routes[operation]!.model,
    question: settings.question,
    spentUsd: budget.spentUsd,
    sweep: rows,
    ...(recommended && { recommended }),
    configured: at(settings.threshold),
    ...(auc !== undefined && { auc }),
    ...(withQa.length > 0 && {
      qaAgreement: agreement(
        withQa.map((r) => ({ qa: r.qa as boolean, identity: r.score!.score! >= cut })),
      ),
    }),
    ...(basis.length > 0 && {
      labelAgreement: agreement(
        basis.map((r) => ({ qa: r.same, identity: r.score!.score! >= cut })),
      ),
    }),
    media,
    ...(untrustedCases.length > 0 && {
      untrusted: group(
        untrustedCases.filter((r) => r.same).map((r) => ({ score: r.score!.score! })),
        untrustedCases.filter((r) => !r.same).map((r) => ({ score: r.score!.score! })),
        settings.threshold,
      ),
    }),
    recordChecks: [...checks.values()],
    results,
  };
}
