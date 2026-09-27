import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { InMemoryCredentialStore } from "@pi-workbench/agent-runtime";
import { runPublicRepositoryAnalysis, PUBLIC_ANALYSIS_PROMPT_VERSION } from "./public-runner.js";
import {
  createPublicEvaluationAnnotationsTemplate,
  DEEPSEEK_CNY_PRICING,
  DEEPSEEK_PRICING,
  DEEPSEEK_PRICE_LIST_CNY_PER_USD,
  loadPublicFacts,
  estimateDeepSeekCostCny,
  formatPublicEvaluationCliSummary,
  MAX_PUBLIC_EVAL_COST_CNY,
  PUBLIC_EVAL_BUDGET_LIMITS,
  parsePublicEvaluationArguments,
  scorePublicEvaluationDirectory,
  writePrivateJson,
  type PublicEvaluationRunRecord,
} from "./public-online-evaluation.js";

const defaultOutputRoot = path.join(os.tmpdir(), "pi-agent-workbench", "public-evaluation");

async function writeStdoutLine(line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => error ? reject(error) : resolve());
  });
}

async function ensurePrivateDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(absolute) !== absolute) {
    throw new Error("Evaluation output path must be a real local directory");
  }
  await chmod(absolute, 0o700);
  return absolute;
}

function usage(): string {
  return [
    "TASK-005 public repository evaluation (DeepSeek Flash only)",
    "",
    "  npm run eval:public --workspace @pi-workbench/reporting -- --help",
    "  DEEPSEEK_API_KEY must be set in the local shell before an online run.",
    "",
    "  Online run (makes paid API calls):",
    "  npm run eval:public --workspace @pi-workbench/reporting -- --online --max-cost-cny 1.33",
    "",
    "  Score a completed local run after editing its annotations.json:",
    "  npm run eval:public --workspace @pi-workbench/reporting -- --score <run-directory>",
    "",
    `The --online flag and an explicit per-run cost cap are required. The cap cannot exceed ¥${MAX_PUBLIC_EVAL_COST_CNY}.`,
    "The cap is converted using the matched DeepSeek peak-price lists (USD $0.30 input equals CNY ¥2 input per million tokens).",
    `Run limits: ${PUBLIC_EVAL_BUDGET_LIMITS.maxModelCalls} model calls, ${PUBLIC_EVAL_BUDGET_LIMITS.maxToolCalls} tool calls, ${PUBLIC_EVAL_BUDGET_LIMITS.maxTokens.toLocaleString("en-US")} cumulative tokens, ${PUBLIC_EVAL_BUDGET_LIMITS.maxOutputTokens.toLocaleString("en-US")} output tokens per call, ${PUBLIC_EVAL_BUDGET_LIMITS.timeoutMs / 1_000}s.`,
    "Token and cost limits are application-side stop thresholds based on usage returned after a response, not provider-side hard limits.",
    "A single in-flight request can exceed the token and cost thresholds; configure a low per-run cost cap and review the printed estimate.",
  ].join("\n");
}

