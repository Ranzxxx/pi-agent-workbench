import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { ManagedObjectQuotaExceededError, ManagedObjectReservationBusyError, StorageError, type AttachmentRecord, type ManagedObjectArea, type ManagedObjectReservationInventory, type ManagedObjectReservationRequest, type Storage } from "@pi-workbench/storage";

export const MAX_MANAGED_OBJECT_BYTES = 2 * 1024 * 1024 * 1024 - 64 * 1024 * 1024;
interface AttachmentResultView {
  schemaVersion: 2; resultId: string; conversationId: string; sourceAttachmentId: string | null;
  fileName: string; byteSize: number; mediaType: "text/plain; charset=utf-8"; createdAt: string;
}

export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function failClosed(): never { throw new Error("Managed local object could not be safely verified or stored"); }

function objectPath(dataDirectory: string, area: "file-objects" | "objects", digest: string): string {
  if (!/^[a-f0-9]{64}$/u.test(digest)) return failClosed();
  return path.join(dataDirectory, area, digest.slice(0, 2), digest);
}

async function validateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 }).catch(failClosed);
  const info = await lstat(directory).catch(failClosed);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory).catch(() => "") !== directory) failClosed();
}

export async function writeManagedObject(dataDirectory: string, area: "file-objects" | "objects", digest: string, bytes: Buffer, stagingId: string = randomUUID()): Promise<void> {
  if (sha256(bytes) !== digest) failClosed();
  const destination = objectPath(dataDirectory, area, digest);
  const parent = path.dirname(destination);
  const root = path.join(dataDirectory, area);
  await validateDirectory(root);
  await validateDirectory(parent);
  const existing = await lstat(destination).catch(() => undefined);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.size !== bytes.byteLength || await readManagedObject(dataDirectory, area, digest) === null) failClosed();
    return;
  }
  const stagingDirectory = path.join(root, ".staging");
  await validateDirectory(stagingDirectory);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(stagingId)) failClosed();
  const staging = path.join(stagingDirectory, stagingId);
  const handle = await open(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600).catch(failClosed);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await validateDirectory(parent);
    await link(staging, destination).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") failClosed(); });
    await unlink(staging);
    const directoryHandle = await open(parent, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    await unlink(staging).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stored = await readManagedObject(dataDirectory, area, digest);
  if (!stored || !stored.equals(bytes)) failClosed();
}

async function inventoryArea(dataDirectory: string, area: ManagedObjectArea): Promise<ManagedObjectReservationInventory> {
  const inventory: ManagedObjectReservationInventory = { objects: [], stagingFiles: [], untrackedBytes: 0 };
  const root = path.join(dataDirectory, area);
  const rootInfo = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; return failClosed(); });
  if (!rootInfo) return inventory;
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root).catch(() => "") !== root) failClosed();
  const entries = await readdir(root, { withFileTypes: true }).catch(failClosed);
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.name === ".staging") {
      const info = await lstat(target).catch(failClosed);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target).catch(() => "") !== target) failClosed();
      for (const staged of await readdir(target, { withFileTypes: true }).catch(failClosed)) {
        const stagedPath = path.join(target, staged.name);
        const stagedInfo = await lstat(stagedPath).catch(failClosed);
        if (!staged.isFile() || !stagedInfo.isFile() || stagedInfo.isSymbolicLink() || stagedInfo.nlink !== 1 || !Number.isSafeInteger(stagedInfo.size) || stagedInfo.size < 0) failClosed();
        inventory.stagingFiles.push({ area, name: staged.name, byteSize: stagedInfo.size });
      }
      continue;
    }
    if (!entry.isDirectory() || !/^[a-f0-9]{2}$/u.test(entry.name)) failClosed();
    const directoryInfo = await lstat(target).catch(failClosed);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || await realpath(target).catch(() => "") !== target) failClosed();
    for (const object of await readdir(target, { withFileTypes: true }).catch(failClosed)) {
      const objectPath = path.join(target, object.name);
      const objectInfo = await lstat(objectPath).catch(failClosed);
      if (!object.isFile() || !objectInfo.isFile() || objectInfo.isSymbolicLink() || objectInfo.nlink !== 1 || !Number.isSafeInteger(objectInfo.size) || objectInfo.size < 0) failClosed();
      if (/^[a-f0-9]{64}$/u.test(object.name) && object.name.slice(0, 2) === entry.name) {
        inventory.objects.push({ area, sha256: object.name, byteSize: objectInfo.size });
      } else inventory.untrackedBytes += objectInfo.size;
    }
  }
  return inventory;
}

