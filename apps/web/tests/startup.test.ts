import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { retryStartupRead } from "../src/app/startup.ts";

const fast = { timeoutMs: 200, attemptTimeoutMs: 30, retryDelayMs: 1 };

test("startup recovers from refused connections and proxy 500/502/503/504 without a page reload", async () => {
  const errors = [new TypeError("Failed to fetch"), ...[500, 502, 503, 504].map((status) => Object.assign(new Error("proxy unavailable"), { status }))];
  let calls = 0;
  const result = await retryStartupRead(async () => {
    const error = errors[calls++];
    if (error) throw error;
    return { conversations: ["saved-conversation"] };
  }, new AbortController().signal, fast);
  assert.deepEqual(result, { conversations: ["saved-conversation"] });
  assert.equal(calls, 6);
});

test("startup does not retry permanent API errors", async () => {
  let calls = 0;
  const error = Object.assign(new Error("not found"), { status: 404 });
  await assert.rejects(retryStartupRead(async () => { calls++; throw error; }, new AbortController().signal, fast), (caught) => caught === error);
  assert.equal(calls, 1);
});

test("startup exits on deadline even when a request hangs", async () => {
  let calls = 0;
  await assert.rejects(retryStartupRead(async (signal) => {
    calls++;
    try { await delay(1_000, undefined, { signal }); }
    catch { throw signal.reason; }
  }, new AbortController().signal, { ...fast, timeoutMs: 80 }), { name: "TimeoutError" });
  assert.ok(calls >= 2);
});

test("unmount cancels startup and prevents any subsequent retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  const stopped = new Error("unmounted");
  const pending = retryStartupRead(async (signal) => {
    calls++;
    controller.abort(stopped);
    signal.throwIfAborted();
  }, controller.signal, fast);
  await assert.rejects(pending, (error) => error === stopped);
  await delay(5);
  assert.equal(calls, 1);
});
