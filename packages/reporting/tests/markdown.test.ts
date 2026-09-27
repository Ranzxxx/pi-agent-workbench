import assert from "node:assert/strict";
import test from "node:test";
import type { StructuredReport } from "../src/contracts.js";
import { renderMarkdown } from "../src/markdown.js";

test("renders structured claims and limitations safely when Markdown contains fences or HTML", () => {
  const report: StructuredReport = {
    schemaVersion: 1,
    runId: "run-markdown",
    attemptId: "attempt-markdown",
    snapshotId: "synthetic-harborlight-v1",
    title: "Fixture <review>",
    limitations: ["No command was run; this line comes from the structured report."],
    evidence: [{
      id: "e-markdown",
      snapshotId: "synthetic-harborlight-v1",
      path: "src/file.ts",
      fileSha256: "a".repeat(64),
      startLine: 1,
      endLine: 1,
      excerpt: "const note = `alpha ``` beta`; return <script>alert(1)</script>;",
    }],
    claims: [
      { id: "claim-markdown", kind: "fact", text: "Source contains `inline` syntax and **bold** text <img>.", evidenceIds: ["e-markdown"] },
      { id: "claim-unknown", kind: "unknown", text: "Runtime result is unknown.", reason: "The source was not executed.", evidenceIds: [] },
    ],
  };

  const markdown = renderMarkdown(report);
  assert.ok(markdown.includes("Fixture &lt;review&gt;"));
  assert.ok(markdown.includes("Source contains \\`inline\\` syntax and \\*\\*bold\\*\\* text &lt;img&gt;\\."));
  assert.ok(markdown.includes("````const note = `alpha ``` beta`; return <script>alert(1)</script>;````"));
  assert.ok(markdown.includes("原因：The source was not executed\\."));
  assert.ok(markdown.includes("No command was run; this line comes from the structured report\\."));
  assert.ok(!markdown.includes("<img>"));
});
