import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEnvironment, refusedVariables, SettingsError } from "../src/env.ts";

const refused = (error: unknown) => {
  assert.ok(error instanceof SettingsError, String(error));
  assert.equal(error.code, "settings_invalid");
  return true;
};

for (const name of [
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
]) {
  test(`checkEnvironment refuses ${name} unless environment.allow lists it`, () => {
    const env = { [name]: "1", PATH: "/usr/bin" };
    assert.throws(() => checkEnvironment([], env), refused);
    assert.throws(() => checkEnvironment([], env), new RegExp(name));
    assert.doesNotThrow(() => checkEnvironment([name.toUpperCase()], env));
  });
}

test("checkEnvironment passes a clean environment and ignores empty values", () => {
  assert.doesNotThrow(() => checkEnvironment([], { PATH: "/usr/bin", HTTPS_PROXY: "" }));
});

test("allowing one variable does not allow another", () => {
  const env = { HTTPS_PROXY: "http://proxy:3128", NODE_EXTRA_CA_CERTS: "/ca.pem" };
  assert.deepEqual(refusedVariables(["HTTPS_PROXY"], env), ["NODE_EXTRA_CA_CERTS"]);
  assert.throws(() => checkEnvironment(["HTTPS_PROXY"], env), refused);
});
