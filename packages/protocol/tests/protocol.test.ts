import assert from "node:assert/strict";
import test from "node:test";
import { BudgetSchema, RunInputSchema, parse, parseArtifacts, parseEvent, parseEvidence, parseResult } from "../src/index.js";

const usage = { modelCalls: 1, toolCalls: 0, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5, estimatedCostUsd: 0, pricingVersion: "offline" };
const result = { schemaVersion: 1, runId: "run-1", attemptId: "attempt-1", usage, endedAt: "2026-09-22T00:00:00.000Z", status: "completed", artifacts: [{ kind: "report.json", path: "reports/report.json", sha256: "a".repeat(64) }] };
const event = { schemaVersion: 1, eventId: "event-1", runId: "run-1", attemptId: "attempt-1", sequence: 1, timestamp: result.endedAt, type: "run.finished", data: result };

test("completed results require typed artifacts and consistent usage", () => {
  assert.equal(parseResult(result).status, "completed");
  for (const bad of [
    { ...result, schemaVersion: 2 }, { ...result, artifacts: [] },
    { ...result, unexpected: true }, { ...result, endedAt: "2026-99-22T00:00:00.000Z" },
    { ...result, endedAt: "2026-02-30T00:00:00.000Z" },
    { ...result, usage: { ...usage, totalTokens: 4 } },
    { ...result, usage: { ...usage, estimatedCostUsd: Infinity } },
    { ...result, artifacts: [...result.artifacts, ...result.artifacts] },
  ]) assert.throws(() => parseResult(bad));
});

test("event payload, result identity and sequence are validated", () => {
  assert.equal(parseEvent(event).type, "run.finished");
  for (const bad of [
    { ...event, runId: "other" }, { ...event, attemptId: "other" },
    { ...event, sequence: 0 }, { ...event, data: {} },
    { ...event, type: "text.delta" },
    { ...event, type: "tool.finished", data: { toolCallId: "tool-1", toolName: "read", isError: true, summary: { anything: 1 } } },
  ]) assert.throws(() => parseEvent(bad));
});

test("cancelled and failed are distinct unions", () => {
  const { artifacts: _, ...base } = result;
  assert.equal(parseResult({ ...base, status: "cancelled", reason: "user" }).status, "cancelled");
  assert.equal(parseResult({ ...base, status: "failed", error: { code: "model_error", message: "failed" } }).status, "failed");
  assert.throws(() => parseResult({ ...base, status: "cancelled", error: { code: "model_error", message: "failed" } }));
  assert.throws(() => parseResult({ ...base, status: "cancelled", reason: "anything" }));
});

test("paths and evidence ranges reject malformed references", () => {
  const evidence = { id: "e-1", path: "src/index.ts", sha: "a".repeat(40), startLine: 1, endLine: 3, excerpt: "synthetic content" };
  assert.equal(parseEvidence(evidence).endLine, 3);
  assert.throws(() => parseEvidence({ ...evidence, startLine: 4 }));
  for (const path of ["../secret", "/etc/passwd", "a/../b", "a\\b", "a\u0000b", "./a", "C:/secret"]) {
    assert.throws(() => parseEvidence({ ...evidence, path }), path);
    assert.throws(() => parseArtifacts([{ ...result.artifacts[0], path }]), path);
  }
});

test("inputs require immutable SHA and numeric bounded budgets without coercion", () => {
  const input = { repository: { url: "https://github.com/example/fixture", sha: "a".repeat(40) }, goal: "Analyze" };
  assert.deepEqual(parse(RunInputSchema, input), input);
  assert.throws(() => parse(RunInputSchema, { ...input, repository: { ...input.repository, sha: "main" } }));
  const budget = { timeoutMs: 1000, maxModelCalls: 8, maxToolCalls: 20, maxTokens: 32000, maxOutputTokens: 2000, maxCostUsd: 0.2 };
  assert.deepEqual(parse(BudgetSchema, budget), budget);
  for (const bad of [{ ...budget, timeoutMs: "1000" }, { ...budget, maxTokens: -1 }, { ...budget, maxCostUsd: NaN }]) assert.throws(() => parse(BudgetSchema, bad));
});
