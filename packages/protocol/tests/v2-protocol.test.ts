import assert from "node:assert/strict";
import test from "node:test";
import {
  parse, V2AttachmentResultSchema, V2ChangesetSchema, V2CleanupPreviewSchema,
  parseV2AttemptIdentity, parseV2Error, parseV2EventCursor, parseV2IdempotencyRequest,
  parseV2Run, parseV2RunAttempt, parseV2RunEvent, parseV2RunEventPage,
} from "../src/index.js";

const timestamp = "2026-10-01T00:00:00.000Z";
const run = {
  schemaVersion: 2, runId: "run_1", conversationId: "conversation_1", projectId: null,
  extensionId: null, status: "accepted", requestHash: "a".repeat(64),
  createdAt: timestamp, updatedAt: timestamp,
};
const error = { schemaVersion: 2, code: "db_busy", message: "Retry later", retryable: true };
const acceptedEvent = {
  schemaVersion: 2, eventId: "event_1", runId: "run_1", attemptId: "attempt_1", sequence: 1,
  timestamp, type: "run.accepted", data: { conversationId: "conversation_1", requestHash: "a".repeat(64) },
};

test("v2 run, attempt, error, and idempotency contracts require their own schema version", () => {
  assert.equal(parseV2Run(run).status, "accepted");
  assert.equal(parseV2AttemptIdentity({ schemaVersion: 2, runId: "run_1", attemptId: "attempt_1", attemptNumber: 1 }).attemptNumber, 1);
  assert.equal(parseV2Error(error).retryable, true);
  assert.equal(parseV2IdempotencyRequest({ schemaVersion: 2, scope: "local", endpoint: "POST /api/v2/runs", key: "request-1", requestHash: "b".repeat(64) }).key, "request-1");

  for (const bad of [
    { ...run, schemaVersion: 1 }, { ...run, status: "queued" }, { ...run, hidden: true },
    { ...run, status: "completed" }, { ...run, endedAt: "2026-09-30T00:00:00.000Z" },
    { ...run, updatedAt: "2026-09-30T00:00:00.000Z" },
  ]) assert.throws(() => parseV2Run(bad));
  assert.equal(parseV2Run({ ...run, status: "completed", updatedAt: "2026-10-01T00:02:00.000Z", endedAt: "2026-10-01T00:01:00.000Z" }).status, "completed");
  assert.throws(() => parseV2Run({ ...run, status: "completed", updatedAt: timestamp, endedAt: "2026-10-01T00:01:00.000Z" }));
  assert.throws(() => parseV2AttemptIdentity({ schemaVersion: 2, runId: "run_1", attemptId: "attempt_1", attemptNumber: 0 }));
  assert.throws(() => parseV2Error({ ...error, schemaVersion: 1 }));
  assert.throws(() => parseV2Error({ ...error, code: "arbitrary" }));
  assert.throws(() => parseV2IdempotencyRequest({ schemaVersion: 2, scope: "local", endpoint: "POST /api/v2/runs", key: "", requestHash: "b".repeat(64) }));

  const failedAttempt = {
    schemaVersion: 2, runId: "run_1", attemptId: "attempt_1", attemptNumber: 1,
    status: "failed", usageComplete: false, startedAt: timestamp, endedAt: timestamp, error,
  };
  assert.equal(parseV2RunAttempt(failedAttempt).status, "failed");
  assert.throws(() => parseV2RunAttempt({ ...failedAttempt, error: undefined }));
  assert.throws(() => parseV2RunAttempt({ ...failedAttempt, status: "completed" }));
  assert.throws(() => parseV2RunAttempt({ ...failedAttempt, startedAt: "2026-10-01T00:01:00.000Z" }));
});

