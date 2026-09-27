import { parseEvidence, type Evidence } from "@pi-workbench/protocol";
import type { ReadOnlyRepository } from "./read-only-repository.js";

export type EvidenceInput = Omit<Evidence, "snapshotId" | "fileSha256">;
export type EvidenceRecord = Evidence;

export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

function validateEvidenceShape(value: EvidenceInput): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value.id)) throw new EvidenceValidationError("Invalid evidence ID");
  if (!Number.isSafeInteger(value.startLine) || value.startLine < 1 || !Number.isSafeInteger(value.endLine) || value.endLine < value.startLine) {
    throw new EvidenceValidationError("Invalid evidence line range");
  }
  if (typeof value.excerpt !== "string" || value.excerpt.length === 0 || Buffer.byteLength(value.excerpt, "utf8") > 16_384) {
    throw new EvidenceValidationError("Invalid evidence excerpt");
  }
}

export function createEvidenceRegistry(repository: ReadOnlyRepository) {
  const records = new Map<string, EvidenceRecord>();

  async function register(input: EvidenceInput): Promise<EvidenceRecord> {
    validateEvidenceShape(input);
    if (records.has(input.id)) throw new EvidenceValidationError("Evidence ID already exists");
    const source = await repository.readFile(input.path);
    const lines = source.text.split(/\r?\n/u);
    if (input.endLine > lines.length) throw new EvidenceValidationError("Evidence line range is outside the file");
    const actualExcerpt = lines.slice(input.startLine - 1, input.endLine).join("\n");
    if (actualExcerpt !== input.excerpt) throw new EvidenceValidationError("Evidence excerpt does not match the selected source lines");
    const record: EvidenceRecord = {
      id: input.id,
      snapshotId: repository.snapshotId,
      path: source.path,
      fileSha256: source.fileSha256,
      startLine: input.startLine,
      endLine: input.endLine,
      excerpt: actualExcerpt,
    };
    try {
      parseEvidence(record);
    } catch {
      throw new EvidenceValidationError("Evidence record does not match the public protocol");
    }
    records.set(record.id, record);
    return structuredClone(record);
  }

  async function validate(record: EvidenceRecord): Promise<void> {
    try {
      parseEvidence(record);
    } catch {
      throw new EvidenceValidationError("Evidence record does not match the public protocol");
    }
    validateEvidenceShape(record);
    if (record.snapshotId !== repository.snapshotId) throw new EvidenceValidationError("Evidence snapshot does not match this repository");
    if (!/^[a-f0-9]{64}$/u.test(record.fileSha256)) throw new EvidenceValidationError("Invalid evidence file digest");
    const source = await repository.readFile(record.path);
    if (source.fileSha256 !== record.fileSha256) throw new EvidenceValidationError("Evidence file digest does not match the snapshot");
    const lines = source.text.split(/\r?\n/u);
    if (record.endLine > lines.length) throw new EvidenceValidationError("Evidence line range is outside the file");
    if (lines.slice(record.startLine - 1, record.endLine).join("\n") !== record.excerpt) throw new EvidenceValidationError("Evidence excerpt does not match the selected source lines");
    const registered = records.get(record.id);
    if (registered && JSON.stringify(registered) !== JSON.stringify(record)) throw new EvidenceValidationError("Evidence ID is bound to different content");
  }

  function list(): EvidenceRecord[] {
    return [...records.values()].map((record) => structuredClone(record));
  }

  return { register, validate, list };
}
