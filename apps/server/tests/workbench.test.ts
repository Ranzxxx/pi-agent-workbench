import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkbenchApp } from "../src/app.js";
import { createFakeChatConfiguration, type ModelConfiguration } from "../src/model-config.js";
import type { WorkbenchRun } from "@pi-workbench/protocol";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function temporaryRoot(): Promise<string> { return mkdtemp(path.join(os.tmpdir(), "pi-workbench-task006-")); }
async function waitForRun(app: Awaited<ReturnType<typeof createWorkbenchApp>>, runId: string): Promise<WorkbenchRun> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const response = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}` });
    assert.equal(response.statusCode, 200);
    const run = response.json<WorkbenchRun>();
    if (["completed", "failed", "cancelled"].includes(run.status)) return run;
    await sleep(10);
  }
  throw new Error(`Run ${runId} did not reach a terminal state`);
}
async function createConversation(app: Awaited<ReturnType<typeof createWorkbenchApp>>): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/v1/conversations", payload: {} });
  assert.equal(response.statusCode, 201);
  return response.json<{ conversationId: string }>().conversationId;
}
async function submit(app: Awaited<ReturnType<typeof createWorkbenchApp>>, conversationId: string, input: unknown, idem = crypto.randomUUID()) {
  return app.inject({
    method: "POST", url: `/api/v1/conversations/${conversationId}/runs`,
    headers: { "idempotency-key": idem }, payload: { schemaVersion: 1, input },
  });
}

await test("Fastify parser errors use the versioned API error envelope", async (t) => {
  const app = await createWorkbenchApp({ mode: "fake" });
  t.after(async () => { await app.close(); });
  const response = await app.inject({
    method: "POST", url: "/api/v1/conversations",
    headers: { "content-type": "application/json" }, payload: "not-json",
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(Object.keys(response.json()).sort(), ["error", "schemaVersion"]);
  assert.equal(response.json<{ error: { code: string } }>().error.code, "invalid_request");
});

await test("versioned API runs ordinary multi-turn prompts; idempotency and run IDs are stable", async (t) => {
  const root = await temporaryRoot();
  const app = await createWorkbenchApp({ mode: "fake", dataDirectory: root });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const conversationId = await createConversation(app);
  const idem = crypto.randomUUID();
  const firstResponse = await submit(app, conversationId, { kind: "message", text: "first ordinary prompt" }, idem);
  assert.equal(firstResponse.statusCode, 202);
  const first = firstResponse.json<WorkbenchRun>();
  const replay = await submit(app, conversationId, { kind: "message", text: "first ordinary prompt" }, idem);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json<WorkbenchRun>().runId, first.runId);
  const conflict = await submit(app, conversationId, { kind: "message", text: "different body" }, idem);
  assert.equal(conflict.statusCode, 409);
  const firstDone = await waitForRun(app, first.runId);
  assert.equal(firstDone.status, "completed");
  assert.match(firstDone.result?.status === "completed" ? firstDone.result.reply : "", /first ordinary prompt/u);
  const cancelAfterFinished = await app.inject({ method: "POST", url: `/api/v1/runs/${first.runId}/cancel`, payload: {} });
  assert.equal(cancelAfterFinished.statusCode, 200);
  assert.equal(cancelAfterFinished.json<WorkbenchRun>().status, "completed", "a late cancel cannot overwrite the completed terminal state");
  const completedEvents = await app.inject({ method: "GET", url: `/api/v1/runs/${first.runId}/events` });
  assert.equal((completedEvents.payload.match(/event: run\.cancelling\n/gu) ?? []).length, 0);
  assert.equal((completedEvents.payload.match(/event: run\.finished\n/gu) ?? []).length, 1);
  const secondResponse = await submit(app, conversationId, { kind: "message", text: "follow-up prompt" });
  const second = secondResponse.json<WorkbenchRun>();
  assert.notEqual(second.runId, first.runId);
  assert.equal(second.conversationId, conversationId);
  assert.equal((await waitForRun(app, second.runId)).status, "completed");
  const originalStream = await app.inject({ method: "GET", url: `/api/v1/runs/${second.runId}/events` });
  assert.equal(originalStream.statusCode, 200);
  const runFrames = originalStream.payload.split(/\r?\n\r?\n/u).filter((frame) => /^event: /mu.test(frame));
  assert.ok(runFrames.some((frame) => /^event: run\.finished$/mu.test(frame)));
  const runEventData = runFrames.map((frame) => JSON.parse(frame.split(/\r?\n/u).find((line) => line.startsWith("data: "))!.slice(6)) as { eventId: string; sequence: number });
  assert.equal(new Set(runEventData.map((event) => event.eventId)).size, runEventData.length, "run event IDs are unique");
  for (let index = 1; index < runEventData.length; index++) {
    assert.ok(runEventData[index]!.sequence > runEventData[index - 1]!.sequence, "run event sequence strictly increases for every event");
  }
  const sseReplay = await app.inject({ method: "GET", url: `/api/v1/runs/${second.runId}/events`, headers: { "last-event-id": "cursor-that-fell-out-of-the-ring" } });
  assert.equal(sseReplay.statusCode, 200);
  assert.match(sseReplay.payload, /event: stream\.reset/u);
  assert.doesNotMatch(sseReplay.payload, /event: run\.finished/u);
  const frames = sseReplay.payload.split(/\r?\n\r?\n/u).filter((frame) => /^event: /mu.test(frame));
  const resetFrame = frames.find((frame) => /^event: stream\.reset$/mu.test(frame));
  assert.ok(resetFrame, "expired cursor should emit a reset control frame");
  const resetData = resetFrame.split(/\r?\n/u).find((line) => line.startsWith("data: "))?.slice(6);
  assert.ok(resetData);
  const reset = JSON.parse(resetData) as { eventId: string; type: string; data: { latestEventId?: string; latestSequence: number } };
  assert.equal(reset.type, "stream.reset");
  assert.ok(reset.eventId);
  assert.ok(reset.data.latestEventId);
  assert.equal(resetFrame.includes(`id: ${reset.eventId}`), false, "control frame ID must not replace EventSource's last real cursor");
  assert.equal(runEventData.at(-1)?.eventId, reset.data.latestEventId, "reset snapshot points to the latest actual run event");
  assert.equal(runEventData.at(-1)?.sequence, reset.data.latestSequence);
  const resumed = await app.inject({ method: "GET", url: `/api/v1/runs/${second.runId}/events?after=${encodeURIComponent(reset.data.latestEventId!)}` });
  assert.equal(resumed.statusCode, 200);
  assert.doesNotMatch(resumed.payload, /event: stream\.reset/u, "resume uses latest real event ID rather than the control-frame ID");
  assert.doesNotMatch(resumed.payload, /event: run\.finished/u, "the already-consumed terminal event is not replayed again");
  const loaded = await app.inject({ method: "GET", url: `/api/v1/conversations/${conversationId}` });
  assert.equal(loaded.json<{ messages: unknown[] }>().messages.length, 4);
});

await test("global concurrency, cancellation, retry association, and unknown capability rejection", async (t) => {
  const root = await temporaryRoot();
  const app = await createWorkbenchApp({ mode: "fake", dataDirectory: root });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const firstConversation = await createConversation(app);
  const secondConversation = await createConversation(app);
  const slowResponse = await submit(app, firstConversation, { kind: "message", text: "[[fake:slow]] keep waiting" });
  const slow = slowResponse.json<WorkbenchRun>();
  assert.equal((await submit(app, secondConversation, { kind: "message", text: "must be busy" })).statusCode, 409);
  await sleep(30);
  const cancel = await app.inject({ method: "POST", url: `/api/v1/runs/${slow.runId}/cancel`, payload: {} });
  assert.equal(cancel.statusCode, 200);
  assert.equal((await waitForRun(app, slow.runId)).status, "cancelled");
  const history = await app.inject({ method: "GET", url: `/api/v1/conversations/${firstConversation}` });
  assert.equal(history.json<{ messages: Array<{ role: string }> }>().messages.some((message) => message.role === "assistant"), false);

  const failedResponse = await submit(app, secondConversation, { kind: "message", text: "[[fake:fail]]" });
  const failed = failedResponse.json<WorkbenchRun>();
  assert.equal((await waitForRun(app, failed.runId)).status, "failed");
  const retryResponse = await app.inject({ method: "POST", url: `/api/v1/runs/${failed.runId}/retry`, headers: { "idempotency-key": crypto.randomUUID() }, payload: {} });
  assert.equal(retryResponse.statusCode, 202);
  const retried = retryResponse.json<WorkbenchRun>();
  assert.notEqual(retried.runId, failed.runId);
  assert.equal(retried.retryOfRunId, failed.runId);
  assert.equal((await waitForRun(app, retried.runId)).status, "failed");

  const unsupported = await submit(app, secondConversation, { kind: "capability", capabilityId: "not_registered", input: {} });
  assert.equal(unsupported.statusCode, 400);
  assert.equal(unsupported.json<{ error: { code: string } }>().error.code, "unsupported_capability");
});

await test("repeated cancellation is idempotent and run.finished keeps the winning terminal state", async (t) => {
  const root = await temporaryRoot();
  const configStarted = deferred<void>();
  const configGate = deferred<ModelConfiguration>();
  const app = await createWorkbenchApp({
    mode: "fake", dataDirectory: root,
    createChatConfiguration: async () => { configStarted.resolve(); return configGate.promise; },
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const conversationId = await createConversation(app);
  const response = await submit(app, conversationId, { kind: "message", text: "cancel while setup is waiting" });
  const run = response.json<WorkbenchRun>();
  await configStarted.promise;

  const firstCancel = await app.inject({ method: "POST", url: `/api/v1/runs/${run.runId}/cancel`, payload: {} });
  const duplicateCancel = await app.inject({ method: "POST", url: `/api/v1/runs/${run.runId}/cancel`, payload: {} });
  assert.equal(firstCancel.statusCode, 200);
  assert.equal(duplicateCancel.statusCode, 200);
  assert.equal(firstCancel.json<WorkbenchRun>().status, "cancelling");
  assert.equal(duplicateCancel.json<WorkbenchRun>().status, "cancelling");
  assert.equal(duplicateCancel.json<WorkbenchRun>().updatedAt, firstCancel.json<WorkbenchRun>().updatedAt, "duplicate cancel leaves the accepted state unchanged");

  configGate.resolve(createFakeChatConfiguration());
  const finished = await waitForRun(app, run.runId);
  assert.equal(finished.status, "cancelled");
  assert.equal(finished.result?.status, "cancelled");
  const finalCancel = await app.inject({ method: "POST", url: `/api/v1/runs/${run.runId}/cancel`, payload: {} });
  assert.equal(finalCancel.statusCode, 200);
  assert.equal(finalCancel.json<WorkbenchRun>().status, "cancelled", "a late cancel preserves the cancellation terminal state");
  const events = await app.inject({ method: "GET", url: `/api/v1/runs/${run.runId}/events` });
  assert.equal((events.payload.match(/event: run\.cancelling\n/gu) ?? []).length, 1, "the run emits exactly one cancellation event");
  assert.equal((events.payload.match(/event: run\.finished\n/gu) ?? []).length, 1, "the run emits exactly one terminal event");
});

await test("fake repository capability returns only the demo fixture and rejects unsupported repositories and refs", async (t) => {
  const root = await temporaryRoot();
  const app = await createWorkbenchApp({ mode: "fake", dataDirectory: root });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const conversationId = await createConversation(app);
  const response = await submit(app, conversationId, {
    kind: "capability", capabilityId: "public_repository_analysis",
    input: { repositoryUrl: "https://github.com/demo/harborlight", goal: "Summarize the service and default port." },
  });
  assert.equal(response.statusCode, 202);
  const run = response.json<WorkbenchRun>();
  const complete = await waitForRun(app, run.runId);
  assert.equal(complete.status, "completed");
  assert.equal(complete.result?.status, "completed");
  if (complete.result?.status !== "completed") throw new Error("Expected successful capability result");
  assert.equal(complete.result.capabilityResult?.capabilityId, "public_repository_analysis");
  assert.ok(complete.result.artifacts?.some((artifact) => artifact.kind === "report.json"));
  const report = await app.inject({ method: "GET", url: `/api/v1/runs/${run.runId}/artifacts/report.json` });
  assert.equal(report.statusCode, 200);
  assert.match(report.payload, /fixture-service-summary/u);
  const unsupportedRepository = await submit(app, conversationId, {
    kind: "capability", capabilityId: "public_repository_analysis",
    input: { repositoryUrl: "https://github.com/acme/private-looking-project", goal: "Analyze a different repository in offline mode." },
  });
  assert.equal(unsupportedRepository.statusCode, 400);
  assert.match(unsupportedRepository.json<{ error: { message: string } }>().error.message, /离线演示仅支持合成仓库/u);
  const unsupportedRef = await submit(app, conversationId, {
    kind: "capability", capabilityId: "public_repository_analysis",
    input: { repositoryUrl: "https://github.com/demo/harborlight", ref: "other-branch", goal: "Do not claim a fake ref was inspected." },
  });
  assert.equal(unsupportedRef.statusCode, 400);
  const conversation = (await app.inject({ method: "GET", url: `/api/v1/conversations/${conversationId}` })).json<{ messages: Array<{ role: string }> }>();
  assert.equal(conversation.messages.filter((message) => message.role === "assistant").length, 1);
});

await test("online repository capability reports GitHub rate limits safely and authenticates only GitHub API lookups", async (t) => {
  const root = await temporaryRoot();
  const requests: Array<{ host: string; authorization: string | null }> = [];
  const snapshotFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ host: new URL(url).hostname, authorization: new Headers(init?.headers).get("authorization") });
    const response = new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403, headers: { "x-ratelimit-remaining": "0" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  const app = await createWorkbenchApp({
    mode: "online", apiKey: "unit-test-model-key", githubToken: "unit-test-github-token",
    snapshotFetch, dataDirectory: root,
    createAnalysisConfiguration: async () => createFakeChatConfiguration(),
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/health" })).json<{ mode: string }>().mode, "online");
  const conversationId = await createConversation(app);
  const submitted = await submit(app, conversationId, {
    kind: "capability", capabilityId: "public_repository_analysis",
    input: { repositoryUrl: "https://github.com/octocat/Hello-World", goal: "Explain the project purpose." },
  });
  const run = submitted.json<WorkbenchRun>();
  const complete = await waitForRun(app, run.runId);
  assert.equal(complete.result?.status, "failed");
  if (complete.result?.status !== "failed") throw new Error("Expected a safe GitHub rate-limit failure");
  assert.equal(complete.result.error.code, "rate_limited");
  assert.match(complete.result.error.message, /GitHub rate limit/u);
  assert.deepEqual(requests, [{ host: "api.github.com", authorization: "Bearer unit-test-github-token" }]);
  const stream = await app.inject({ method: "GET", url: `/api/v1/runs/${run.runId}/events` });
  assert.doesNotMatch(stream.payload, /unit-test-github-token|API rate limit exceeded/u);
});
