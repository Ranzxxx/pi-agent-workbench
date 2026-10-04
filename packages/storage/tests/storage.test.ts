import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import {
  applyMigrations, loadCoreMigrations, openStorage, resolveDataDirectory, resolveDatabasePath,
  StorageMigrationError, StorageSchemaError, StorageError,
} from "../src/index.js";

const at = "2026-10-01T00:00:00.000Z";
const hash = "a".repeat(64);

function tempRoot(): string { return mkdtempSync(join(tmpdir(), "pi-workbench-storage-")); }
function withDb(run: (root: string, path: string) => void): void {
  const root = tempRoot();
  const path = join(root, "state", "workbench.sqlite");
  try { run(root, path); } finally { rmSync(root, { recursive: true, force: true }); }
}
function createBase(store: ReturnType<typeof openStorage>, suffix = "1") {
  store.projects.create({ id: `project_${suffix}`, displayName: "Synthetic project", canonicalRoot: resolve(`/tmp/pi-fixture-${suffix}`), directoryIdentity: null, validationState: "valid" });
  store.conversations.create({ id: `conversation_${suffix}`, projectId: `project_${suffix}`, piSessionId: `session_${suffix}`, title: "Synthetic conversation" });
  const run = store.runs.create({ runId: `run_${suffix}`, conversationId: `conversation_${suffix}`, request: { prompt: "Analyze the synthetic fixture" } });
  return { run, attempt: store.attempts.create({ attemptId: `attempt_${suffix}`, runId: run.runId, workerBootId: `worker_${suffix}`, startedAt: at }) };
}

test("stable data directory honors override, XDG, and home fallback", () => {
  assert.equal(resolveDataDirectory({ env: { XDG_DATA_HOME: "/tmp/xdg" }, homeDirectory: "/home/test" }), "/tmp/xdg/pi-agent-workbench");
  assert.equal(resolveDataDirectory({ env: {}, homeDirectory: "/home/test" }), "/home/test/.local/share/pi-agent-workbench");
  assert.equal(resolveDataDirectory({ dataDirectory: "/tmp/custom", env: { XDG_DATA_HOME: "/tmp/xdg" }, homeDirectory: "/home/test" }), "/tmp/custom");
  assert.equal(resolveDatabasePath({ dataDirectory: "/tmp/custom" }), "/tmp/custom/workbench.sqlite");
  assert.throws(() => resolveDataDirectory({ env: { XDG_DATA_HOME: "relative" }, homeDirectory: "/home/test" }));
});

test("new database migrates to WAL/FULL with foreign keys, and repeated open preserves schema", () => withDb((_root, path) => {
  const first = openStorage({ path });
  assert.deepEqual(first.diagnostics, { journalMode: "wal", synchronous: 2, foreignKeys: true, busyTimeoutMs: 100, schemaVersion: 9 });
  assert.equal(first.projects.list().length, 0);
  first.close();
  const reopened = openStorage({ path });
  assert.equal(reopened.diagnostics.schemaVersion, 9);
  assert.equal(reopened.projects.list().length, 0);
  reopened.close();
}));

test("capability states persist enabled flags and non-sensitive configuration", () => withDb((_root, path) => {
  const first = openStorage({ path });
  const saved = first.capabilityStates.set({ capabilityId: "development_greeting_tool", apiVersion: "1.0", enabled: true, config: { greeting: "hello", retries: 2 } });
  assert.equal(saved.enabled, true);
  assert.deepEqual(first.capabilityStates.get("development_greeting_tool")?.config, { greeting: "hello", retries: 2 });
  assert.throws(() => first.capabilityStates.set({ capabilityId: "bad id", apiVersion: "1.0", enabled: true, config: {} }), StorageError);
  assert.throws(() => first.capabilityStates.set({ capabilityId: "secret_config", apiVersion: "1.0", enabled: true, config: { apiKey: "secret" } }), StorageError);
  first.close();
  const reopened = openStorage({ path });
  assert.equal(reopened.capabilityStates.get("development_greeting_tool")?.enabled, true);
  assert.deepEqual(reopened.capabilityStates.list()[0]?.config, { greeting: "hello", retries: 2 });
  reopened.close();
}));