export async function managedObjectInventory(dataDirectory: string): Promise<ManagedObjectReservationInventory> {
  const absolute = path.resolve(dataDirectory);
  if (absolute !== dataDirectory || await realpath(dataDirectory).catch(() => "") !== dataDirectory) failClosed();
  const [attachments, backups] = await Promise.all([inventoryArea(dataDirectory, "objects"), inventoryArea(dataDirectory, "file-objects")]);
  return { objects: [...attachments.objects, ...backups.objects], stagingFiles: [...attachments.stagingFiles, ...backups.stagingFiles],
    untrackedBytes: attachments.untrackedBytes + backups.untrackedBytes };
}

export async function reserveManagedObjects(storage: Storage, dataDirectory: string, requests: Array<Omit<ManagedObjectReservationRequest, "reservationId">>, maxBytes = MAX_MANAGED_OBJECT_BYTES): Promise<ManagedObjectReservationRequest[]> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("Managed object capacity must be a non-negative safe integer");
  const unique = new Map<string, ManagedObjectReservationRequest>();
  for (const request of requests) {
    const key = `${request.area}:${request.sha256}`;
    const existing = unique.get(key);
    if (existing && existing.byteSize !== request.byteSize) throw new Error("Managed object metadata does not match");
    if (!existing) unique.set(key, { ...request, reservationId: randomUUID() });
  }
  const reservations = [...unique.values()];
  if (!reservations.length) return [];
  const deadline = Date.now() + 30_000;
  let pauseMs = 10;
  while (true) {
    const observedReservations = storage.managedObjects.list();
    const inventory = await managedObjectInventory(dataDirectory);
    try {
      storage.managedObjects.reserveBatch({ requests: reservations, maxBytes, inventory, observedReservations });
      return reservations;
    } catch (error) {
      if ((!(error instanceof ManagedObjectReservationBusyError) && !(error instanceof StorageError && error.code === "db_busy")) || Date.now() >= deadline) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pauseMs));
      pauseMs = Math.min(pauseMs * 2, 250);
    }
  }
}

export async function readManagedObject(dataDirectory: string, area: "file-objects" | "objects", digest: string): Promise<Buffer | null> {
  const target = objectPath(dataDirectory, area, digest);
  const parent = path.dirname(target);
  const info = await lstat(target).catch(() => undefined);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(parent).catch(() => "") !== parent || await realpath(target).catch(() => "") !== target) failClosed();
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(failClosed);
  try {
    const opened = await handle.stat();
    const maximum = area === "objects" ? 20 * 1024 * 1024 : 65_536;
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maximum) failClosed();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || sha256(bytes) !== digest) failClosed();
    return bytes;
  } finally { await handle.close(); }
}

export async function storeFileBackup(storage: Storage, dataDirectory: string, bytes: Buffer, maxManagedObjectBytes = MAX_MANAGED_OBJECT_BYTES): Promise<string> {
  if (bytes.byteLength > 65_536) throw new Error("单个文件备份上限为 64 KiB。");
  const digest = sha256(bytes);
  let reservations: ManagedObjectReservationRequest[] = [];
  let failure: unknown;
  let failed = false;
  let writeAttempted = false;
  try {
    reservations = await reserveManagedObjects(storage, dataDirectory, [{ area: "file-objects", sha256: digest, byteSize: bytes.byteLength }], maxManagedObjectBytes);
    const reservation = reservations[0]!;
    writeAttempted = true;
    await writeManagedObject(dataDirectory, "file-objects", digest, bytes, reservation.reservationId);
    storage.contentObjects.registerReserved({ sha256: digest, byteSize: bytes.byteLength, createdAt: new Date().toISOString() }, reservation.reservationId);
  } catch (error) {
    failed = true;
    failure = error instanceof ManagedObjectQuotaExceededError
      ? new Error("本地备份空间达到安全上限，已拒绝无备份写入。", { cause: error }) : error;
    if (writeAttempted && reservations.length) {
      try {
        storage.contentObjects.register({ sha256: digest, byteSize: bytes.byteLength, createdAt: new Date().toISOString() });
        storage.garbage.enqueue({ kind: "file_backup_object", objectRef: digest });
      } catch (cleanupError) {
        if (failure instanceof Error) Object.defineProperty(failure, "garbageEnqueueError", { value: cleanupError, configurable: true });
      }
    }
  }
  try { storage.managedObjects.releaseMany(reservations.map((reservation) => reservation.reservationId)); }
  catch (releaseError) {
    if (!failed) { failed = true; failure = releaseError; }
    else if (failure instanceof Error) Object.defineProperty(failure, "reservationReleaseError", { value: releaseError, configurable: true });
  }
  if (failed) throw failure;
  return digest;
}

