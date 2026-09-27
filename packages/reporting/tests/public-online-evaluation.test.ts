import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { buildPublicAnalysisGoal, PUBLIC_ANALYSIS_PROMPT_VERSION } from "../src/public-runner.js";
import {
  createPublicEvaluationAnnotationsTemplate,
  DEEPSEEK_CNY_PRICING,
  DEEPSEEK_PRICING,
  DEEPSEEK_PRICE_LIST_CNY_PER_USD,
  estimateDeepSeekCostCny,
  formatPublicEvaluationCliSummary,
  loadPublicFacts,
  parsePublicEvaluationArguments,
  PUBLIC_EVAL_BUDGET_LIMITS,
  scorePublicEvaluationDirectory,
  type PublicEvaluationRunRecord,
} from "../src/public-online-evaluation.js";

const promptVersion = "public-repository-analysis-v2";

test("online analysis prompt targets benchmark questions without leaking the answer key", async () => {
  const facts = await loadPublicFacts();
  const goal = buildPublicAnalysisGoal(facts.facts);
  const encodedQuestions = goal.split("\n").at(-1);

  assert.equal(PUBLIC_ANALYSIS_PROMPT_VERSION, promptVersion);
  assert.match(goal, /Answer only the following benchmark questions/u);
  assert.match(goal, /Do not provide a general architecture survey/u);
  assert.match(goal, /stop when every question is answered or marked unknown/iu);
  assert.deepEqual(JSON.parse(encodedQuestions!), facts.facts.map(({ id, question }) => ({ id, question })));
  for (const fact of facts.facts) {
    assert.equal(goal.includes(fact.expectedAnswer), false, `answer key leaked for ${fact.id}`);
    assert.equal(goal.includes(JSON.stringify(fact.expectedEvidence)), false, `expected evidence leaked for ${fact.id}`);
  }
});

test("online evaluation requires explicit opt-in and a cost ceiling", () => {
  assert.deepEqual(parsePublicEvaluationArguments([]), { mode: "help" });
  assert.deepEqual(parsePublicEvaluationArguments(["--help"]), { mode: "help" });
  assert.throws(() => parsePublicEvaluationArguments(["--max-cost-cny", "1"]), /--online/u);
  assert.throws(() => parsePublicEvaluationArguments(["--online"]), /max-cost-cny/u);
  assert.throws(() => parsePublicEvaluationArguments(["--online", "--max-cost-cny", "1.34"]), /no greater/u);
  assert.deepEqual(parsePublicEvaluationArguments(["--online", "--max-cost-cny", "1.33"]), {
    mode: "online", maxCostCny: 1.33, maxCostUsd: 0.1995,
  });
  assert.deepEqual(parsePublicEvaluationArguments(["--score", "/tmp/public-eval"]), { mode: "score", runDirectory: "/tmp/public-eval" });
});