test("file changesets persist operations, support multiple sequence numbers, and release only unreferenced objects", () => withDb((_root, path) => {
  const store = openStorage({ path });
  const { run } = createBase(store, "files");
  const runCompletedAt = new Date(Date.now() + 1).toISOString();
  store.runs.updateStatus(run.runId, "running", runCompletedAt);
  store.runs.updateStatus(run.runId, "completed", runCompletedAt, runCompletedAt);
  const backupA = "b".repeat(64);
  const resultA = "c".repeat(64);
  const backupB = "d".repeat(64);
  for (const sha256 of [backupA, resultA, backupB]) store.contentObjects.register({ sha256, byteSize: 5, createdAt: at });
  const changeset = store.fileChangesets.ensureForRun({
    id: "changeset_files", conversationId: "conversation_files", projectId: "project_files", runId: run.runId, createdAt: at,
  });
  const first = store.fileOperations.prepare({
    id: "operation_first", changesetId: changeset.id, relativePath: "src/a.ts", kind: "replace",
    preVersion: "version_before", preHash: "a".repeat(64), expectedPostHash: resultA,
    backupSha256: backupA, resultSha256: resultA, createdAt: at,
  });
  const appliedFirst = store.fileOperations.applied(first.id, "version_middle", resultA, at);
  assert.equal(appliedFirst.sequence, 1);
  const second = store.fileOperations.prepare({
    id: "operation_second", changesetId: changeset.id, relativePath: "src/a.ts", kind: "replace",
    preVersion: "version_middle", preHash: resultA, expectedPostHash: backupB,
    backupSha256: resultA, resultSha256: backupB, createdAt: at,
  });
  assert.equal(second.sequence, 2);
  store.fileOperations.applied(second.id, "version_after", backupB, at);
  assert.equal(store.fileChangesets.finalizeRun(run.runId, at)?.status, "applied");
  assert.equal(store.fileOperations.list(changeset.id).length, 2);

  store.attachmentResults.create({
    id: "result_file", conversationId: "conversation_files", runId: run.runId, sourceAttachmentId: null,
    objectSha256: "e".repeat(64), fileName: "edited.txt", byteSize: 12, createdAt: at,
  });
  store.conversations.deletePermanently("conversation_files");
  const garbage = store.garbage.list();
  assert.deepEqual(garbage.filter((item) => item.kind === "file_backup_object").map((item) => item.objectRef).sort(),
    [backupA, backupB, resultA].sort());
  assert.deepEqual(garbage.filter((item) => item.kind === "attachment_object").map((item) => item.objectRef), ["e".repeat(64)]);
  store.close();
}));

test("attachment references stay scoped and conversation deletion queues only unshared objects", () => withDb((_root, path) => {
  const store = openStorage({ path });
  store.conversations.create({ id: "conversation_one", projectId: null, piSessionId: null, title: "One" });
  store.conversations.create({ id: "conversation_two", projectId: null, piSessionId: null, title: "Two" });
  const shared = "a".repeat(64); const unique = "b".repeat(64);
  store.attachments.add({ id: "attachment_one", conversationId: "conversation_one", objectSha256: shared, fileName: "shared.txt", relativePath: "shared.txt", byteSize: 7, mediaType: "text/plain; charset=utf-8" });
  store.attachments.add({ id: "attachment_unique", conversationId: "conversation_one", objectSha256: unique, fileName: "unique.txt", relativePath: "unique.txt", byteSize: 6, mediaType: "text/plain; charset=utf-8" });
  store.attachments.add({ id: "attachment_two", conversationId: "conversation_two", objectSha256: shared, fileName: "shared-copy.txt", relativePath: "shared.txt", byteSize: 7, mediaType: "text/plain; charset=utf-8" });
  assert.equal(store.attachments.getForConversation("attachment_two", "conversation_one"), undefined);
  store.conversations.deletePermanently("conversation_one");
  assert.equal(store.attachments.list("conversation_one").length, 0);
  assert.equal(store.attachments.list("conversation_two").length, 1);
  assert.deepEqual(store.garbage.list().filter((item) => item.kind === "attachment_object").map((item) => item.objectRef), [unique]);
  store.conversations.deletePermanently("conversation_two");
  assert.deepEqual(store.garbage.list().filter((item) => item.kind === "attachment_object").map((item) => item.objectRef).sort(), [shared, unique].sort());
  store.close();
}));

