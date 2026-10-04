import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openStorage, resolveDatabasePath, StorageError } from "@pi-workbench/storage";
import { createWorkbenchApp } from "../src/app.js";
import { localFetch, injectedSessionHeaders, localSessionHeaders } from "./local-client.js";
import type { V2Conversation, V2Run } from "@pi-workbench/protocol";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function temporaryRoot(): Promise<string> { return mkdtemp(path.join(os.tmpdir(), "pi-workbench-task011-")); }
async function createApp(root: string, workerEntryPath?: string) {
  const app = await createWorkbenchApp({ mode: "fake", dataDirectory: root, ...(workerEntryPath ? { workerEntryPath } : {}) });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, baseUrl: address };
}
async function createConversation(baseUrl: string): Promise<V2Conversation> {
  const response = await localFetch(`${baseUrl}/api/v2/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 201);
  return await response.json() as V2Conversation;
}
async function pickerHeaders(baseUrl: string): Promise<Record<string, string>> {
  const origin = new URL(baseUrl).origin;
  const response = await fetch(`${baseUrl}/api/v2/picker/session`, { method: "POST", headers: { origin } });
  assert.equal(response.status, 200);
  const session = await response.json() as { csrfToken: string };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return { origin, cookie, "x-csrf-token": session.csrfToken };
}
async function submit(baseUrl: string, conversationId: string, text: string, idempotencyKey = crypto.randomUUID()): Promise<Response> {
  return localFetch(`${baseUrl}/api/v2/runs`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ schemaVersion: 2, conversationId, input: { kind: "message", text } }),
  });
}
async function fetchRun(baseUrl: string, runId: string): Promise<V2Run> {
  const response = await localFetch(`${baseUrl}/api/v2/runs/${runId}`);
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
    const response = await localFetch(`${baseUrl}/api/v2/health`);
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
  const health = await localFetch(`${baseUrl}/api/v2/health`).then((response) => response.json()) as { workerReady: boolean };
  assert.equal(health.workerReady, true, "API must wait for its supervised Worker to report ready");

  const conversation = await createConversation(baseUrl);
  const invalid = await localFetch(`${baseUrl}/api/v2/runs`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ schemaVersion: 2, conversationId: conversation.conversationId, input: { kind: "message", text: "" } }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as { code: string }).code, "invalid_request");
  assert.deepEqual((await localFetch(`${baseUrl}/api/v2/conversations/${conversation.conversationId}/runs`).then((response) => response.json()) as { runs: unknown[] }).runs, []);
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

  const originalSse = await localFetch(`${baseUrl}/api/v2/runs/${first.runId}/events`);
  assert.equal(originalSse.status, 200);
  assert.match(originalSse.headers.get("content-type") ?? "", /text\/event-stream/u);
  const frames = (await originalSse.text()).split(/\r?\n\r?\n/u).filter((frame) => /^event: /mu.test(frame));
  const actualEvents = frames.filter((frame) => !/^event: stream\.reset$/mu.test(frame));
  assert.ok(actualEvents.some((frame) => /^event: run.completed$/mu.test(frame)), actualEvents.join("\n\n"));
  const eventIds = actualEvents.map((frame) => frame.match(/^id: ([A-Za-z0-9_-]+)$/mu)?.[1]).filter(Boolean) as string[];
  assert.ok(eventIds.length >= 4);
  assert.equal(new Set(eventIds).size, eventIds.length);

  const reconnected = await localFetch(`${baseUrl}/api/v2/runs/${first.runId}/events`, { headers: { "last-event-id": eventIds[0]! } });
  const resumedFrames = (await reconnected.text()).split(/\r?\n\r?\n/u).filter((frame) => /^event: /mu.test(frame));
  assert.equal(resumedFrames.some((frame) => frame.includes(`id: ${eventIds[0]}`)), false);
  assert.ok(resumedFrames.some((frame) => /^event: run.completed$/mu.test(frame)));

  const db = openStorage({ dataDirectory: { dataDirectory: root } });
  assert.equal(db.snapshots.latest(conversation.conversationId)?.sdkVersion, "0.86.1");
  assert.ok(db.events.latestSequence(first.runId) >= eventIds.length);
  assert.equal(db.attempts.list(first.runId).length, 1);
  const attempt = db.attempts.list(first.runId).at(-1)!;
  const syntheticHistory: Array<ReturnType<typeof db.events.append>> = [];
  for (let index = 0; index < 1205; index++) {
    syntheticHistory.push(db.events.append({ eventId: crypto.randomUUID(), runId: first.runId, attemptId: attempt.attemptId, type: "run.progress",
      data: { phase: "sse-page-test", message: `historical ${index}` } }));
  }
  const highWater = db.events.latestSequence(first.runId);
  const pagedResponse = await localFetch(`${baseUrl}/api/v2/runs/${first.runId}/events`);
  const pagedFrames = (await pagedResponse.text()).split(/\r?\n\r?\n/u).filter((frame) => /^id: /mu.test(frame));
  const pagedEvents = pagedFrames.map((frame) => JSON.parse(frame.match(/^data: (.+)$/mu)?.[1] ?? "null") as { eventId: string; sequence: number; type: string });
  assert.equal(pagedEvents.length, highWater, "SSE must stream every replay page even when the run is terminal");
  assert.deepEqual(pagedEvents.map((event) => event.sequence), Array.from({ length: highWater }, (_, index) => index + 1));
  assert.ok(pagedEvents.some((event) => event.type === "run.completed"));

  const pagedResume = await localFetch(`${baseUrl}/api/v2/runs/${first.runId}/events`, { headers: { "last-event-id": syntheticHistory[99]!.eventId } });
  const pagedResumeFrames = (await pagedResume.text()).split(/\r?\n\r?\n/u).filter((frame) => /^id: /mu.test(frame));
  const pagedResumeEvents = pagedResumeFrames.map((frame) => JSON.parse(frame.match(/^data: (.+)$/mu)?.[1] ?? "null") as { eventId: string; sequence: number });
  assert.equal(pagedResumeEvents[0]?.sequence, syntheticHistory[99]!.sequence + 1);
  assert.equal(pagedResumeEvents.at(-1)?.sequence, highWater);
  assert.equal(pagedResumeEvents.some((event) => event.eventId === syntheticHistory[99]!.eventId), false);

  const invalidCursorResponse = await localFetch(`${baseUrl}/api/v2/runs/${first.runId}/events`, { headers: { "last-event-id": "unknown-event-id" } });
  const invalidCursorFrames = (await invalidCursorResponse.text()).split(/\r?\n\r?\n/u).filter((frame) => /^event: stream\.reset$/mu.test(frame));
  assert.equal(invalidCursorFrames.length, 1);
  const reset = JSON.parse(invalidCursorFrames[0]!.match(/^data: (.+)$/mu)?.[1] ?? "null") as { data: { latestSequence: number; latestEventId: string } };
  assert.equal(reset.data.latestSequence, highWater);
  assert.equal(reset.data.latestEventId, syntheticHistory.at(-1)?.eventId);
  db.close();

  await app.close();
  ({ app, baseUrl } = await createApp(root));
  assert.equal(await waitForWorker(baseUrl), true);
  const loaded = await localFetch(`${baseUrl}/api/v2/conversations/${conversation.conversationId}`).then((response) => response.json()) as V2Conversation;
  assert.equal(loaded.messages.length, 2);
  assert.equal((await fetchRun(baseUrl, first.runId)).status, "completed");
  const next = await submit(baseUrl, conversation.conversationId, "continue the durable session");
  assert.equal(next.status, 202);
  assert.equal((await waitForRun(baseUrl, (await next.json() as V2Run).runId, "completed")).status, "completed");

  const failedResponse = await submit(baseUrl, conversation.conversationId, "[[fake:fail]] test retry behavior");
  const failed = await failedResponse.json() as V2Run;
  assert.equal((await waitForRun(baseUrl, failed.runId, "failed")).status, "failed");
  const retriedResponse = await localFetch(`${baseUrl}/api/v2/runs/${failed.runId}/retry`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: "{}",
  });
  assert.equal(retriedResponse.status, 202);
  const retried = await retriedResponse.json() as V2Run;
  assert.notEqual(retried.runId, failed.runId);
  assert.equal(retried.retryOfRunId, failed.runId);
  assert.equal((await waitForRun(baseUrl, retried.runId, "failed")).status, "failed");
});

await test("a paused HTTP SSE client receives the full replay before a live terminal event", { timeout: 45_000 }, async (t) => {
  const root = await temporaryRoot();
  const workerEntryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/workbench/tests/fixtures/usage-safety-worker.ts");
  const { app, baseUrl } = await createApp(root, workerEntryPath);
  t.after(async () => { await app.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  const conversation = await createConversation(baseUrl);
  const submitted = await submit(baseUrl, conversation.conversationId, "[[test:before-call]] hold while SSE replays");
  assert.equal(submitted.status, 202);
  const run = await submitted.json() as V2Run;
  await waitForRun(baseUrl, run.runId, "running");
  const marker = path.join(root, "usage-safety-before-call-paused");
  for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt++) await sleep(10);
  assert.ok(existsSync(marker), "the Worker fixture must reach its deterministic pre-call pause");

  const db = openStorage({ dataDirectory: { dataDirectory: root } });
  const attempt = db.attempts.list(run.runId).at(-1)!;
  for (let index = 0; index < 1205; index++) {
    db.events.append({ eventId: crypto.randomUUID(), runId: run.runId, attemptId: attempt.attemptId, type: "run.progress",
      data: { phase: "slow-client-replay", message: `${index}: ${"x".repeat(1900)}` } });
  }
  db.close();

  const request = httpRequest(new URL(`/api/v2/runs/${run.runId}/events`, baseUrl), { headers: await localSessionHeaders(baseUrl) });
  t.after(() => request.destroy());
  const responsePromise = new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
  });
  request.end();
  const response = await responsePromise;
  assert.equal(response.statusCode, 200);
  response.pause();

  const workerDb = openStorage({ dataDirectory: { dataDirectory: root } });
  const identity = workerDb.workerIdentity.get();
  assert.ok(identity);
  process.kill(identity!.pid, "SIGKILL");
  workerDb.close();
  assert.equal((await waitForRun(baseUrl, run.runId, "interrupted")).status, "interrupted");

  const bodyPromise = new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.once("error", reject);
  });
  response.resume();
  const body = await bodyPromise;
  const frames = body.split(/\r?\n\r?\n/u).filter((frame) => /^id: /mu.test(frame));
  const events = frames.map((frame) => JSON.parse(frame.match(/^data: (.+)$/mu)?.[1] ?? "null") as { sequence: number; type: string });
  assert.ok(events.length > 1205);
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1));
  assert.equal(new Set(frames.map((frame) => frame.match(/^id: (.+)$/mu)?.[1])).size, frames.length);
  assert.equal(events.at(-1)?.type, "run.interrupted", "the live terminal event follows full replay and closes the stream");
});

await test("capability catalog, guarded state updates, disabled rejection, and tool extension execution", { timeout: 30_000 }, async (t) => {
  const root = await temporaryRoot();
  const { app, baseUrl } = await createApp(root);
  t.after(async () => { await app.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  assert.equal(await waitForWorker(baseUrl), true);

  const catalog = await localFetch(`${baseUrl}/api/v2/capabilities`).then((response) => response.json()) as {
    capabilities: Array<{ manifest: { id: string; apiVersion: string; kind: string }; enabled: boolean; status: string }>;
  };
  assert.equal(catalog.capabilities.length, 2);
  const greeting = catalog.capabilities.find((entry) => entry.manifest.id === "development_greeting_tool");
  assert.equal(greeting?.manifest.kind, "tools");
  assert.equal(greeting?.enabled, false);

  const conversation = await createConversation(baseUrl);
  const call = { schemaVersion: 2, conversationId: conversation.conversationId, input: {
    kind: "capability", capabilityId: "development_greeting_tool", input: {}, prompt: "[[demo:greeting-tool]]",
  } };
  const disabled = await localFetch(`${baseUrl}/api/v2/runs`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(call),
  });
  assert.equal(disabled.status, 409);
  assert.equal((await disabled.json() as { code: string }).code, "extension_disabled");

  const denied = await fetch(`${baseUrl}/api/v2/capabilities/development_greeting_tool/state`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 2, enabled: true }),
  });
  assert.equal(denied.status, 403);
  const headers = await pickerHeaders(baseUrl);
  const enabled = await localFetch(`${baseUrl}/api/v2/capabilities/development_greeting_tool/state`, {
    method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 2, enabled: true }),
  });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json() as { capability: { status: string } }).capability.status, "enabled");

  const unknown = await localFetch(`${baseUrl}/api/v2/runs`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ ...call, input: { ...call.input, capabilityId: "unregistered_extension" } }),
  });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json() as { code: string }).code, "unknown_extension");

  const submitted = await localFetch(`${baseUrl}/api/v2/runs`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(call),
  });
  assert.equal(submitted.status, 202);
  const accepted = await submitted.json() as V2Run;
  assert.equal(accepted.input?.kind, "capability");
  if (accepted.input?.kind !== "capability") throw new Error("Expected a capability run");
  assert.equal(accepted.input.apiVersion, "1.0");
  assert.deepEqual(accepted.input.configSnapshot, {});
  const completed = await waitForRun(baseUrl, accepted.runId, "completed");
  assert.equal(completed.result?.status, "completed");
  if (completed.result?.status !== "completed") throw new Error("Expected a completed tool run");
  assert.equal(completed.result.extensionResult?.extensionId, "development_greeting_tool");
  const output = completed.result.extensionResult?.output as { toolCalls?: Array<{ toolName: string; result: { message: string } }> };
  assert.equal(output.toolCalls?.[0]?.toolName, "development_greeting_tool__make_greeting");
  assert.equal(output.toolCalls?.[0]?.result.message, "Hello, PI Workbench.");

  const persisted = openStorage({ path: resolveDatabasePath({ dataDirectory: root }), readOnly: true });
  assert.equal(persisted.capabilityStates.get("development_greeting_tool")?.enabled, true);
  persisted.close();
});

await test("global Worker slot serializes runs; cancellation waits for stop and conversation deletion is permanent", { timeout: 30_000 }, async (t) => {
  const root = await temporaryRoot();
  let { app, baseUrl } = await createApp(root);
  t.after(async () => { await app.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  const first = await createConversation(baseUrl);
  const second = await createConversation(baseUrl);
  const picker = await pickerHeaders(baseUrl);
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
  assert.equal((await localFetch(`${baseUrl}/api/v2/conversations/${first.conversationId}`, { method: "DELETE", headers: picker })).status, 409);

  const cancel = await localFetch(`${baseUrl}/api/v2/runs/${run.runId}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
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
  const deletion = await localFetch(`${baseUrl}/api/v2/conversations/${first.conversationId}`, { method: "DELETE", headers: picker });
  assert.equal(deletion.status, 200);
  assert.equal((await localFetch(`${baseUrl}/api/v2/conversations/${first.conversationId}`)).status, 404);
  assert.equal((await localFetch(`${baseUrl}/api/v2/conversations/${second.conversationId}`)).status, 200);
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
  const oldWrite = await localFetch(`${baseUrl}/api/v1/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(oldWrite.status, 426);
  assert.equal((await oldWrite.json() as { code: string }).code, "upgrade_required");
  await app.close();
  ({ app, baseUrl } = await createApp(root));
  assert.equal(await waitForWorker(baseUrl), true);
  assert.equal((await localFetch(`${baseUrl}/api/v2/conversations/${first.conversationId}`)).status, 404);
  assert.equal((await localFetch(`${baseUrl}/api/v2/conversations/${second.conversationId}`)).status, 200);
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
  const continuedResponse = await localFetch(`${baseUrl}/api/v2/runs/${run.runId}/continue`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": continueKey }, body: "{}",
  });
  assert.equal(continuedResponse.status, 202);
  assert.equal((await continuedResponse.json() as V2Run).status, "running");
  const resumedDb = openStorage({ dataDirectory: { dataDirectory: root } });
  assert.equal(resumedDb.attempts.list(run.runId).length, 2);
  resumedDb.close();
  const duplicateContinue = await localFetch(`${baseUrl}/api/v2/runs/${run.runId}/continue`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": continueKey }, body: "{}",
  });
  assert.equal(duplicateContinue.status, 200);
  assert.equal((await duplicateContinue.json() as V2Run).runId, run.runId);
  const duplicateDb = openStorage({ dataDirectory: { dataDirectory: root } });
  assert.equal(duplicateDb.attempts.list(run.runId).length, 2);
  duplicateDb.close();
  await localFetch(`${baseUrl}/api/v2/runs/${run.runId}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal((await waitForRun(baseUrl, run.runId, "cancelled")).status, "cancelled");
  const duplicateAfterTerminal = await localFetch(`${baseUrl}/api/v2/runs/${run.runId}/continue`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": continueKey }, body: "{}",
  });
  assert.equal(duplicateAfterTerminal.status, 200, "an already committed replay succeeds even after its run becomes terminal");
  const terminalReplayDb = openStorage({ dataDirectory: { dataDirectory: root } });
  assert.equal(terminalReplayDb.attempts.list(run.runId).length, 2, "replay must not create a new attempt");
  terminalReplayDb.close();
  await app.close();
  ({ app, baseUrl } = await createApp(root));
  assert.equal((await fetchRun(baseUrl, run.runId)).status, "cancelled");
});

