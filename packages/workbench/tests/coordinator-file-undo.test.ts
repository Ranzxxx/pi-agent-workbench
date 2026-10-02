import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openStorage } from "@pi-workbench/storage";
import { createProjectFileAccess } from "@pi-workbench/tools";
import { createWorkbenchService } from "../src/coordinator.js";
import { createPersistedFileJournal } from "../src/file-journal.js";

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