test("nested repository calls participate in the outer storage transaction", () => withDb((_root, path) => {
  const store = openStorage({ path });
  assert.throws(() => store.transaction(() => {
    store.projects.create({ id: "project_atomic", displayName: "Atomic fixture", canonicalRoot: "/tmp/pi-atomic-fixture", directoryIdentity: null, validationState: "valid" });
    store.conversations.create({ id: "conversation_atomic", projectId: "project_atomic", piSessionId: null, title: "Atomic fixture" });
    throw new Error("rollback fixture");
  }));
  assert.equal(store.projects.get("project_atomic"), undefined);
  assert.equal(store.conversations.get("conversation_atomic"), undefined);
  store.close();
}));

test("safe checkpoints require the exact attempt usage already settled in durable storage", () => withDb((_root, path) => {
  const store = openStorage({ path });
  const { run, attempt } = createBase(store, "safe_usage");
  const zeroUsage = {
    attemptId: attempt.attemptId, modelId: null, modelCalls: 0, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
    estimatedCostUsd: 0, costStatus: "estimate" as const, pricingVersion: "fake-v1", updatedAt: at,
  };
  store.attemptSafety.initializeBeforeCall(zeroUsage);
  const reusable = store.checkpoints.create({ id: "safe_usage_old_checkpoint", runId: run.runId, attemptId: attempt.attemptId,
    phaseId: "snapshot", inputSha256: hash, outputRef: "snapshot.json", status: "completed", createdAt: at });

  // Starting another provider call must invalidate the preceding safe ledger
  // before a caller can publish an old known snapshot as a fresh checkpoint.
  assert.throws(() => store.attemptSafety.modelCallStarted({ ...zeroUsage, modelCalls: 2, estimatedCostUsd: null,
    costStatus: "unknown", pricingVersion: null, updatedAt: "2026-10-01T00:00:01.000Z" }), StorageError);
  assert.equal(store.attemptSafety.get(attempt.attemptId)?.state, "safe");
  store.attemptSafety.modelCallStarted({ ...zeroUsage, modelCalls: 1, estimatedCostUsd: null,
    costStatus: "unknown", pricingVersion: null, updatedAt: "2026-10-01T00:00:01.000Z" });
  assert.equal(store.attemptSafety.get(attempt.attemptId)?.state, "in_flight");
  assert.equal(store.usage.get(attempt.attemptId)?.costStatus, "unknown");
  assert.throws(() => store.attemptSafety.saveWorkflowCheckpoint({
    checkpoint: { id: "safe_usage_stale_workflow", runId: run.runId, attemptId: attempt.attemptId,
      phaseId: "report", inputSha256: hash, outputRef: "report.json", status: "completed", createdAt: at },
    usage: zeroUsage,
  }), StorageError);
  assert.throws(() => store.attemptSafety.saveConversationCheckpoint({
    attemptId: attempt.attemptId, conversationId: "conversation_safe_usage",
    snapshot: { id: "safe_usage_stale_snapshot", conversationId: "conversation_safe_usage", sdkVersion: "0.86.1",
      formatVersion: "pi-session-v3", snapshot: { formatVersion: "pi-session-v3" }, summary: null, createdAt: at },
    usage: zeroUsage,
  }), StorageError);
  assert.throws(() => store.attemptSafety.adoptWorkflowCheckpoint({ attemptId: attempt.attemptId, checkpointId: reusable.id, usage: zeroUsage }), StorageError);
  assert.equal(store.checkpoints.get("safe_usage_stale_workflow"), undefined);
  assert.equal(store.snapshots.latest("conversation_safe_usage"), undefined);
  assert.equal(store.attemptSafety.get(attempt.attemptId)?.state, "in_flight");

  const settled = { ...zeroUsage, modelCalls: 1, inputTokens: 2, totalTokens: 2,
    estimatedCostUsd: 0.125, updatedAt: "2026-10-01T00:00:02.000Z" };
  assert.throws(() => store.attemptSafety.recordSettledUsage({ ...settled, modelCalls: 0 }), StorageError);
  store.attemptSafety.recordSettledUsage(settled);
  assert.throws(() => store.attemptSafety.saveWorkflowCheckpoint({
    checkpoint: { id: "safe_usage_mismatched_workflow", runId: run.runId, attemptId: attempt.attemptId,
      phaseId: "report", inputSha256: hash, outputRef: "report.json", status: "completed", createdAt: at },
    usage: { ...settled, inputTokens: 1, totalTokens: 1 },
  }), StorageError);
  assert.equal(store.checkpoints.get("safe_usage_mismatched_workflow"), undefined);
  assert.equal(store.attemptSafety.get(attempt.attemptId)?.state, "in_flight");

  const saved = store.attemptSafety.saveWorkflowCheckpoint({
    checkpoint: { id: "safe_usage_valid_workflow", runId: run.runId, attemptId: attempt.attemptId,
      phaseId: "report", inputSha256: hash, outputRef: "report.json", status: "completed", createdAt: at },
    usage: { ...settled, updatedAt: "2026-10-01T00:00:03.000Z" },
  });
  assert.equal(saved.safety.state, "safe");
  assert.equal(saved.safety.checkpointId, "safe_usage_valid_workflow");
  assert.deepEqual(store.usage.get(attempt.attemptId), settled);

  assert.throws(() => store.attemptSafety.modelCallStarted({ ...settled, modelCalls: 3, estimatedCostUsd: null,
    costStatus: "unknown", pricingVersion: null, updatedAt: "2026-10-01T00:00:04.000Z" }), StorageError);
  assert.throws(() => store.attemptSafety.modelCallStarted({ ...settled, modelCalls: 2, inputTokens: 1, totalTokens: 1, estimatedCostUsd: null,
    costStatus: "unknown", pricingVersion: null, updatedAt: "2026-10-01T00:00:04.000Z" }), StorageError);
  assert.equal(store.attemptSafety.get(attempt.attemptId)?.state, "safe");
  store.attemptSafety.modelCallStarted({ ...settled, modelCalls: 2, toolCalls: 1, estimatedCostUsd: null,
    costStatus: "unknown", pricingVersion: null, updatedAt: "2026-10-01T00:00:04.000Z" });
  assert.throws(() => store.attemptSafety.recordSettledUsage({ ...settled, modelCalls: 2, toolCalls: 0,
    updatedAt: "2026-10-01T00:00:05.000Z" }), StorageError);
  const secondSettled = { ...settled, modelCalls: 2, toolCalls: 1, inputTokens: 3, totalTokens: 3,
    estimatedCostUsd: 0.25, updatedAt: "2026-10-01T00:00:05.000Z" };
  store.attemptSafety.recordSettledUsage(secondSettled);
  assert.deepEqual(store.usage.get(attempt.attemptId), secondSettled);
  store.close();
}));

