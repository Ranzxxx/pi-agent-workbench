import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BudgetSchema, parse, parseReport, PricingSchema, UsageSchema, type Budget, type Pricing, type Report, type Usage } from "@pi-workbench/protocol";
import { evaluateReport, type EvaluationMetrics, type GoldenFact, type SemanticAnnotations } from "./evaluation.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");
const factsFile = path.join(projectRoot, "evals/public-repository-facts.json");
const publicRepository = {
  url: "https://github.com/sindresorhus/slugify",
  ref: "v3.0.0",
  sha: "7c318bd1aa4b4affab29761f15a9604323fe2a3b",
} as const;

export const DEEPSEEK_PRICING: Pricing = {
  version: "deepseek-flash-peak-2026-09-27",
  input: 0.3,
  output: 1.2,
  cacheRead: 0.006,
  cacheWrite: 0,
};

/** Official DeepSeek Chinese peak prices, in CNY per million tokens. */
export const DEEPSEEK_CNY_PRICING = {
  version: "deepseek-flash-peak-cny-2026-09-27",
  currency: "CNY",
  input: 2,
  output: 8,
  cacheRead: 0.04,
  cacheWrite: 0,
  sourceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
} as const;

/** Ratio shared by DeepSeek's corresponding published peak USD and CNY prices. */
export const DEEPSEEK_PRICE_LIST_CNY_PER_USD = 20 / 3;
// Keep the previous $0.20 ceiling equivalent, rounded down to a CNY amount.
export const MAX_PUBLIC_EVAL_COST_CNY = 1.33;
const supportedPromptVersions = new Set([
  "public-repository-analysis-v1",
  "public-repository-analysis-v2",
]);

/**
 * Conservative defaults for the public online evaluation. Token and cost
 * limits are checked against provider usage after a response returns, so an
 * in-flight request can take a run past these thresholds.
 */
export const PUBLIC_EVAL_BUDGET_LIMITS = {
  timeoutMs: 180_000,
  maxModelCalls: 12,
  maxToolCalls: 24,
  maxTokens: 200_000,
  maxOutputTokens: 2_000,
} as const;

export interface PublicEvaluationCliSummary {
  status: "completed" | "failed" | "cancelled";
  provider: "deepseek";
  model: "deepseek-flash";
  snapshotSha: string;
  runId: string;
  modelCalls: number;
  toolCalls: number;
  totalTokens: number;
  estimatedCostCny: number;
  pricingVersion: string;
  directory?: string;
  errorCode?: string;
  cancelReason?: string;
}

/** Format only safe run metadata; never include prompts, model text, or credentials. */
export function formatPublicEvaluationCliSummary(summary: PublicEvaluationCliSummary): string {
  return JSON.stringify(summary, null, 2);
}

export function estimateDeepSeekCostCny(usage: Pick<Usage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">): number {
  const cost = (usage.inputTokens * DEEPSEEK_CNY_PRICING.input + usage.outputTokens * DEEPSEEK_CNY_PRICING.output +
    usage.cacheReadTokens * DEEPSEEK_CNY_PRICING.cacheRead + usage.cacheWriteTokens * DEEPSEEK_CNY_PRICING.cacheWrite) / 1_000_000;
  return Math.round(cost * 100_000_000) / 100_000_000;
}

export interface PublicFactsDocument {
  schemaVersion: 1;
  repository: typeof publicRepository & { license: string };
  facts: Array<GoldenFact & { question: string; expectedAnswer: string }>;
}

export interface PublicEvaluationRunRecord {
  schemaVersion: 2;
  status: "completed" | "failed" | "cancelled";
  createdAt: string;
  repository: { url: string; ref: string; sha: string };
  provider: "deepseek";
  model: { id: "deepseek-flash"; name: string; api: string; baseUrl: string; officialVersionAsOf: string };
  promptVersion: string;
  runId: string;
  attemptId: string;
  pricing: Pricing;
  pricingCny: typeof DEEPSEEK_CNY_PRICING;
  priceListCnyPerUsd: number;
  maxCostCny: number;
  budget: Budget;
  usage: Usage;
  reportSha256?: string;
  validatedEvidenceIds: string[];
}

