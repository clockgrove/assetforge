import { InputError } from "./errors.ts";

/** Bounded spend: every provider call reserves against the cap first and is refused if it would exceed it. */

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
}

export class Budget {
  readonly capUsd: number;
  private spent = 0;
  private reserved = 0;

  constructor(capUsd: number) {
    if (!(capUsd >= 0)) throw new InputError(`invalid cost cap: ${capUsd}`);
    this.capUsd = capUsd;
  }

  get spentUsd(): number {
    return this.spent;
  }

  get reservedUsd(): number {
    return this.reserved;
  }

  /** Throws `BudgetExceededError` when the amount does not fit beside what is spent and reserved. */
  reserve(amountUsd: number, what = "the call"): Reservation {
    const committed = this.spent + this.reserved;
    // The epsilon absorbs floating-point sums of cent values.
    if (committed + amountUsd > this.capUsd + 1e-9) {
      throw new BudgetExceededError(this.capUsd, committed, amountUsd, what);
    }
    this.reserved += amountUsd;
    return { amountUsd, settled: false };
  }

  /** Releases the reservation and records what was actually spent. */
  settle(reservation: Reservation, actualUsd: number): void {
    if (reservation.settled) throw new Error("reservation already settled");
    reservation.settled = true;
    this.reserved -= reservation.amountUsd;
    this.spent += actualUsd;
  }
}
