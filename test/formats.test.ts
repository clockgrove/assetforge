import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FormatError,
  formatLine,
  readFormat,
  registerMigration,
  unregisterMigration,
} from "../src/formats.ts";

function refusal(reason: string) {
  return (error: unknown) => {
    assert.ok(error instanceof FormatError, String(error));
    assert.equal(error.code, "format_unsupported");
    assert.equal(error.reason, reason);
    return true;
  };
}

test("a current format reads as is", () => {
  const result = readFormat("recipe", { format: "assetgrove-recipe/1", name: "x" }, "r.json");
  assert.equal(result.version, 1);
  assert.equal(result.migratedFrom, undefined);
  assert.equal(result.value["name"], "x");
  assert.equal(formatLine("recipe"), "assetgrove-recipe/1");
});

test("a missing format is refused with reason missing, naming the line to add", () => {
  assert.throws(() => readFormat("recipe", { name: "x" }, "r.json"), refusal("missing"));
  assert.throws(
    () => readFormat("recipe", { name: "x" }, "r.json"),
    /"format": "assetgrove-recipe\/1"/,
  );
  assert.throws(() => readFormat("recipe", "not an object", "r.json"), refusal("missing"));
});

test("a newer format is refused with reason too_new", () => {
  assert.throws(
    () => readFormat("target-profile", { format: "assetgrove-target-profile/2" }, "p.json"),
    refusal("too_new"),
  );
});

test("an unknown kind or a mismatched format is refused with reason unknown", () => {
  assert.throws(
    () => readFormat("nonsense", { format: "assetgrove-nonsense/1" }, "x"),
    refusal("unknown"),
  );
  assert.throws(
    () => readFormat("recipe", { format: "assetgrove-style-preset/1" }, "x"),
    refusal("unknown"),
  );
  assert.throws(() => readFormat("recipe", { format: "recipe v1" }, "x"), refusal("unknown"));
});

test("a registered 1-to-2 migration moves an older file forward and reports migratedFrom", (t) => {
  registerMigration("test-kind", 1, (value) => {
    const { oldName, ...rest } = value;
    return { ...rest, newName: oldName };
  });
  t.after(() => unregisterMigration("test-kind", 1));
  const result = readFormat(
    "test-kind",
    { format: "assetgrove-test-kind/1", oldName: "a" },
    "t",
    2,
  );
  assert.equal(result.migratedFrom, 1);
  assert.equal(result.version, 2);
  assert.deepEqual(result.value, { format: "assetgrove-test-kind/2", newName: "a" });
  // Without the step, the older version cannot be read.
  unregisterMigration("test-kind", 1);
  assert.throws(
    () => readFormat("test-kind", { format: "assetgrove-test-kind/1" }, "t", 2),
    refusal("unknown"),
  );
});
