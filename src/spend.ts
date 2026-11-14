import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BudgetExceededError } from "./budget.ts";
import { InputError } from "./errors.ts";
import type { TargetProfile } from "./types.ts";

/**
 * Provider spend across runs (assetgrove#74). A run's `Budget` caps that run alone; this ledger
 * caps what every run on this machine (or in this CI job) spends together: a daily limit over the
 * last 24 hours, and a limit per work item (an Objective, a campaign or a session label).
 *
 * The ledger is an append-only JSON Lines file. Every paid call appends a reservation of its
 * estimate before it is made and a settlement with its actual cost after. A reservation is checked
 * against the entries before it in the file, so concurrent runs are ordered by their appends and
 * can never both fit into the same remaining spend; a reservation that does not fit is cancelled
 * (settled at 0) and the call is refused. A reservation never settled (a crashed run) keeps its
 * estimate, as a failed call does in `Budget`. Scripted calls cost nothing and are never recorded
 * (`isPaidProvider`).
 */

export const DEFAULT_DAILY_LIMIT_USD = 10;
export const DEFAULT_WORK_ITEM_LIMIT_USD = 5;

/** The provider name whose calls cost no money: the scripted provider of tests and offline runs. */
export const UNPAID_PROVIDER = "scripted";

/**
 * Whether a provider's calls are real spend, decided on its name alone. Every name but the
 * scripted provider's is paid, and an unknown provider (undefined) counts as paid.
 */
export function isPaidProvider(providerName: string | undefined): boolean {
  return providerName !== UNPAID_PROVIDER;
}

/**
 * The ledger a run with this provider reserves against, with the profile's limits: none for the
 * scripted provider, whose runs keep only their own cap.
 */
export function ledgerFor(
  ledger: SpendLedger | undefined,
  providerName: string | undefined,
  profile?: Pick<TargetProfile, "spend">,
): SpendLedger | undefined {
  return isPaidProvider(providerName) ? ledger?.forProfile(profile) : undefined;
}
const DAY_MS = 24 * 60 * 60 * 1000;
const EPSILON = 1e-9;

export const SPEND_ENV = {
  ledger: "ASSETGROVE_SPEND_LEDGER",
  workItem: "ASSETGROVE_WORK_ITEM",
  dailyLimit: "ASSETGROVE_DAILY_LIMIT_USD",
  workItemLimit: "ASSETGROVE_WORK_ITEM_LIMIT_USD",
  /** Set by Factory in a worker's environment on every route: the Objective's issue number. */
  factoryIssue: "FACTORY_ISSUE",
} as const;

/**
 * The work item when none is named: a Factory worker's Objective, from `FACTORY_ISSUE` (digits
 * only), as `<GITHUB_REPOSITORY>#<n>` on Actions or `factory#<n>` elsewhere. Two repositories'
 * Objectives with the same number on one machine then share a limit, which only makes it stricter.
 */
export function factoryWorkItem(env: NodeJS.ProcessEnv): string | undefined {
  const issue = env[SPEND_ENV.factoryIssue]?.trim();
  if (!issue || !/^[0-9]+$/.test(issue)) return undefined;
  const repo = env["GITHUB_REPOSITORY"]?.trim();
  return `${repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : "factory"}#${issue}`;
}

export type SpendLimitName = "daily" | "work-item";
export type LimitSource = "environment" | "profile" | "default";

export interface SpendLimitStatus {
  limit: SpendLimitName;
  /** The work item the limit counts, for the work-item limit. */
  workItem?: string;
  limitUsd: number;
  source: LimitSource;
  spentUsd: number;
  remainingUsd: number;
}

export interface SpendStatus {
  ledger: string;
  /** Null when no work item is named: only the daily limit applies then. */
  workItem: string | null;
  limits: SpendLimitStatus[];
}

/** A call or run refused because it would cross a cross-run limit. Exit 3, like the run's cap. */
export class SpendLimitError extends BudgetExceededError {
  readonly limit: SpendLimitName;
  readonly workItem: string | undefined;
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly ledger: string;
  constructor(status: SpendLimitStatus, requestedUsd: number, what: string, ledger: string) {
    super(status.limitUsd, status.spentUsd, requestedUsd, what);
    this.name = "SpendLimitError";
    this.limit = status.limit;
    this.workItem = status.workItem;
    this.limitUsd = status.limitUsd;
    this.spentUsd = status.spentUsd;
    this.ledger = ledger;
    this.message =
      `refused: ${what} needs $${requestedUsd.toFixed(4)} but the ${limitLabel(status)} has ` +
      `$${status.spentUsd.toFixed(4)} spent and $${status.remainingUsd.toFixed(4)} left ` +
      `(spend ledger ${ledger})`;
  }
}

