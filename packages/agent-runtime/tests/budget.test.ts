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

test("continuation shares prior attempt budgets while reporting only this attempt's usage", () => {
  const prior = {
    modelCalls: 1, toolCalls: 1, inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 30, estimatedCostUsd: 0.00003, pricingVersion: pricing.version,
  };
  const ledger = new BudgetLedger({ ...budget, maxModelCalls: 2, maxToolCalls: 2, maxTokens: 100 }, pricing, prior);
  assert.equal(ledger.remainingTokens(), 70);
  assert.deepEqual(ledger.snapshot(), {
    modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 0, estimatedCostUsd: 0, pricingVersion: pricing.version,
  });
  assert.equal(ledger.modelCall(), undefined);
  assert.equal(ledger.modelCall(), "call_limit");
  ledger.record({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0 });
  assert.equal(ledger.snapshot().totalTokens, 10);
  assert.equal(ledger.usageComplete, true);
});

test("continuation stops before a model call when prior usage or pricing is not trusted", () => {
  const prior = {
    modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 0, estimatedCostUsd: 0, pricingVersion: pricing.version,
  };
  const unknown = new BudgetLedger(budget, pricing, prior, false);
  assert.equal(unknown.modelCall(), "cost_limit");
  assert.throws(() => new BudgetLedger(budget, pricing, { ...prior, pricingVersion: "other" }), /pricing version/u);
});
