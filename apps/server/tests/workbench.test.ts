import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openStorage, resolveDatabasePath, StorageError } from "@pi-workbench/storage";
import { createWorkbenchApp } from "../src/app.js";
import type { V2Conversation, V2Run } from "@pi-workbench/protocol";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function temporaryRoot(): Promise<string> { return mkdtemp(path.join(os.tmpdir(), "pi-workbench-task011-")); }
async function createApp(root: string) {
  const app = await createWorkbenchApp({ mode: "fake", dataDirectory: root });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, baseUrl: address };
}
async function createConversation(baseUrl: string): Promise<V2Conversation> {
  const response = await fetch(`${baseUrl}/api/v2/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 201);
  return await response.json() as V2Conversation;
}
async function submit(baseUrl: string, conversationId: string, text: string, idempotencyKey = crypto.randomUUID()): Promise<Response> {
  return fetch(`${baseUrl}/api/v2/runs`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ schemaVersion: 2, conversationId, input: { kind: "message", text } }),
  });
}
async function fetchRun(baseUrl: string, runId: string): Promise<V2Run> {
  const response = await fetch(`${baseUrl}/api/v2/runs/${runId}`);
  assert.equal(response.status, 200);
  return await response.json() as V2Run;
}
async function waitForRun(baseUrl: string, runId: string, wanted?: string): Promise<V2Run> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const run = await fetchRun(baseUrl, runId);
    if (wanted ? run.status === wanted : ["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return run;
    await sleep(20);
  }
  throw new Error(`Run ${runId} did not reach the expected state`);
}
async function waitForWorker(baseUrl: string): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await fetch(`${baseUrl}/api/v2/health`);
    const health = await response.json() as { workerReady: boolean };
    if (health.workerReady) return true;
    await sleep(25);
  }
  return false;
}

await test("v2 Worker persists ordinary conversations and real SSE replays after restart", { timeout: 30_000 }, async (t) => {
  const root = await temporaryRoot();
  let { app, baseUrl } = await createApp(root);
  t.after(async () => { await app.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  const health = await fetch(`${baseUrl}/api/v2/health`).then((response) => response.json()) as { workerReady: boolean };
  assert.equal(health.workerReady, true, "API must wait for its supervised Worker to report ready");

  const conversation = await createConversation(baseUrl);
  const invalid = await fetch(`${baseUrl}/api/v2/runs`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ schemaVersion: 2, conversationId: conversation.conversationId, input: { kind: "message", text: "" } }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as { code: string }).code, "invalid_request");
  assert.deepEqual((await fetch(`${baseUrl}/api/v2/conversations/${conversation.conversationId}/runs`).then((response) => response.json()) as { runs: unknown[] }).runs, []);
  const idem = crypto.randomUUID();
  const submitted = await submit(baseUrl, conversation.conversationId, "first persisted prompt", idem);
  assert.equal(submitted.status, 202);
  const first = await submitted.json() as V2Run;
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.status, "running");
  const done = await waitForRun(baseUrl, first.runId, "completed");
  assert.match(done.result?.status === "completed" ? done.result.reply : "", /first persisted prompt/u);

  const replay = await submit(baseUrl, conversation.conversationId, "first persisted prompt", idem);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as V2Run).runId, first.runId);
  const conflict = await submit(baseUrl, conversation.conversationId, "different prompt", idem);
  assert.equal(conflict.status, 409);

  const originalSse = await fetch(`${baseUrl}/api/v2/runs/${first.runId}/events`);
  assert.equal(originalSse.status, 200);
  assert.match(originalSse.headers.get("content-type") ?? "", /text\/event-stream/u);
  const frames = (await originalSse.text()).split(/\r?\n\r?\n/u).filter((frame) => /^event: /mu.test(frame));
  const actualEvents = frames.filter((frame) => !/^event: stream\.reset$/mu.test(frame));
  assert.ok(actualEvents.some((frame) => /^event: run.completed$/mu.test(frame)), actualEvents.join("\n\n"));
  const eventIds = actualEvents.map((frame) => frame.match(/^id: ([A-Za-z0-9_-]+)$/mu)?.[1]).filter(Boolean) as string[];
  assert.ok(eventIds.length >= 4);
  assert.equal(new Set(eventIds).size, eventIds.length);

  const reconnected = await fetch(`${baseUrl}/api/v2/runs/${first.runId}/events`, { headers: { "last-event-id": eventIds[0]! } });
  const resumedFrames = (await reconnected.text()).split(/\r?\n\r?\n/u).filter((frame) => /^event: /mu.test(frame));
  assert.equal(resumedFrames.some((frame) => frame.includes(`id: ${eventIds[0]}`)), false);
  assert.ok(resumedFrames.some((frame) => /^event: run.completed$/mu.test(frame)));

  const db = openStorage({ dataDirectory: { dataDirectory: root } });
  assert.equal(db.snapshots.latest(conversation.conversationId)?.sdkVersion, "0.86.1");
  assert.ok(db.events.latestSequence(first.runId) >= eventIds.length);
  assert.equal(db.attempts.list(first.runId).length, 1);
  db.close();

  await app.close();
  ({ app, baseUrl } = await createApp(root));
  assert.equal(await waitForWorker(baseUrl), true);
  const loaded = await fetch(`${baseUrl}/api/v2/conversations/${conversation.conversationId}`).then((response) => response.json()) as V2Conversation;
  assert.equal(loaded.messages.length, 2);
  assert.equal((await fetchRun(baseUrl, first.runId)).status, "completed");
  const next = await submit(baseUrl, conversation.conversationId, "continue the durable session");
  assert.equal(next.status, 202);
  assert.equal((await waitForRun(baseUrl, (await next.json() as V2Run).runId, "completed")).status, "completed");

  const failedResponse = await submit(baseUrl, conversation.conversationId, "[[fake:fail]] test retry behavior");
  const failed = await failedResponse.json() as V2Run;
  assert.equal((await waitForRun(baseUrl, failed.runId, "failed")).status, "failed");
  const retriedResponse = await fetch(`${baseUrl}/api/v2/runs/${failed.runId}/retry`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: "{}",
  });
  assert.equal(retriedResponse.status, 202);
  const retried = await retriedResponse.json() as V2Run;
  assert.notEqual(retried.runId, failed.runId);
  assert.equal(retried.retryOfRunId, failed.runId);
  assert.equal((await waitForRun(baseUrl, retried.runId, "failed")).status, "failed");
});

await test("global Worker slot serializes runs; cancellation waits for stop and conversation deletion is permanent", { timeout: 30_000 }, async (t) => {
  const root = await temporaryRoot();
  let { app, baseUrl } = await createApp(root);
  t.after(async () => { await app.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  const first = await createConversation(baseUrl);
  const second = await createConversation(baseUrl);
  const activeKey = crypto.randomUUID();
  const running = await submit(baseUrl, first.conversationId, "[[fake:slow]] keep waiting", activeKey);
  assert.equal(running.status, 202);
  const run = await running.json() as V2Run;
  await waitForRun(baseUrl, run.runId, "running");
  const duplicate = await submit(baseUrl, first.conversationId, "[[fake:slow]] keep waiting", activeKey);
  assert.equal(duplicate.status, 200, "a retry with the same idempotency key must replay the active run");
  assert.equal((await duplicate.json() as V2Run).runId, run.runId);
  const competingKey = crypto.randomUUID();
  const competing = await submit(baseUrl, second.conversationId, "must wait", competingKey);
  assert.equal(competing.status, 409);
  assert.equal((await fetch(`${baseUrl}/api/v2/conversations/${first.conversationId}`, { method: "DELETE" })).status, 409);

  const cancel = await fetch(`${baseUrl}/api/v2/runs/${run.runId}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json() as V2Run).status, "cancelling");
  assert.equal((await waitForRun(baseUrl, run.runId, "cancelled")).status, "cancelled");

  const acceptedAfterRelease = await submit(baseUrl, second.conversationId, "must wait", competingKey);
  assert.equal(acceptedAfterRelease.status, 202, "a rejected busy request must not leave an idempotency record or orphan run");
  const otherRun = await acceptedAfterRelease.json() as V2Run;
  assert.equal((await waitForRun(baseUrl, otherRun.runId, "completed")).status, "completed");

  const beforeDeleteDb = openStorage({ dataDirectory: { dataDirectory: root } });
  const deletedAttemptIds = beforeDeleteDb.attempts.list(run.runId).map((attempt) => attempt.attemptId);
  beforeDeleteDb.close();
  const deletion = await fetch(`${baseUrl}/api/v2/conversations/${first.conversationId}`, { method: "DELETE" });
  assert.equal(deletion.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/v2/conversations/${first.conversationId}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/v2/conversations/${second.conversationId}`)).status, 200);
  const deletionDb = openStorage({ dataDirectory: { dataDirectory: root } });
  assert.deepEqual(deletionDb.messages.list(first.conversationId), []);
  assert.equal(deletionDb.snapshots.latest(first.conversationId), undefined);
  assert.deepEqual(deletionDb.runs.list(first.conversationId), []);
  assert.deepEqual(deletionDb.attempts.list(run.runId), []);
  assert.equal(deletionDb.events.latestSequence(run.runId), 0);
  assert.deepEqual(deletionDb.checkpoints.list(run.runId), []);
  assert.equal(deletionDb.results.get(run.runId), undefined);
  for (const attemptId of deletedAttemptIds) assert.equal(deletionDb.usage.get(attemptId), undefined);
  assert.throws(() => deletionDb.idempotency.resolve(
    { schemaVersion: 2, scope: first.conversationId, endpoint: "POST /api/v2/runs", key: activeKey, requestHash: run.requestHash },
    { schemaVersion: 2, resourceKind: "run", resourceId: run.runId },
  ), (error: unknown) => error instanceof StorageError && error.code === "not_found");
  deletionDb.close();
  const oldWrite = await fetch(`${baseUrl}/api/v1/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(oldWrite.status, 426);
  assert.equal((await oldWrite.json() as { code: string }).code, "upgrade_required");
  await app.close();
  ({ app, baseUrl } = await createApp(root));
  assert.equal(await waitForWorker(baseUrl), true);
  assert.equal((await fetch(`${baseUrl}/api/v2/conversations/${first.conversationId}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/v2/conversations/${second.conversationId}`)).status, 200);
});

