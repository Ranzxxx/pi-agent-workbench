import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEvidenceRegistry, type ReadOnlyRepository } from "@pi-workbench/tools";
import { evaluateReport, type EvaluationMetrics, type GoldenFact, type SemanticAnnotations } from "./evaluation.js";
import { SYNTHETIC_SNAPSHOT_ID, type StructuredReport } from "./contracts.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");

interface GoldenFactsDocument {
  schemaVersion: 1;
  snapshotId: string;
  contentDigestSha256: string;
  facts: Array<GoldenFact & { expectedEvidence: Array<{ path: string; startLine: number; endLine: number }> }>;
  method: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseJsonFile<T>(filename: string): Promise<T> {
  const contents = await readFile(path.join(projectRoot, filename), "utf8");
  return JSON.parse(contents) as T;
}

async function loadEvaluationData(): Promise<{ golden: GoldenFactsDocument; annotations: SemanticAnnotations }> {
  const [goldenValue, annotationValue] = await Promise.all([
    parseJsonFile<unknown>("evals/golden-facts.json"),
    parseJsonFile<unknown>("evals/offline-demo-annotations.json"),
  ]);
  if (!object(goldenValue) || goldenValue.schemaVersion !== 1 || goldenValue.snapshotId !== SYNTHETIC_SNAPSHOT_ID ||
      typeof goldenValue.contentDigestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(goldenValue.contentDigestSha256) ||
      !Array.isArray(goldenValue.facts) || goldenValue.facts.length === 0 || typeof goldenValue.method !== "string") {
    throw new Error("Golden fact list is malformed or references another snapshot");
  }
  if (!object(annotationValue) || annotationValue.schemaVersion !== 1 || typeof annotationValue.method !== "string" || !object(annotationValue.claimFactMap) ||
      !Array.isArray(annotationValue.reviewedAssertionClaimIds) || !Array.isArray(annotationValue.supportedAssertionClaimIds) ||
      !Array.isArray(annotationValue.unsupportedAssertionClaimIds)) {
    throw new Error("Manual evaluation annotations are malformed");
  }
  const facts: GoldenFactsDocument["facts"] = goldenValue.facts.map((factValue) => {
    if (!object(factValue) || typeof factValue.id !== "string" || typeof factValue.statement !== "string" ||
        !Array.isArray(factValue.expectedEvidence) || factValue.expectedEvidence.length === 0) throw new Error("Golden fact entry is malformed");
    const expectedEvidence = factValue.expectedEvidence.map((expectedValue) => {
      if (!object(expectedValue) || typeof expectedValue.path !== "string" || expectedValue.path.length === 0 || expectedValue.path.startsWith("/") ||
          expectedValue.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
          typeof expectedValue.startLine !== "number" || !Number.isSafeInteger(expectedValue.startLine) || expectedValue.startLine < 1 ||
          typeof expectedValue.endLine !== "number" || !Number.isSafeInteger(expectedValue.endLine) || expectedValue.endLine < expectedValue.startLine) {
        throw new Error("Golden fact source range is malformed");
      }
      return { path: expectedValue.path, startLine: expectedValue.startLine, endLine: expectedValue.endLine };
    });
    return { id: factValue.id, statement: factValue.statement, expectedEvidence };
  });
  const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
  if (!stringArray(annotationValue.reviewedAssertionClaimIds) || !stringArray(annotationValue.supportedAssertionClaimIds) ||
      !stringArray(annotationValue.unsupportedAssertionClaimIds)) throw new Error("Manual evaluation labels must contain claim IDs");
  const claimFactMap: Record<string, string[]> = {};
  for (const [claimId, factIds] of Object.entries(annotationValue.claimFactMap)) {
    if (!stringArray(factIds)) throw new Error("Manual fact mappings must contain fact IDs");
    claimFactMap[claimId] = factIds;
  }
  return {
    golden: { ...goldenValue, facts } as GoldenFactsDocument,
    annotations: {
      claimFactMap,
      reviewedAssertionClaimIds: annotationValue.reviewedAssertionClaimIds,
      supportedAssertionClaimIds: annotationValue.supportedAssertionClaimIds,
      unsupportedAssertionClaimIds: annotationValue.unsupportedAssertionClaimIds,
    },
  };
}

/** Verify the checked-in fact list is pinned to the full fixture tree before any metric is produced. */
export async function verifyGoldenSnapshot(repository: ReadOnlyRepository): Promise<GoldenFactsDocument> {
  const { golden } = await loadEvaluationData();
  const fingerprint = await repository.fingerprint();
  if (repository.snapshotId !== golden.snapshotId || fingerprint.contentDigestSha256 !== golden.contentDigestSha256) {
    throw new Error("Synthetic fixture content differs from the pre-scored golden snapshot");
  }
  return golden;
}

export async function evaluateFixtureReport(
  report: StructuredReport,
  repository: ReadOnlyRepository,
): Promise<EvaluationMetrics> {
  const { golden, annotations } = await loadEvaluationData();
  const fingerprint = await repository.fingerprint();
  if (repository.snapshotId !== golden.snapshotId || report.snapshotId !== golden.snapshotId || fingerprint.contentDigestSha256 !== golden.contentDigestSha256) {
    throw new Error("Evaluation refused: fixture snapshot does not match the pinned golden data");
  }
  const registry = createEvidenceRegistry(repository);
  for (const evidence of report.evidence) await registry.validate(evidence);
  const validEvidenceIds = new Set(report.evidence.map((item) => item.id));
  const evidenceById = new Map(report.evidence.map(({ id, path, startLine, endLine }) => [id, { path, startLine, endLine }] as const));
  return evaluateReport(report, golden.facts, annotations, validEvidenceIds, evidenceById);
}
