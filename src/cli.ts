#!/usr/bin/env node
import { EXIT } from "./errors.ts";
import { main } from "./cli/main.ts";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT.internal_error;
  },
);
