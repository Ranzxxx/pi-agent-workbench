import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseV2RunEvent } from "@pi-workbench/protocol";
import { BoundedSseEventQueue, canWriteSseHeartbeat } from "../src/app.js";

function progress(sequence: number) {
  return parseV2RunEvent({ schemaVersion: 2, eventId: `event_${sequence}`, runId: "run_buffer", attemptId: "attempt_buffer",
    type: "run.progress", timestamp: new Date(0).toISOString(), sequence,
    data: { phase: "buffer-test", message: `synthetic ${sequence}` } });
}

test("a slow SSE consumer gets a reset after its bounded unsent queue overflows", () => {
  const queue = new BoundedSseEventQueue("run_buffer", 3);
  assert.equal(queue.enqueue(progress(1)), true);
  assert.equal(queue.enqueue(progress(2)), true);
  assert.equal(queue.enqueue(progress(3)), true);
  assert.equal(queue.length, 3, "simulated paused socket has not drained any pending frames");

  assert.equal(queue.enqueue(progress(4)), false);
  assert.equal(queue.length, 0, "unsent old frames are discarded when a reset is required");
  assert.equal(queue.enqueue(progress(5)), false);
  assert.equal(queue.length, 0, "events arriving while reset is pending do not rebuild the backlog");
  assert.equal(queue.shift(), undefined, "no old event can be sent after the reset frame");

  const reset = queue.takeReset();
  assert.equal(reset?.type, "stream.reset");
  assert.equal(reset?.data.latestSequence, 5);
  assert.equal(reset?.data.latestEventId, "event_5");
  assert.equal(queue.reset, undefined);
});

test("an SSE queue can use the production cache bound for the full replay window", () => {
  const queue = new BoundedSseEventQueue("run_buffer");
  for (let sequence = 1; sequence <= 4096; sequence++) assert.equal(queue.enqueue(progress(sequence)), true);
  assert.equal(queue.length, 4096);
  assert.equal(queue.enqueue(parseV2RunEvent({ ...progress(4097), eventId: randomUUID() })), false);
  assert.equal(queue.length, 0);
  assert.equal(queue.reset?.data.latestSequence, 4097);
});

test("a backpressured SSE response does not accumulate heartbeat frames outside its bounded queue", () => {
  const frames: string[] = [];
  const writeHeartbeat = (state: Parameters<typeof canWriteSseHeartbeat>[0]) => {
    if (canWriteSseHeartbeat(state)) frames.push(": keep-alive\n\n");
  };
  writeHeartbeat({ closed: false, destroyed: false, pumping: true, backpressured: true, pendingEvents: 4096, resetPending: false });
  writeHeartbeat({ closed: false, destroyed: false, pumping: false, backpressured: true, pendingEvents: 0, resetPending: false });
  writeHeartbeat({ closed: false, destroyed: false, pumping: false, backpressured: false, pendingEvents: 0, resetPending: true });
  assert.deepEqual(frames, [], "blocked or queued responses receive no out-of-band heartbeat writes");

  writeHeartbeat({ closed: false, destroyed: false, pumping: false, backpressured: false, pendingEvents: 0, resetPending: false });
  assert.deepEqual(frames, [": keep-alive\n\n"], "an idle response still receives its keep-alive frame");
});