export async function readFileBackup(storage: Storage, dataDirectory: string, digest: string): Promise<Buffer | null> {
  const object = storage.contentObjects.get(digest);
  if (!object) return null;
  const bytes = await readManagedObject(dataDirectory, "file-objects", digest);
  if (!bytes || bytes.byteLength !== object.byteSize) failClosed();
  return bytes;
}

export function attachmentRecordView(record: AttachmentRecord) {
  return { attachmentId: record.id, fileName: record.fileName, byteSize: record.byteSize, mediaType: record.mediaType };
}

export async function storeAttachmentResult(input: {
  storage: Storage; dataDirectory: string; conversationId: string; runId: string; fileName: string; text: string; sourceAttachmentId?: string; maxManagedObjectBytes?: number;
}) {
  const fileName = input.fileName.trim();
  if (!fileName || fileName.length > 128 || fileName === "." || fileName === ".." || /[\\/:\u0000-\u001f\u007f]/u.test(fileName)) throw new Error("结果文件名必须是单一文件名。");
  if (typeof input.text !== "string" || input.text.includes("\u0000")) throw new Error("只允许保存 UTF-8 文本结果。");
  const bytes = Buffer.from(input.text, "utf8");
  if (bytes.toString("utf8") !== input.text || bytes.byteLength > 65_536) throw new Error("单个文本结果上限为 64 KiB。");
  if (input.sourceAttachmentId && !input.storage.attachments.getForConversation(input.sourceAttachmentId, input.conversationId)) throw new Error("源附件不属于当前对话。");
  const digest = sha256(bytes);
  let reservations: ManagedObjectReservationRequest[] = [];
  let saved: AttachmentResultView | undefined;
  let failure: unknown;
  let failed = false;
  let writeAttempted = false;
  try {
    reservations = await reserveManagedObjects(input.storage, input.dataDirectory, [{ area: "objects", sha256: digest, byteSize: bytes.byteLength }], input.maxManagedObjectBytes ?? MAX_MANAGED_OBJECT_BYTES);
    const reservation = reservations[0]!;
    writeAttempted = true;
    await writeManagedObject(input.dataDirectory, "objects", digest, bytes, reservation.reservationId);
    const record = input.storage.attachmentResults.createReserved({ id: randomUUID(), conversationId: input.conversationId,
      runId: input.runId, sourceAttachmentId: input.sourceAttachmentId ?? null, objectSha256: digest, fileName, byteSize: bytes.byteLength }, reservation.reservationId);
    saved = { schemaVersion: 2, resultId: record.id, conversationId: record.conversationId, sourceAttachmentId: record.sourceAttachmentId,
      fileName: record.fileName, byteSize: record.byteSize, mediaType: record.mediaType, createdAt: record.createdAt };
  } catch (error) {
    failed = true;
    failure = error instanceof ManagedObjectQuotaExceededError
      ? new Error("本地附件空间达到安全上限，已拒绝保存结果。", { cause: error }) : error;
    if (writeAttempted && reservations.length) {
      try { input.storage.garbage.enqueue({ kind: "attachment_object", objectRef: digest }); }
      catch (cleanupError) {
        if (failure instanceof Error) Object.defineProperty(failure, "garbageEnqueueError", { value: cleanupError, configurable: true });
      }
    }
  }
  try { input.storage.managedObjects.releaseMany(reservations.map((reservation) => reservation.reservationId)); }
  catch (releaseError) {
    if (!failed) { failed = true; failure = releaseError; }
    else if (failure instanceof Error) Object.defineProperty(failure, "reservationReleaseError", { value: releaseError, configurable: true });
  }
  if (failed) throw failure;
  return saved!;
}

export async function readAttachmentObject(storage: Storage, dataDirectory: string, attachment: AttachmentRecord): Promise<Buffer> {
  const record = storage.attachments.getForConversation(attachment.id, attachment.conversationId);
  if (!record || record.objectSha256 !== attachment.objectSha256) failClosed();
  const bytes = await readManagedObject(dataDirectory, "objects", record.objectSha256);
  if (!bytes || bytes.byteLength !== record.byteSize) failClosed();
  return bytes;
}
