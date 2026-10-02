import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, access, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createWorkbenchApp } from "../src/app.js";

const rootDir = async () => mkdtemp(path.join(os.tmpdir(), "pi-workbench-picker-"));
async function createApp(base: string, pickerRoot: string) {
  const app = await createWorkbenchApp({ mode: "fake", dataDirectory: path.join(base, "state"), pickerRoots: [pickerRoot] });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, baseUrl };
}
async function localSession(baseUrl: string) {
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
    headers.set("origin", origin); headers.set("cookie", cookie!); headers.set("x-csrf-token", body.csrfToken);
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    return fetch(`${baseUrl}/api/v2${route}`, { ...init, headers });
  }
  return { request, origin, cookie: cookie!, csrfToken: body.csrfToken };
}
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

await test("picker binds directory grants to loopback session, imports immutable text copies, and protects reference cleanup", { timeout: 30_000 }, async (t) => {
  const base = await rootDir();
  const pickerRoot = path.join(base, "projects");
  const projectRoot = path.join(pickerRoot, "sample-app");
  const nested = path.join(projectRoot, "src");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(projectRoot, "AGENTS.md"), "Use local rules only after user confirmation.\n");
  await writeFile(path.join(nested, "notes.md"), "original source bytes\n");
  await writeFile(path.join(nested, "same.md"), "original source bytes\n");
  await writeFile(path.join(nested, ".env"), "SECRET=never import\n");
  await symlink(base, path.join(projectRoot, "outside-link"));
  await mkdir(pickerRoot, { recursive: true });
  let { app, baseUrl } = await createApp(base, pickerRoot);
  t.after(async () => { await app.close().catch(() => undefined); await rm(base, { recursive: true, force: true }); });
  const session = await localSession(baseUrl);

  const noCsrf = await fetch(`${baseUrl}/api/v2/picker/roots?mode=project`, { headers: { origin: session.origin, cookie: session.cookie } });
  assert.equal(noCsrf.status, 400);
  const badOrigin = await fetch(`${baseUrl}/api/v2/picker/roots?mode=project`, { headers: { origin: "http://attacker.example", cookie: session.cookie, "x-csrf-token": session.csrfToken } });
  assert.equal(badOrigin.status, 403);
  const badHostStatus = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(new URL(`${baseUrl}/api/v2/picker/roots?mode=project`), {
      headers: { host: "attacker.example", origin: session.origin, cookie: session.cookie, "x-csrf-token": session.csrfToken },
    }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
    request.on("error", reject); request.end();
  });
  assert.equal(badHostStatus, 403);

  const rootsResponse = await session.request("/picker/roots?mode=project");
  assert.equal(rootsResponse.status, 200);
  const roots = await rootsResponse.json() as { roots: Array<{ token: string }> };
  assert.equal(roots.roots.length, 1);
  const rootListing = await session.request("/picker/browse", post({ schemaVersion: 2, mode: "project", directoryToken: roots.roots[0]!.token }));
  const rootView = await rootListing.json() as { directoryToken: string; entries: Array<{ name: string; kind: string; token?: string }> };
  const selectedDir = rootView.entries.find((entry) => entry.name === "sample-app" && entry.kind === "directory")!;
  const pending = await session.request("/picker/project-selection", post({ schemaVersion: 2, directoryToken: selectedDir.token }));
  const pendingBody = await pending.json() as { selectionToken: string };
  const tampered = await session.request("/picker/open-project", post({ schemaVersion: 2, selectionToken: `${pendingBody.selectionToken}tampered` }));
  assert.equal(tampered.status, 404);
  assert.deepEqual((await session.request("/projects").then((response) => response.json()) as { projects: unknown[] }).projects, [], "cancelling before open does not create a project");

  const projectViewResponse = await session.request("/picker/browse", post({ schemaVersion: 2, mode: "project", directoryToken: selectedDir.token }));
  const projectView = await projectViewResponse.json() as { directoryToken: string; entries: Array<{ name: string; kind: string; token?: string; reason?: string }> };
  assert.equal(projectView.entries.find((entry) => entry.name === "outside-link")?.kind, "excluded");
  const openSelection = await session.request("/picker/project-selection", post({ schemaVersion: 2, directoryToken: selectedDir.token }));
  const openSelectionBody = await openSelection.json() as { selectionToken: string };
  const openedResponse = await session.request("/picker/open-project", post({ schemaVersion: 2, selectionToken: openSelectionBody.selectionToken }));
  assert.equal(openedResponse.status, 201);
  const opened = await openedResponse.json() as { project: { projectId: string; canonicalRoot: string }; conversation: { conversationId: string; projectId: string } };
  assert.equal(opened.project.canonicalRoot, projectRoot);
  assert.equal(opened.conversation.projectId, opened.project.projectId);
  const secondConversation = await session.request(`/projects/${opened.project.projectId}/conversations`, post({}));
  const secondConversationBody = await secondConversation.json() as { conversationId: string; projectId: string };
  assert.equal(secondConversationBody.projectId, opened.project.projectId);
  const nestedProjectView = await session.request("/picker/browse", post({ schemaVersion: 2, mode: "project", directoryToken: selectedDir.token }));
  const nestedProjectEntries = await nestedProjectView.json() as { entries: Array<{ name: string; token?: string }> };
  const nestedProjectToken = nestedProjectEntries.entries.find((entry) => entry.name === "src")!.token!;
  const nestedSelection = await session.request("/picker/project-selection", post({ schemaVersion: 2, directoryToken: nestedProjectToken }));
  const nestedSelectionBody = await nestedSelection.json() as { selectionToken: string };
  assert.equal((await session.request("/picker/open-project", post({ schemaVersion: 2, selectionToken: nestedSelectionBody.selectionToken }))).status, 409,
    "nested project roots are rejected to prevent overlapping grants");

  const previewResponse = await session.request(`/projects/${opened.project.projectId}/rules/preview`, post({}));
  const preview = await previewResponse.json() as { previewToken: string; content: string };
  assert.match(preview.content, /local rules/u);
  const acceptedResponse = await session.request(`/projects/${opened.project.projectId}/rules/accept`, post({ schemaVersion: 2, previewToken: preview.previewToken }));
  assert.equal(acceptedResponse.status, 200);
  assert.equal((await acceptedResponse.json() as { rules: { sourceVersion: string } }).rules.sourceVersion.startsWith("sha256:"), true);
  assert.equal((await session.request(`/projects/${opened.project.projectId}/rules`).then((response) => response.json()) as { rules: { content: string } }).rules.content, preview.content);
  assert.equal((await session.request(`/projects/${opened.project.projectId}/rules`, { method: "DELETE" })).status, 200);
  assert.equal((await session.request(`/projects/${opened.project.projectId}/rules`).then((response) => response.json()) as { rules: unknown }).rules, null);

  const plainConversation = await fetch(`${baseUrl}/api/v2/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((response) => response.json()) as { conversationId: string };
  const attachmentRoots = await session.request("/picker/roots?mode=attachment").then((response) => response.json()) as { roots: Array<{ token: string }> };
  const attachmentRoot = await session.request("/picker/browse", post({ schemaVersion: 2, mode: "attachment", directoryToken: attachmentRoots.roots[0]!.token }));
  const attachmentRootView = await attachmentRoot.json() as { entries: Array<{ name: string; kind: string; token?: string }> };
  const attachmentProjectToken = attachmentRootView.entries.find((entry) => entry.name === "sample-app" && entry.kind === "directory")!.token!;
  const attachmentProjectView = await session.request("/picker/browse", post({ schemaVersion: 2, mode: "attachment", directoryToken: attachmentProjectToken }));
  const attachmentProjectBody = await attachmentProjectView.json() as { entries: Array<{ name: string; kind: string; token?: string }> };
  const attachmentNestedToken = attachmentProjectBody.entries.find((entry) => entry.name === "src" && entry.kind === "directory")!.token!;
  const attachmentListing = await session.request("/picker/browse", post({ schemaVersion: 2, mode: "attachment", directoryToken: attachmentNestedToken }));
  const attachmentDirectory = await attachmentListing.json() as { directoryToken: string; entries: Array<{ name: string; kind: string; token?: string; reason?: string }> };
  assert.equal(attachmentDirectory.entries.find((entry) => entry.name === ".env")?.kind, "excluded");
  const file = attachmentDirectory.entries.find((entry) => entry.name === "notes.md" && entry.kind === "file")!;
  const sameFile = attachmentDirectory.entries.find((entry) => entry.name === "same.md" && entry.kind === "file")!;
  const importResponse = await session.request(`/conversations/${plainConversation.conversationId}/attachments/import`, post({ schemaVersion: 2, fileTokens: [file.token] }));
  assert.equal(importResponse.status, 200);
  const imported = await importResponse.json() as { attachments: Array<{ attachmentId: string; fileName: string }>; totalBytes: number };
  assert.equal(imported.attachments.length, 1);
  const directoryImport = await session.request(`/conversations/${plainConversation.conversationId}/attachments/import`, post({ schemaVersion: 2, fileTokens: [], directoryToken: attachmentNestedToken }));
  const directoryImportBody = await directoryImport.json() as { attachments: Array<unknown>; skipped: Array<{ path: string; reason: string }> };
  assert.equal(directoryImport.status, 200);
  assert.equal(directoryImportBody.attachments.length, 2, "folder import copies eligible text files");
  assert.equal(directoryImportBody.skipped.some((item) => item.path.endsWith(".env") && item.reason === "sensitive_file"), true);
  await writeFile(path.join(nested, "notes.md"), "changed after import\n");
  const attachmentPath = `/conversations/${plainConversation.conversationId}/attachments/${imported.attachments[0]!.attachmentId}`;
  const bytes = await session.request(attachmentPath).then((response) => response.text());
  assert.equal(bytes, "original source bytes\n");
  const forgedAttachment = await session.request(`/conversations/${opened.conversation.conversationId}/attachments/${imported.attachments[0]!.attachmentId}`);
  assert.equal(forgedAttachment.status, 404);

  const secondImport = await session.request(`/conversations/${secondConversationBody.conversationId}/attachments/import`, post({ schemaVersion: 2, fileTokens: [sameFile.token] }));
  assert.equal(secondImport.status, 200);
  const secondImported = await secondImport.json() as { attachments: Array<{ attachmentId: string }> };
  const hash = createHash("sha256").update("original source bytes\n").digest("hex");
  const objectPath = path.join(base, "state", "objects", hash.slice(0, 2), hash);
  assert.equal(await readFile(objectPath, "utf8"), "original source bytes\n");
  assert.equal((await session.request(`/conversations/${plainConversation.conversationId}`, { method: "DELETE" })).status, 200);
  assert.equal((await session.request(attachmentPath)).status, 404, "deleted attachment references are no longer accessible");
  await access(objectPath);
  const otherConversationId = secondConversationBody.conversationId;
  assert.equal((await session.request(`/conversations/${otherConversationId}/attachments/${secondImported.attachments[0]!.attachmentId}`).then((response) => response.status)), 200);
  assert.equal((await session.request(`/conversations/${otherConversationId}`, { method: "DELETE" })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await assert.rejects(access(objectPath));

  const retryContent = "retry cleanup payload\n";
  await writeFile(path.join(nested, "retry.md"), retryContent);
  const retryListing = await session.request("/picker/browse", post({ schemaVersion: 2, mode: "attachment", directoryToken: attachmentNestedToken }));
  const retryEntries = await retryListing.json() as { entries: Array<{ name: string; token?: string }> };
  const retryToken = retryEntries.entries.find((entry) => entry.name === "retry.md")!.token!;
  const retryConversation = await fetch(`${baseUrl}/api/v2/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((response) => response.json()) as { conversationId: string };
  const retryImport = await session.request(`/conversations/${retryConversation.conversationId}/attachments/import`, post({ schemaVersion: 2, fileTokens: [retryToken] }));
  assert.equal(retryImport.status, 200);
  const retryHash = createHash("sha256").update(retryContent).digest("hex");
  const retryObjectPath = path.join(base, "state", "objects", retryHash.slice(0, 2), retryHash);
  await rm(retryObjectPath);
  await mkdir(retryObjectPath);
  assert.equal((await session.request(`/conversations/${retryConversation.conversationId}`, { method: "DELETE" })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal((await lstat(retryObjectPath)).isDirectory(), true, "failed object cleanup remains queued rather than deleting a directory");
  await rm(retryObjectPath, { recursive: true });
  await writeFile(retryObjectPath, retryContent);

  await app.close();
  ({ app, baseUrl } = await createApp(base, pickerRoot));
  await assert.rejects(access(retryObjectPath), "startup retries the queued object cleanup");
  const restarted = await localSession(baseUrl);
  const recent = await restarted.request("/projects").then((response) => response.json()) as { projects: Array<{ projectId: string; validationState: string }> };
  assert.equal(recent.projects.find((item) => item.projectId === opened.project.projectId)?.validationState, "valid");
});
