import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openStorage } from "@pi-workbench/storage";
import { ProjectPickerService } from "../src/project-picker.js";
import { sha256, writeManagedObject } from "../src/managed-object-store.js";

test("file backup cleanup refuses unexpected directories without deleting their contents", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-workbench-file-cleanup-"));
  const dataDirectory = path.join(parent, "state");
  const storage = openStorage({ dataDirectory: { dataDirectory } });
  const picker = new ProjectPickerService(storage, dataDirectory, []);
  try {
    await picker.initialize();
    const bytes = Buffer.from("expected backup");
    const digest = sha256(bytes);
    storage.contentObjects.register({ sha256: digest, byteSize: bytes.byteLength, createdAt: new Date().toISOString() });
    storage.garbage.enqueue({ kind: "file_backup_object", objectRef: digest });

    const target = path.join(dataDirectory, "file-objects", digest.slice(0, 2), digest);
    await mkdir(target, { recursive: true });
    const marker = path.join(target, "preserve-me.txt");
    await writeFile(marker, "not a managed backup object", "utf8");

    await picker.flushGarbage();

    assert.equal(await readFile(marker, "utf8"), "not a managed backup object");
    assert.equal(storage.contentObjects.get(digest)?.byteSize, bytes.byteLength);
    assert.equal(storage.garbage.list().some((item) => item.kind === "file_backup_object" && item.objectRef === digest), true);
  } finally {
    storage.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("successful backup cleanup removes the deleting claim and object metadata", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-workbench-file-cleanup-success-"));
  const dataDirectory = path.join(parent, "state");
  const storage = openStorage({ dataDirectory: { dataDirectory } });
  const picker = new ProjectPickerService(storage, dataDirectory, []);
  try {
    await picker.initialize();
    const bytes = Buffer.from("unreferenced backup");
    const digest = sha256(bytes);
    await writeManagedObject(dataDirectory, "file-objects", digest, bytes);
    storage.contentObjects.register({ sha256: digest, byteSize: bytes.byteLength, createdAt: new Date().toISOString() });
    storage.garbage.enqueue({ kind: "file_backup_object", objectRef: digest });

    await picker.flushGarbage();

    assert.equal(storage.contentObjects.get(digest), undefined);
    assert.equal(storage.garbage.list().some((item) => item.kind === "file_backup_object" && item.objectRef === digest), false);
    assert.equal(await readFile(path.join(dataDirectory, "file-objects", digest.slice(0, 2), digest)).then(() => true, () => false), false);
  } finally {
    storage.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("permanent conversation deletion removes run and workflow trees but preserves other runs and shared cache", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-workbench-run-artifact-cleanup-"));
  const dataDirectory = path.join(parent, "state");
  const storage = openStorage({ dataDirectory: { dataDirectory } });
  const picker = new ProjectPickerService(storage, dataDirectory, []);
  try {
    await picker.initialize();
    const deletedConversation = storage.conversations.create({ id: "conversation_cleanup", projectId: null, piSessionId: null, title: "Delete" });
    const deletedRun = storage.runs.create({ runId: "run_cleanup", conversationId: deletedConversation.id, request: { kind: "message", text: "fixture" } });
    storage.runs.updateStatus(deletedRun.runId, "failed");
    const retainedConversation = storage.conversations.create({ id: "conversation_keep", projectId: null, piSessionId: null, title: "Keep" });
    const retainedRun = storage.runs.create({ runId: "run_keep", conversationId: retainedConversation.id, request: { kind: "message", text: "fixture" } });
    storage.runs.updateStatus(retainedRun.runId, "failed");

    const runArtifact = path.join(dataDirectory, "runs", deletedRun.runId, "attempt_1", "report.json");
    const workflowArtifact = path.join(dataDirectory, "workflows", deletedRun.runId, "analysis", "output.json");
    const retainedRunArtifact = path.join(dataDirectory, "runs", retainedRun.runId, "attempt_1", "report.json");
    const retainedWorkflowArtifact = path.join(dataDirectory, "workflows", retainedRun.runId, "analysis", "output.json");
    const sharedCacheArtifact = path.join(dataDirectory, "cache", "snapshot", "source.json");
    for (const target of [runArtifact, workflowArtifact, retainedRunArtifact, retainedWorkflowArtifact, sharedCacheArtifact]) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, target);
    }

    storage.conversations.deletePermanently(deletedConversation.id);
    assert.equal(storage.conversations.get(deletedConversation.id), undefined);
    assert.equal(storage.runs.get(deletedRun.runId), undefined);
    assert.ok(storage.garbage.list().some((item) => item.kind === "run_artifacts" && item.objectRef === deletedRun.runId));
    await picker.flushGarbage();

    await assert.rejects(readFile(runArtifact), { code: "ENOENT" });
    await assert.rejects(readFile(workflowArtifact), { code: "ENOENT" });
    assert.equal(await readFile(retainedRunArtifact, "utf8"), retainedRunArtifact);
    assert.equal(await readFile(retainedWorkflowArtifact, "utf8"), retainedWorkflowArtifact);
    assert.equal(await readFile(sharedCacheArtifact, "utf8"), sharedCacheArtifact);
    assert.equal(storage.runs.get(retainedRun.runId)?.conversationId, retainedConversation.id);
    assert.equal(storage.garbage.list().some((item) => item.kind === "run_artifacts" && item.objectRef === deletedRun.runId), false);

    storage.garbage.enqueue({ kind: "run_artifacts", objectRef: "run_without_artifacts" });
    await picker.flushGarbage();
    assert.equal(storage.garbage.list().some((item) => item.kind === "run_artifacts" && item.objectRef === "run_without_artifacts"), false,
      "a run with no disk artifact trees is an idempotent successful cleanup");
  } finally {
    storage.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("run artifact cleanup records unsafe targets and retries after the path is repaired", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-workbench-run-artifact-retry-"));
  const dataDirectory = path.join(parent, "state");
  const outside = path.join(parent, "outside");
  const storage = openStorage({ dataDirectory: { dataDirectory } });
  const picker = new ProjectPickerService(storage, dataDirectory, []);
  try {
    await picker.initialize();
    const conversation = storage.conversations.create({ id: "conversation_retry", projectId: null, piSessionId: null, title: "Retry" });
    const run = storage.runs.create({ runId: "run_retry", conversationId: conversation.id, request: { kind: "message", text: "fixture" } });
    storage.runs.updateStatus(run.runId, "failed");

    const runArtifact = path.join(dataDirectory, "runs", run.runId, "attempt_1", "report.json");
    const outsideMarker = path.join(outside, "keep.txt");
    const unsafeWorkflowTarget = path.join(dataDirectory, "workflows", run.runId);
    await mkdir(path.dirname(runArtifact), { recursive: true });
    await writeFile(runArtifact, "preserve until both artifact paths validate");
    await mkdir(outside, { recursive: true });
    await writeFile(outsideMarker, "outside data");
    await mkdir(path.dirname(unsafeWorkflowTarget), { recursive: true });
    await symlink(outside, unsafeWorkflowTarget);

    storage.conversations.deletePermanently(conversation.id);
    assert.equal(storage.conversations.get(conversation.id), undefined);
    assert.equal(storage.runs.get(run.runId), undefined);
    await picker.flushGarbage();

    const failedQueueItem = storage.garbage.list().find((item) => item.kind === "run_artifacts" && item.objectRef === run.runId);
    assert.deepEqual(failedQueueItem, { kind: "run_artifacts", objectRef: run.runId, attempts: 1 },
      "database deletion must remain visible as a pending disk-cleanup failure");
    assert.equal(await readFile(runArtifact, "utf8"), "preserve until both artifact paths validate");
    assert.equal(await readFile(outsideMarker, "utf8"), "outside data");

    await rm(unsafeWorkflowTarget);
    const workflowRoot = path.join(dataDirectory, "workflows");
    await rm(workflowRoot, { recursive: true });
    await symlink(outside, workflowRoot);
    await picker.flushGarbage();
    assert.deepEqual(storage.garbage.list().find((item) => item.kind === "run_artifacts" && item.objectRef === run.runId),
      { kind: "run_artifacts", objectRef: run.runId, attempts: 2 }, "a symlinked workflow root must also remain a retryable failure");
    assert.equal(await readFile(runArtifact, "utf8"), "preserve until both artifact paths validate");
    assert.equal(await readFile(outsideMarker, "utf8"), "outside data");

    await rm(workflowRoot);
    const workflowArtifact = path.join(unsafeWorkflowTarget, "analysis", "result.json");
    await mkdir(path.dirname(workflowArtifact), { recursive: true });
    await writeFile(workflowArtifact, "retry output");
    await picker.flushGarbage();

    await assert.rejects(readFile(runArtifact), { code: "ENOENT" });
    await assert.rejects(readFile(workflowArtifact), { code: "ENOENT" });
    assert.equal(await readFile(outsideMarker, "utf8"), "outside data");
    assert.equal(storage.garbage.list().some((item) => item.kind === "run_artifacts" && item.objectRef === run.runId), false);
  } finally {
    storage.close();
    await rm(parent, { recursive: true, force: true });
  }
});
