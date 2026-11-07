/** Typed failures the CLI maps to exit codes: InputError is 2, ProviderError is 4. */

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