for (const corrupted of ["result", "snapshot", "usage", "request"] as const) {
  test(`completed conversation recovery rejects corrupted ${corrupted} without committing an assistant message`, () => withDb((_root, path) => {
    const store = openStorage({ path });
    const conversationId = `conversation_recovery_${corrupted}`;
    const runId = `run_recovery_${corrupted}`;
    const attemptId = `attempt_recovery_${corrupted}`;
    store.conversations.create({ id: conversationId, projectId: null, piSessionId: null, title: "Recovery fixture" });
    store.runs.create({ runId, conversationId, request: { kind: "message", text: "restore this reply" } });
    store.attempts.create({ attemptId, runId, startedAt: at });
    const zero = { attemptId, modelId: null, modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, estimatedCostUsd: 0, costStatus: "estimate" as const,
      pricingVersion: "fake-v1", updatedAt: at };
    store.attemptSafety.initializeBeforeCall(zero);
    store.attemptSafety.modelCallStarted({ ...zero, modelCalls: 1, estimatedCostUsd: null, costStatus: "unknown", pricingVersion: null });
    const settled = { ...zero, modelCalls: 1, inputTokens: 2, outputTokens: 3, totalTokens: 5 };
    store.attemptSafety.recordSettledUsage(settled);
    const snapshot = { formatVersion: "pi-session-v3", sdkVersion: "0.86.1", sessionId: "session_recovery",
      header: { id: "session_recovery", type: "session", cwd: process.cwd() }, entries: [], leafId: null };
    store.attemptSafety.saveConversationCheckpoint({ attemptId, conversationId,
      snapshot: { id: `snapshot_recovery_${corrupted}`, conversationId, sdkVersion: "0.86.1", formatVersion: "pi-session-v3",
        snapshot, summary: null, createdAt: at }, usage: settled });
    store.completedConversationResults.save({ attemptId, runId,
      result: { schemaVersion: 1, status: "completed", runId, conversationId, endedAt: at, reply: "saved reply" },
      snapshot, usage: { modelCalls: 1, toolCalls: 0, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0,
        cacheWriteTokens: 0, totalTokens: 5, estimatedCostUsd: 0, pricingVersion: "fake-v1" } });
    const interruptedAt = new Date().toISOString();
    store.attempts.finish(attemptId, "interrupted", interruptedAt, undefined, true);
    store.runs.updateStatus(runId, "interrupted", interruptedAt, interruptedAt);
    const raw = new DatabaseSync(path);
    if (corrupted === "result") raw.prepare("UPDATE completed_conversation_results SET result_json = ? WHERE attempt_id = ?")
      .run('{"status":"completed","reply":"tampered"}', attemptId);
    else if (corrupted === "snapshot") raw.prepare("UPDATE session_snapshots SET snapshot_json = ? WHERE id = ?")
      .run('{"sessionId":"other"}', `snapshot_recovery_${corrupted}`);
    else if (corrupted === "usage") raw.prepare("UPDATE usage_records SET input_tokens = input_tokens + 1, total_tokens = total_tokens + 1 WHERE attempt_id = ?").run(attemptId);
    else raw.prepare("UPDATE runs SET request_json = ? WHERE id = ?").run('{"kind":"message","text":"changed"}', runId);
    raw.close();
    assert.throws(() => store.completedConversationResults.recover(attemptId, {
      schemaVersion: 2, scope: runId, endpoint: "POST /api/v2/runs/:id/continue", key: `resume_${corrupted}`, requestHash: hash,
    }), StorageError);
    assert.equal(store.runs.get(runId)?.status, "interrupted");
    assert.equal(store.attempts.list(runId).length, 1);
    assert.deepEqual(store.messages.list(conversationId), []);
    assert.equal(store.results.get(runId), undefined);
    store.close();
  }));
}