export interface PublicEvaluationAnnotations extends SemanticAnnotations {
  schemaVersion: 1;
  runId: string;
  reportSha256: string;
  method: string;
  reviewedUnknownClaimIds: string[];
  correctlyAbstainedClaimIds: string[];
  incorrectlyAbstainedClaimIds: string[];
}

export interface PublicEvaluationScore {
  schemaVersion: 1;
  runId: string;
  reportSha256: string;
  qualityGate: "incomplete" | "passed" | "failed";
  thresholds: {
    factRecall: 0.8;
    citationValidity: 1;
    evidenceSupport: 1;
    unsupportedAssertions: 0;
    allAssertionsReviewed: true;
    allUnknownsReviewedAndCorrect: true;
  };
  abstentionQuality: { correct: number; incorrect: number; reviewed: number; totalUnknown: number; rate: number | null };
  metrics: EvaluationMetrics;
}

export type PublicEvaluationArguments =
  | { mode: "help" }
  | { mode: "online"; maxCostCny: number; maxCostUsd: number }
  | { mode: "score"; runDirectory: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function unique(values: string[], label: string): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length) throw new Error(`Duplicate ${label}`);
  return result;
}

export function parsePublicEvaluationArguments(argv: string[]): PublicEvaluationArguments {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--help")) return { mode: "help" };
  if (argv[0] === "--score") {
    if (argv.length !== 2 || !argv[1]) throw new Error("Usage: eval:public --score <run-directory>");
    return { mode: "score", runDirectory: argv[1] };
  }
  if (argv[0] !== "--online") throw new Error("Online evaluation requires the explicit --online flag. Use --help for usage.");

  let maxCostCny: number | undefined;
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] !== "--max-cost-cny" || maxCostCny !== undefined || index + 1 >= argv.length) {
      throw new Error("Usage: eval:public --online --max-cost-cny <amount>");
    }
    maxCostCny = Number(argv[++index]);
  }
  if (maxCostCny === undefined || !Number.isFinite(maxCostCny) || maxCostCny <= 0 || maxCostCny > MAX_PUBLIC_EVAL_COST_CNY) {
    throw new Error(`Set --max-cost-cny to a positive amount no greater than ¥${MAX_PUBLIC_EVAL_COST_CNY}.`);
  }
  return { mode: "online", maxCostCny, maxCostUsd: maxCostCny / DEEPSEEK_PRICE_LIST_CNY_PER_USD };
}

export async function loadPublicFacts(): Promise<PublicFactsDocument> {
  const value: unknown = JSON.parse(await readFile(factsFile, "utf8"));
  if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.repository) || !Array.isArray(value.facts)) {
    throw new Error("Public evaluation fact list is malformed");
  }
  const repository = value.repository;
  if (repository.url !== publicRepository.url || repository.ref !== publicRepository.ref || repository.sha !== publicRepository.sha || typeof repository.license !== "string") {
    throw new Error("Public evaluation fact list is not pinned to the approved repository snapshot");
  }
  const facts: PublicFactsDocument["facts"] = value.facts.map((entry) => {
    if (!isObject(entry) || typeof entry.id !== "string" || typeof entry.question !== "string" || typeof entry.expectedAnswer !== "string" ||
        !Array.isArray(entry.expectedEvidence) || entry.expectedEvidence.length === 0) throw new Error("Public evaluation fact entry is malformed");
    const expectedEvidence = entry.expectedEvidence.map((range) => {
      if (!isObject(range) || typeof range.path !== "string" || range.path.startsWith("/") ||
          !Number.isSafeInteger(range.startLine) || (range.startLine as number) < 1 ||
          !Number.isSafeInteger(range.endLine) || (range.endLine as number) < (range.startLine as number)) {
        throw new Error("Public evaluation source range is malformed");
      }
      return { path: range.path, startLine: range.startLine as number, endLine: range.endLine as number };
    });
    return { id: entry.id, statement: entry.expectedAnswer, question: entry.question, expectedAnswer: entry.expectedAnswer, expectedEvidence };
  });
  unique(facts.map((fact) => fact.id), "golden fact ID");
  if (facts.length === 0) throw new Error("Public evaluation requires at least one golden fact");
  return { schemaVersion: 1, repository: { ...publicRepository, license: repository.license }, facts };
}

