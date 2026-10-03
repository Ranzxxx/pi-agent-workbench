import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openStorage, type Storage } from "@pi-workbench/storage";
import type { V2RunSubmission } from "@pi-workbench/protocol";
import { createDevelopmentGreetingExtension } from "../src/development-extension.js";
import { composeToolsExtensionSet, createAuthorizedConversationTools, type WorkerExecutionOptions } from "../src/execution.js";
import { createCapabilityRegistry, type CapabilityContext } from "../src/registry.js";
import { reserveManagedObjects, sha256, writeManagedObject } from "../src/managed-object-store.js";

function identity(info: { dev: number | bigint; ino: number | bigint }): string { return `${info.dev}:${info.ino}`; }

function options(input: {
  dataDirectory: string; conversationId: string; runId: string; submission?: V2RunSubmission;
  project?: WorkerExecutionOptions["project"];
}): WorkerExecutionOptions {
  return {
    runId: input.runId, attemptId: `attempt_${input.runId}`, conversationId: input.conversationId,
    input: input.submission ?? { kind: "message", text: "ordinary request" }, mode: "fake",
    dataDirectory: input.dataDirectory, fixtureRoot: input.dataDirectory,
    ...(input.project ? { project: input.project } : {}), signal: new AbortController().signal,
    async emit() {}, async saveSnapshot() {},
  };
}

function context(conversationId: string, projectId: string | null): CapabilityContext {
  return {
    runId: `run_${conversationId}`, attemptId: `attempt_run_${conversationId}`, conversationId, projectId,
    prompt: "Call the greeting tool", signal: new AbortController().signal,
    budget: { timeoutMs: 10_000, maxModelCalls: 3, maxToolCalls: 8, maxTokens: 4000, maxOutputTokens: 1000, maxCostUsd: 1 },
    configuration: {}, emit() {},
  };
}

function toolText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) throw new Error("Tool did not return content");
  const text = result.content.find((item: unknown): item is { type: "text"; text: string } =>
    typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string")?.text;
  assert.equal(typeof text, "string");
  return text!;
}

async function createAttachment(storage: Storage, dataDirectory: string, input: { id: string; conversationId: string; runId: string; fileName: string; text: string }) {
  const bytes = Buffer.from(input.text, "utf8");
  const digest = sha256(bytes);
  const reservations = await reserveManagedObjects(storage, dataDirectory, [{ area: "objects", sha256: digest, byteSize: bytes.byteLength }], 1024);
  await writeManagedObject(dataDirectory, "objects", digest, bytes, reservations[0]!.reservationId);
  return storage.attachments.addManyReserved([{
    id: input.id, conversationId: input.conversationId, objectSha256: digest, fileName: input.fileName,
    relativePath: input.fileName, byteSize: bytes.byteLength, mediaType: "text/plain; charset=utf-8",
  }], reservations.map((reservation) => reservation.reservationId))[0]!;
}

