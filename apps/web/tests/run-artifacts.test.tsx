import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkbenchRun } from "@pi-workbench/protocol";
import { RunArtifacts } from "../src/app/run-artifacts.js";

const artifact = { kind: "events.jsonl" as const, sha256: "a".repeat(64) };
function run(status: "failed" | "cancelled", withArtifact: boolean): WorkbenchRun {
  const base = {
    schemaVersion: 1 as const, runId: "run-123", conversationId: "conversation-123", status,
    createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z",
    input: { kind: "message" as const, text: "test" },
  };
  return {
    ...base,
    result: status === "failed"
      ? { schemaVersion: 1, status, runId: base.runId, conversationId: base.conversationId, endedAt: base.updatedAt, error: { code: "runtime_error", message: "failed" }, ...(withArtifact ? { artifacts: [artifact] } : {}) }
      : { schemaVersion: 1, status, runId: base.runId, conversationId: base.conversationId, endedAt: base.updatedAt, reason: "user", ...(withArtifact ? { artifacts: [artifact] } : {}) },
  } as WorkbenchRun;
}

test("failed and cancelled runs expose registered partial artifacts without dead links", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const html = renderToStaticMarkup(<RunArtifacts run={run(status, true)} />);
    assert.match(html, /aria-label="运行产物"/u);
    assert.match(html, /\/api\/v1\/runs\/run-123\/artifacts\/events\.jsonl/u);
    assert.equal(renderToStaticMarkup(<RunArtifacts run={run(status, false)} />), "");
  }
});
