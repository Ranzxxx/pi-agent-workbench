import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkbenchApp } from "../src/app.js";
import { openStorage } from "@pi-workbench/storage";
import { localSessionHeaders } from "./local-client.js";

test("all private API routes reject unauthenticated or foreign requests before reading or mutating state", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-api-security-"));
  const app = await createWorkbenchApp({ mode: "fake", dataDirectory: root });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const headers = await localSessionHeaders(base);
  const created = await fetch(`${base}/api/v2/conversations`, { method: "POST", headers });
  assert.equal(created.status, 201);
  const conversation = await created.json() as { conversationId: string };
  const id = conversation.conversationId;
  const readRoutes = [
    "/api/v1/conversations", `/api/v1/conversations/${id}`, `/api/v1/conversations/${id}/runs`,
    "/api/v1/runs/missing", "/api/v1/runs/missing/artifacts/report.json",
    "/api/v2/conversations", `/api/v2/conversations/${id}`, `/api/v2/conversations/${id}/runs`,
    "/api/v2/runs/missing", "/api/v2/runs/missing/events", "/api/v2/runs/missing/artifacts/report.json",
    "/api/v2/projects", "/api/v2/capabilities", "/api/v2/deletions",
  ];
  for (const route of readRoutes) {
    assert.equal((await fetch(`${base}${route}`)).status, 401, `${route}: no cookie`);
    const badHost = await app.inject({ method: "GET", url: route, headers: { host: "rebind.invalid", cookie: headers.cookie } });
    assert.equal(badHost.statusCode, 403, `${route}: bad Host without Origin`);
    assert.equal((await fetch(`${base}${route}`, { headers: { ...headers, origin: "http://attacker.invalid" } })).status, 403, route);
    assert.equal((await fetch(`${base}${route}`, { headers: { ...headers, "sec-fetch-site": "cross-site" } })).status, 403, route);
  }
  const writes = [
    ["POST", "/api/v2/conversations"], ["DELETE", `/api/v2/conversations/${id}`],
    ["POST", "/api/v2/runs"], ["POST", "/api/v2/runs/missing/cancel"],
    ["POST", "/api/v2/runs/missing/retry"], ["POST", "/api/v2/runs/missing/continue"],
    ["POST", "/api/v2/deletions/missing/retry"],
    ["PATCH", "/api/v2/capabilities/development_greeting_tool/state"],
    ["POST", "/api/v1/conversations"], ["POST", "/api/v1/runs/missing/retry"],
  ];
  const payload = JSON.stringify({ schemaVersion: 2, conversationId: id, input: { kind: "message", text: "must not run" } });
  for (const [method, route] of writes) {
    const options = { method, body: payload };
    const common = { "content-type": "application/json", "idempotency-key": crypto.randomUUID() };
    assert.equal((await fetch(`${base}${route}`, { ...options, headers: { ...common, origin: base } })).status, 401, `${route}: no session`);
    for (const csrf of [undefined, "wrong"]) {
      const response = await fetch(`${base}${route}`, { ...options, headers: {
        ...common, origin: base, cookie: headers.cookie!, ...(csrf ? { "x-csrf-token": csrf } : {}),
      } });
      assert.equal(response.status, 400, `${route}: invalid CSRF`);
      assert.match(await response.text(), /本地请求校验失败/u, "reject authentication, not the business payload");
    }
    const noOrigin: Record<string, string> = { ...headers, ...common }; delete noOrigin.origin;
    assert.equal((await fetch(`${base}${route}`, { ...options, headers: noOrigin })).status, 403, `${route}: missing Origin`);
  }
  const conversations = await fetch(`${base}/api/v2/conversations`, { headers }).then((r) => r.json()) as { conversations: unknown[] };
  assert.equal(conversations.conversations.length, 1, "rejected requests must not create/delete conversations");
  const runs = await fetch(`${base}/api/v2/conversations/${id}/runs`, { headers }).then((r) => r.json()) as { runs: unknown[] };
  assert.deepEqual(runs.runs, [], "rejected writes must not admit runs");
  assert.equal((await fetch(`${base}/api/v1/conversations/${id}`, { headers: { cookie: headers.cookie! } })).status, 200);

  const runResponse = await fetch(`${base}/api/v2/runs`, { method: "POST", headers: {
    ...headers, "content-type": "application/json", "idempotency-key": crypto.randomUUID(),
  }, body: payload });
  assert.equal(runResponse.status, 202);
  const run = await runResponse.json() as { runId: string };
  let status: string | undefined;
  for (let attempt = 0; attempt < 200 && status !== "completed"; attempt++) {
    const response = await fetch(`${base}/api/v2/runs/${run.runId}`, { headers: { cookie: headers.cookie! } });
    assert.equal(response.status, 200);
    status = (await response.json() as { status: string }).status;
    if (status !== "completed") await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(status, "completed");
  const stream = await fetch(`${base}/api/v2/runs/${run.runId}/events`, { headers: { cookie: headers.cookie! } });
  assert.equal(stream.status, 200, "EventSource needs no custom CSRF header");
  assert.match(await stream.text(), /event: run.completed/u);
});