test("tools-kind extensions compose with authorized project tools and journal real file edits", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-extension-tools-compose-"));
  const projectRoot = path.join(parent, "project");
  const dataDirectory = path.join(parent, "state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "notes.txt"), "before\n", "utf8");
  let storage = openStorage({ dataDirectory: { dataDirectory } });
  t.after(async () => { storage.close(); await rm(parent, { recursive: true, force: true }); });

  const canonicalRoot = await realpath(projectRoot);
  const directoryIdentity = identity(await lstat(canonicalRoot));
  storage.projects.create({ id: "project_compose", displayName: "Compose", canonicalRoot, directoryIdentity, validationState: "valid" });
  storage.conversations.create({ id: "conversation_compose", projectId: "project_compose", piSessionId: null, title: "Compose" });
  storage.runs.create({ runId: "run_conversation_compose", conversationId: "conversation_compose", request: { kind: "message", text: "edit" } });
  storage.runs.create({ runId: "run_conversation_next", conversationId: "conversation_compose", request: { kind: "message", text: "ordinary" } });

  const workerOptions = options({
    dataDirectory, conversationId: "conversation_compose", runId: "run_conversation_compose",
    project: { projectId: "project_compose", canonicalRoot, directoryIdentity },
  });
  const base = await createAuthorizedConversationTools(storage, workerOptions);
  if (!base.ok) throw new Error("project tools were not authorized");
  assert.equal(base.ok, true);
  const baseNames = base.tools.map((tool) => tool.name);
  assert.ok(baseNames.includes("read_project_file"));
  assert.ok(baseNames.includes("edit_project_file"));

  const registry = createCapabilityRegistry([createDevelopmentGreetingExtension()]);
  const greeting = registry.get("development_greeting_tool");
  const enabled = registry.updateState(greeting, undefined, { enabled: true });
  const submission = registry.prepareInvocation({
    kind: "capability", capabilityId: greeting.manifest.id, input: {}, prompt: "Call the greeting tool",
  }, enabled, new Set());
  let reservedNamesSeen: ReadonlySet<string> = new Set();
  const createRegisteredTools = registry.createTools.bind(registry);
  registry.createTools = async (input, invocationContext, reservedNames) => {
    reservedNamesSeen = new Set(reservedNames);
    return createRegisteredTools(input, invocationContext, reservedNames);
  };
  const composed = await composeToolsExtensionSet(registry, submission, context("conversation_compose", "project_compose"), base.tools);
  for (const name of baseNames) assert.equal(reservedNamesSeen.has(name), true, `base tool name ${name} must be reserved during extension registration`);
  assert.ok(composed.tools.some((tool) => tool.name === "development_greeting_tool__make_greeting"));
  assert.ok(composed.tools.some((tool) => tool.name === "read_project_file"));
  assert.deepEqual(base.tools.map((tool) => tool.name), baseNames, "composition must not mutate the next ordinary request's base tool set");
  const nextTurn = await createAuthorizedConversationTools(storage, options({
    dataDirectory, conversationId: "conversation_compose", runId: "run_conversation_next",
    project: { projectId: "project_compose", canonicalRoot, directoryIdentity },
  }));
  assert.equal(nextTurn.ok, true);
  if (!nextTurn.ok) throw new Error("next ordinary run in the same conversation lost its project authorization");
  assert.equal(nextTurn.tools.some((tool) => tool.name === "development_greeting_tool__make_greeting"), false,
    "extension tools are scoped to the selected capability request");

  const readTool = composed.tools.find((tool) => tool.name === "read_project_file");
  const editTool = composed.tools.find((tool) => tool.name === "edit_project_file");
  const greetingTool = composed.tools.find((tool) => tool.name === "development_greeting_tool__make_greeting");
  assert.ok(readTool && editTool && greetingTool);
  const read = await readTool.execute("read", { path: "notes.txt" }, undefined, undefined, {} as never);
  const before = JSON.parse(toolText(read)) as { token: string; text: string };
  assert.equal(before.text, "before\n");
  const edited = await editTool.execute("edit", { path: "notes.txt", version: before.token, text: "after\n" }, undefined, undefined, {} as never);
  assert.equal(JSON.parse(toolText(edited)).text, "after\n");
  assert.equal(await readFile(path.join(projectRoot, "notes.txt"), "utf8"), "after\n");
  const changeset = storage.fileChangesets.forRun("run_conversation_compose");
  assert.ok(changeset);
  assert.equal(storage.fileOperations.list(changeset!.id).length, 1);
  assert.equal(storage.fileOperations.list(changeset!.id)[0]?.status, "applied");

  const greetingResult = await greetingTool.execute("greeting", { name: "Ada" }, undefined, undefined, {} as never);
  assert.deepEqual(JSON.parse(toolText(greetingResult)), { message: "Hello, Ada." });
  assert.equal(composed.toolCalls.length, 1);
  assert.equal(composed.toolCalls[0]?.toolName, "development_greeting_tool__make_greeting");
  assert.equal(registry.validateOutput(greeting.manifest.id, { toolCalls: composed.toolCalls }), true);
});

