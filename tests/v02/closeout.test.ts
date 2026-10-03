import assert from "node:assert/strict";
import { cp, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createWorkbenchApp } from "@pi-workbench/server";
import { openStorage, resolveDatabasePath } from "@pi-workbench/storage";
import { createProjectFileAccess } from "@pi-workbench/tools";
import { localFetch } from "../../apps/server/tests/local-client.ts";
import { createPersistedFileJournal } from "../../packages/workbench/src/file-journal.ts";

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/v02-workspace/sample-project");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function identity(info: { dev: number | bigint; ino: number | bigint }): string {
  return `${info.dev}:${info.ino}`;
}

async function startApp(dataDirectory: string, pickerRoot: string) {
  const app = await createWorkbenchApp({ mode: "fake", dataDirectory, pickerRoots: [pickerRoot] });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, baseUrl };
}

async function sessionFor(baseUrl: string) {
  const origin = new URL(baseUrl).origin;
  const response = await fetch(`${baseUrl}/api/v2/picker/session`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}",
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const body = await response.json() as { csrfToken: string };
  async function request(route: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("origin", origin);
    headers.set("cookie", cookie!);
    headers.set("x-csrf-token", body.csrfToken);
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    return fetch(`${baseUrl}/api/v2${route}`, { ...init, headers });
  }
  return { request };
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

async function openSample(request: (route: string, init?: RequestInit) => Promise<Response>) {
  const roots = await request("/picker/roots?mode=project").then((response) => response.json()) as { roots: Array<{ token: string }> };
  const listing = await request("/picker/browse", post({ schemaVersion: 2, mode: "project", directoryToken: roots.roots[0]!.token }));
  const view = await listing.json() as { entries: Array<{ name: string; kind: string; token?: string }> };
  const directory = view.entries.find((entry) => entry.name === "sample-project" && entry.kind === "directory");
  assert.ok(directory?.token);
  const selection = await request("/picker/project-selection", post({ schemaVersion: 2, directoryToken: directory.token }));
  const pending = await selection.json() as { selectionToken: string };
  const opened = await request("/picker/open-project", post({ schemaVersion: 2, selectionToken: pending.selectionToken, displayName: "V02 sample" }));
  assert.equal(opened.status, 201);
  return await opened.json() as { project: { projectId: string }; conversation: { conversationId: string; projectId: string } };
}

async function waitForRun(baseUrl: string, runId: string, wanted?: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await localFetch(`${baseUrl}/api/v2/runs/${runId}`);
    assert.equal(response.status, 200);
    const run = await response.json() as { status: string; runId: string; result?: { status: string; reply?: string; extensionResult?: { extensionId: string } } };
    if (wanted ? run.status === wanted : ["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return run;
    await sleep(25);
  }
  throw new Error(`Run ${runId} did not finish`);
}

test("v0.2 flow A keeps project edits, undo, attachments, and the other conversation across restart", { timeout: 60_000 }, async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "pi-v02-flow-a-"));
  const pickerRoot = path.join(parent, "picker");
  const projectRoot = path.join(pickerRoot, "sample-project");
  const dataDirectory = path.join(parent, "state");
  await cp(fixtureRoot, projectRoot, { recursive: true });
  let { app, baseUrl } = await startApp(dataDirectory, pickerRoot);
  t.after(async () => { await app.close().catch(() => undefined); await rm(parent, { recursive: true, force: true }); });
  const session = await sessionFor(baseUrl);
  const opened = await openSample(session.request);
  const second = await session.request(`/projects/${opened.project.projectId}/conversations`, post({}));
  assert.equal(second.status, 201);
  const other = await second.json() as { conversationId: string; projectId: string };
  assert.equal(other.projectId, opened.project.projectId);
  assert.notEqual(other.conversationId, opened.conversation.conversationId);

  const storage = openStorage({ path: resolveDatabasePath({ dataDirectory }) });
  try {
    const run = storage.runs.create({ runId: "run_v02_edit", conversationId: opened.conversation.conversationId, request: { kind: "message", text: "edit the sample note" } });
    const changeset = storage.fileChangesets.ensureForRun({ id: "changeset_v02_edit", conversationId: opened.conversation.conversationId, projectId: opened.project.projectId, runId: run.runId });
    const directory = await lstat(projectRoot);
    const files = createProjectFileAccess(projectRoot, identity(directory), createPersistedFileJournal({ storage, dataDirectory, changesetId: changeset.id }));
    const initial = await files.readFile("notes.md");
    assert.equal(initial.text, "initial note\n");
    await files.editFile("notes.md", initial.token, "edited note\n");
    await files.createFile("extra.md", "created by the sample run\n");
    await assert.rejects(files.readFile("../outside.txt"), (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_path");
    storage.fileChangesets.finalizeRun(run.runId);
  } finally { storage.close(); }

  const summaries = await session.request(`/conversations/${opened.conversation.conversationId}/changesets`).then((response) => response.json()) as { changesets: Array<{ changesetId: string }> };
  assert.equal(summaries.changesets.length, 1);
  const detail = await session.request(`/conversations/${opened.conversation.conversationId}/changesets/${summaries.changesets[0]!.changesetId}`).then((response) => response.json()) as { diffs: Array<{ path: string; beforeText: string | null; afterText: string | null }> };
  assert.deepEqual(detail.diffs.map((diff) => [diff.path, diff.beforeText, diff.afterText]), [
    ["notes.md", "initial note\n", "edited note\n"],
    ["extra.md", null, "created by the sample run\n"],
  ]);
  const isolated = await session.request(`/conversations/${other.conversationId}/changesets`).then((response) => response.json()) as { changesets: unknown[] };
  assert.deepEqual(isolated.changesets, []);

  const undone = await session.request(`/conversations/${opened.conversation.conversationId}/changesets/${summaries.changesets[0]!.changesetId}/undo`, post({ schemaVersion: 2, confirm: true }));
  assert.equal(undone.status, 200);
  const undoBody = await undone.json() as { status: string; undonePaths: string[] };
  assert.equal(undoBody.status, "undone");
  assert.deepEqual(undoBody.undonePaths.sort(), ["extra.md", "notes.md"]);
  assert.equal(await readFile(path.join(projectRoot, "notes.md"), "utf8"), "initial note\n");
  await assert.rejects(readFile(path.join(projectRoot, "extra.md")), { code: "ENOENT" });

  const conflictStore = openStorage({ path: resolveDatabasePath({ dataDirectory }) });
  try {
    const run = conflictStore.runs.create({ runId: "run_v02_conflict", conversationId: opened.conversation.conversationId, request: { kind: "message", text: "conflict check" } });
    const changeset = conflictStore.fileChangesets.ensureForRun({ id: "changeset_v02_conflict", conversationId: opened.conversation.conversationId, projectId: opened.project.projectId, runId: run.runId });
    const directory = await lstat(projectRoot);
    const files = createProjectFileAccess(projectRoot, identity(directory), createPersistedFileJournal({ storage: conflictStore, dataDirectory, changesetId: changeset.id }));
    const before = await files.readFile("notes.md");
    await files.editFile("notes.md", before.token, "agent update\n");
    conflictStore.fileChangesets.finalizeRun(run.runId);
  } finally { conflictStore.close(); }
  await writeFile(path.join(projectRoot, "notes.md"), "user update\n", "utf8");
  const conflict = await session.request(`/conversations/${opened.conversation.conversationId}/changesets/changeset_v02_conflict/undo`, post({ schemaVersion: 2, confirm: true }));
  const conflictBody = await conflict.json() as { status: string; conflictPaths: string[] };
  assert.equal(conflictBody.status, "conflict");
  assert.deepEqual(conflictBody.conflictPaths, ["notes.md"]);
  assert.equal(await readFile(path.join(projectRoot, "notes.md"), "utf8"), "user update\n");

  const attachmentRoots = await session.request("/picker/roots?mode=attachment").then((response) => response.json()) as { roots: Array<{ token: string }> };
  const attachmentRoot = await session.request("/picker/browse", post({ schemaVersion: 2, mode: "attachment", directoryToken: attachmentRoots.roots[0]!.token }));
  const attachmentRootView = await attachmentRoot.json() as { entries: Array<{ name: string; token?: string }> };
  const projectToken = attachmentRootView.entries.find((entry) => entry.name === "sample-project")?.token;
  assert.ok(projectToken);
  const projectListing = await session.request("/picker/browse", post({ schemaVersion: 2, mode: "attachment", directoryToken: projectToken }));
  const projectEntries = await projectListing.json() as { entries: Array<{ name: string; token?: string }> };
  const srcToken = projectEntries.entries.find((entry) => entry.name === "src")?.token;
  assert.ok(srcToken);
  const srcListing = await session.request("/picker/browse", post({ schemaVersion: 2, mode: "attachment", directoryToken: srcToken }));
  const srcEntries = await srcListing.json() as { entries: Array<{ name: string; kind: string; token?: string }> };
  const source = srcEntries.entries.find((entry) => entry.name === "source.txt" && entry.kind === "file");
  assert.ok(source?.token);
  const imported = await session.request(`/conversations/${opened.conversation.conversationId}/attachments/import`, post({ schemaVersion: 2, fileTokens: [source.token] }));
  assert.equal(imported.status, 200);
  const importedBody = await imported.json() as { attachments: Array<{ attachmentId: string }> };
  await writeFile(path.join(projectRoot, "src/source.txt"), "changed after import\n", "utf8");
  const copy = await session.request(`/conversations/${opened.conversation.conversationId}/attachments/${importedBody.attachments[0]!.attachmentId}`);
  assert.equal(await copy.text(), "attachment source\n");
  assert.equal((await session.request(`/conversations/${other.conversationId}/attachments/${importedBody.attachments[0]!.attachmentId}`)).status, 404);

  const finished = openStorage({ path: resolveDatabasePath({ dataDirectory }) });
  try {
    const endedAt = new Date().toISOString();
    for (const runId of ["run_v02_edit", "run_v02_conflict"]) finished.runs.updateStatus(runId, "cancelled", endedAt, endedAt);
  } finally { finished.close(); }
  const deletion = await session.request(`/conversations/${opened.conversation.conversationId}`, { method: "DELETE" });
  assert.equal(deletion.status, 200);
  assert.equal((await localFetch(`${baseUrl}/api/v2/conversations/${opened.conversation.conversationId}`)).status, 404);
  assert.equal((await localFetch(`${baseUrl}/api/v2/conversations/${other.conversationId}`)).status, 200);
  assert.equal(await readFile(path.join(projectRoot, "notes.md"), "utf8"), "user update\n");
  const projects = await session.request("/projects").then((response) => response.json()) as { projects: Array<{ projectId: string }> };
  assert.equal(projects.projects.some((item) => item.projectId === opened.project.projectId), true);

  const continued = await localFetch(`${baseUrl}/api/v2/runs`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "v02-continue" },
    body: JSON.stringify({ schemaVersion: 2, conversationId: other.conversationId, input: { kind: "message", text: "continue after the other conversation was deleted" } }),
  });
  assert.equal(continued.status, 202);
  const continuedRun = await continued.json() as { runId: string };
  assert.equal((await waitForRun(baseUrl, continuedRun.runId, "completed")).status, "completed");
  const replay = await localFetch(`${baseUrl}/api/v2/runs`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "v02-continue" },
    body: JSON.stringify({ schemaVersion: 2, conversationId: other.conversationId, input: { kind: "message", text: "continue after the other conversation was deleted" } }),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { runId: string }).runId, continuedRun.runId);

  await app.close();
  ({ app, baseUrl } = await startApp(dataDirectory, pickerRoot));
  const restored = await localFetch(`${baseUrl}/api/v2/conversations/${other.conversationId}`).then((response) => response.json()) as { messages: Array<{ role: string; content: string }> };
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.messages[0]?.role, "user");
  assert.match(restored.messages.map((message) => message.content).join("\n"), /continue after the other conversation was deleted/u);
  assert.equal((await localFetch(`${baseUrl}/api/v2/conversations/${opened.conversation.conversationId}`)).status, 404);
  assert.equal(await readFile(path.join(projectRoot, "notes.md"), "utf8"), "user update\n");
});