test("v2 event envelope and cursor enforce identities, positive sequence, and monotone pages", () => {
  assert.equal(parseV2RunEvent(acceptedEvent).sequence, 1);
  const cursor = { schemaVersion: 2, runId: "run_1", afterSequence: 0 };
  assert.deepEqual(parseV2EventCursor(cursor), cursor);
  const second = {
    schemaVersion: 2, eventId: "event_2", runId: "run_1", attemptId: "attempt_1", sequence: 2,
    timestamp, type: "run.progress", data: { phase: "analysis", message: "Working" },
  };
  const page = {
    schemaVersion: 2, runId: "run_1", afterSequence: 0, events: [acceptedEvent, second],
    nextCursor: { schemaVersion: 2, runId: "run_1", afterSequence: 2, lastEventId: "event_2" },
  };
  assert.equal(parseV2RunEventPage(page).events.length, 2);
  const usageEvent = {
    schemaVersion: 2, eventId: "event_usage", runId: "run_1", attemptId: "attempt_1", sequence: 1,
    timestamp, type: "usage.updated", data: { modelCalls: 1, toolCalls: 0, inputTokens: 2, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 6, costStatus: "unknown" },
  };
  assert.equal(parseV2RunEvent(usageEvent).type, "usage.updated");
  assert.throws(() => parseV2RunEvent({ ...usageEvent, data: { ...usageEvent.data, totalTokens: 5 } }));
  assert.throws(() => parseV2RunEvent({ ...usageEvent, data: { ...usageEvent.data, costStatus: "estimate" } }));
  for (const bad of [
    { ...acceptedEvent, schemaVersion: 1 }, { ...acceptedEvent, sequence: 0 },
    { ...acceptedEvent, type: "unregistered.event" }, { ...acceptedEvent, data: { ...acceptedEvent.data, secret: "token" } },
    { ...acceptedEvent, attemptId: "bad attempt" },
  ]) assert.throws(() => parseV2RunEvent(bad));
  for (const badPage of [
    { ...page, events: [acceptedEvent, { ...second, sequence: 1 }] },
    { ...page, events: [{ ...acceptedEvent, sequence: 2 }] },
    { ...page, events: [acceptedEvent], nextCursor: { ...page.nextCursor, afterSequence: 2 } },
    { ...page, nextCursor: { ...page.nextCursor, lastEventId: "wrong_event" } },
    { ...page, runId: "other_run" },
  ]) assert.throws(() => parseV2RunEventPage(badPage));
});

test("project file event, diff, cleanup, and attachment result contracts reject malformed values", () => {
  const fileEvent = {
    schemaVersion: 2, eventId: "event_file", runId: "run_1", attemptId: "attempt_1", sequence: 2,
    timestamp, type: "file_change_applied", data: {
      changesetId: "changeset_1", operationId: "operation_1", path: "src/index.ts", postHash: "b".repeat(64),
    },
  };
  assert.equal(parseV2RunEvent(fileEvent).type, "file_change_applied");
  assert.throws(() => parseV2RunEvent({ ...fileEvent, data: { ...fileEvent.data, path: "../outside.ts" } }));
  const changeset = {
    schemaVersion: 2, changesetId: "changeset_1", conversationId: "conversation_1", projectId: "project_1",
    status: "applied", createdAt: timestamp, updatedAt: timestamp,
    operations: [{ schemaVersion: 2, operationId: "operation_1", changesetId: "changeset_1", sequence: 1,
      path: "src/index.ts", kind: "replace", status: "applied", preHash: "a".repeat(64), postHash: "b".repeat(64) }],
    diffs: [{ path: "src/index.ts", status: "applied", beforeText: "old", afterText: "new", diffText: "-old\n+new", truncated: false }],
  };
  assert.equal(parse(V2ChangesetSchema, changeset).operations.length, 1);
  assert.throws(() => parse(V2ChangesetSchema, { ...changeset, operations: [{ ...changeset.operations[0], status: "success" }] }));
  assert.equal(parse(V2CleanupPreviewSchema, { schemaVersion: 2, changesetIds: ["changeset_1"], changesetCount: 1,
    backupObjectCount: 2, backupBytes: 10, losesUndoHistory: true, note: "Confirmed loss." }).backupBytes, 10);
  assert.equal(parse(V2AttachmentResultSchema, { schemaVersion: 2, resultId: "result_1", conversationId: "conversation_1",
    fileName: "edited.txt", byteSize: 3, mediaType: "text/plain; charset=utf-8", createdAt: timestamp }).fileName, "edited.txt");
});