test("attachments stay conversation-scoped, absent project authorization fails closed, and ordinary requests get no extension tools", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-conversation-tools-scope-"));
  const dataDirectory = path.join(parent, "state");
  let storage = openStorage({ dataDirectory: { dataDirectory } });
  t.after(async () => { storage.close(); await rm(parent, { recursive: true, force: true }); });

  storage.conversations.create({ id: "conversation_a", projectId: null, piSessionId: null, title: "A" });
  storage.conversations.create({ id: "conversation_b", projectId: null, piSessionId: null, title: "B" });
  storage.conversations.create({ id: "conversation_empty", projectId: null, piSessionId: null, title: "Empty" });
  storage.projects.create({ id: "project_missing", displayName: "Missing authorization", canonicalRoot: parent, directoryIdentity: null, validationState: "needs_review" });
  storage.conversations.create({ id: "conversation_project", projectId: "project_missing", piSessionId: null, title: "Project" });
  storage.runs.create({ runId: "run_conversation_a", conversationId: "conversation_a", request: { kind: "capability", capabilityId: "development_greeting_tool", input: {} } });
  storage.runs.create({ runId: "run_conversation_b", conversationId: "conversation_b", request: { kind: "message", text: "B" } });
  storage.runs.create({ runId: "run_conversation_empty", conversationId: "conversation_empty", request: { kind: "message", text: "ordinary" } });
  storage.runs.create({ runId: "run_conversation_project", conversationId: "conversation_project", request: { kind: "message", text: "ordinary" } });
  const first = await createAttachment(storage, dataDirectory, { id: "attachment_a", conversationId: "conversation_a", runId: "run_conversation_a", fileName: "a.txt", text: "private A" });
  const second = await createAttachment(storage, dataDirectory, { id: "attachment_b", conversationId: "conversation_b", runId: "run_conversation_b", fileName: "b.txt", text: "private B" });

  const authorized = await createAuthorizedConversationTools(storage, options({ dataDirectory, conversationId: "conversation_a", runId: "run_conversation_a" }));
  if (!authorized.ok) throw new Error("attachment tools were not authorized");
  assert.equal(authorized.ok, true);
  const listTool = authorized.tools.find((tool) => tool.name === "list_attachments");
  const readTool = authorized.tools.find((tool) => tool.name === "read_attachment");
  const saveTool = authorized.tools.find((tool) => tool.name === "save_text_result");
  assert.ok(listTool && readTool && saveTool);
  assert.equal(authorized.tools.some((tool) => tool.name === "read_project_file"), false);
  assert.deepEqual(JSON.parse(toolText(await listTool.execute("list", {}, undefined, undefined, {} as never))), [
    { attachmentId: first.id, fileName: first.fileName, byteSize: first.byteSize, mediaType: first.mediaType },
  ]);
  await assert.rejects(readTool.execute("read-other", { attachmentId: second.id }, undefined, undefined, {} as never), /不属于当前对话/u);
  assert.match(toolText(await readTool.execute("read-own", { attachmentId: first.id }, undefined, undefined, {} as never)), /private A/u);
  const saved = await saveTool.execute("save", { fileName: "summary.txt", text: "result", sourceAttachmentId: first.id }, undefined, undefined, {} as never);
  assert.equal(JSON.parse(toolText(saved)).fileName, "summary.txt");
  assert.equal(storage.attachmentResults.list("conversation_a").length, 1);
  assert.equal(storage.attachmentResults.list("conversation_b").length, 0);
  await assert.rejects(saveTool.execute("save-other-source", {
    fileName: "invalid-source.txt", text: "must reject", sourceAttachmentId: second.id,
  }, undefined, undefined, {} as never), /源附件不属于当前对话/u);
  assert.equal(storage.attachmentResults.list("conversation_a").length, 1, "foreign attachment IDs must not create a result");

  const empty = await createAuthorizedConversationTools(storage, options({ dataDirectory, conversationId: "conversation_empty", runId: "run_conversation_empty" }));
  assert.equal(empty.ok, true);
  if (!empty.ok) throw new Error("ordinary request failed authorization");
  assert.deepEqual(empty.tools, [], "ordinary requests have no extension or project tools when they have no project or attachments");

  const missingProject = await createAuthorizedConversationTools(storage, options({ dataDirectory, conversationId: "conversation_project", runId: "run_conversation_project" }));
  if (missingProject.ok) throw new Error("missing project authorization unexpectedly exposed tools");
  assert.equal(missingProject.result.status, "failed");
  if (missingProject.result.status === "failed") assert.match(missingProject.result.error.message, /项目授权缺失/u);

  const registry = createCapabilityRegistry([createDevelopmentGreetingExtension()]);
  const definition = registry.get("development_greeting_tool");
  const enabled = registry.updateState(definition, undefined, { enabled: true });
  const submission = registry.prepareInvocation({ kind: "capability", capabilityId: definition.manifest.id, input: {}, prompt: "Call greeting" }, enabled, new Set());
  await assert.rejects(registry.createTools(submission, context("conversation_a", null), new Set(["development_greeting_tool__make_greeting"])), /conflicts/u);
});
