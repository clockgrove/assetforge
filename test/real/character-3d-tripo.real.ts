/**
 * Opt-in check of the Tripo credentials. Set TRIPO_API_KEY. It only reads the account balance, so
 * it spends nothing. Without a key it skips. Run with `pnpm test:real`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TripoProvider } from "../../src/gateway/tripo.ts";

const skip = process.env["TRIPO_API_KEY"] ? false : "TRIPO_API_KEY not set";

test("tripo accepts the key and reports a balance", { skip }, async () => {
  const balance = await TripoProvider.fromEnv().balance();
  assert.equal(typeof balance, "number");
});