async function runOnline(maxCostCny: number, maxCostUsd: number): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing. No network request was made.");

  const facts = await loadPublicFacts();
  const provider = deepseekProvider();
  const model = provider.getModels().find((candidate) => candidate.id === "deepseek-flash");
  if (!model || model.provider !== "deepseek" || model.api !== "openai-completions" || model.baseUrl !== "https://api.deepseek.com") {
    throw new Error("Installed PI SDK does not expose the expected DeepSeek Flash model configuration");
  }
  if (model.cost.input !== DEEPSEEK_PRICING.input || model.cost.output !== DEEPSEEK_PRICING.output ||
      model.cost.cacheRead !== DEEPSEEK_PRICING.cacheRead || model.cost.cacheWrite !== DEEPSEEK_PRICING.cacheWrite) {
    throw new Error("PI SDK DeepSeek Flash catalog pricing differs from the reviewed peak-price snapshot; update the pricing record before calling the API");
  }

  const root = await ensurePrivateDirectory(defaultOutputRoot);
  const cacheDirectory = await ensurePrivateDirectory(path.join(root, "cache"));
  const outputDirectory = await ensurePrivateDirectory(path.join(root, "runs"));
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(provider.id, async () => ({ type: "api_key", key: apiKey }));

  const budget = {
    ...PUBLIC_EVAL_BUDGET_LIMITS,
    maxCostUsd,
  };
  const result = await runPublicRepositoryAnalysis({
    repository: { url: facts.repository.url, ref: facts.repository.sha },
    // Pass questions only. The evaluator's expected answers and evidence stay local for scoring.
    questions: facts.facts.map(({ id, question }) => ({ id, question })),
    cacheDirectory,
    outputDirectory,
    credentials,
    provider,
    model,
    budget,
    pricing: DEEPSEEK_PRICING,
  });

  // Print the outcome as soon as the runner returns, before optional artifact
  // bookkeeping can fail and hide the status of a completed/cancelled run.
  await writeStdoutLine(formatPublicEvaluationCliSummary({
    status: result.status,
    provider: "deepseek",
    model: "deepseek-flash",
    snapshotSha: result.snapshot.sha,
    runId: result.result.runId,
    modelCalls: result.result.usage.modelCalls,
    toolCalls: result.result.usage.toolCalls,
    totalTokens: result.result.usage.totalTokens,
    estimatedCostCny: estimateDeepSeekCostCny(result.result.usage),
    pricingVersion: DEEPSEEK_CNY_PRICING.version,
    ...(result.directory ? { directory: result.directory } : {}),
    ...(result.result.status === "failed" ? { errorCode: result.result.error.code } : {}),
    ...(result.result.status === "cancelled" ? { cancelReason: result.result.reason } : {}),
  }));

  const directory = result.directory;
  if (directory) {
    const reportBytes = result.report ? await readFile(path.join(directory, "report.json")) : undefined;
    const record: PublicEvaluationRunRecord = {
      schemaVersion: 2,
      status: result.status,
      createdAt: new Date().toISOString(),
      repository: facts.repository,
      provider: "deepseek",
      model: {
        id: "deepseek-flash",
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        officialVersionAsOf: "DeepSeek-V4.1-Flash (official mapping verified 2026-09-27)",
      },
      promptVersion: PUBLIC_ANALYSIS_PROMPT_VERSION,
      runId: result.result.runId,
      attemptId: result.result.attemptId,
      pricing: DEEPSEEK_PRICING,
      pricingCny: DEEPSEEK_CNY_PRICING,
      priceListCnyPerUsd: DEEPSEEK_PRICE_LIST_CNY_PER_USD,
      maxCostCny,
      budget,
      usage: result.result.usage,
      ...(reportBytes ? { reportSha256: createHash("sha256").update(reportBytes).digest("hex") } : {}),
      validatedEvidenceIds: result.report?.evidence.map((item) => item.id) ?? [],
    };
    await writePrivateJson(directory, "evaluation-run.json", record);
    if (result.status === "completed" && result.report && record.reportSha256) {
      await writePrivateJson(directory, "annotations.json", createPublicEvaluationAnnotationsTemplate(result.result.runId, record.reportSha256, result.report, facts.facts));
    }
  }

  if (result.status === "completed" && directory) {
    console.log(`Review claims in ${path.join(directory, "annotations.json")}, then run --score ${directory}.`);
  } else {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = parsePublicEvaluationArguments(process.argv.slice(2));
  if (args.mode === "help") {
    console.log(usage());
    return;
  }
  if (args.mode === "score") {
    const score = await scorePublicEvaluationDirectory(args.runDirectory);
    await writePrivateJson(args.runDirectory, "evaluation-score.json", score, true);
    console.log(JSON.stringify(score, null, 2));
    if (score.qualityGate !== "passed") process.exitCode = 1;
    return;
  }
  await runOnline(args.maxCostCny, args.maxCostUsd);
}

main().catch((error: unknown) => {
  // Provider exceptions can contain request details; don't print raw errors or credentials.
  console.error(error instanceof Error && error.message.includes("DEEPSEEK_API_KEY") ? error.message : "Evaluation command failed; no raw provider response or credential was written to the console.");
  process.exitCode = 1;
});
