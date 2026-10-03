import assert from "node:assert/strict";
import test from "node:test";
import { createWorkbenchFetch } from "../src/app/api-client.js";

test("ordinary API requests share one session and preserve request bodies and idempotency headers", async () => {
  let starts = 0;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const request = createWorkbenchFetch("/api/v2", async (url, init = {}) => {
    if (String(url).endsWith("/picker/session")) { starts++; return Response.json({ csrfToken: "token" }); }
    calls.push({ url: String(url), init });
    return Response.json({});
  });
  await Promise.all([request("/conversations"), request("/capabilities")]);
  await request("/runs", { method: "POST", body: "original body", headers: { "idempotency-key": "same-key" } });
  assert.equal(starts, 1);
  for (const call of calls) {
    assert.equal(new Headers(call.init.headers).get("x-csrf-token"), "token");
    assert.equal(call.init.credentials, "same-origin");
  }
  assert.equal(calls[2]!.init.body, "original body");
  assert.equal(new Headers(calls[2]!.init.headers).get("idempotency-key"), "same-key");
});

test("only expired authentication retries once; business failures and network errors never replay writes", async () => {
  for (const outcome of [401, 404, 500, "network"] as const) {
    let starts = 0;
    let writes = 0;
    const request = createWorkbenchFetch("/api/v2", async (url) => {
      if (String(url).endsWith("/picker/session")) { starts++; return Response.json({ csrfToken: `token-${starts}` }); }
      writes++;
      if (outcome === "network") throw new TypeError("connection lost");
      return new Response(null, { status: outcome });
    });
    if (outcome === "network") await assert.rejects(request("/runs", { method: "POST" }), /connection lost/u);
    else assert.equal((await request("/runs", { method: "POST" })).status, outcome);
    assert.equal(writes, outcome === 401 ? 2 : 1);
    assert.equal(starts, outcome === 401 ? 2 : 1);
  }
});

test("an expired session renews its token and retries the rejected request with its original idempotency key", async () => {
  let sessions = 0;
  const tokens: string[] = [];
  const request = createWorkbenchFetch("/api/v2", async (url, init = {}) => {
    if (String(url).endsWith("/picker/session")) return Response.json({ csrfToken: `token-${++sessions}` });
    const headers = new Headers(init.headers);
    tokens.push(headers.get("x-csrf-token")!);
    assert.equal(headers.get("idempotency-key"), "original-key");
    assert.equal(init.body, "original-body");
    return new Response(null, { status: tokens.length === 1 ? 401 : 202 });
  });
  assert.equal((await request("/runs", { method: "POST", headers: { "idempotency-key": "original-key" }, body: "original-body" })).status, 202);
  assert.deepEqual(tokens, ["token-1", "token-2"]);
  assert.equal(sessions, 2);
});
