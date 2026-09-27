export type ClaimKind = "fact" | "inference" | "unknown";

export interface EvaluatedClaim {
  id: string;
  kind: ClaimKind;
  evidenceIds: string[];
}

export interface EvaluatedReport {
  claims: EvaluatedClaim[];
}

export interface GoldenFact {
  id: string;
  statement: string;
  expectedEvidence?: Array<{ path: string; startLine: number; endLine: number }>;
}

export interface ScoredEvidenceRange {
  path: string;
  startLine: number;
  endLine: number;
}

export interface SemanticAnnotations {
  claimFactMap: Record<string, string[]>;
  reviewedAssertionClaimIds: string[];
  supportedAssertionClaimIds: string[];
  unsupportedAssertionClaimIds: string[];
}

export interface EvaluationMetrics {
  factRecall: { recovered: number; applicable: number; rate: number | null };
  citationValidity: { validUses: number; totalUses: number; rate: number | null };
  evidenceSupport: { supportedClaims: number; reviewedClaims: number; rate: number | null };
  reviewCoverage: { reviewedAssertions: number; totalAssertions: number; rate: number | null };
  unsupportedAssertions: { claims: number; reviewedAssertions: number; rate: number | null };
  semanticReview: "manual claim-to-fact mapping and manual evidence-support adjudication";
  limitations: string[];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function unique(values: string[], label: string): Set<string> {
  const set = new Set(values);
  if (set.size !== values.length) throw new Error(`Duplicate ${label}`);
  return set;
}

/**
 * Machine-check citation identity separately from human judgments of what prose means.
 * Only evidence IDs revalidated against the pinned fixture count as valid citations.
 */
export function evaluateReport(
  report: EvaluatedReport,
  goldenFacts: GoldenFact[],
  annotations: SemanticAnnotations,
  validEvidenceIds: ReadonlySet<string>,
  evidenceById: ReadonlyMap<string, ScoredEvidenceRange> = new Map(),
): EvaluationMetrics {
  const factIds = unique(goldenFacts.map((fact) => fact.id), "golden fact ID");
  const claims = new Map(report.claims.map((claim) => [claim.id, claim]));
  if (claims.size !== report.claims.length) throw new Error("Duplicate report claim ID");
  const reviewed = unique(annotations.reviewedAssertionClaimIds, "reviewed claim ID");
  const supported = unique(annotations.supportedAssertionClaimIds, "supported claim ID");
  const unsupported = unique(annotations.unsupportedAssertionClaimIds, "unsupported claim ID");
  const assertions = new Set(report.claims.filter((claim) => claim.kind !== "unknown").map((claim) => claim.id));
  for (const claimId of [...reviewed, ...supported, ...unsupported]) {
    if (!assertions.has(claimId)) throw new Error("Semantic annotation references a non-assertion claim");
  }
  for (const claimId of supported) {
    if (!reviewed.has(claimId) || unsupported.has(claimId)) throw new Error("Conflicting semantic annotations");
  }
  for (const claimId of unsupported) {
    if (!reviewed.has(claimId)) throw new Error("Unsupported assertion must be reviewed");
  }
  for (const claimId of reviewed) {
    if (!supported.has(claimId) && !unsupported.has(claimId)) throw new Error("Every reviewed assertion must be labeled supported or unsupported");
  }
  for (const [claimId, mappedFactIds] of Object.entries(annotations.claimFactMap)) {
    const claim = claims.get(claimId);
    if (!claim || claim.kind !== "fact") throw new Error("Fact mapping must reference a fact claim");
    if (!reviewed.has(claimId) || !supported.has(claimId)) throw new Error("Fact mapping must be human-reviewed and supported");
    const mapped = unique(mappedFactIds, "claim fact mapping");
    for (const factId of mapped) if (!factIds.has(factId)) throw new Error("Fact mapping references an unknown golden fact");
  }

  const recovered = new Set<string>();
  for (const [claimId, mappedFactIds] of Object.entries(annotations.claimFactMap)) {
    if (!supported.has(claimId)) continue;
    const claim = claims.get(claimId)!;
    for (const factId of mappedFactIds) {
      const fact = goldenFacts.find((candidate) => candidate.id === factId)!;
      const sources = fact.expectedEvidence ?? [];
      const sourceRangesCovered = sources.every((expected) => claim.evidenceIds.some((evidenceId) => {
        const evidence = evidenceById.get(evidenceId);
        return validEvidenceIds.has(evidenceId) && evidence !== undefined && evidence.path === expected.path &&
          evidence.startLine <= expected.startLine && evidence.endLine >= expected.endLine;
      }));
      if (sourceRangesCovered) recovered.add(factId);
    }
  }
  let citationUses = 0;
  let validCitationUses = 0;
  for (const claim of report.claims) {
    if (claim.kind === "unknown") continue;
    for (const evidenceId of claim.evidenceIds) {
      citationUses++;
      if (validEvidenceIds.has(evidenceId)) validCitationUses++;
    }
  }
  const reviewedCount = reviewed.size;
  const supportedCount = [...supported].filter((claimId) => reviewed.has(claimId)).length;

  return {
    factRecall: { recovered: recovered.size, applicable: factIds.size, rate: ratio(recovered.size, factIds.size) },
    citationValidity: { validUses: validCitationUses, totalUses: citationUses, rate: ratio(validCitationUses, citationUses) },
    evidenceSupport: { supportedClaims: supportedCount, reviewedClaims: reviewedCount, rate: ratio(supportedCount, reviewedCount) },
    reviewCoverage: { reviewedAssertions: reviewed.size, totalAssertions: assertions.size, rate: ratio(reviewed.size, assertions.size) },
    unsupportedAssertions: { claims: unsupported.size, reviewedAssertions: reviewed.size, rate: ratio(unsupported.size, reviewed.size) },
    semanticReview: "manual claim-to-fact mapping and manual evidence-support adjudication",
    limitations: [
      "Fact recall depends on the prewritten fixture fact list and the human claim-to-fact mapping.",
      "Citation validity checks snapshot, path, digest, line range, excerpt, and reference identity; it does not prove semantic support.",
      "Evidence support and unsupported-assertion labels are manual judgments for this synthetic sample, not an automated quality guarantee.",
      "Unsupported-assertion rate uses reviewed assertions as its denominator; reviewCoverage reports how much of the assertion set was adjudicated.",
      "A score on this small synthetic fixture is not a quality estimate for real GitHub repositories or model-generated reports.",
    ],
  };
}
