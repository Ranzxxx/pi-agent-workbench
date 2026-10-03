import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openStorage } from "@pi-workbench/storage";
import { createProjectFileAccess } from "@pi-workbench/tools";
import { createPersistedFileJournal, recoverPreparedFileOperations } from "../src/file-journal.js";
import { readManagedObject, sha256, storeAttachmentResult, storeFileBackup } from "../src/managed-object-store.js";

function identity(info: { dev: number | bigint; ino: number | bigint }): string { return `${info.dev}:${info.ino}`; }

test("a request journals multiple edits and stores downloadable attachment results separately", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-workbench-journal-"));
  const projectRoot = path.join(parent, "project");
  const dataDirectory = path.join(parent, "state");
  await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, "notes.txt"), "initial\n", "utf8");
  const store = openStorage({ dataDirectory: { dataDirectory } });
  const projectStat = await lstat(projectRoot);
  store.projects.create({ id: "project_files", displayName: "Files", canonicalRoot: projectRoot, directoryIdentity: identity(projectStat), validationState: "valid" });
  store.conversations.create({ id: "conversation_files", projectId: "project_files", piSessionId: null, title: "Files" });
  store.runs.create({ runId: "run_files", conversationId: "conversation_files", request: { kind: "message", text: "edit" } });
  const changeset = store.fileChangesets.ensureForRun({ id: "changeset_files", conversationId: "conversation_files", projectId: "project_files", runId: "run_files" });
  const journal = createPersistedFileJournal({ storage: store, dataDirectory, changesetId: changeset.id });
  const files = createProjectFileAccess(projectRoot, identity(projectStat), journal);
  try {
    const initial = await files.readFile("notes.txt");
    const middle = await files.editFile("notes.txt", initial.token, "middle\n");
    const final = await files.editFile("notes.txt", middle.token, "final\n");
    assert.equal(final.text, "final\n");
    const operations = store.fileOperations.list(changeset.id);
    assert.deepEqual(operations.map((operation) => [operation.sequence, operation.status]), [[1, "applied"], [2, "applied"]]);
    assert.equal(operations[0]?.backupSha256, sha256(Buffer.from("initial\n")));
    assert.equal(operations[1]?.backupSha256, sha256(Buffer.from("middle\n")));
    assert.equal(store.fileChangesets.finalizeRun("run_files")?.status, "applied");

    const result = await storeAttachmentResult({ storage: store, dataDirectory, conversationId: "conversation_files", runId: "run_files", fileName: "edited-notes.txt", text: final.text });
    assert.equal(result.byteSize, Buffer.byteLength(final.text));
    const saved = store.attachmentResults.getForConversation(result.resultId, "conversation_files");
    assert.ok(saved);
    assert.equal((await readManagedObject(dataDirectory, "objects", saved!.objectSha256))?.toString("utf8"), "final\n");
    assert.equal((await readFile(path.join(projectRoot, "notes.txt"), "utf8")), "final\n");
  } finally { store.close(); await rm(parent, { recursive: true, force: true }); }
});

