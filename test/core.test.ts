import assert from "node:assert/strict";
import { test } from "node:test";
import { Budget, BudgetExceededError } from "../src/budget.ts";
import { render, renderString } from "../src/template.ts";

test("the budget reserves against the cap and refuses what would exceed it", () => {
  const budget = new Budget(1);
  const a = budget.reserve(0.6);
  assert.throws(() => budget.reserve(0.5), BudgetExceededError);
  budget.settle(a, 0.2);
  assert.equal(budget.spentUsd, 0.2);
  assert.equal(budget.reservedUsd, 0);
  budget.settle(budget.reserve(0.8), 0.8);
  assert.throws(() => budget.reserve(0.01), /refused/);
  assert.throws(() => budget.settle(a, 0), /already settled/);
});

test("templates insert whole values, interpolate text, omit optional holes and refuse required ones", () => {
  const context = { spec: { id: "stevie", frames: { count: 6 } } };
  assert.deepEqual(
    render(
      {
        id: "{{spec.id}}",
        frames: "{{spec.frames}}",
        label: "x-{{spec.id}}",
        gone: "{{spec.none?}}",
        list: ["{{spec.none?}}", 1],
      },
      context,
    ),
    { id: "stevie", frames: { count: 6 }, label: "x-stevie", list: [1] },
  );
  assert.equal(renderString("a/{{spec.frames.count}}.png", context), "a/6.png");
  assert.throws(() => render({ x: "{{spec.none}}" }, context), /"spec.none" is undefined/);
});
