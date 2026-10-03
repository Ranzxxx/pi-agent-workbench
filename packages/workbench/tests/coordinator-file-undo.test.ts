import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openStorage } from "@pi-workbench/storage";
import { createProjectFileAccess } from "@pi-workbench/tools";
import { createWorkbenchService } from "../src/coordinator.js";
import { createPersistedFileJournal } from "../src/file-journal.js";
import { readFileBackup, sha256, writeManagedObject } from "../src/managed-object-store.js";

function identity(info: { dev: number | bigint; ino: number | bigint }): string { return `${info.dev}:${info.ino}`; }

test("coordinator aggregates multi-edit diffs and safely undoes edits and newly created files", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-workbench-file-undo-"));
  const allowedRoot = path.join(parent, "projects");
  const projectRoot = path.join(allowedRoot, "synthetic");
  const dataDirectory = path.join(parent, "state");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "notes.md"), "initial\n", "utf8");

  let service: Awaited<ReturnType<typeof createWorkbenchService>> | undefined;
  let storage: ReturnType<typeof openStorage> | undefined;
  try {
    service = await createWorkbenchService({ mode: "fake", dataDirectory, pickerRoots: [allowedRoot] });
    const session = service.createPickerSession("http://127.0.0.1:3038");
    const rootToken = service.pickerRoots(session.sessionId, "project").roots[0]?.token;
    assert.ok(rootToken);
    const rootView = await service.browsePickerDirectory(session.sessionId, rootToken, "project");
    const directoryToken = rootView.entries.find((entry) => entry.name === "synthetic" && entry.kind === "directory")?.token;
    assert.ok(directoryToken);
    const projectView = await service.browsePickerDirectory(session.sessionId, directoryToken, "project");
    const selection = service.prepareProjectSelection(session.sessionId, projectView.directoryToken);
    const opened = await service.openProject(session.sessionId, selection.selectionToken, "Synthetic project");
    const project = opened.project;
    const conversation = opened.conversation;

    storage = openStorage({ dataDirectory: { dataDirectory } });
    const run = storage.runs.create({ runId: "run_file_undo", conversationId: conversation.conversationId,
      request: { kind: "message", text: "synthetic file update" } });
    const changeset = storage.fileChangesets.ensureForRun({ id: "changeset_file_undo", conversationId: conversation.conversationId,
      projectId: project.projectId, runId: run.runId });
    const directory = await lstat(projectRoot);
    const files = createProjectFileAccess(projectRoot, identity(directory), createPersistedFileJournal({ storage, dataDirectory, changesetId: changeset.id }));
    const initial = await files.readFile("notes.md");
    const middle = await files.editFile("notes.md", initial.token, "middle\n");
    await files.editFile("notes.md", middle.token, "final\n");
    await files.createFile("created.md", "created by task\n");
    storage.fileChangesets.finalizeRun(run.runId);

    const summaries = service.listConversationChangesets(conversation.conversationId);
    assert.equal(summaries.length, 1);
    const detail = await service.getConversationChangeset(conversation.conversationId, summaries[0]!.changesetId);
    assert.deepEqual(detail.diffs.map((diff) => [diff.path, diff.beforeText, diff.afterText]), [
      ["notes.md", "initial\n", "final\n"], ["created.md", null, "created by task\n"],
    ]);

    const undone = await service.undoFileChangeset(conversation.conversationId, changeset.id);
    assert.equal(undone.status, "undone");
    assert.deepEqual(undone.undonePaths.sort(), ["created.md", "notes.md"]);
    assert.deepEqual(undone.conflictPaths, []);
    assert.equal(await readFile(path.join(projectRoot, "notes.md"), "utf8"), "initial\n");
    await assert.rejects(readFile(path.join(projectRoot, "created.md")), { code: "ENOENT" });

    const conflictRun = storage.runs.create({ runId: "run_external_conflict", conversationId: conversation.conversationId,
      request: { kind: "message", text: "external modification conflict" } });
    const conflictChangeset = storage.fileChangesets.ensureForRun({ id: "changeset_external_conflict", conversationId: conversation.conversationId,
      projectId: project.projectId, runId: conflictRun.runId });
    const conflictFiles = createProjectFileAccess(projectRoot, identity(directory), createPersistedFileJournal({ storage, dataDirectory, changesetId: conflictChangeset.id }));
    const conflictBefore = await conflictFiles.readFile("notes.md");
    await conflictFiles.editFile("notes.md", conflictBefore.token, "agent update\n");
    storage.fileChangesets.finalizeRun(conflictRun.runId);
    await writeFile(path.join(projectRoot, "notes.md"), "user update\n", "utf8");
    const conflict = await service.undoFileChangeset(conversation.conversationId, conflictChangeset.id);
    assert.equal(conflict.status, "conflict");
    assert.deepEqual(conflict.undonePaths, []);
    assert.deepEqual(conflict.conflictPaths, ["notes.md"]);
    assert.equal(await readFile(path.join(projectRoot, "notes.md"), "utf8"), "user update\n");
  } finally {
    storage?.close();
    await service?.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("BOM edits preserve exact backup and undo bytes; inconsistent backups become conflicts", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-workbench-bom-undo-"));
  const allowedRoot = path.join(parent, "projects");
  const projectRoot = path.join(allowedRoot, "synthetic");
  const dataDirectory = path.join(parent, "state");
  await mkdir(projectRoot, { recursive: true });
  const originalBom = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("before café\n", "utf8")]);
  const originalPlain = Buffer.from("普通 UTF-8 before\n", "utf8");
  await writeFile(path.join(projectRoot, "bom.md"), originalBom);
  await writeFile(path.join(projectRoot, "plain.md"), originalPlain);

  let service: Awaited<ReturnType<typeof createWorkbenchService>> | undefined;
  let storage: ReturnType<typeof openStorage> | undefined;
  try {
    service = await createWorkbenchService({ mode: "fake", dataDirectory, pickerRoots: [allowedRoot] });
    const session = service.createPickerSession("http://127.0.0.1:3038");
    const rootToken = service.pickerRoots(session.sessionId, "project").roots[0]?.token;
    assert.ok(rootToken);
    const rootView = await service.browsePickerDirectory(session.sessionId, rootToken, "project");
    const directoryToken = rootView.entries.find((entry) => entry.name === "synthetic" && entry.kind === "directory")?.token;
    assert.ok(directoryToken);
    const projectView = await service.browsePickerDirectory(session.sessionId, directoryToken, "project");
    const selection = service.prepareProjectSelection(session.sessionId, projectView.directoryToken);
    const opened = await service.openProject(session.sessionId, selection.selectionToken, "BOM project");
    storage = openStorage({ dataDirectory: { dataDirectory } });
    const run = storage.runs.create({ runId: "run_bom_undo", conversationId: opened.conversation.conversationId,
      request: { kind: "message", text: "edit UTF-8 files" } });
    const changeset = storage.fileChangesets.ensureForRun({ id: "changeset_bom_undo", conversationId: opened.conversation.conversationId,
      projectId: opened.project.projectId, runId: run.runId });
    const rootStat = await lstat(projectRoot);
    const files = createProjectFileAccess(projectRoot, identity(rootStat), createPersistedFileJournal({ storage, dataDirectory, changesetId: changeset.id }));

    const bomBefore = await files.readFile("bom.md");
    assert.equal(bomBefore.text, "\uFEFFbefore café\n");
    await files.editFile("bom.md", bomBefore.token, bomBefore.text);
    assert.deepEqual(await readFile(path.join(projectRoot, "bom.md")), originalBom, "submitting the unmodified read text must retain BOM bytes");
    await files.editFile("bom.md", bomBefore.token, "after café\n");
    assert.deepEqual(await readFile(path.join(projectRoot, "bom.md")), Buffer.from("after café\n", "utf8"), "editing can remove a BOM explicitly");
    const plainBefore = await files.readFile("plain.md");
    await files.editFile("plain.md", plainBefore.token, `\uFEFF${plainBefore.text}after`);
    assert.deepEqual(await readFile(path.join(projectRoot, "plain.md")), Buffer.from(`\uFEFF${plainBefore.text}after`, "utf8"), "editing can add a BOM explicitly");
    await files.createFile("created.md", "\uFEFF新建\n");
    storage.fileChangesets.finalizeRun(run.runId);

    const operations = storage.fileOperations.list(changeset.id);
    const bomOperation = operations.find((operation) => operation.relativePath === "bom.md");
    const plainOperation = operations.find((operation) => operation.relativePath === "plain.md");
    assert.ok(bomOperation?.preHash && bomOperation.backupSha256);
    assert.equal(bomOperation.backupSha256, bomOperation.preHash);
    assert.deepEqual(await readFileBackup(storage, dataDirectory, bomOperation.backupSha256), originalBom);
    assert.ok(plainOperation?.preHash && plainOperation.backupSha256);
    assert.equal(plainOperation.backupSha256, plainOperation.preHash);
    assert.deepEqual(await readFileBackup(storage, dataDirectory, plainOperation.backupSha256), originalPlain);

    const undone = await service.undoFileChangeset(opened.conversation.conversationId, changeset.id);
    assert.equal(undone.status, "undone");
    assert.deepEqual(await readFile(path.join(projectRoot, "bom.md")), originalBom);
    assert.deepEqual(await readFile(path.join(projectRoot, "plain.md")), originalPlain);
    await assert.rejects(readFile(path.join(projectRoot, "created.md")), { code: "ENOENT" });

    const badRun = storage.runs.create({ runId: "run_bad_backup", conversationId: opened.conversation.conversationId,
      request: { kind: "message", text: "reject an old inconsistent backup" } });
    const badChangeset = storage.fileChangesets.ensureForRun({ id: "changeset_bad_backup", conversationId: opened.conversation.conversationId,
      projectId: opened.project.projectId, runId: badRun.runId });
    const wrongBackup = Buffer.from("valid object with wrong preimage\n", "utf8");
    const wrongBackupSha = sha256(wrongBackup);
    storage.contentObjects.register({ sha256: wrongBackupSha, byteSize: wrongBackup.byteLength, createdAt: new Date().toISOString() });
    await writeManagedObject(dataDirectory, "file-objects", wrongBackupSha, wrongBackup);
    const expectedPreimage = Buffer.from("legacy original\n", "utf8");
    const currentBytes = Buffer.from("do not overwrite\n", "utf8");
    const currentSha = sha256(currentBytes);
    storage.contentObjects.register({ sha256: currentSha, byteSize: currentBytes.byteLength, createdAt: new Date().toISOString() });
    await writeManagedObject(dataDirectory, "file-objects", currentSha, currentBytes);
    const badPath = path.join(projectRoot, "legacy.md");
    await writeFile(badPath, currentBytes);
    const access = createProjectFileAccess(projectRoot, identity(rootStat));
    const current = await access.readFile("legacy.md");
    const operation = storage.fileOperations.prepare({ id: "operation_bad_backup", changesetId: badChangeset.id, relativePath: "legacy.md",
      kind: "replace", preVersion: "legacy-pre-version", preHash: sha256(expectedPreimage), expectedPostHash: currentSha,
      backupSha256: wrongBackupSha, resultSha256: currentSha });
    storage.fileOperations.applied(operation.id, current.token, current.sha256);
    storage.fileChangesets.finalizeRun(badRun.runId);

    await assert.rejects(service.getConversationChangeset(opened.conversation.conversationId, badChangeset.id),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
      "a diff must not display a valid object as the recorded preimage when its hash disagrees with preHash");
    await writeFile(path.join(dataDirectory, "file-objects", wrongBackupSha.slice(0, 2), wrongBackupSha), Buffer.alloc(wrongBackup.byteLength, 0x78));
    const conflict = await service.undoFileChangeset(opened.conversation.conversationId, badChangeset.id);
    assert.equal(conflict.status, "conflict");
    assert.deepEqual(conflict.conflictPaths, ["legacy.md"]);
    assert.deepEqual(await readFile(badPath), currentBytes);
    assert.equal(storage.fileOperations.get(operation.id)?.status, "applied", "a rejected backup must not mark the original operation undone");
  } finally {
    storage?.close();
    await service?.close();
    await rm(parent, { recursive: true, force: true });
  }
});