export function limitLabel(status: SpendLimitStatus): string {
  return status.limit === "daily"
    ? `$${status.limitUsd.toFixed(2)} daily limit (last 24 hours)`
    : `$${status.limitUsd.toFixed(2)} work-item limit for "${status.workItem}"`;
}

type Entry =
  | { op: "reserve"; id: string; at: string; route: string; workItem?: string; amountUsd: number }
  | { op: "settle"; id: string; at: string; costUsd: number };

/** A limit as each source sets it; the strictest one set applies, the default when none is. */
interface LimitSetting {
  environment?: number;
  profile?: number;
  fallback: number;
}

interface LedgerOptions {
  path: string;
  workItem?: string;
  daily: LimitSetting;
  workItemLimit: LimitSetting;
  now?: () => Date;
}

export class SpendLedger {
  readonly path: string;
  readonly workItem: string | undefined;
  private readonly options: LedgerOptions;
  private readonly now: () => Date;

  constructor(options: LedgerOptions) {
    this.options = options;
    this.path = options.path;
    this.workItem = options.workItem;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The ledger and limits from the environment: `ASSETGROVE_SPEND_LEDGER` (default
   * `$XDG_STATE_HOME/assetgrove/spend.jsonl`, or `~/.local/state/...`; in a Factory worker, where
   * `FACTORY_ISSUE` is set, `assetgrove-spend.jsonl` in `$FACTORY_STATE_DIR`, else `$TMPDIR`),
   * `ASSETGROVE_WORK_ITEM`
   * (or `workItem`, from `--work-item`; else a Factory worker's Objective from `FACTORY_ISSUE`),
   * `ASSETGROVE_DAILY_LIMIT_USD` and
   * `ASSETGROVE_WORK_ITEM_LIMIT_USD`.
   */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    options: { workItem?: string; now?: () => Date } = {},
  ): SpendLedger {
    const configured = env[SPEND_ENV.ledger]?.trim();
    const stateHome = env["XDG_STATE_HOME"]?.trim();
    // Factory's stage-persistent state directory when it gives one, else the stage's temp dir.
    const temp = env["FACTORY_STATE_DIR"]?.trim() || env["TMPDIR"]?.trim();
    const path = configured
      ? resolve(configured)
      : factoryWorkItem(env) !== undefined
        ? // A Factory worker's sandbox drops writes outside its stage's temp dir between commands,
          // so a ledger under the home directory would forget every reservation (assetgrove#108).
          join(temp && isAbsolute(temp) ? temp : tmpdir(), "assetgrove-spend.jsonl")
        : join(
            stateHome && isAbsolute(stateHome) ? stateHome : join(homedir(), ".local", "state"),
            "assetgrove",
            "spend.jsonl",
          );
    const workItem =
      (options.workItem ?? env[SPEND_ENV.workItem])?.trim() || factoryWorkItem(env) || undefined;
    const daily = envLimit(env, SPEND_ENV.dailyLimit);
    const item = envLimit(env, SPEND_ENV.workItemLimit);
    return new SpendLedger({
      path,
      ...(workItem !== undefined && { workItem }),
      daily: {
        ...(daily !== undefined && { environment: daily }),
        fallback: DEFAULT_DAILY_LIMIT_USD,
      },
      workItemLimit: {
        ...(item !== undefined && { environment: item }),
        fallback: DEFAULT_WORK_ITEM_LIMIT_USD,
      },
      ...(options.now !== undefined && { now: options.now }),
    });
  }

  /** This ledger with the target profile's `spend` limits added; the stricter of each pair wins. */
  forProfile(profile: Pick<TargetProfile, "spend"> | undefined): SpendLedger {
    const spend = profile?.spend;
    if (spend === undefined) return this;
    if (typeof spend !== "object" || spend === null || Array.isArray(spend))
      throw new InputError("profile spend must be an object");
    const daily = profileLimit(spend.dailyLimitUsd, "spend.dailyLimitUsd");
    const item = profileLimit(spend.workItemLimitUsd, "spend.workItemLimitUsd");
    return new SpendLedger({
      ...this.options,
      daily: withProfile(this.options.daily, daily),
      workItemLimit: withProfile(this.options.workItemLimit, item),
    });
  }

  /** Spend against each limit that applies, from the ledger as it is now. */
  status(): SpendStatus {
    const entries = this.read();
    return {
      ledger: this.path,
      workItem: this.workItem ?? null,
      limits: this.limits(entries, entries.length),
    };
  }

  /** Throws `SpendLimitError` when `amountUsd` more would cross a limit. Records nothing. */
  check(amountUsd: number, what: string): void {
    const entries = this.read();
    this.assertFits(this.limits(entries, entries.length), amountUsd, what);
  }

  /**
   * Records a reservation of `amountUsd` for a call on `route`, or throws `SpendLimitError` (with
   * the reservation cancelled) when it does not fit beside the reservations recorded before it.
   * Returns the reservation's ledger id, for `settle`.
   */
  reserve(amountUsd: number, what: string, route: string): string {
    const id = randomUUID();
    this.append({
      op: "reserve",
      id,
      at: this.now().toISOString(),
      route,
      ...(this.workItem !== undefined && { workItem: this.workItem }),
      amountUsd,
    });
    const entries = this.read();
    const index = entries.findIndex((e) => e.op === "reserve" && e.id === id);
    try {
      if (index < 0) throw new Error(`spend ledger ${this.path} lost a reservation`);
      this.assertFits(this.limits(entries, index), amountUsd, what);
    } catch (error) {
      this.settle(id, 0);
      throw error;
    }
    return id;
  }

  /** Records what a reserved call actually cost. */
  settle(id: string, costUsd: number): void {
    this.append({ op: "settle", id, at: this.now().toISOString(), costUsd });
  }

  private assertFits(limits: SpendLimitStatus[], amountUsd: number, what: string): void {
    // Nothing to spend is never refused, even when actual costs have run past a limit.
    if (amountUsd <= 0) return;
    for (const limit of limits) {
      if (limit.spentUsd + amountUsd > limit.limitUsd + EPSILON)
        throw new SpendLimitError(limit, amountUsd, what, this.path);
    }
  }

  /** Each applicable limit, counting the reservations among the first `before` entries. */
  private limits(entries: Entry[], before: number): SpendLimitStatus[] {
    const settled = new Map<string, number>();
    for (const e of entries) if (e.op === "settle") settled.set(e.id, e.costUsd);
    const since = this.now().getTime() - DAY_MS;
    let daily = 0;
    let item = 0;
    for (const e of entries.slice(0, before)) {
      if (e.op !== "reserve") continue;
      const cost = settled.get(e.id) ?? e.amountUsd;
      if (Date.parse(e.at) > since) daily += cost;
      if (this.workItem !== undefined && e.workItem === this.workItem) item += cost;
    }
    const status = (
      limit: SpendLimitName,
      setting: LimitSetting,
      spentUsd: number,
    ): SpendLimitStatus => {
      const { usd, source } = effective(setting);
      return {
        limit,
        ...(limit === "work-item" && { workItem: this.workItem }),
        limitUsd: usd,
        source,
        spentUsd,
        remainingUsd: Math.max(0, usd - spentUsd),
      };
    };
    return [
      status("daily", this.options.daily, daily),
      ...(this.workItem !== undefined
        ? [status("work-item", this.options.workItemLimit, item)]
        : []),
    ];
  }

  private read(): Entry[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new InputError(`cannot read spend ledger ${this.path}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    const entries: Entry[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue; // A line torn by a crash mid-write records nothing usable.
      }
      if (isEntry(value)) entries.push(value);
    }
    return entries;
  }

  /** One `appendFileSync` is one O_APPEND write, so concurrent appends never interleave. */
  private append(entry: Entry): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (error) {
      throw new InputError(`cannot write spend ledger ${this.path}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  if (typeof e["id"] !== "string" || typeof e["at"] !== "string") return false;
  if (e["op"] === "reserve")
    return (
      typeof e["route"] === "string" &&
      typeof e["amountUsd"] === "number" &&
      Number.isFinite(e["amountUsd"]) &&
      (e["workItem"] === undefined || typeof e["workItem"] === "string")
    );
  return e["op"] === "settle" && typeof e["costUsd"] === "number" && Number.isFinite(e["costUsd"]);
}

function effective(setting: LimitSetting): { usd: number; source: LimitSource } {
  const { environment, profile } = setting;
  if (environment !== undefined && (profile === undefined || environment <= profile))
    return { usd: environment, source: "environment" };
  if (profile !== undefined) return { usd: profile, source: "profile" };
  return { usd: setting.fallback, source: "default" };
}

function withProfile(setting: LimitSetting, value: number | undefined): LimitSetting {
  if (value === undefined) return setting;
  const profile = setting.profile === undefined ? value : Math.min(setting.profile, value);
  return { ...setting, profile };
}

function envLimit(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0)
    throw new InputError(`${name} must be a non-negative number of USD, got "${raw}"`);
  return n;
}

function profileLimit(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new InputError(`profile ${field} must be a non-negative number of USD`);
  return value;
}
