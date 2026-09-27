import assert from "node:assert/strict";
import test from "node:test";
import { evaluateReport } from "../src/evaluation.js";

const report = {
  claims: [
    { id: "fact-1", kind: "fact" as const, evidenceIds: ["e-valid"] },
    { id: "fact-2", kind: "fact" as const, evidenceIds: ["e-missing"] },
    { id: "inference-1", kind: "inference" as const, evidenceIds: ["e-valid"] },
    { id: "unknown-1", kind: "unknown" as const, evidenceIds: [] },
  ],
};
const goldenFacts = [{ id: "GF-001", statement: "first" }, { id: "GF-002", statement: "second" }];

test("reports recall, citation validity, semantic support, and unsupported assertions separately", () => {
  const result = evaluateReport(report, goldenFacts, {
    claimFactMap: { "fact-1": ["GF-001"] },
    reviewedAssertionClaimIds: ["fact-1", "fact-2", "inference-1"],
    supportedAssertionClaimIds: ["fact-1", "inference-1"],
    unsupportedAssertionClaimIds: ["fact-2"],
  }, new Set(["e-valid"]));
  assert.deepEqual(result.factRecall, { recovered: 1, applicable: 2, rate: 0.5 });
  assert.deepEqual(result.citationValidity, { validUses: 2, totalUses: 3, rate: 2 / 3 });
  assert.deepEqual(result.evidenceSupport, { supportedClaims: 2, reviewedClaims: 3, rate: 2 / 3 });
  assert.deepEqual(result.reviewCoverage, { reviewedAssertions: 3, totalAssertions: 3, rate: 1 });
  assert.deepEqual(result.unsupportedAssertions, { claims: 1, reviewedAssertions: 3, rate: 1 / 3 });
  assert.match(result.limitations.join(" "), /manual judgments/u);
});

test("uses null for metrics with no applicable observations", () => {
  const result = evaluateReport({ claims: [{ id: "unknown", kind: "unknown", evidenceIds: [] }] }, [], {
    claimFactMap: {},
    reviewedAssertionClaimIds: [],
    supportedAssertionClaimIds: [],
    unsupportedAssertionClaimIds: [],
  }, new Set());
  assert.deepEqual(result.factRecall, { recovered: 0, applicable: 0, rate: null });
  assert.deepEqual(result.citationValidity, { validUses: 0, totalUses: 0, rate: null });
  assert.deepEqual(result.evidenceSupport, { supportedClaims: 0, reviewedClaims: 0, rate: null });
  assert.deepEqual(result.reviewCoverage, { reviewedAssertions: 0, totalAssertions: 0, rate: null });
  assert.deepEqual(result.unsupportedAssertions, { claims: 0, reviewedAssertions: 0, rate: null });
});

test("fact recall requires a supported claim to cite every expected source range", () => {
  const report = { claims: [{ id: "claim-fact", kind: "fact" as const, evidenceIds: ["e-fact"] }] };
  const facts = [{ id: "GF-001", statement: "first", expectedEvidence: [{ path: "src/health.ts", startLine: 2, endLine: 3 }] }];
  const annotations = {
    claimFactMap: { "claim-fact": ["GF-001"] },
    reviewedAssertionClaimIds: ["claim-fact"],
    supportedAssertionClaimIds: ["claim-fact"],
    unsupportedAssertionClaimIds: [],
  };
  const wrongSource = evaluateReport(report, facts, annotations, new Set(["e-fact"]), new Map([
    ["e-fact", { path: "src/index.ts", startLine: 1, endLine: 4 }],
  ]));
  assert.deepEqual(wrongSource.factRecall, { recovered: 0, applicable: 1, rate: 0 });

  const correctSource = evaluateReport(report, facts, annotations, new Set(["e-fact"]), new Map([
    ["e-fact", { path: "src/health.ts", startLine: 1, endLine: 4 }],
  ]));
  assert.deepEqual(correctSource.factRecall, { recovered: 1, applicable: 1, rate: 1 });
});

test("rejects unsupported/stale annotations instead of silently scoring them", () => {
  assert.throws(() => evaluateReport(report, goldenFacts, {
    claimFactMap: { "fact-1": ["not-in-golden-list"] },
    reviewedAssertionClaimIds: ["fact-1"],
    supportedAssertionClaimIds: ["fact-1"],
    unsupportedAssertionClaimIds: [],
  }, new Set(["e-valid"])));
  assert.throws(() => evaluateReport(report, goldenFacts, {
    claimFactMap: {},
    reviewedAssertionClaimIds: ["fact-1"],
    supportedAssertionClaimIds: ["fact-1"],
    unsupportedAssertionClaimIds: ["fact-1"],
  }, new Set(["e-valid"])));
  assert.throws(() => evaluateReport(report, goldenFacts, {
    claimFactMap: {},
    reviewedAssertionClaimIds: ["fact-1"],
    supportedAssertionClaimIds: [],
    unsupportedAssertionClaimIds: [],
  }, new Set(["e-valid"])));
});
