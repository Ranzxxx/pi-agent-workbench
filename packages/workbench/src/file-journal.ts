import { randomUUID } from "node:crypto";
import type { Storage } from "@pi-workbench/storage";
import { createProjectFileAccess, type ProjectFileJournal } from "@pi-workbench/tools";
import { sha256, storeFileBackup } from "./managed-object-store.js";
import type { WorkerEventPayload } from "./worker-ipc.js";

export function createPersistedFileJournal(input: {
  storage: Storage;
  dataDirectory: string;
  changesetId?: string;
  ensureChangesetId?: () => Promise<string>;
  emit?: (event: WorkerEventPayload) => Promise<void>;
}): ProjectFileJournal {
  const operationChangesets = new Map<string, string>();
  async function changesetId(): Promise<string> {
    if (input.changesetId) return input.changesetId;
    if (input.ensureChangesetId) return input.ensureChangesetId();
    throw new Error("File changeset is unavailable");
  }
  return {
    async prepare(operation) {
      const ownerChangesetId = await changesetId();
      let backupSha256: string | null = null;
      let resultSha256: string | null = null;
      if (operation.preimage) backupSha256 = await storeFileBackup(input.storage, input.dataDirectory, operation.preimage);
      if (operation.postimage) resultSha256 = await storeFileBackup(input.storage, input.dataDirectory, operation.postimage);
      const record = input.storage.fileOperations.prepare({
        id: randomUUID(), changesetId: ownerChangesetId, relativePath: operation.relativePath, kind: operation.kind,
        preVersion: operation.preVersion, preHash: operation.preHash, expectedPostHash: operation.postHash,
        backupSha256, resultSha256,
      });
      operationChangesets.set(record.id, ownerChangesetId);
      await input.emit?.({ type: "file_change_prepared", data: {
        changesetId: ownerChangesetId, operationId: record.id, path: record.relativePath, kind: record.kind,
        preHash: record.preHash, postHash: record.expectedPostHash,
      } });
      return { operationId: record.id, changesetId: ownerChangesetId };
    },
    async applied(operation) {
      const ownerChangesetId = operationChangesets.get(operation.operationId) ?? input.storage.fileOperations.get(operation.operationId)?.changesetId;
      if (!ownerChangesetId) throw new Error("File operation is unavailable");
      const record = input.storage.fileOperations.applied(operation.operationId, operation.postVersion, operation.postHash);
      await input.emit?.({ type: "file_change_applied", data: {
        changesetId: ownerChangesetId, operationId: record.id, path: record.relativePath, postHash: record.postHash,
      } });
      operationChangesets.delete(operation.operationId);
    },
    async expectPostIdentity(operation) {
      input.storage.fileOperations.expectPostIdentity(operation.operationId, operation.identity);
    },
    async failed(operation) {
      const ownerChangesetId = operationChangesets.get(operation.operationId) ?? input.storage.fileOperations.get(operation.operationId)?.changesetId;
      if (!ownerChangesetId) throw new Error("File operation is unavailable");
      const record = input.storage.fileOperations.fail(operation.operationId, operation.state, operation.code);
      if (operation.state === "conflict" || operation.state === "uncertain") {
        await input.emit?.({ type: "file_change_conflict", data: {
          changesetId: ownerChangesetId, operationId: record.id, path: record.relativePath, reason: operation.code.slice(0, 128),
        } });
      }
      operationChangesets.delete(operation.operationId);
    },
  };
}

export function contentDigest(bytes: Buffer): string { return sha256(bytes); }

export async function recoverPreparedFileOperations(storage: Storage): Promise<void> {
  const touched = new Set<string>();
  for (const operation of storage.fileOperations.listPrepared()) {
    const changeset = storage.fileChangesets.get(operation.changesetId);
    if (!changeset) continue;
    touched.add(changeset.id);
    const project = storage.projects.get(changeset.projectId);
    if (!project) {
      storage.fileOperations.fail(operation.id, "conflict", "project_missing");
      continue;
    }
    try {
      const access = createProjectFileAccess(project.canonicalRoot, project.directoryIdentity);
      await access.initialize();
      const current = await access.versionOf(operation.relativePath);
      const preMatches = operation.preVersion === null ? current === null : current?.token === operation.preVersion;
      const postMatches = operation.expectedPostHash === null ? current === null
        : current?.sha256 === operation.expectedPostHash && current.identity === operation.expectedPostIdentity;
      if (postMatches && !preMatches) storage.fileOperations.applied(operation.id, current?.token ?? null, current?.sha256 ?? null);
      else if (preMatches && !postMatches) storage.fileOperations.fail(operation.id, "not_applied", "recovered_preimage");
      else storage.fileOperations.fail(operation.id, "conflict", "recovery_ambiguous");
    } catch {
      storage.fileOperations.fail(operation.id, "conflict", "recovery_unavailable");
    }
  }
  for (const changeset of storage.fileChangesets.listOpen()) {
    if (changeset.runId) {
      const run = storage.runs.get(changeset.runId);
      if (run && (run.status === "accepted" || run.status === "running" || run.status === "cancelling")) continue;
    }
    touched.add(changeset.id);
  }
  for (const changesetId of touched) storage.fileChangesets.finalize(changesetId);
}
