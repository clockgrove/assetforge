/**
 * The exit and error-code table (design section 5): every refusal names one error code, and each
 * code maps to one exit. InputError and ProviderError are the typed failures most code throws.
 */

/** Each exit code with what it means. Exit 0 is success and has no error code. */
export const EXIT_MEANING = {
  0: "success",
  1: "internal error",
  2: "invalid input",
  3: "spend refused",
  4: "provider error",
  5: "QA found nothing",
  6: "written output rejected",
  7: "licence refused",
  8: "a person must confirm",
  9: "prompt refused",
} as const;

/** Every error code and its exit. */
export const EXIT = {
  internal_error: 1,
  invalid_input: 2,
  settings_invalid: 2,
  key_tracked: 2,
  format_unsupported: 2,
  extension_unavailable: 2,
  extension_refused: 2,
  extension_conflict: 2,
  route_unavailable: 2,
  plan_changed: 2,
  run_in_progress: 2,
  command_refused: 2,
  cap_refused: 3,
  provider_limit_undeclared: 3,
  provider_limit_mismatch: 3,
  spend_hold: 3,
  provider_error: 4,
  qa_found_nothing: 5,
  validator_rejected: 6,
  handoff_check_failed: 6,
  license_refused: 7,
  confirmation_required: 8,
  confirmation_declined: 8,
  prompt_refused: 9,
} as const satisfies Record<string, Exclude<keyof typeof EXIT_MEANING, 0>>;

export type ErrorCode = keyof typeof EXIT;

/** The caller's input is unusable: a bad spec, file, option or state. Nothing was spent. */
export class InputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InputError";
  }
}

/** A model provider call failed or returned nothing usable. */
export class ProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderError";
  }
}