test("v0.2 flow B keeps capability selection on the current request and replays a dropped event cursor", { timeout: 40_000 }, async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "pi-v02-flow-b-"));
  const { app, baseUrl } = await startApp(path.join(parent, "state"), parent);
  t.after(async () => { await app.close().catch(() => undefined); await rm(parent, { recursive: true, force: true }); });
  const session = await sessionFor(baseUrl);
  const conversation = await localFetch(`${baseUrl}/api/v2/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(conversation.status, 201);
  const created = await conversation.json() as { conversationId: string };
  const call = { schemaVersion: 2, conversationId: created.conversationId, input: { kind: "capability", capabilityId: "development_greeting_tool", input: {}, prompt: "[[demo:greeting-tool]]" } };
  const disabled = await localFetch(`${baseUrl}/api/v2/runs`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(call) });
  assert.equal(disabled.status, 409);
  const enabled = await session.request("/capabilities/development_greeting_tool/state", { method: "PATCH", body: JSON.stringify({ schemaVersion: 2, enabled: true }) });
  assert.equal(enabled.status, 200);
  const submitted = await localFetch(`${baseUrl}/api/v2/runs`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(call) });
  assert.equal(submitted.status, 202);
  const capabilityRun = await submitted.json() as { runId: string };
  const completed = await waitForRun(baseUrl, capabilityRun.runId, "completed");
  assert.equal(completed.result?.extensionResult?.extensionId, "development_greeting_tool");

  const plain = await localFetch(`${baseUrl}/api/v2/runs`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ schemaVersion: 2, conversationId: created.conversationId, input: { kind: "message", text: "ordinary follow-up without a capability" } }),
  });
  const plainRun = await plain.json() as { runId: string };
  const plainDone = await waitForRun(baseUrl, plainRun.runId, "completed");
  assert.equal(plainDone.result?.extensionResult, undefined);

  const events = await localFetch(`${baseUrl}/api/v2/runs/${capabilityRun.runId}/events`);
  const frames = (await events.text()).split(/\r?\n\r?\n/u).filter((frame) => /^event: /mu.test(frame) && !/^event: stream\.reset$/mu.test(frame));
  const firstId = frames[0]?.match(/^id: ([A-Za-z0-9_-]+)$/mu)?.[1];
  assert.ok(firstId);
  const resumed = await localFetch(`${baseUrl}/api/v2/runs/${capabilityRun.runId}/events`, { headers: { "last-event-id": firstId } });
  const resumedText = await resumed.text();
  assert.equal(resumedText.includes(`id: ${firstId}`), false);
  assert.match(resumedText, /event: run\.completed/u);
});