await test("terminal result rollback recovers the durable reply without another provider call", { timeout: 30_000 }, async (t) => {
  const root = await temporaryRoot();
  let { app, baseUrl } = await createApp(root);
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
    ready = (await localFetch(`${baseUrl}/api/v2/health`).then((response) => response.json()) as { workerReady: boolean }).workerReady;
  }
  assert.equal(ready, false, "failed terminal persistence must fence the Worker");
  const store = openStorage({ dataDirectory: { dataDirectory: root } });
  assert.equal(store.runs.get(run.runId)?.status, "running");
  assert.equal(store.results.get(run.runId), undefined);
  const safeSnapshot = store.snapshots.latest(conversation.conversationId);
  assert.ok(safeSnapshot, "the settled conversation checkpoint remains durable when terminal finalization fails");
  assert.equal(store.messages.list(conversation.conversationId).length, 1);
  const attempt = store.attempts.list(run.runId)[0];
  assert.equal(attempt?.status, "running");
  assert.equal(store.attemptSafety.get(attempt!.attemptId)?.state, "safe");
  assert.equal(store.attemptSafety.get(attempt!.attemptId)?.snapshotId, safeSnapshot.id);
  const settledUsage = store.usage.get(attempt!.attemptId);
  assert.ok(settledUsage?.modelCalls && settledUsage.modelCalls > 0);
  assert.equal(store.completedConversationResults.get(attempt!.attemptId)?.result.status, "completed");
  assert.equal(attempt?.usageComplete, false, "the still-running attempt has not committed terminal usage completion");
  assert.equal(store.activeSlot.get().runId, run.runId);
  store.close();
  raw.exec("DROP TRIGGER fail_terminal_event");
  raw.close();
  await app.close();
  ({ app, baseUrl } = await createApp(root));
  assert.equal(await waitForWorker(baseUrl), true);
  assert.equal((await fetchRun(baseUrl, run.runId)).status, "interrupted");
  const continueKey = crypto.randomUUID();
  const recoveredContinue = await localFetch(`${baseUrl}/api/v2/runs/${run.runId}/continue`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": continueKey }, body: "{}",
  });
  assert.equal(recoveredContinue.status, 202);
  assert.equal((await recoveredContinue.json() as V2Run).status, "completed");
  const repeated = await localFetch(`${baseUrl}/api/v2/runs/${run.runId}/continue`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": continueKey }, body: "{}",
  });
  assert.equal(repeated.status, 200);
  const recovered = openStorage({ dataDirectory: { dataDirectory: root } });
  assert.equal(recovered.snapshots.latest(conversation.conversationId)?.id, safeSnapshot.id);
  assert.equal((recovered.results.get(run.runId) as { result: { status: string } }).result.status, "completed");
  assert.equal(recovered.messages.list(conversation.conversationId).length, 2);
  assert.equal(recovered.attempts.list(run.runId).length, 1, "recovery must not create a second provider attempt");
  assert.equal(recovered.attempts.get(attempt!.attemptId)?.status, "completed");
  assert.equal(recovered.attempts.get(attempt!.attemptId)?.usageComplete, true);
  const terminalEvents = recovered.events.after({ schemaVersion: 2, runId: run.runId, afterSequence: 0 }).events;
  assert.equal(terminalEvents.filter((event) => event.type === "run.completed").length, 1);
  assert.deepEqual(recovered.usage.get(attempt!.attemptId), settledUsage, "recovery must reuse settled usage without another provider call");
  recovered.close();
});