test("deleted conversation cleanup is authenticated, durable, and retryable without following symlinks", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-deletion-status-"));
  const dataDirectory = path.join(root, "state");
  const outside = path.join(root, "outside");
  const app = await createWorkbenchApp({ mode: "fake", dataDirectory });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const headers = await localSessionHeaders(base);
  const created = await fetch(`${base}/api/v2/conversations`, { method: "POST", headers });
  assert.equal(created.status, 201);
  const { conversationId } = await created.json() as { conversationId: string };
  const storage = openStorage({ dataDirectory: { dataDirectory } });
  const run = storage.runs.create({ runId: crypto.randomUUID(), conversationId, request: { kind: "message", text: "cleanup fixture" } });
  storage.runs.updateStatus(run.runId, "failed");
  storage.close();
  await mkdir(outside);
  const marker = path.join(outside, "keep.txt");
  await writeFile(marker, "outside data");
  const workflowPath = path.join(dataDirectory, "workflows", run.runId);
  await mkdir(path.dirname(workflowPath), { recursive: true });
  await symlink(outside, workflowPath);

  const deleted = await fetch(`${base}/api/v2/conversations/${conversationId}`, { method: "DELETE", headers });
  assert.equal(deleted.status, 200);
  const response = await deleted.json() as { deleted: boolean; cleanup: { conversationId: string; status: string } };
  assert.equal(response.deleted, true);
  assert.equal(response.cleanup.conversationId, conversationId);
  assert.equal((await fetch(`${base}/api/v2/deletions`)).status, 401);
  let cleanup: { status: string; items: Array<{ attempts: number; status: string }> } | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const listed = await fetch(`${base}/api/v2/deletions`, { headers }).then((item) => item.json()) as { deletions: Array<{ conversationId: string; status: string; items: Array<{ attempts: number; status: string }> }> };
    cleanup = listed.deletions.find((item) => item.conversationId === conversationId);
    if (cleanup?.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(cleanup?.status, "failed");
  assert.equal(cleanup.items[0]?.attempts, 1);
  assert.equal(await readFile(marker, "utf8"), "outside data");
  const retryRoute = `${base}/api/v2/deletions/${conversationId}/retry`;
  assert.equal((await fetch(retryRoute, { method: "POST", headers: { cookie: headers.cookie! }, body: "{}" })).status, 403);
  await rm(workflowPath);
  await mkdir(path.join(workflowPath, "analysis"), { recursive: true });
  await writeFile(path.join(workflowPath, "analysis", "result.json"), "safe artifact");
  const retried = await fetch(retryRoute, { method: "POST", headers, body: "{}" });
  assert.equal(retried.status, 200);
  const after = await retried.json() as { cleanup: { status: string; items: Array<{ attempts: number }> } };
  assert.equal(after.cleanup.status, "completed");
  assert.equal(after.cleanup.items[0]?.attempts, 1);
  assert.equal(await readFile(marker, "utf8"), "outside data");
  await assert.rejects(readFile(path.join(workflowPath, "analysis", "result.json")), { code: "ENOENT" });
});

test("session bootstrap verifies local authority including proxy headers and expires the legacy cookie path", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-api-proxy-"));
  const app = await createWorkbenchApp({ mode: "fake", dataDirectory: root });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const proxy = { host: "127.0.0.1:2027", "x-forwarded-host": "localhost:2026", origin: "http://localhost:2026" };
  for (const headers of [
    { ...proxy, host: "attacker.invalid" }, { ...proxy, "x-forwarded-host": "attacker.invalid" },
    { ...proxy, origin: "http://localhost:9999" }, { ...proxy, origin: "null" },
    { ...proxy, "sec-fetch-site": "cross-site" },
  ]) assert.equal((await app.inject({ method: "POST", url: "/api/v2/picker/session", headers })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/v2/picker/session", remoteAddress: "192.0.2.1", headers: proxy })).statusCode, 403);
  const session = await app.inject({ method: "POST", url: "/api/v2/picker/session", headers: proxy });
  assert.equal(session.statusCode, 200);
  const cookies = session.headers["set-cookie"] as string[];
  assert.match(cookies[0]!, /Path=\/api;.*Max-Age=14400/u);
  assert.match(cookies[1]!, /Path=\/api\/v2; Max-Age=0/u);
  const cookie = cookies[0]!.split(";")[0]!;
  const created = await app.inject({ method: "POST", url: "/api/v2/conversations", headers: {
    ...proxy, cookie, "x-csrf-token": session.json<{ csrfToken: string }>().csrfToken,
  } });
  assert.equal(created.statusCode, 201);
  const { origin: _origin, ...readHeaders } = proxy;
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/conversations", headers: { ...readHeaders, cookie } })).statusCode, 200);
});
