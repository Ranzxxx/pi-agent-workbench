import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { AttachmentRecord, Storage } from "@pi-workbench/storage";

export const MAX_MANAGED_OBJECT_BYTES = 2 * 1024 * 1024 * 1024 - 64 * 1024 * 1024;

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

export async function writeManagedObject(dataDirectory: string, area: "file-objects" | "objects", digest: string, bytes: Buffer): Promise<void> {
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
  const staging = path.join(stagingDirectory, randomUUID());
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

export async function storeFileBackup(storage: Storage, dataDirectory: string, bytes: Buffer): Promise<string> {
  const digest = sha256(bytes);
  const existing = storage.contentObjects.get(digest);
  if (!existing && storage.contentObjects.totalBytes() + storage.attachments.totalBytes() + bytes.byteLength > MAX_MANAGED_OBJECT_BYTES) {
    throw new Error("本地备份空间达到安全上限，已拒绝无备份写入。");
  }
  await writeManagedObject(dataDirectory, "file-objects", digest, bytes);
  storage.contentObjects.register({ sha256: digest, byteSize: bytes.byteLength, createdAt: new Date().toISOString() });
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
  storage: Storage; dataDirectory: string; conversationId: string; runId: string; fileName: string; text: string; sourceAttachmentId?: string;
}) {
  const fileName = input.fileName.trim();
  if (!fileName || fileName.length > 128 || fileName === "." || fileName === ".." || /[\\/:\u0000-\u001f\u007f]/u.test(fileName)) throw new Error("结果文件名必须是单一文件名。");
  if (typeof input.text !== "string" || input.text.includes("\u0000")) throw new Error("只允许保存 UTF-8 文本结果。");
  const bytes = Buffer.from(input.text, "utf8");
  if (bytes.toString("utf8") !== input.text || bytes.byteLength > 65_536) throw new Error("单个文本结果上限为 64 KiB。");
  if (input.sourceAttachmentId && !input.storage.attachments.getForConversation(input.sourceAttachmentId, input.conversationId)) throw new Error("源附件不属于当前对话。");
  const digest = sha256(bytes);
  const existing = input.storage.attachments.referenceCount(digest) > 0;
  if (!existing && input.storage.contentObjects.totalBytes() + input.storage.attachments.totalBytes() + bytes.byteLength > MAX_MANAGED_OBJECT_BYTES) {
    throw new Error("本地附件空间达到安全上限，已拒绝保存结果。");
  }
  await writeManagedObject(input.dataDirectory, "objects", digest, bytes);
  const record = input.storage.attachmentResults.create({ id: randomUUID(), conversationId: input.conversationId,
    runId: input.runId, sourceAttachmentId: input.sourceAttachmentId ?? null, objectSha256: digest, fileName, byteSize: bytes.byteLength });
  return { schemaVersion: 2, resultId: record.id, conversationId: record.conversationId, sourceAttachmentId: record.sourceAttachmentId,
    fileName: record.fileName, byteSize: record.byteSize, mediaType: record.mediaType, createdAt: record.createdAt };
}

export async function readAttachmentObject(storage: Storage, dataDirectory: string, attachment: AttachmentRecord): Promise<Buffer> {
  const record = storage.attachments.getForConversation(attachment.id, attachment.conversationId);
  if (!record || record.objectSha256 !== attachment.objectSha256) failClosed();
  const bytes = await readManagedObject(dataDirectory, "objects", record.objectSha256);
  if (!bytes || bytes.byteLength !== record.byteSize) failClosed();
  return bytes;
}