test("restart recovery distinguishes expected postimage, preimage, and an external conflict", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-workbench-recovery-"));
  const projectRoot = path.join(parent, "project");
  const dataDirectory = path.join(parent, "state");
  await mkdir(projectRoot);
  const store = openStorage({ dataDirectory: { dataDirectory } });
  const projectStat = await lstat(projectRoot);
  store.projects.create({ id: "project_recovery", displayName: "Recovery", canonicalRoot: projectRoot, directoryIdentity: identity(projectStat), validationState: "valid" });
  store.conversations.create({ id: "conversation_recovery", projectId: "project_recovery", piSessionId: null, title: "Recovery" });
  const rootIdentity = identity(projectStat);
  try {
    const cases = [
      { runId: "run_post", name: "post.txt", externalText: null, expected: "applied" as const },
      { runId: "run_pre", name: "pre.txt", externalText: null, expected: "not_applied" as const },
      { runId: "run_conflict", name: "conflict.txt", externalText: "external", expected: "conflict" as const },
      { runId: "run_identical_external", name: "identical.txt", externalText: "postimage", expected: "conflict" as const },
    ];
    for (const item of cases) {
      const beforeText = "preimage";
      await writeFile(path.join(projectRoot, item.name), beforeText, "utf8");
      const staging = path.join(projectRoot, `.recovery-${item.runId}.tmp`);
      await writeFile(staging, "postimage", "utf8");
      const stagedIdentity = identity(await lstat(staging));
      store.runs.create({ runId: item.runId, conversationId: "conversation_recovery", request: { kind: "message", text: "recover" } });
      const changeset = store.fileChangesets.ensureForRun({ id: `changeset_${item.runId}`, conversationId: "conversation_recovery", projectId: "project_recovery", runId: item.runId });
      const access = createProjectFileAccess(projectRoot, rootIdentity);
      const before = await access.readFile(item.name);
      const post = Buffer.from("postimage");
      const backupSha256 = await storeFileBackup(store, dataDirectory, Buffer.from(beforeText));
      const resultSha256 = await storeFileBackup(store, dataDirectory, post);
      const operation = store.fileOperations.prepare({
        id: `operation_${item.runId}`, changesetId: changeset.id, relativePath: item.name, kind: "replace",
        preVersion: before.token, preHash: before.sha256, expectedPostHash: resultSha256, backupSha256, resultSha256,
      });
      store.fileOperations.expectPostIdentity(operation.id, stagedIdentity);
      if (item.expected === "applied") await rename(staging, path.join(projectRoot, item.name));
      else {
        if (item.externalText !== null) await writeFile(path.join(projectRoot, item.name), item.externalText, "utf8");
        await unlink(staging);
      }
      await recoverPreparedFileOperations(store);
      assert.equal(store.fileOperations.get(operation.id)?.status, item.expected);
      if (item.expected === "applied") assert.equal(store.fileOperations.get(operation.id)?.postHash, resultSha256);
    }
  } finally { store.close(); await rm(parent, { recursive: true, force: true }); }
});

test("real committed writes with failed verification survive database reopen and recover without overwriting external edits", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-workbench-uncertain-"));
  const projectRoot = path.join(parent, "project");
  const dataDirectory = path.join(parent, "state");
  await mkdir(projectRoot);
  let store = openStorage({ dataDirectory: { dataDirectory } });
  t.after(async () => { store.close(); await rm(parent, { recursive: true, force: true }); });
  const rootIdentity = identity(await lstat(projectRoot));
  store.projects.create({ id: "project_uncertain", displayName: "Uncertain", canonicalRoot: projectRoot, directoryIdentity: rootIdentity, validationState: "valid" });
  store.conversations.create({ id: "conversation_uncertain", projectId: "project_uncertain", piSessionId: null, title: "Uncertain" });
  for (const scenario of ["create", "replace", "external"] as const) {
    const runId = `run_${scenario}`;
    const name = `${scenario}.txt`;
    store.runs.create({ runId, conversationId: "conversation_uncertain", request: { kind: "message", text: "edit" } });
    const changeset = store.fileChangesets.ensureForRun({ id: `changeset_${scenario}`, conversationId: "conversation_uncertain", projectId: "project_uncertain", runId });
    const journal = createPersistedFileJournal({ storage: store, dataDirectory, changesetId: changeset.id });
    const files = createProjectFileAccess(projectRoot, rootIdentity, journal);
    if (scenario === "replace") await writeFile(path.join(projectRoot, name), "before");
    const before = scenario === "replace" ? await files.readFile(name) : undefined;
    const realRead = files.readFile.bind(files);
    const mock = t.mock.method(files, "readFile", async (relativePath: string) => {
      const result = await realRead(relativePath);
      if (result.text === "after") throw Object.assign(new Error("read failed after commit"), { code: "io_error" });
      return result;
    });
    await assert.rejects(before ? files.editFile(name, before.token, "after") : files.createFile(name, "after"), /read failed after commit/u);
    mock.mock.restore();
    assert.equal(store.fileOperations.list(changeset.id)[0]?.status, "uncertain");
    assert.equal(await readFile(path.join(projectRoot, name), "utf8"), "after");
    if (scenario === "external") await writeFile(path.join(projectRoot, name), "external user content");
  }
  store.close();
  store = openStorage({ dataDirectory: { dataDirectory } });
  await recoverPreparedFileOperations(store);
  for (const scenario of ["create", "replace", "external"]) {
    assert.equal(store.fileOperations.list(`changeset_${scenario}`)[0]?.status, scenario === "external" ? "conflict" : "applied");
    assert.equal(await readFile(path.join(projectRoot, `${scenario}.txt`), "utf8"), scenario === "external" ? "external user content" : "after");
  }
});