await test("API restart detects Worker exit, marks run interrupted and only continues on explicit request", { timeout: 40_000 }, async (t) => {
  const root = await temporaryRoot();
  let { app, baseUrl } = await createApp(root);
  t.after(async () => { await app.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  const conversation = await createConversation(baseUrl);
  const submitted = await submit(baseUrl, conversation.conversationId, "[[fake:slow]] interrupted run");
  const run = await submitted.json() as V2Run;
  await waitForRun(baseUrl, run.runId, "running");
  const db = openStorage({ dataDirectory: { dataDirectory: root } });
  const identity = db.workerIdentity.get();
  assert.ok(identity);
  process.kill(identity!.pid, "SIGKILL");
  db.close();
  const interrupted = await waitForRun(baseUrl, run.runId, "interrupted");
  assert.equal(interrupted.status, "interrupted");
  assert.equal(await waitForWorker(baseUrl), true);

  const continueKey = crypto.randomUUID();
  const continuedResponse = await fetch(`${baseUrl}/api/v2/runs/${run.runId}/continue`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": continueKey }, body: "{}",
  });
  assert.equal(continuedResponse.status, 202);
  assert.equal((await continuedResponse.json() as V2Run).status, "running");
  const resumedDb = openStorage({ dataDirectory: { dataDirectory: root } });
  assert.equal(resumedDb.attempts.list(run.runId).length, 2);
  resumedDb.close();
  const duplicateContinue = await fetch(`${baseUrl}/api/v2/runs/${run.runId}/continue`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": continueKey }, body: "{}",
  });
  assert.equal(duplicateContinue.status, 200);
  assert.equal((await duplicateContinue.json() as V2Run).runId, run.runId);
  const duplicateDb = openStorage({ dataDirectory: { dataDirectory: root } });
  assert.equal(duplicateDb.attempts.list(run.runId).length, 2);
  duplicateDb.close();
  await fetch(`${baseUrl}/api/v2/runs/${run.runId}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal((await waitForRun(baseUrl, run.runId, "cancelled")).status, "cancelled");
  await app.close();
  ({ app, baseUrl } = await createApp(root));
  assert.equal((await fetchRun(baseUrl, run.runId)).status, "cancelled");
});

await test("terminal result and session snapshot roll back together on persistence failure", { timeout: 30_000 }, async (t) => {
  const root = await temporaryRoot();
  const { app, baseUrl } = await createApp(root);
  t.after(async () => { await app.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  const raw = new DatabaseSync(resolveDatabasePath({ dataDirectory: root }));
  raw.exec(`CREATE TRIGGER fail_terminal_event BEFORE INSERT ON run_events WHEN NEW.event_type = 'run.completed' BEGIN SELECT RAISE(ABORT, 'injected terminal event failure'); END;`);
  const conversation = await createConversation(baseUrl);
  const submitted = await submit(baseUrl, conversation.conversationId, "atomic finalization fixture");
  assert.equal(submitted.status, 202);
  const run = await submitted.json() as V2Run;
  let ready = true;
  for (let attempt = 0; attempt < 200 && ready; attempt += 1) {
    await sleep(20);
    ready = (await fetch(`${baseUrl}/api/v2/health`).then((response) => response.json()) as { workerReady: boolean }).workerReady;
  }
  assert.equal(ready, false, "failed terminal persistence must fence the Worker");
  const store = openStorage({ dataDirectory: { dataDirectory: root } });
  assert.equal(store.runs.get(run.runId)?.status, "running");
  assert.equal(store.results.get(run.runId), undefined);
  assert.equal(store.snapshots.latest(conversation.conversationId), undefined);
  assert.equal(store.messages.list(conversation.conversationId).length, 1);
  assert.equal(store.attempts.list(run.runId)[0]?.status, "running");
  assert.equal(store.activeSlot.get().runId, run.runId);
  store.close();
  raw.exec("DROP TRIGGER fail_terminal_event");
  raw.close();
  await app.close();
  const recovered = openStorage({ dataDirectory: { dataDirectory: root } });
  assert.equal(recovered.runs.get(run.runId)?.status, "interrupted");
  assert.equal(recovered.snapshots.latest(conversation.conversationId), undefined);
  recovered.close();
});