export function createPublicEvaluationAnnotationsTemplate(
  runId: string,
  reportSha256: string,
  report: Report,
  facts: PublicFactsDocument["facts"],
): PublicEvaluationAnnotations & { instructions: string[]; claimsToReview: unknown[]; goldenFacts: unknown[] } {
  return {
    schemaVersion: 1,
    runId,
    reportSha256,
    method: "Human review: map supported fact claims to the prewritten fact IDs; adjudicate every factual/inference claim and every unknown claim.",
    instructions: [
      "Review every fact and inference claim against the report evidence, then place its ID in reviewedAssertionClaimIds and exactly one of supportedAssertionClaimIds or unsupportedAssertionClaimIds.",
      "For each supported fact claim, map its claim ID to one or more matching golden fact IDs in claimFactMap. Do not map inferences or unsupported claims.",
      "Review every unknown claim and put its ID in reviewedUnknownClaimIds and exactly one of correctlyAbstainedClaimIds or incorrectlyAbstainedClaimIds.",
      "This manual annotation is required; the evaluator does not ask a second model to grade the report.",
    ],
    claimsToReview: report.claims.map((claim) => ({ id: claim.id, kind: claim.kind, text: claim.text, evidenceIds: claim.evidenceIds })),
    goldenFacts: facts.map(({ id, question, expectedAnswer, expectedEvidence }) => ({ id, question, expectedAnswer, expectedEvidence })),
    claimFactMap: {},
    reviewedAssertionClaimIds: [],
    supportedAssertionClaimIds: [],
    unsupportedAssertionClaimIds: [],
    reviewedUnknownClaimIds: [],
    correctlyAbstainedClaimIds: [],
    incorrectlyAbstainedClaimIds: [],
  };
}

