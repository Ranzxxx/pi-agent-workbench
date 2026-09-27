import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { evaluateFixtureReport } from "../src/fixture-evaluation.js";
import { renderMarkdown } from "../src/markdown.js";
import { runOfflineAnalysis } from "../src/offline-runner.js";
import { loadProtocolBoundary } from "../src/contracts.js";
import { createReadOnlyRepository } from "@pi-workbench/tools";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");
const fixtureRoot = path.join(projectRoot, "fixtures", "synthetic-ts-repo");

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "pi-task004-reporting-"));
}

test("offline CLI pipeline validates and publishes exactly four coherent artifacts", async () => {
  const temporary = await tempDirectory();
  try {
    const protocol = await loadProtocolBoundary();
    const result = await runOfflineAnalysis({
      outputDirectory: path.join(temporary, "artifacts"),
      fixtureRoot,
      runId: "run-success",
      attemptId: "attempt-success",
      protocol,
      now: () => new Date("2026-09-27T01:02:03.000Z"),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.snapshotId, "synthetic-harborlight-v1");
    assert.deepEqual(new Set(result.artifacts.map((item) => item.kind)), new Set(["report.json", "report.md", "manifest.json", "events.jsonl"]));
    assert.equal(result.artifacts.length, 4);
    assert.ok(result.directory);

    const reportText = await readFile(path.join(result.directory!, "report.json"), "utf8");
    const report = protocol.parseReport(JSON.parse(reportText));
    assert.deepEqual(report, result.report);
    const markdown = await readFile(path.join(result.directory!, "report.md"), "utf8");
    assert.equal(markdown, renderMarkdown(report));
    assert.match(markdown, /The package declares npm test as node --test/u);
    assert.match(markdown, /Whether the fixture test command passes is unknown/u);
    assert.match(markdown, /no dependency installation, script execution, or test run was performed/u);
    assert.equal(report.claims.filter((claim) => claim.kind === "fact").length, 5);
    assert.equal(report.claims.filter((claim) => claim.kind === "inference").length, 1);
    assert.equal(report.claims.filter((claim) => claim.kind === "unknown").length, 1);

    const manifestText = await readFile(path.join(result.directory!, "manifest.json"), "utf8");
    const manifest = protocol.parseManifest(JSON.parse(manifestText));
    assert.equal(manifest.status, "completed");
    assert.deepEqual(manifest.artifacts.map((item) => item.kind), ["report.json", "report.md", "events.jsonl"]);
    for (const artifact of manifest.artifacts) {
      const artifactBytes: Uint8Array = await readFile(path.join(result.directory!, artifact.path));
      assert.equal(createHashHex(artifactBytes), artifact.sha256);
    }

    const eventsText = await readFile(path.join(result.directory!, "events.jsonl"), "utf8");
    const events = eventsText.trimEnd().split("\n").map((line) => protocol.parseEvent(JSON.parse(line)));
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.type !== "run.finished"));
    assert.equal(events[0]?.type, "run.started");
    const metrics = await evaluateFixtureReport(report, createReadOnlyRepository({ root: fixtureRoot, snapshotId: report.snapshotId }));
    assert.equal(metrics.factRecall.rate, 1);
    assert.equal(metrics.citationValidity.rate, 1);
    assert.equal(metrics.evidenceSupport.rate, 1);
    assert.equal(metrics.unsupportedAssertions.rate, 0);
    assert.equal(metrics.reviewCoverage.rate, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("schema failure and cancellation publish partial status without Markdown or completed", async () => {
  const temporary = await tempDirectory();
  try {
    const protocol = await loadProtocolBoundary();
    const rejectReport = { ...protocol, parseReport: () => { throw new Error("deliberately invalid report"); } };
    const failed = await runOfflineAnalysis({
      outputDirectory: path.join(temporary, "failed"),
      fixtureRoot,
      runId: "run-failure",
      attemptId: "attempt-failure",
      protocol: rejectReport,
    });
    assert.equal(failed.status, "failed");
    assert.ok(failed.directory);
    assert.ok(!failed.artifacts.some((item) => item.kind === "report.md" || item.kind === "report.json"));
    const failedManifest = protocol.parseManifest(JSON.parse(await readFile(path.join(failed.directory!, "manifest.json"), "utf8")));
    assert.equal(failedManifest.status, "failed");
    assert.ok(failed.artifacts.some((item) => item.kind === "manifest.json"));

    const controller = new AbortController();
    const cancelled = await runOfflineAnalysis({
      outputDirectory: path.join(temporary, "cancelled"),
      fixtureRoot,
      runId: "run-cancelled",
      attemptId: "attempt-cancelled",
      protocol,
      beforePublish: () => controller.abort(),
      signal: controller.signal,
    });
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.directory);
    assert.ok(!cancelled.artifacts.some((item) => item.kind === "report.md"));
    const cancelledManifest = protocol.parseManifest(JSON.parse(await readFile(path.join(cancelled.directory!, "manifest.json"), "utf8")));
    assert.equal(cancelledManifest.status, "cancelled");
    const partialEvents = await readFile(path.join(cancelled.directory!, "events.jsonl"), "utf8");
    assert.ok(partialEvents.length > 0);
    assert.ok(partialEvents.trimEnd().split("\n").every((line) => protocol.parseEvent(JSON.parse(line)).type !== "run.finished"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("refuses output below a symlinked parent without publishing artifacts", async () => {
  const temporary = await tempDirectory();
  try {
    const destination = path.join(temporary, "actual");
    await mkdir(destination);
    const link = path.join(temporary, "linked");
    await symlink(destination, link);
    const result = await runOfflineAnalysis({
      outputDirectory: path.join(link, "nested"),
      fixtureRoot,
      runId: "run-output-symlink",
      attemptId: "attempt-output-symlink",
      protocol: await loadProtocolBoundary(),
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(await readdir(destination), []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

function createHashHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
