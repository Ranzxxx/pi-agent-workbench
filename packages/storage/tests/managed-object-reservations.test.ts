import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedObjectQuotaExceededError, ManagedObjectReservationBusyError, openStorage, type ManagedObjectReservationInventory } from "../src/index.js";

const emptyInventory: ManagedObjectReservationInventory = { objects: [], stagingFiles: [], untrackedBytes: 0 };

test("managed object reservations share one atomic budget across SQLite connections and physical areas", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-managed-quota-storage-"));
  const dataDirectory = path.join(parent, "state");
  const first = openStorage({ dataDirectory: { dataDirectory } });
  const second = openStorage({ path: first.path });
  try {
    first.managedObjects.reserveBatch({ requests: [
      { reservationId: "attachment", area: "objects", sha256: "a".repeat(64), byteSize: 4 },
      { reservationId: "backup", area: "file-objects", sha256: "a".repeat(64), byteSize: 4 },
    ], maxBytes: 8, inventory: emptyInventory, observedReservations: first.managedObjects.list() });
    assert.equal(first.managedObjects.list().length, 2);
    assert.throws(() => second.managedObjects.reserveBatch({ requests: [
      { reservationId: "attachment-again", area: "objects", sha256: "a".repeat(64), byteSize: 4 },
    ], maxBytes: 8, inventory: emptyInventory, observedReservations: second.managedObjects.list() }), (error: unknown) => error instanceof ManagedObjectReservationBusyError);
    assert.throws(() => second.managedObjects.reserveBatch({ requests: [
      { reservationId: "over-limit", area: "objects", sha256: "b".repeat(64), byteSize: 1 },
    ], maxBytes: 8, inventory: emptyInventory, observedReservations: second.managedObjects.list() }), ManagedObjectQuotaExceededError);
    assert.equal(first.managedObjects.list().length, 2);
    first.managedObjects.releaseMany(["attachment", "backup"]);
    assert.deepEqual(second.managedObjects.list(), []);
  } finally {
    second.close();
    first.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("dead reservation cleanup rescans disk after the stale marker before releasing its capacity", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-managed-quota-stale-"));
  const dataDirectory = path.join(parent, "state");
  const storage = openStorage({ dataDirectory: { dataDirectory } });
  const staleHash = "c".repeat(64);
  const requestedHash = "d".repeat(64);
  const createdAt = "2026-10-03T00:00:00.000Z";
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const db = new DatabaseSync(storage.path);
    try {
      db.prepare(`INSERT INTO managed_object_reservations(reservation_id, area, sha256, byte_size, owner_pid, owner_start, owner_boot_id, created_at)
        VALUES ('dead-owner', 'objects', ?, 4, 2147483647, '1', ?, ?)`)
        .run(staleHash, `linux:${bootId}`, createdAt);
    } finally { db.close(); }

    const staleBeforeFirstScan = storage.managedObjects.list();
    assert.throws(() => storage.managedObjects.reserveBatch({ requests: [
      { reservationId: "replacement", area: "objects", sha256: requestedHash, byteSize: 1 },
    ], maxBytes: 5, inventory: emptyInventory, observedReservations: staleBeforeFirstScan }), (error: unknown) => error instanceof ManagedObjectReservationBusyError);
    assert.ok(storage.managedObjects.list().find((row) => row.reservationId === "dead-owner")?.createdAt);
    const marked = new DatabaseSync(storage.path, { readOnly: true });
    try { assert.ok(marked.prepare("SELECT stale_marked_at FROM managed_object_reservations WHERE reservation_id='dead-owner'").get()?.stale_marked_at); }
    finally { marked.close(); }

    const inventory: ManagedObjectReservationInventory = { objects: [{ area: "objects", sha256: staleHash, byteSize: 4 }], stagingFiles: [], untrackedBytes: 0 };
    assert.throws(() => storage.managedObjects.reserveBatch({ requests: [
      { reservationId: "stale-snapshot", area: "objects", sha256: requestedHash, byteSize: 1 },
    ], maxBytes: 5, inventory, observedReservations: staleBeforeFirstScan }), (error: unknown) => error instanceof ManagedObjectReservationBusyError);
    storage.managedObjects.reserveBatch({ requests: [
      { reservationId: "replacement", area: "objects", sha256: requestedHash, byteSize: 1 },
    ], maxBytes: 5, inventory, observedReservations: storage.managedObjects.list() });
    assert.deepEqual(storage.managedObjects.list().map((row) => row.reservationId), ["replacement"]);
    storage.managedObjects.releaseMany(["replacement"]);
  } finally {
    storage.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("garbage claims and managed object reservations serialize on matching area and digest", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-managed-quota-garbage-race-"));
  const dataDirectory = path.join(parent, "state");
  const writer = openStorage({ dataDirectory: { dataDirectory } });
  const collector = openStorage({ path: writer.path });
  const digest = "e".repeat(64);
  try {
    writer.garbage.enqueue({ kind: "attachment_object", objectRef: digest });
    writer.managedObjects.reserveBatch({ requests: [
      { reservationId: "writer-reservation", area: "objects", sha256: digest, byteSize: 4 },
    ], maxBytes: 4, inventory: emptyInventory, observedReservations: writer.managedObjects.list() });
    assert.equal(collector.garbage.claim({ kind: "attachment_object", objectRef: digest }), false,
      "a live writer reservation must keep the queued object from being claimed");
    writer.managedObjects.releaseMany(["writer-reservation"]);
    assert.equal(collector.garbage.claim({ kind: "attachment_object", objectRef: digest }), true);
    assert.throws(() => collector.managedObjects.reserveBatch({ requests: [
      { reservationId: "blocked-by-delete", area: "objects", sha256: digest, byteSize: 4 },
    ], maxBytes: 4, inventory: emptyInventory, observedReservations: collector.managedObjects.list() }),
    (error: unknown) => error instanceof ManagedObjectReservationBusyError,
    "a claimed deletion must keep a new writer from recording a dangling reference");

    collector.garbage.fail({ kind: "attachment_object", objectRef: digest }, "injected unlink failure");
    collector.managedObjects.reserveBatch({ requests: [
      { reservationId: "writer-after-failed-delete", area: "objects", sha256: digest, byteSize: 4 },
    ], maxBytes: 4, inventory: { objects: [{ area: "objects", sha256: digest, byteSize: 4 }], stagingFiles: [], untrackedBytes: 0 },
      observedReservations: collector.managedObjects.list() });
    assert.equal(collector.garbage.claim({ kind: "attachment_object", objectRef: digest }), false);
    assert.equal(collector.managedObjects.list().length, 1);
    collector.managedObjects.releaseMany(["writer-after-failed-delete"]);
    assert.equal(collector.garbage.claim({ kind: "attachment_object", objectRef: digest }), true);
  } finally {
    collector.close();
    writer.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("file journal consumes backup reservations with object registration and reference insertion", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-file-operation-reservation-"));
  const dataDirectory = path.join(parent, "state");
  const writer = openStorage({ dataDirectory: { dataDirectory } });
  const collector = openStorage({ path: writer.path });
  const digest = "f".repeat(64);
  try {
    writer.projects.create({ id: "project_reserved", displayName: "Reserved", canonicalRoot: parent,
      directoryIdentity: null, validationState: "valid" });
    writer.conversations.create({ id: "conversation_reserved", projectId: "project_reserved", piSessionId: null, title: "Reserved" });
    writer.runs.create({ runId: "run_reserved", conversationId: "conversation_reserved", request: { kind: "message", text: "edit" } });
    const changeset = writer.fileChangesets.ensureForRun({ id: "changeset_reserved", conversationId: "conversation_reserved",
      projectId: "project_reserved", runId: "run_reserved" });
    writer.contentObjects.register({ sha256: digest, byteSize: 4, createdAt: "2026-10-03T00:00:00.000Z" });
    writer.garbage.enqueue({ kind: "file_backup_object", objectRef: digest });
    writer.managedObjects.reserveBatch({ requests: [
      { reservationId: "journal-backup", area: "file-objects", sha256: digest, byteSize: 4 },
    ], maxBytes: 4, inventory: emptyInventory, observedReservations: writer.managedObjects.list() });
    assert.equal(collector.garbage.claim({ kind: "file_backup_object", objectRef: digest }), false,
      "the reservation must fence garbage collection while the file operation is being prepared");

    const operation = writer.fileOperations.prepareReserved({
      id: "operation_reserved", changesetId: changeset.id, relativePath: "notes.txt", kind: "replace",
      preVersion: "before", preHash: "a".repeat(64), expectedPostHash: digest, backupSha256: digest, resultSha256: digest,
    }, [{ sha256: digest, byteSize: 4, createdAt: "2026-10-03T00:00:00.000Z" }], ["journal-backup"]);
    assert.equal(operation.status, "prepared");
    assert.equal(writer.contentObjects.get(digest)?.byteSize, 4);
    assert.equal(writer.managedObjects.list().length, 0);
    assert.equal(collector.garbage.claim({ kind: "file_backup_object", objectRef: digest }), false,
      "once the reservation is consumed, the operation reference and object registration must already be committed");
  } finally {
    collector.close();
    writer.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("active garbage claims are not reset or bypassed by another SQLite connection", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-gc-live-claim-"));
  const dataDirectory = path.join(parent, "state");
  const collector = openStorage({ dataDirectory: { dataDirectory } });
  const writer = openStorage({ path: collector.path });
  const digest = "1".repeat(64);
  try {
    collector.garbage.enqueue({ kind: "attachment_object", objectRef: digest });
    assert.equal(collector.garbage.claim({ kind: "attachment_object", objectRef: digest }), true);

    writer.garbage.resetClaims();
    assert.throws(() => writer.managedObjects.reserveBatch({ requests: [
      { reservationId: "blocked-by-live-gc", area: "objects", sha256: digest, byteSize: 4 },
    ], maxBytes: 4, inventory: emptyInventory, observedReservations: writer.managedObjects.list() }),
    (error: unknown) => error instanceof ManagedObjectReservationBusyError);

    collector.garbage.complete({ kind: "attachment_object", objectRef: digest });
    writer.managedObjects.reserveBatch({ requests: [
      { reservationId: "allowed-after-gc", area: "objects", sha256: digest, byteSize: 4 },
    ], maxBytes: 4, inventory: emptyInventory, observedReservations: writer.managedObjects.list() });
    writer.managedObjects.releaseMany(["allowed-after-gc"]);
  } finally {
    writer.close();
    collector.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("garbage reset reopens only claims whose owner process is confirmed dead", { skip: process.platform !== "linux" }, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-gc-dead-claim-"));
  const dataDirectory = path.join(parent, "state");
  const storage = openStorage({ dataDirectory: { dataDirectory } });
  const backupHash = "2".repeat(64);
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    storage.contentObjects.register({ sha256: backupHash, byteSize: 4, createdAt: "2026-10-03T00:00:00.000Z" });
    storage.garbage.enqueue({ kind: "file_backup_object", objectRef: backupHash });
    const db = new DatabaseSync(storage.path);
    try {
      const owner = { pid: 2_147_483_647, start: "1", boot: `linux:${bootId}` };
      db.prepare("UPDATE file_object_garbage SET status='deleting', claim_pid=?, claim_start=?, claim_boot_id=? WHERE sha256=?")
        .run(owner.pid, owner.start, owner.boot, backupHash);
      db.prepare("INSERT INTO garbage_queue(kind, object_ref, queued_at, status, claim_pid, claim_start, claim_boot_id) VALUES ('run_artifacts', 'run_dead_claim', ?, 'deleting', ?, ?, ?)")
        .run("2026-10-03T00:00:00.000Z", owner.pid, owner.start, owner.boot);
      db.prepare("INSERT INTO garbage_queue(kind, object_ref, queued_at, status) VALUES ('attachment_object', ?, ?, 'deleting')")
        .run("3".repeat(64), "2026-10-03T00:00:00.000Z");
    } finally { db.close(); }

    storage.garbage.resetClaims();
    const verify = new DatabaseSync(storage.path, { readOnly: true });
    try {
      const backup = verify.prepare("SELECT status, claim_pid FROM file_object_garbage WHERE sha256=?").get(backupHash) as { status: string; claim_pid: number | null };
      assert.deepEqual({ status: backup.status, claim_pid: backup.claim_pid }, { status: "pending", claim_pid: null });
      const deadQueue = verify.prepare("SELECT status, claim_pid FROM garbage_queue WHERE kind='run_artifacts' AND object_ref='run_dead_claim'").get() as { status: string; claim_pid: number | null };
      assert.deepEqual({ status: deadQueue.status, claim_pid: deadQueue.claim_pid }, { status: "pending", claim_pid: null });
      const legacy = verify.prepare("SELECT status, claim_pid FROM garbage_queue WHERE kind='attachment_object'").get() as { status: string; claim_pid: number | null };
      assert.deepEqual({ status: legacy.status, claim_pid: legacy.claim_pid }, { status: "deleting", claim_pid: null },
        "pre-007 deleting rows without owner identity must remain fail-closed");
    } finally { verify.close(); }
  } finally {
    storage.close();
    await rm(parent, { recursive: true, force: true });
  }
});
