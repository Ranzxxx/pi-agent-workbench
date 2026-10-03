import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedObjectQuotaExceededError, openStorage, StorageError } from "@pi-workbench/storage";
import { ProjectPickerService } from "../src/project-picker.js";
import { readManagedObject, sha256, storeAttachmentResult, storeFileBackup } from "../src/managed-object-store.js";

async function pickerFixture(input: { quota: number; files: Record<string, string> }) {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-managed-quota-workbench-"));
  const dataDirectory = path.join(parent, "state");
  const root = path.join(parent, "projects");
  await mkdir(root);
  for (const [name, content] of Object.entries(input.files)) await writeFile(path.join(root, name), content, "utf8");
  const storage = openStorage({ dataDirectory: { dataDirectory } });
  storage.conversations.create({ id: "conversation_quota", projectId: null, piSessionId: null, title: "Quota" });
  const run = storage.runs.create({ runId: "run_quota", conversationId: "conversation_quota", request: { kind: "message", text: "save" } });
  const picker = new ProjectPickerService(storage, dataDirectory, [root], input.quota);
  await picker.initialize();
  const session = picker.startSession("http://localhost");
  const rootToken = picker.listRoots(session.sessionId, "attachment").roots[0]?.token;
  assert.ok(rootToken);
  const view = await picker.browse(session.sessionId, rootToken!, "attachment");
  const tokens = Object.fromEntries(view.entries.filter((entry) => entry.kind === "file" && entry.token).map((entry) => [entry.name, entry.token!])) as Record<string, string>;
  return { parent, root, dataDirectory, storage, picker, sessionId: session.sessionId, tokens, runId: run.runId };
}