await test("nonterminal event and usage persistence failures fence the Worker without crashing the API", { timeout: 40_000 }, async (t) => {
  const root = await temporaryRoot();
  let app: Awaited<ReturnType<typeof createWorkbenchApp>> | undefined;
  let raw: DatabaseSync | undefined;
  t.after(async () => {
    raw?.close();
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const scenarios = [
    ["message-delta", `CREATE TRIGGER fail_message_delta BEFORE INSERT ON run_events WHEN NEW.event_type = 'message.delta' BEGIN SELECT RAISE(ABORT, 'injected nonterminal event failure'); END;`],
    ["usage-record", `CREATE TRIGGER fail_usage BEFORE INSERT ON usage_records BEGIN SELECT RAISE(ABORT, 'injected usage persistence failure'); END;`],
  ] as const;

  for (const [name, trigger] of scenarios) {
    const dataDirectory = path.join(root, name);
    await mkdir(dataDirectory);
    app = await createWorkbenchApp({ mode: "fake", dataDirectory });
    const health = async () => {
      const response = await app!.inject({ method: "GET", url: "/api/v2/health" });
      assert.equal(response.statusCode, 200, "the API must stay responsive after persistence failure");
      return JSON.parse(response.body) as { workerReady: boolean };
    };
    assert.equal((await health()).workerReady, true);
    raw = new DatabaseSync(resolveDatabasePath({ dataDirectory }));
    raw.exec(trigger);
    const sessionHeaders = await injectedSessionHeaders(app);
    const conversationResponse = await app.inject({ method: "POST", url: "/api/v2/conversations", headers: sessionHeaders, payload: {} });
    assert.equal(conversationResponse.statusCode, 201);
    const conversation = JSON.parse(conversationResponse.body) as V2Conversation;
    const submitted = await app.inject({
      method: "POST", url: "/api/v2/runs", headers: { ...sessionHeaders, "idempotency-key": crypto.randomUUID() },
      payload: { schemaVersion: 2, conversationId: conversation.conversationId, input: { kind: "message", text: `fault injection ${name}` } },
    });
    assert.equal(submitted.statusCode, 202);
    const run = JSON.parse(submitted.body) as V2Run;
    let workerReady = true;
    for (let attempt = 0; attempt < 200 && workerReady; attempt += 1) {
      await sleep(20);
      workerReady = (await health()).workerReady;
    }
    assert.equal(workerReady, false, `${name}: a persistence failure must fence the Worker`);

    const store = openStorage({ dataDirectory: { dataDirectory } });
    assert.equal(store.runs.get(run.runId)?.status, "running");
    assert.equal(store.results.get(run.runId), undefined);
    assert.equal(store.messages.list(conversation.conversationId).length, 1);
    assert.equal(store.activeSlot.get().runId, run.runId);
    if (name === "usage-record") assert.equal(store.workerIdentity.get()?.status, "uncertain");
    const attempt = store.attempts.list(run.runId)[0]!;
    const safety = store.attemptSafety.get(attempt.attemptId);
    const snapshot = store.snapshots.latest(conversation.conversationId);
    const usage = store.usage.get(attempt.attemptId);
    if (name === "message-delta") {
      assert.ok(snapshot, "the settled message-delta failure keeps its complete conversation checkpoint");
      assert.equal(safety?.state, "safe");
      assert.equal(safety?.checkpointKind, "conversation_turn");
      assert.equal(safety?.snapshotId, snapshot.id);
      assert.ok(usage && usage.costStatus === "estimate" && usage.modelCalls > 0);
      assert.equal(attempt.usageComplete, false, "terminal usage completion is not committed while finalization failed");
    } else {
      assert.equal(snapshot, undefined, "a usage persistence failure must not create a conversation checkpoint");
      assert.equal(safety?.state, "unknown", "a rolled-back pre-call transaction does not fabricate a settled or in-flight record");
      assert.equal(usage, undefined, "usage stays fail closed when its initial transaction fails");
      assert.equal(attempt.usageComplete, false);
    }
    store.close();
    raw.close();
    raw = undefined;

    await app.close();
    app = undefined;
    app = await createWorkbenchApp({ mode: "fake", dataDirectory });
    const recoveredRun = await app.inject({ method: "GET", url: `/api/v2/runs/${run.runId}`, headers: await injectedSessionHeaders(app) });
    assert.equal(recoveredRun.statusCode, 200);
    assert.equal((JSON.parse(recoveredRun.body) as V2Run).status, "interrupted");
    const recovered = openStorage({ dataDirectory: { dataDirectory } });
    const recoveredSnapshot = recovered.snapshots.latest(conversation.conversationId);
    if (name === "message-delta") {
      assert.equal(recoveredSnapshot?.id, snapshot?.id);
      const recoveredAttempt = recovered.attempts.list(run.runId)[0]!;
      assert.equal(recovered.attemptSafety.get(recoveredAttempt.attemptId)?.state, "safe");
      assert.ok(recovered.usage.get(recoveredAttempt.attemptId)?.costStatus === "estimate");
    } else {
      assert.equal(recoveredSnapshot, undefined);
      const recoveredAttempt = recovered.attempts.list(run.runId)[0]!;
      assert.equal(recovered.attemptSafety.get(recoveredAttempt.attemptId)?.state, "unknown");
      assert.equal(recovered.usage.get(recoveredAttempt.attemptId), undefined);
    }
    recovered.close();
    await app.close();
    app = undefined;
  }
});
