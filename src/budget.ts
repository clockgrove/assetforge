import { InputError } from "./errors.ts";
import type { SpendLedger } from "./spend.ts";

/**
 * Bounded spend: every provider call reserves against the run's cap first and is refused if it
 * would exceed it. With a spend ledger, the call is also reserved against the cross-run limits
 * (src/spend.ts) and refused when it would cross one.
 */

export class BudgetExceededError extends Error {
  readonly capUsd: number;
  readonly requestedUsd: number;
  constructor(capUsd: number, committedUsd: number, requestedUsd: number, what: string) {
    super(
      `refused: ${what} needs $${requestedUsd.toFixed(4)} but only $${(capUsd - committedUsd).toFixed(4)} of the $${capUsd.toFixed(2)} cap remains`,
    );
    this.name = "BudgetExceededError";
    this.capUsd = capUsd;
    this.requestedUsd = requestedUsd;
  }
}

export interface Reservation {
  readonly amountUsd: number;
  settled: boolean;
  /** The reservation's id in the spend ledger, when the budget has one. */
  readonly ledgerId?: string;
}

export class Budget {
  readonly capUsd: number;
  readonly ledger: SpendLedger | undefined;
  private spent = 0;
  private reserved = 0;

  constructor(capUsd: number, ledger?: SpendLedger) {
    if (!(capUsd >= 0)) throw new InputError(`invalid cost cap: ${capUsd}`);
    this.capUsd = capUsd;
    this.ledger = ledger;
  }

  get spentUsd(): number {
    return this.spent;
  }

  get reservedUsd(): number {
    return this.reserved;
  }

  /**
   * The run-level check before any call: throws `BudgetExceededError` when the whole forecast does
   * not fit the cap beside what is spent and reserved, or would cross a ledger limit. Records nothing.
   */
  check(amountUsd: number, what: string): void {
    this.fitCap(amountUsd, what);
    this.ledger?.check(amountUsd, what);
  }

  /**
   * Throws `BudgetExceededError` when the amount does not fit beside what is spent and reserved,
   * or would cross a ledger limit. Only a paid call names its `route`, and only a call with a
   * route is reserved in the ledger; a scripted call reserves against the run's cap alone.
   */
  reserve(amountUsd: number, what = "the call", route?: string): Reservation {
    this.fitCap(amountUsd, what);
    const ledgerId = route === undefined ? undefined : this.ledger?.reserve(amountUsd, what, route);
    this.reserved += amountUsd;
    return { amountUsd, settled: false, ...(ledgerId !== undefined && { ledgerId }) };
  }

  /** Releases the reservation and records what was actually spent. */
  settle(reservation: Reservation, actualUsd: number): void {
    if (reservation.settled) throw new Error("reservation already settled");
    reservation.settled = true;
    this.reserved -= reservation.amountUsd;
    this.spent += actualUsd;
    if (reservation.ledgerId !== undefined) this.ledger?.settle(reservation.ledgerId, actualUsd);
  }

  /** Counts spend made before this run, already in any ledger, against the run's cap. */
  addPrior(amountUsd: number, what: string): void {
    this.fitCap(amountUsd, what);
    this.spent += amountUsd;
  }

  private fitCap(amountUsd: number, what: string): void {
    const committed = this.spent + this.reserved;
    // The epsilon absorbs floating-point sums of cent values.
    if (committed + amountUsd > this.capUsd + 1e-9) {
      throw new BudgetExceededError(this.capUsd, committed, amountUsd, what);
    }
  }
}