test("attachments and attachment results share physical object bytes by area and digest", async () => {
  const fixture = await pickerFixture({ quota: 3, files: { "notes.txt": "abc" } });
  try {
    const imported = await fixture.picker.importAttachments(fixture.sessionId, "conversation_quota", [fixture.tokens["notes.txt"]!]);
    assert.equal(imported.totalBytes, 3);
    const result = await storeAttachmentResult({ storage: fixture.storage, dataDirectory: fixture.dataDirectory, conversationId: "conversation_quota",
      runId: fixture.runId, fileName: "copy.txt", text: "abc", maxManagedObjectBytes: 3 });
    assert.equal(result.byteSize, 3);
    assert.equal(fixture.storage.attachments.totalBytes(), 3);
    assert.equal(fixture.storage.contentObjects.totalBytes(), 0);
    assert.equal(fixture.storage.attachmentResults.list("conversation_quota").length, 1);

    await assert.rejects(storeAttachmentResult({ storage: fixture.storage, dataDirectory: fixture.dataDirectory, conversationId: "conversation_quota",
      runId: fixture.runId, fileName: "new.txt", text: "xyz", maxManagedObjectBytes: 3 }),
      (error: unknown) => error instanceof Error && error.message.includes("本地附件空间达到安全上限") &&
        error.cause instanceof ManagedObjectQuotaExceededError);
    assert.equal(fixture.storage.attachmentResults.list("conversation_quota").length, 1);
    assert.equal(fixture.storage.managedObjects.list().length, 0);

    await assert.rejects(storeFileBackup(fixture.storage, fixture.dataDirectory, Buffer.from("abc"), 5),
      (error: unknown) => error instanceof Error && error.message.includes("本地备份空间达到安全上限") &&
        error.cause instanceof ManagedObjectQuotaExceededError);
    assert.equal(fixture.storage.contentObjects.totalBytes(), 0);
  } finally {
    fixture.storage.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("same digest backup writes deduplicate under concurrent reservations", async () => {
  const fixture = await pickerFixture({ quota: 6, files: {} });
  try {
    const bytes = Buffer.from("shared");
    const [first, second] = await Promise.all([
      storeFileBackup(fixture.storage, fixture.dataDirectory, bytes, 6),
      storeFileBackup(fixture.storage, fixture.dataDirectory, bytes, 6),
    ]);
    assert.equal(first, sha256(bytes));
    assert.equal(second, first);
    assert.equal(fixture.storage.contentObjects.totalBytes(), 6);
    assert.equal(fixture.storage.managedObjects.list().length, 0);
  } finally {
    fixture.storage.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("new attachment import over an already-used quota is rejected before writing or recording it", async () => {
  const fixture = await pickerFixture({ quota: 4, files: { "existing.txt": "held", "new.txt": "new" } });
  try {
    await fixture.picker.importAttachments(fixture.sessionId, "conversation_quota", [fixture.tokens["existing.txt"]!]);
    const rejectedHash = sha256(Buffer.from("new"));
    await assert.rejects(fixture.picker.importAttachments(fixture.sessionId, "conversation_quota", [fixture.tokens["new.txt"]!]),
      (error: unknown) => error instanceof Error && error.message.includes("本地附件空间达到安全上限，已拒绝导入。") &&
        (error as Error & { statusCode?: number }).statusCode === 409);
    assert.equal(fixture.storage.attachments.list("conversation_quota").length, 1);
    assert.equal(fixture.storage.attachments.totalBytes(), 4);
    assert.equal(fixture.storage.attachments.referenceCount(rejectedHash), 0);
    assert.equal(await readManagedObject(fixture.dataDirectory, "objects", rejectedHash), null);
    assert.equal(fixture.storage.managedObjects.list().length, 0);
    assert.equal((await readdir(path.join(fixture.dataDirectory, "objects", ".staging"))).length, 0);
  } finally {
    fixture.storage.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("failed result registration queues the written object, releases its reservation, and leaves no reference", async () => {
  const fixture = await pickerFixture({ quota: 32, files: {} });
  try {
    const text = "orphan result";
    const orphanHash = sha256(Buffer.from(text));
    await assert.rejects(storeAttachmentResult({ storage: fixture.storage, dataDirectory: fixture.dataDirectory,
      conversationId: "missing_conversation", runId: fixture.runId, fileName: "result.txt", text, maxManagedObjectBytes: 32 }),
      (error: unknown) => error instanceof StorageError && error.code === "conflict");
    assert.equal(fixture.storage.managedObjects.list().length, 0);
    assert.equal(fixture.storage.attachments.referenceCount(orphanHash), 0);
    assert.equal(fixture.storage.attachments.totalBytes(), 0);
    assert.ok(fixture.storage.garbage.list().some((item) => item.kind === "attachment_object" && item.objectRef === orphanHash));
    assert.equal((await readManagedObject(fixture.dataDirectory, "objects", orphanHash))?.toString("utf8"), text);

    await fixture.picker.flushGarbage();

    assert.equal(await readManagedObject(fixture.dataDirectory, "objects", orphanHash), null);
    assert.equal(fixture.storage.garbage.list().some((item) => item.kind === "attachment_object" && item.objectRef === orphanHash), false);
    assert.equal(fixture.storage.attachments.referenceCount(orphanHash), 0);
  } finally {
    fixture.storage.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("failed standalone backup registration queues and cleans the written orphan", async () => {
  const fixture = await pickerFixture({ quota: 32, files: {} });
  try {
    const bytes = Buffer.from("orphan backup");
    const orphanHash = sha256(bytes);
    Object.defineProperty(fixture.storage.contentObjects, "registerReserved", { configurable: true,
      value: () => { throw new Error("injected backup registration failure"); } });
    await assert.rejects(storeFileBackup(fixture.storage, fixture.dataDirectory, bytes, 32), /injected backup registration failure/u);
    assert.equal(fixture.storage.managedObjects.list().length, 0);
    assert.equal(fixture.storage.fileOperations.list("missing_changeset").length, 0);
    assert.equal(fixture.storage.contentObjects.get(orphanHash)?.byteSize, bytes.byteLength);
    assert.ok(fixture.storage.garbage.list().some((item) => item.kind === "file_backup_object" && item.objectRef === orphanHash));
    assert.deepEqual(await readManagedObject(fixture.dataDirectory, "file-objects", orphanHash), bytes);

    await fixture.picker.flushGarbage();

    assert.equal(fixture.storage.contentObjects.get(orphanHash), undefined);
    assert.equal(fixture.storage.garbage.list().some((item) => item.kind === "file_backup_object" && item.objectRef === orphanHash), false);
    assert.equal(await readManagedObject(fixture.dataDirectory, "file-objects", orphanHash), null);
  } finally {
    fixture.storage.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("concurrent attachment import and backup cannot commit above the shared limit", async () => {
  const fixture = await pickerFixture({ quota: 8, files: { "notes.txt": "import" } });
  const workerStorage = openStorage({ path: fixture.storage.path });
  try {
    const outcomes = await Promise.allSettled([
      fixture.picker.importAttachments(fixture.sessionId, "conversation_quota", [fixture.tokens["notes.txt"]!]),
      storeFileBackup(workerStorage, fixture.dataDirectory, Buffer.from("backup"), 8),
    ]);
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
    assert.ok(fixture.storage.attachments.totalBytes() + fixture.storage.contentObjects.totalBytes() <= 8);
    assert.equal(fixture.storage.managedObjects.list().length, 0);
    assert.equal(fixture.storage.attachments.list("conversation_quota").length, outcomes[0]?.status === "fulfilled" ? 1 : 0);
  } finally {
    workerStorage.close();
    fixture.storage.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("partial attachment write failure releases reservations and creates no attachment references", async () => {
  const fixture = await pickerFixture({ quota: 32, files: { "first.txt": "first", "second.txt": "second" } });
  try {
    const original = (fixture.picker as unknown as { writeObject: (hash: string, bytes: Buffer, stagingId: string) => Promise<void> }).writeObject.bind(fixture.picker);
    let writes = 0;
    Object.defineProperty(fixture.picker, "writeObject", { configurable: true, value: async (hash: string, bytes: Buffer, stagingId: string) => {
      writes += 1;
      if (writes === 2) throw new Error("injected second object write failure");
      await original(hash, bytes, stagingId);
    } });
    const tokens = [fixture.tokens["first.txt"]!, fixture.tokens["second.txt"]!];
    await assert.rejects(fixture.picker.importAttachments(fixture.sessionId, "conversation_quota", tokens), /没有创建附件记录/u);
    assert.equal(fixture.storage.attachments.list("conversation_quota").length, 0);
    assert.equal(fixture.storage.attachments.totalBytes(), 0);
    assert.equal(fixture.storage.managedObjects.list().length, 0);
    const firstHash = sha256(Buffer.from("first"));
    assert.equal(await readManagedObject(fixture.dataDirectory, "objects", firstHash), null);
    assert.equal((await readdir(path.join(fixture.dataDirectory, "objects", ".staging"))).length, 0);
    assert.equal(writes, 2);
  } finally {
    fixture.storage.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});
