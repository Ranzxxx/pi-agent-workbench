import assert from "node:assert/strict";
import test from "node:test";
import { BudgetLedger } from "../src/budget.js";

const budget = { timeoutMs: 1000, maxModelCalls: 1, maxToolCalls: 1, maxTokens: 100, maxOutputTokens: 10, maxCostUsd: 1 };
const pricing = { version: "test-per-million", input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };

test("call reservations stop additional operations, snapshots cannot mutate accounting", () => {
  const ledger = new BudgetLedger(budget, pricing);
  assert.equal(ledger.modelCall(), undefined);
  assert.equal(ledger.modelCall(), "call_limit");
  assert.equal(ledger.toolCall(), undefined);
  assert.equal(ledger.toolCall(), "tool_limit");
  ledger.snapshot().modelCalls = 99;
  assert.equal(ledger.snapshot().modelCalls, 1);
});

test("all token categories and versioned prices accumulate across attempts", () => {
  const ledger = new BudgetLedger(budget, pricing);
  ledger.record({ input: 10, output: 20, cacheRead: 5, cacheWrite: 5 });
  ledger.record({ input: 10, output: 20, cacheRead: 5, cacheWrite: 5 });
  assert.equal(ledger.snapshot().totalTokens, 80);
  assert.equal(ledger.snapshot().estimatedCostUsd, 170 / 1_000_000);
  ledger.record({ input: 20, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(ledger.modelCall(), "token_limit");
  assert.throws(() => ledger.record({ input: -1, output: 0, cacheRead: 0, cacheWrite: 0 }));
  assert.throws(() => ledger.record({ input: NaN, output: 0, cacheRead: 0, cacheWrite: 0 }));
});

test("cost is enforced before subsequent model and tool calls", () => {
  const ledger = new BudgetLedger({ ...budget, maxCostUsd: 0.00001 }, pricing);
  ledger.record({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(ledger.modelCall(), "cost_limit");
  assert.equal(ledger.toolCall(), "cost_limit");
});