test("migration failure rolls back schema and data, and unknown newer schema is not modified", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.throws(() => applyMigrations(db, [{ version: 1, name: "broken", sql: `
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT);
      CREATE TABLE partial_change(id TEXT PRIMARY KEY);
      INSERT INTO schema_migrations VALUES (1, 'broken', '${hash}', '${at}');
      SELECT * FROM missing_table;
    ` }]), StorageMigrationError);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial_change'").get(), undefined);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get(), undefined);
  } finally { db.close(); }

  withDb((_root, path) => {
    const store = openStorage({ path });
    store.close();
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE schema_migrations SET version = version + 98").run();
    raw.close();
    assert.throws(() => openStorage({ path }), StorageSchemaError);
    const verify = new DatabaseSync(path, { readOnly: true });
    assert.equal((verify.prepare("SELECT version FROM schema_migrations").get() as { version: number }).version, 99);
    verify.close();
  });
});

test("newer schema is refused before changing a database's non-WAL journal mode", () => withDb((_root, path) => {
  mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  try {
    assert.equal((raw.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode: string }).journal_mode.toLowerCase(), "delete");
    raw.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (99, 'future', '${hash}', '${at}');
      CREATE TABLE future_data(value TEXT NOT NULL);
      INSERT INTO future_data VALUES ('preserve me');
    `);
  } finally { raw.close(); }

  assert.throws(() => openStorage({ path }), StorageSchemaError);

  const verify = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal((verify.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode.toLowerCase(), "delete");
    assert.equal((verify.prepare("SELECT version FROM schema_migrations").get() as { version: number }).version, 99);
    assert.equal((verify.prepare("SELECT value FROM future_data").get() as { value: string }).value, "preserve me");
    assert.equal(verify.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get(), undefined);
  } finally { verify.close(); }
}));

test("foreign keys and unique constraints reject invalid project/conversation rows", () => withDb((_root, path) => {
  const store = openStorage({ path });
  store.projects.create({ id: "project", displayName: "Project", canonicalRoot: "/tmp/pi-one", directoryIdentity: null, validationState: "valid" });
  assert.throws(() => store.projects.create({ id: "duplicate", displayName: "Other", canonicalRoot: "/tmp/pi-one", directoryIdentity: null, validationState: "valid" }),
    (error: unknown) => error instanceof StorageError && error.code === "conflict");
  assert.throws(() => store.conversations.create({ id: "orphan", projectId: "missing", piSessionId: null, title: "Orphan" }),
    (error: unknown) => error instanceof StorageError && error.code === "conflict");
  assert.equal(store.conversations.list().length, 0);
  store.close();
}));

test("projects, conversations, ordered messages, snapshots, runs, attempts, events, usage, and checkpoints survive reopen", () => withDb((_root, path) => {
  let store = openStorage({ path });
  const { run, attempt } = createBase(store);
  assert.equal(store.messages.append({ id: "message_1", conversationId: "conversation_1", runId: run.runId, role: "user", content: "first", source: "user", extensionId: null, createdAt: at }).sequence, 1);
  assert.equal(store.messages.append({ id: "message_2", conversationId: "conversation_1", runId: run.runId, role: "assistant", content: "second", source: "agent", extensionId: null, createdAt: at }).sequence, 2);
  store.snapshots.save({ id: "snapshot_1", conversationId: "conversation_1", sdkVersion: "0.86.1", formatVersion: "pi-session-v1", snapshot: { entries: [{ type: "message", text: "safe fixture" }] }, summary: null, createdAt: at });
  store.events.append({ eventId: "event_1", runId: run.runId, attemptId: attempt.attemptId, type: "run.accepted", timestamp: at, data: { conversationId: run.conversationId, requestHash: run.requestHash } });
  store.events.append({ eventId: "event_2", runId: run.runId, attemptId: attempt.attemptId, type: "run.progress", timestamp: at, data: { phase: "analysis", message: "Synthetic progress" } });
  store.usage.record({ attemptId: attempt.attemptId, modelId: "offline-fixture", modelCalls: 0, toolCalls: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5, estimatedCostUsd: null, costStatus: "unknown", pricingVersion: null, updatedAt: at });
  store.checkpoints.create({ id: "checkpoint_1", runId: run.runId, attemptId: attempt.attemptId, phaseId: "fixture", inputSha256: hash, outputRef: null, status: "completed", createdAt: at });
  store.close();

  store = openStorage({ path });
  assert.equal(store.projects.get("project_1")?.canonicalRoot, "/tmp/pi-fixture-1");
  assert.equal(store.conversations.get("conversation_1")?.projectId, "project_1");
  assert.deepEqual(store.messages.list("conversation_1").map((message) => [message.sequence, message.content]), [[1, "first"], [2, "second"]]);
  assert.deepEqual(store.snapshots.latest("conversation_1")?.snapshot, { entries: [{ type: "message", text: "safe fixture" }] });
  assert.equal(store.runs.get(run.runId)?.status, "accepted");
  assert.equal(store.attempts.get(attempt.attemptId)?.attemptNumber, 1);
  assert.equal(store.attempts.get(attempt.attemptId)?.usageComplete, false);
  const page = store.events.after({ schemaVersion: 2, runId: run.runId, afterSequence: 0 });
  assert.deepEqual(page.events.map((event) => event.sequence), [1, 2]);
  assert.equal(store.events.after(page.nextCursor).events.length, 0);
  assert.equal(store.events.latestSequence(run.runId), 2);
  assert.equal(store.usage.get(attempt.attemptId)?.costStatus, "unknown");
  assert.equal(store.checkpoints.list(run.runId)[0]?.status, "completed");
  store.close();
}));

test("two database connections enforce one active slot, release is claim-token fenced", () => withDb((_root, path) => {
  const first = openStorage({ path });
  const { run } = createBase(first);
  first.runs.create({ runId: "run_2", conversationId: "conversation_1", request: { prompt: "another request" } });
  const second = openStorage({ path });
  const slot = first.activeSlot.claim({ runId: run.runId, claimToken: "claim_first", workerBootId: "worker_one" });
  assert.equal(slot.generation, 1);
  assert.throws(() => second.activeSlot.claim({ runId: "run_2", claimToken: "claim_second" }),
    (error: unknown) => error instanceof StorageError && error.code === "active_task");
  assert.equal(second.activeSlot.get().runId, run.runId);
  assert.throws(() => second.activeSlot.release({ runId: run.runId, claimToken: "stale_token", generation: slot.generation }),
    (error: unknown) => error instanceof StorageError && error.code === "conflict");
  first.activeSlot.release({ runId: run.runId, claimToken: "claim_first", generation: slot.generation });
  assert.equal(second.activeSlot.get().runId, null);
  assert.equal(second.activeSlot.claim({ runId: "run_2", claimToken: "claim_second" }).generation, 2);
  second.close(); first.close();
}));

test("concurrent SQLite slot-claim transactions have exactly one winner", async () => {
  const root = tempRoot();
  const path = join(root, "state", "workbench.sqlite");
  const setup = openStorage({ path });
  createBase(setup, "race1");
  setup.runs.create({ runId: "run_race2", conversationId: "conversation_race1", request: { prompt: "second race candidate" } });
  setup.close();

  const shared = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3));
  const workerCode = `
    (async () => {
    const { parentPort, workerData } = require("node:worker_threads");
    const gate = new Int32Array(workerData.gate);
    let store;
    try {
      const { tsImport } = await import("tsx/esm/api");
      const { openStorage } = await tsImport(workerData.moduleUrl, workerData.parentUrl);
      store = openStorage({ path: workerData.path, busyTimeoutMs: 1000 });
      Atomics.add(gate, 1, 1);
      Atomics.notify(gate, 1);
      if (Atomics.wait(gate, 0, 0, 5000) === "timed-out") throw new Error("claim race barrier timed out");
      try {
        const slot = store.activeSlot.claim({ runId: workerData.runId, claimToken: workerData.claimToken, workerBootId: workerData.workerBootId });
        parentPort.postMessage({ kind: "result", result: "claimed", generation: slot.generation });
      } catch (error) {
        parentPort.postMessage({ kind: "result", result: error && typeof error === "object" && "code" in error ? error.code : "error", message: error instanceof Error ? error.message : "unknown" });
      }
    } catch (error) {
      Atomics.add(gate, 2, 1);
      Atomics.notify(gate, 1);
      parentPort.postMessage({ kind: "startup-error", message: error instanceof Error ? error.message : "unknown" });
    } finally { store?.close(); }
    })();
  `;
  const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
  const workers = [
    new Worker(workerCode, { eval: true, execArgv: [], workerData: { path, moduleUrl, parentUrl: import.meta.url, runId: "run_race1", claimToken: "race_claim1", workerBootId: "worker_race1", gate: shared.buffer } }),
    new Worker(workerCode, { eval: true, execArgv: [], workerData: { path, moduleUrl, parentUrl: import.meta.url, runId: "run_race2", claimToken: "race_claim2", workerBootId: "worker_race2", gate: shared.buffer } }),
  ];
  try {
    const resultPromises = workers.map((worker) => new Promise<{ kind: string; result?: string; generation?: number; message?: string }>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => { if (code !== 0) reject(new Error(`Race worker exited with ${code}`)); });
    }));
    const deadline = Date.now() + 5000;
    while (Atomics.load(shared, 1) + Atomics.load(shared, 2) < 2 && Date.now() < deadline) {
      const ready = Atomics.load(shared, 1);
      Atomics.wait(shared, 1, ready, 100);
    }
    Atomics.store(shared, 0, 1);
    Atomics.notify(shared, 0, 2);
    const results = await Promise.all(resultPromises);
    assert.equal(Atomics.load(shared, 1), 2, `both workers should open independent storage connections before the race; results: ${JSON.stringify(results)}`);
    assert.equal(Atomics.load(shared, 2), 0, `storage connections should open without startup errors; results: ${JSON.stringify(results)}`);
    assert.deepEqual(results.map((result) => result.result).sort(), ["active_task", "claimed"]);
    assert.deepEqual(results.map((result) => result.kind), ["result", "result"]);
    assert.equal(results.find((result) => result.result === "claimed")?.generation, 1);
    const verification = openStorage({ path });
    try { assert.ok(["run_race1", "run_race2"].includes(verification.activeSlot.get().runId ?? "")); }
    finally { verification.close(); }
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("idempotency replays the same resource and rejects a changed request hash", () => withDb((_root, path) => {
  const store = openStorage({ path });
  const { run } = createBase(store);
  const key = { schemaVersion: 2 as const, scope: "local", endpoint: "POST /api/v2/runs", key: "dedupe-1", requestHash: run.requestHash };
  const result = { schemaVersion: 2 as const, resourceKind: "run" as const, resourceId: run.runId };
  assert.equal(store.idempotency.lookup(key, result), undefined);
  assert.deepEqual(store.idempotency.resolve(key, result), { result, replayed: false });
  assert.deepEqual(store.idempotency.resolve(key, result), { result, replayed: true });
  assert.deepEqual(store.idempotency.lookup(key, result), { result, replayed: true });
  assert.throws(() => store.idempotency.resolve({ ...key, requestHash: "b".repeat(64) }, result),
    (error: unknown) => error instanceof StorageError && error.code === "conflict");
  assert.throws(() => store.idempotency.lookup({ ...key, requestHash: "b".repeat(64) }, result),
    (error: unknown) => error instanceof StorageError && error.code === "conflict");
  assert.throws(() => store.idempotency.lookup(key, { ...result, resourceId: "run_other" }),
    (error: unknown) => error instanceof StorageError && error.code === "conflict");
  store.close();
}));

test("idempotent run creation stores the run and key together and never leaves a duplicate", () => withDb((_root, path) => {
  const store = openStorage({ path });
  store.projects.create({ id: "project_1", displayName: "Synthetic project", canonicalRoot: "/tmp/pi-fixture-1", directoryIdentity: null, validationState: "valid" });
  store.conversations.create({ id: "conversation_1", projectId: "project_1", piSessionId: null, title: "Synthetic conversation" });
  const key = { scope: "local", endpoint: "POST /api/v2/runs", key: "submit-1" };
  const first = store.runs.createIdempotent({ runId: "run_once", conversationId: "conversation_1", request: { prompt: "same" } }, key);
  const replay = store.runs.createIdempotent({ runId: "run_generated_again", conversationId: "conversation_1", request: { prompt: "same" } }, key);
  assert.equal(first.run.runId, "run_once");
  assert.equal(first.replayed, false);
  assert.equal(replay.run.runId, "run_once");
  assert.equal(replay.replayed, true);
  assert.equal(store.runs.get("run_generated_again"), undefined);
  assert.throws(() => store.runs.createIdempotent({ runId: "run_conflict", conversationId: "conversation_1", request: { prompt: "different" } }, key),
    (error: unknown) => error instanceof StorageError && error.code === "conflict");
  assert.equal(store.runs.get("run_conflict"), undefined);
  store.close();
}));

test("attempt usage stays incomplete until cost provenance has been recorded", () => withDb((_root, path) => {
  const store = openStorage({ path });
  const { attempt } = createBase(store);
  const baseUsage = {
    attemptId: attempt.attemptId, modelId: "offline-fixture", modelCalls: 0, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
    updatedAt: at,
  };
  store.usage.record({ ...baseUsage, estimatedCostUsd: null, costStatus: "unknown", pricingVersion: null });
  assert.throws(() => store.attempts.finish(attempt.attemptId, "completed", at, undefined, true),
    (error: unknown) => error instanceof StorageError && error.code === "invalid_input");
  assert.equal(store.attempts.get(attempt.attemptId)?.status, "running");
  assert.throws(() => store.usage.record({ ...baseUsage, estimatedCostUsd: null, costStatus: "estimate", pricingVersion: "synthetic-fixture" }),
    (error: unknown) => error instanceof StorageError && error.code === "invalid_input");
  store.usage.record({ ...baseUsage, estimatedCostUsd: 0, costStatus: "estimate", pricingVersion: "synthetic-fixture" });
  assert.equal(store.attempts.finish(attempt.attemptId, "completed", at, undefined, true).usageComplete, true);
  store.close();
}));

test("busy and read-only errors are bounded and do not appear as success", () => withDb((_root, path) => {
  const store = openStorage({ path, busyTimeoutMs: 100 });
  const lock = new DatabaseSync(path, { timeout: 100 });
  lock.exec("BEGIN IMMEDIATE");
  const start = Date.now();
  assert.throws(() => store.projects.create({ id: "blocked", displayName: "Busy", canonicalRoot: "/tmp/pi-busy", directoryIdentity: null, validationState: "valid" }),
    (error: unknown) => error instanceof StorageError && error.code === "db_busy");
  assert.ok(Date.now() - start < 2000, "busy failure should be bounded");
  lock.exec("ROLLBACK");
  store.close();

  const readOnly = openStorage({ path, readOnly: true });
  assert.throws(() => readOnly.projects.create({ id: "readonly", displayName: "Read only", canonicalRoot: "/tmp/pi-readonly", directoryIdentity: null, validationState: "valid" }),
    (error: unknown) => error instanceof StorageError && error.code === "db_readonly");
  readOnly.close();
}));

test("credential-like metadata and token values are rejected before persistence", () => withDb((_root, path) => {
  const store = openStorage({ path });
  createBase(store);
  assert.throws(() => store.runs.create({ runId: "run_secret", conversationId: "conversation_1", request: { apiKey: "fake" } }),
    (error: unknown) => error instanceof StorageError && error.code === "invalid_input");
  assert.throws(() => store.messages.append({ id: "message_secret", conversationId: "conversation_1", runId: null, role: "user", content: `token ${"sk-"}${"x".repeat(24)}`, source: "user", extensionId: null }),
    (error: unknown) => error instanceof StorageError && error.code === "invalid_input");
  assert.equal(store.messages.list("conversation_1").length, 0);
  store.close();
}));