async function readRegularFile(directory: string, filename: string): Promise<Buffer> {
  const absoluteDirectory = path.resolve(directory);
  if (await realpath(absoluteDirectory) !== absoluteDirectory || !(await lstat(absoluteDirectory)).isDirectory()) throw new Error("Evaluation run directory must be a real directory");
  const target = path.join(absoluteDirectory, filename);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Evaluation file is not a regular file: ${filename}`);
  return readFile(target);
}

function parseRunRecord(value: unknown): PublicEvaluationRunRecord {
  if (!isObject(value) || value.schemaVersion !== 2 || value.status !== "completed" || !isObject(value.repository) ||
      value.repository.url !== publicRepository.url || value.repository.ref !== publicRepository.ref || value.repository.sha !== publicRepository.sha ||
      value.provider !== "deepseek" || typeof value.promptVersion !== "string" || !supportedPromptVersions.has(value.promptVersion) || typeof value.createdAt !== "string" ||
      !isObject(value.model) || value.model.id !== "deepseek-flash" || value.model.api !== "openai-completions" ||
      value.model.baseUrl !== "https://api.deepseek.com" || typeof value.model.name !== "string" || typeof value.model.officialVersionAsOf !== "string" ||
      !isObject(value.pricingCny) || value.pricingCny.version !== DEEPSEEK_CNY_PRICING.version || value.pricingCny.currency !== "CNY" ||
      value.pricingCny.input !== DEEPSEEK_CNY_PRICING.input || value.pricingCny.output !== DEEPSEEK_CNY_PRICING.output ||
      value.pricingCny.cacheRead !== DEEPSEEK_CNY_PRICING.cacheRead || value.pricingCny.cacheWrite !== DEEPSEEK_CNY_PRICING.cacheWrite ||
      value.pricingCny.sourceUrl !== DEEPSEEK_CNY_PRICING.sourceUrl || value.priceListCnyPerUsd !== DEEPSEEK_PRICE_LIST_CNY_PER_USD ||
      typeof value.maxCostCny !== "number" || !Number.isFinite(value.maxCostCny) || value.maxCostCny <= 0 || value.maxCostCny > MAX_PUBLIC_EVAL_COST_CNY ||
      typeof value.runId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.runId) ||
      typeof value.attemptId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.attemptId) ||
      typeof value.reportSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.reportSha256) || !stringArray(value.validatedEvidenceIds)) {
    throw new Error("Evaluation run record is malformed, incomplete, or uses a different model/repository");
  }
  return {
    schemaVersion: 2,
    status: "completed",
    createdAt: value.createdAt,
    repository: { url: publicRepository.url, ref: publicRepository.ref, sha: publicRepository.sha },
    provider: "deepseek",
    model: value.model as PublicEvaluationRunRecord["model"],
    promptVersion: value.promptVersion,
    runId: value.runId,
    attemptId: value.attemptId,
    pricing: parse(PricingSchema, value.pricing),
    pricingCny: DEEPSEEK_CNY_PRICING,
    priceListCnyPerUsd: DEEPSEEK_PRICE_LIST_CNY_PER_USD,
    maxCostCny: value.maxCostCny as number,
    budget: parse(BudgetSchema, value.budget),
    usage: parse(UsageSchema, value.usage),
    reportSha256: value.reportSha256,
    validatedEvidenceIds: value.validatedEvidenceIds,
  };
}

function parseAnnotations(value: unknown, record: PublicEvaluationRunRecord): PublicEvaluationAnnotations {
  if (!isObject(value) || value.schemaVersion !== 1 || value.runId !== record.runId || value.reportSha256 !== record.reportSha256 ||
      !isObject(value.claimFactMap) || !stringArray(value.reviewedAssertionClaimIds) || !stringArray(value.supportedAssertionClaimIds) ||
      !stringArray(value.unsupportedAssertionClaimIds) || !stringArray(value.reviewedUnknownClaimIds) ||
      !stringArray(value.correctlyAbstainedClaimIds) || !stringArray(value.incorrectlyAbstainedClaimIds) || typeof value.method !== "string") {
    throw new Error("Manual annotations are missing, malformed, or belong to another evaluation run");
  }
  const claimFactMap: Record<string, string[]> = {};
  for (const [claimId, factIds] of Object.entries(value.claimFactMap)) {
    if (!stringArray(factIds)) throw new Error("Fact mapping entries must be arrays of fact IDs");
    claimFactMap[claimId] = factIds;
  }
  return {
    schemaVersion: 1,
    runId: record.runId,
    reportSha256: record.reportSha256!,
    method: value.method,
    claimFactMap,
    reviewedAssertionClaimIds: value.reviewedAssertionClaimIds,
    supportedAssertionClaimIds: value.supportedAssertionClaimIds,
    unsupportedAssertionClaimIds: value.unsupportedAssertionClaimIds,
    reviewedUnknownClaimIds: value.reviewedUnknownClaimIds,
    correctlyAbstainedClaimIds: value.correctlyAbstainedClaimIds,
    incorrectlyAbstainedClaimIds: value.incorrectlyAbstainedClaimIds,
  };
}

function scoreAnnotations(report: Report, annotations: PublicEvaluationAnnotations): {
  reviewedUnknown: Set<string>; correctUnknown: Set<string>; incorrectUnknown: Set<string>; complete: boolean;
} {
  const unknowns = new Set(report.claims.filter((claim) => claim.kind === "unknown").map((claim) => claim.id));
  const assertions = new Set(report.claims.filter((claim) => claim.kind !== "unknown").map((claim) => claim.id));
  const reviewedUnknown = unique(annotations.reviewedUnknownClaimIds, "reviewed unknown claim ID");
  const correctUnknown = unique(annotations.correctlyAbstainedClaimIds, "correct abstention claim ID");
  const incorrectUnknown = unique(annotations.incorrectlyAbstainedClaimIds, "incorrect abstention claim ID");
  for (const claimId of reviewedUnknown) if (!unknowns.has(claimId)) throw new Error("Unknown-claim review references a non-unknown claim");
  for (const claimId of correctUnknown) if (!reviewedUnknown.has(claimId)) throw new Error("Correct abstention must be reviewed");
  for (const claimId of incorrectUnknown) if (!reviewedUnknown.has(claimId) || correctUnknown.has(claimId)) throw new Error("Incorrect abstention must be reviewed and cannot conflict");
  for (const claimId of reviewedUnknown) if (!correctUnknown.has(claimId) && !incorrectUnknown.has(claimId)) throw new Error("Every reviewed unknown claim must be labeled correct or incorrect");
  const assertionsReviewed = new Set(annotations.reviewedAssertionClaimIds);
  for (const claimId of assertionsReviewed) if (!assertions.has(claimId)) throw new Error("Assertion review references a non-assertion claim");
  return {
    reviewedUnknown,
    correctUnknown,
    incorrectUnknown,
    complete: assertionsReviewed.size === assertions.size && reviewedUnknown.size === unknowns.size,
  };
}

export async function scorePublicEvaluationDirectory(runDirectory: string): Promise<PublicEvaluationScore> {
  const record = parseRunRecord(JSON.parse((await readRegularFile(runDirectory, "evaluation-run.json")).toString("utf8")) as unknown);
  const reportBytes = await readRegularFile(runDirectory, "report.json");
  const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
  if (reportSha256 !== record.reportSha256) throw new Error("Report changed after its evaluation run was recorded");
  const report = parseReport(JSON.parse(reportBytes.toString("utf8")) as unknown);
  if (report.runId !== record.runId || report.attemptId !== record.attemptId || report.snapshotId !== record.repository.sha) {
    throw new Error("Report identity does not match its evaluation record");
  }
  const reportEvidenceIds = report.evidence.map((item) => item.id).sort();
  const validatedEvidenceIds = [...record.validatedEvidenceIds].sort();
  if (reportEvidenceIds.length !== validatedEvidenceIds.length || reportEvidenceIds.some((id, index) => id !== validatedEvidenceIds[index])) {
    throw new Error("Evaluation record does not attest the report's complete evidence set");
  }
  const annotations = parseAnnotations(JSON.parse((await readRegularFile(runDirectory, "annotations.json")).toString("utf8")) as unknown, record);
  const facts = await loadPublicFacts();
  const evidenceById = new Map(report.evidence.map(({ id, path: evidencePath, startLine, endLine }) => [id, { path: evidencePath, startLine, endLine }] as const));
  const metrics = evaluateReport(report, facts.facts, annotations, new Set(validatedEvidenceIds), evidenceById);
  const { reviewedUnknown, correctUnknown, incorrectUnknown, complete } = scoreAnnotations(report, annotations);
  const totalUnknown = report.claims.filter((claim) => claim.kind === "unknown").length;
  const abstentionRate = reviewedUnknown.size === 0 ? null : correctUnknown.size / reviewedUnknown.size;
  const gatePass = complete && metrics.factRecall.rate !== null && metrics.factRecall.rate >= 0.8 &&
    metrics.citationValidity.rate === 1 && metrics.citationValidity.totalUses > 0 &&
    metrics.evidenceSupport.rate === 1 && metrics.unsupportedAssertions.claims === 0 &&
    (totalUnknown === 0 || (reviewedUnknown.size === totalUnknown && incorrectUnknown.size === 0 && abstentionRate === 1));
  return {
    schemaVersion: 1,
    runId: record.runId,
    reportSha256,
    qualityGate: !complete ? "incomplete" : gatePass ? "passed" : "failed",
    thresholds: {
      factRecall: 0.8,
      citationValidity: 1,
      evidenceSupport: 1,
      unsupportedAssertions: 0,
      allAssertionsReviewed: true,
      allUnknownsReviewedAndCorrect: true,
    },
    abstentionQuality: {
      correct: correctUnknown.size,
      incorrect: incorrectUnknown.size,
      reviewed: reviewedUnknown.size,
      totalUnknown,
      rate: abstentionRate,
    },
    metrics,
  };
}

export async function writePrivateJson(directory: string, filename: string, value: unknown, overwrite = false): Promise<void> {
  const target = path.join(directory, filename);
  const text = JSON.stringify(value, null, 2) + "\n";
  if (!overwrite) {
    const handle = await open(target, "wx", 0o600);
    try { await handle.writeFile(text, "utf8"); } finally { await handle.close(); }
    return;
  }
  const temporary = `${target}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(text, "utf8"); } finally { await handle.close(); }
  try { await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; }
}
