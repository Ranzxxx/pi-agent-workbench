import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openStorage, resolveDatabasePath } from "@pi-workbench/storage";
import { createWorkbenchService } from "../src/coordinator.js";

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/synthetic-ts-repo");
const workerEntryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/worker/src/main.ts");
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor<T>(probe: () => T | undefined, message: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await pause(10);
  }
  throw new Error(message);
}

test("event subscriptions page through a fixed watermark, buffer live events, and validate Last-Event-ID", { timeout: 60_000 }, async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "pi-event-replay-"));
  const dataDirectory = path.join(parent, "state");
  const service = await createWorkbenchService({ mode: "fake", dataDirectory, fixtureRoot, workerEntryPath });
  const storage = openStorage({ path: resolveDatabasePath({ dataDirectory }) });
  t.after(async () => {
    await service.close().catch(() => undefined);
    storage.close();
    await rm(parent, { recursive: true, force: true });
  });

  const conversation = service.createConversationV2();
  const submitted = service.submitV2(conversation.conversationId,
    { kind: "message", text: "[[fake:slow]] seed synthetic event history, then cancel" }, randomUUID());
  const runId = submitted.run.runId;
  await waitFor(() => {
    const attempt = storage.attempts.list(runId).at(-1);
    const usage = attempt && storage.usage.get(attempt.attemptId);
    return attempt?.status === "running" && usage?.modelCalls === 1 ? attempt : undefined;
  }, "fake provider did not enter its in-flight call");
  const attempt = storage.attempts.list(runId).at(-1);
  assert.ok(attempt);

  const history = [];
  for (let index = 0; index < 1205; index++) {
    history.push(storage.events.append({ eventId: randomUUID(), runId, attemptId: attempt.attemptId, type: "run.progress",
      data: { phase: "synthetic-history", message: `historical event ${index}` } }));
  }
  const watermark = storage.events.latestSequence(runId);
  const liveEvents: Array<{ eventId: string; sequence: number; type: string }> = [];
  const initial = service.subscribeEventsV2(runId, undefined, (event) => liveEvents.push(event));
  assert.equal(initial.reset, undefined);
  assert.equal(initial.finished, false);
  assert.equal(initial.replay.length, watermark);
  assert.deepEqual(initial.replay.map((event) => event.sequence), Array.from({ length: watermark }, (_, index) => index + 1));
  initial.replay.forEach((event) => assert.notEqual(event.sequence, watermark + 1));
  service.cancelV2(runId);
  await Promise.resolve();
  assert.deepEqual(liveEvents.map((event) => event.sequence), [watermark + 1]);
  assert.equal(liveEvents[0]?.type, "run.cancelling", "a live event published before the caller switches to real-time must follow the watermark");
  initial.unsubscribe();

  await waitFor(() => {
    const run = service.getRunV2(runId);
    return ["completed", "failed", "cancelled", "interrupted"].includes(run.status) ? run : undefined;
  }, "cancelled fake run did not reach a terminal state");
  const terminalHistory = storage.events.after({ schemaVersion: 2, runId, afterSequence: watermark }, 10).events;
  assert.ok(terminalHistory.some((event) => event.type === "run.cancelled"), "the terminal event must be persisted after live cancellation");

  const cursor = history[99]!;
  const resumed = service.subscribeEventsV2(runId, cursor.eventId);
  assert.equal(resumed.reset, undefined);
  assert.equal(resumed.replay[0]?.sequence, cursor.sequence + 1);
  assert.equal(resumed.replay.at(-1)?.sequence, terminalHistory.at(-1)?.sequence);
  assert.equal(resumed.replay.some((event) => event.eventId === cursor.eventId), false);
  assert.ok(resumed.replay.some((event) => event.type === "run.cancelled"), "the terminal event remains in resumed history");
  resumed.unsubscribe();

  const invalid = service.subscribeEventsV2(runId, "missing-event-id");
  assert.ok(invalid.reset);
  const completedWatermark = storage.events.latestSequence(runId);
  assert.equal(invalid.reset.data.latestSequence, completedWatermark);
  assert.equal(invalid.reset.data.latestEventId, terminalHistory.at(-1)?.eventId,
    "reset latestEventId must identify the event at the fixed high-water mark");
  assert.equal(invalid.replay.length, 0);
  invalid.unsubscribe();

  let latest = history.at(-1)!;
  for (let index = 0; index < 3200; index++) {
    latest = storage.events.append({ eventId: randomUUID(), runId, attemptId: attempt.attemptId, type: "run.progress",
      data: { phase: "synthetic-overflow", message: `history overflow ${index}` } });
  }
  const overloaded = service.subscribeEventsV2(runId);
  assert.ok(overloaded.reset, "history past the replay cache limit must request a visible reset");
  assert.equal(overloaded.replay.length, 0);
  assert.equal(overloaded.reset.data.latestSequence, storage.events.latestSequence(runId));
  assert.equal(overloaded.reset.data.latestEventId, latest.eventId);
  overloaded.unsubscribe();
});