test("the locked PI SDK exposes the selected DeepSeek model without a custom provider", () => {
  const provider = deepseekProvider();
  const model = provider.getModels().find((candidate) => candidate.id === "deepseek-flash");
  assert.ok(model);
  assert.equal(provider.id, "deepseek");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "https://api.deepseek.com");
  assert.deepEqual(model.cost, { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
});

test("estimates current DeepSeek peak prices in CNY per million tokens", () => {
  assert.deepEqual(DEEPSEEK_CNY_PRICING, {
    version: "deepseek-flash-peak-cny-2026-09-27", currency: "CNY", input: 2, output: 8,
    cacheRead: 0.04, cacheWrite: 0, sourceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
  });
  assert.equal(DEEPSEEK_PRICE_LIST_CNY_PER_USD, 20 / 3);
  assert.equal(estimateDeepSeekCostCny({ inputTokens: 20_733, outputTokens: 988, cacheReadTokens: 28_288, cacheWriteTokens: 0 }), 0.05050152);
});

test("online evaluation budget covers observed token use while retaining bounded calls and time", () => {
  assert.deepEqual(PUBLIC_EVAL_BUDGET_LIMITS, {
    timeoutMs: 180_000,
    maxModelCalls: 12,
    maxToolCalls: 24,
    maxTokens: 200_000,
    maxOutputTokens: 2_000,
  });
});

test("formats a cancelled run summary using safe metadata and includes tool usage", () => {
  const summary = JSON.parse(formatPublicEvaluationCliSummary({
    status: "cancelled",
    provider: "deepseek",
    model: "deepseek-flash",
    snapshotSha: "a".repeat(40),
    runId: "run-123",
    modelCalls: 9,
    toolCalls: 15,
    totalTokens: 100_247,
    estimatedCostCny: 0.0537868,
    pricingVersion: DEEPSEEK_CNY_PRICING.version,
    directory: "/tmp/public-eval/run-123",
    cancelReason: "token_limit",
  }));
  assert.equal(summary.status, "cancelled");
  assert.equal(summary.modelCalls, 9);
  assert.equal(summary.toolCalls, 15);
  assert.equal(summary.totalTokens, 100_247);
  assert.equal(summary.estimatedCostCny, 0.0537868);
  assert.equal(summary.cancelReason, "token_limit");
  assert.equal("prompt" in summary, false);
  assert.equal("apiKey" in summary, false);
});

async function createScorableRun(directory: string, complete = true, recordedPromptVersion = promptVersion): Promise<void> {
  const facts = await loadPublicFacts();
  const selectedFacts = facts.facts.slice(0, 4);
  const evidence = selectedFacts.map((fact, index) => ({
    id: `e-${index + 1}`,
    snapshotId: facts.repository.sha,
    path: fact.expectedEvidence![0]!.path,
    fileSha256: "a".repeat(64),
    startLine: fact.expectedEvidence![0]!.startLine,
    endLine: fact.expectedEvidence![0]!.endLine,
    excerpt: `Evidence ${index + 1}`,
  }));
  const report = {
    schemaVersion: 1 as const,
    runId: "online-run-1",
    attemptId: "online-attempt-1",
    snapshotId: facts.repository.sha,
    title: "Slugify analysis",
    limitations: ["Read-only analysis; no target code was executed."],
    evidence,
    claims: [
      ...selectedFacts.map((fact, index) => ({
        id: `claim-${index + 1}`,
        kind: "fact" as const,
        text: fact.expectedAnswer,
        evidenceIds: [`e-${index + 1}`],
      })),
      { id: "unknown-1", kind: "unknown" as const, text: "A detail could not be established.", reason: "No relevant source was found.", evidenceIds: [] },
    ],
  };
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const reportSha256 = createHash("sha256").update(reportText).digest("hex");
  const record: PublicEvaluationRunRecord = {
    schemaVersion: 2,
    status: "completed",
    createdAt: new Date().toISOString(),
    repository: facts.repository,
    provider: "deepseek",
    model: {
      id: "deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      officialVersionAsOf: "DeepSeek-V4.1-Flash",
    },
    promptVersion: recordedPromptVersion,
    runId: report.runId,
    attemptId: report.attemptId,
    pricing: DEEPSEEK_PRICING,
    pricingCny: DEEPSEEK_CNY_PRICING,
    priceListCnyPerUsd: DEEPSEEK_PRICE_LIST_CNY_PER_USD,
    maxCostCny: 1.33,
    budget: { ...PUBLIC_EVAL_BUDGET_LIMITS, maxCostUsd: 0.1995 },
    usage: {
      modelCalls: 4, toolCalls: 4, inputTokens: 120, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 170, estimatedCostUsd: 0.000096, pricingVersion: DEEPSEEK_PRICING.version,
    },
    reportSha256,
    validatedEvidenceIds: evidence.map((item) => item.id),
  };
  const template = createPublicEvaluationAnnotationsTemplate(report.runId, reportSha256, report, facts.facts);
  const annotations = complete ? {
    ...template,
    claimFactMap: Object.fromEntries(selectedFacts.map((fact, index) => [`claim-${index + 1}`, [fact.id]])),
    reviewedAssertionClaimIds: selectedFacts.map((_fact, index) => `claim-${index + 1}`),
    supportedAssertionClaimIds: selectedFacts.map((_fact, index) => `claim-${index + 1}`),
    unsupportedAssertionClaimIds: [],
    reviewedUnknownClaimIds: ["unknown-1"],
    correctlyAbstainedClaimIds: ["unknown-1"],
    incorrectlyAbstainedClaimIds: [],
  } : template;
  await writeFile(path.join(directory, "report.json"), reportText);
  await writeFile(path.join(directory, "evaluation-run.json"), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(path.join(directory, "annotations.json"), `${JSON.stringify(annotations, null, 2)}\n`);
}

test("scores human-reviewed claims, evidence coverage, and correct abstention separately", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-public-online-eval-"));
  try {
    await createScorableRun(directory);
    const score = await scorePublicEvaluationDirectory(directory);
    assert.equal(score.qualityGate, "passed");
    assert.deepEqual(score.metrics.factRecall, { recovered: 4, applicable: 5, rate: 0.8 });
    assert.deepEqual(score.metrics.citationValidity, { validUses: 4, totalUses: 4, rate: 1 });
    assert.equal(score.abstentionQuality.correct, 1);
    assert.equal(score.abstentionQuality.totalUnknown, 1);
    assert.equal(score.abstentionQuality.rate, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("continues to score completed v1 records after the prompt version bump", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-public-online-eval-v1-"));
  try {
    await createScorableRun(directory, true, "public-repository-analysis-v1");
    const score = await scorePublicEvaluationDirectory(directory);
    assert.equal(score.qualityGate, "passed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("leaves incomplete human annotation clearly incomplete instead of passing it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-public-online-eval-incomplete-"));
  try {
    await createScorableRun(directory, false);
    const score = await scorePublicEvaluationDirectory(directory);
    assert.equal(score.qualityGate, "incomplete");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to score a report changed after the run record was created", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-public-online-eval-tamper-"));
  try {
    await createScorableRun(directory);
    await writeFile(path.join(directory, "report.json"), (await readFile(path.join(directory, "report.json"), "utf8")) + " ");
    await assert.rejects(scorePublicEvaluationDirectory(directory), /Report changed/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
