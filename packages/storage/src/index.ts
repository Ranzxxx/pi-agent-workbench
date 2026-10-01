import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  parseV2Error,
  parseV2EventCursor,
  parseV2IdempotencyRequest,
  parseV2Run,
  parseV2RunAttempt,
  parseV2RunEvent,
  parseV2RunEventPage,
  parseV2IdempotencyResult,
  type V2Error,
  type V2EventCursor,
  type V2IdempotencyRequest,
  type V2IdempotencyResult,
  type V2Run,
  type V2RunAttempt,
  type V2RunEvent,
  type V2RunStatus,
} from "@pi-workbench/protocol";
import { assertMigrationsCompatible, assertMigrationsCurrent, applyMigrations, loadCoreMigrations, StorageMigrationError, StorageSchemaError, type StorageMigration } from "./migrations.js";
import { resolveDatabasePath, type DataDirectoryOptions } from "./data-directory.js";

export { resolveDataDirectory, resolveDatabasePath, ensureDataDirectory } from "./data-directory.js";
export { applyMigrations, assertMigrationsCompatible, assertMigrationsCurrent, loadCoreMigrations, migrationChecksum, StorageMigrationError, StorageSchemaError } from "./migrations.js";
export type { StorageMigration } from "./migrations.js";

export type StorageErrorCode = "db_busy" | "db_readonly" | "not_found" | "conflict" | "active_task" | "invalid_input";
export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
  }
}

export interface StorageOptions {
  /** File path or `:memory:`. Omit to use the stable XDG/home data directory. */
  path?: string;
  /** Read-only opens never apply migrations. */
  readOnly?: boolean;
  /** SQLite's built-in lock wait bound. Defaults to 100ms; accepted range is 1..5000ms. */
  busyTimeoutMs?: number;
  dataDirectory?: DataDirectoryOptions;
}

export interface ProjectRecord {
  id: string; displayName: string; canonicalRoot: string; directoryIdentity: string | null;
  validationState: "valid" | "missing" | "needs_review"; createdAt: string; lastAccessedAt: string;
}
export interface AttachmentRecord {
  id: string; conversationId: string; objectSha256: string; fileName: string; relativePath: string;
  byteSize: number; mediaType: "text/plain; charset=utf-8"; createdAt: string;
}
export interface ProjectRulesRecord {
  projectId: string; sourcePath: string; sourceSha256: string; sourceVersion: string; content: string;
  acceptedAt: string; revokedAt: string | null;
}
export interface GarbageRecord { kind: "attachment_object" | "run_artifacts"; objectRef: string; attempts: number; }
export interface ConversationRecord {
  id: string; projectId: string | null; piSessionId: string | null; title: string;
  status: "active" | "archived" | "recovery_required"; createdAt: string; updatedAt: string;
}
export interface MessageRecord {
  id: string; conversationId: string; runId: string | null; sequence: number;
  role: "user" | "assistant" | "capability"; content: string;
  source: "user" | "agent" | "extension" | "system"; extensionId: string | null;
  attachmentRefs: string[]; createdAt: string;
}
export interface SessionSnapshotRecord {
  id: string; conversationId: string; version: number; sdkVersion: string; formatVersion: string;
  snapshot: JsonValue; summary: string | null; createdAt: string;
}
export interface RunRecord extends V2Run { request: JsonValue; }
export interface RunAttemptRecord extends V2RunAttempt {}
export interface CheckpointRecord {
  id: string; runId: string; attemptId: string; phaseId: string; inputSha256: string;
  outputRef: string | null; status: "completed" | "failed" | "interrupted"; createdAt: string;
}
export interface UsageRecord {
  attemptId: string; modelId: string | null; modelCalls: number; toolCalls: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  totalTokens: number; estimatedCostUsd: number | null;
  costStatus: "unknown" | "estimate" | "known"; pricingVersion: string | null; updatedAt: string;
}
export interface IdempotencyResolution { result: V2IdempotencyResult; replayed: boolean; }
export interface ActiveSlot {
  runId: string | null; claimToken: string | null; generation: number; workerBootId: string | null;
  heartbeatAt: string | null; leaseExpiresAt: string | null;
}
export interface WorkerIdentityRecord {
  bootId: string; pid: number; processStart: string; status: "idle" | "running" | "stopping" | "uncertain";
  startedAt: string; heartbeatAt: string;
}
export interface StorageDiagnostics {
  journalMode: string; synchronous: number; foreignKeys: boolean; busyTimeoutMs: number; schemaVersion: number;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface Context {
  readonly db: DatabaseSync;
  readonly readOnly: boolean;
  atomic<T>(callback: (db: DatabaseSync) => T): T;
  translate(error: unknown): never;
}

export class Storage {
  readonly projects: ProjectRepository;
  readonly attachments: AttachmentRepository;
  readonly projectRules: ProjectRulesRepository;
  readonly garbage: GarbageRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly snapshots: SessionSnapshotRepository;
  readonly runs: RunRepository;
  readonly attempts: RunAttemptRepository;
  readonly events: RunEventRepository;
  readonly checkpoints: CheckpointRepository;
  readonly usage: UsageRepository;
  readonly idempotency: IdempotencyRepository;
  readonly activeSlot: ActiveSlotRepository;
  readonly results: RunResultRepository;
  readonly workerIdentity: WorkerIdentityRepository;
  readonly path: string;
  readonly readOnly: boolean;

  private constructor(private readonly context: Context, path: string, readOnly: boolean) {
    this.path = path;
    this.readOnly = readOnly;
    this.projects = new ProjectRepository(context);
    this.attachments = new AttachmentRepository(context);
    this.projectRules = new ProjectRulesRepository(context);
    this.garbage = new GarbageRepository(context);
    this.conversations = new ConversationRepository(context);
    this.messages = new MessageRepository(context);
    this.snapshots = new SessionSnapshotRepository(context);
    this.runs = new RunRepository(context);
    this.attempts = new RunAttemptRepository(context);
    this.events = new RunEventRepository(context);
    this.checkpoints = new CheckpointRepository(context);
    this.usage = new UsageRepository(context);
    this.idempotency = new IdempotencyRepository(context);
    this.activeSlot = new ActiveSlotRepository(context);
    this.results = new RunResultRepository(context);
    this.workerIdentity = new WorkerIdentityRepository(context);
  }

  static open(options: StorageOptions = {}): Storage {
    const busyTimeoutMs = options.busyTimeoutMs ?? 100;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 5000) throw new TypeError("busyTimeoutMs must be an integer from 1 to 5000");
    const readOnly = options.readOnly ?? false;
    const path = options.path ?? resolveDatabasePath(options.dataDirectory);
    if (!path || (path !== ":memory:" && !isAbsolute(path))) throw new TypeError("Database path must be absolute or :memory:");
    if (readOnly && path === ":memory:") throw new TypeError("An in-memory database cannot be opened read-only");
    if (!readOnly && path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });

    const db = new DatabaseSync(path, {
      readOnly,
      enableForeignKeyConstraints: true,
      allowExtension: false,
      timeout: busyTimeoutMs,
    });
    try {
      if (typeof db.enableDefensive === "function") db.enableDefensive(true);
      const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number } | undefined;
      if (foreignKeys?.foreign_keys !== 1) throw new Error("SQLite foreign key enforcement is unavailable");

      const migrations = loadCoreMigrations();
      let journalMode: string;
      let synchronous: number;
      if (!readOnly) {
        assertMigrationsCompatible(db, migrations);
        const journal = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string } | undefined;
        journalMode = journal?.journal_mode.toLowerCase() ?? "";
        if (path !== ":memory:" && journalMode !== "wal") throw new Error("SQLite WAL mode could not be enabled");
        db.exec("PRAGMA synchronous = FULL");
        const sync = db.prepare("PRAGMA synchronous").get() as { synchronous: number } | undefined;
        synchronous = sync?.synchronous ?? -1;
        if (synchronous !== 2) throw new Error("SQLite FULL synchronous mode could not be enabled");
        applyMigrations(db, migrations);
      } else {
        const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
        journalMode = journal?.journal_mode.toLowerCase() ?? "";
        if (journalMode !== "wal") throw new Error("Read-only database is not configured for WAL mode");
        const sync = db.prepare("PRAGMA synchronous").get() as { synchronous: number } | undefined;
        synchronous = sync?.synchronous ?? -1;
        assertMigrationsCurrent(db, migrations);
      }
      const check = db.prepare("PRAGMA quick_check(1)").get() as { quick_check: string } | undefined;
      if (check?.quick_check !== "ok") throw new Error("SQLite quick check failed");
      const version = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };

      let transactionDepth = 0;
      const context: Context = {
        db,
        readOnly,
        atomic<T>(callback: (connection: DatabaseSync) => T): T {
          if (readOnly) throw new StorageError("db_readonly", "Database is read-only");
          if (transactionDepth > 0) {
            const value = callback(db);
            if (value !== null && typeof value === "object" && "then" in value) throw new TypeError("SQLite transactions must not be asynchronous");
            return value;
          }
          try {
            db.exec("BEGIN IMMEDIATE");
            transactionDepth += 1;
            const value = callback(db);
            if (value !== null && typeof value === "object" && "then" in value) throw new TypeError("SQLite transactions must not be asynchronous");
            db.exec("COMMIT");
            return value;
          } catch (error) {
            try { if (db.isTransaction) db.exec("ROLLBACK"); } catch { /* Keep the original failure. */ }
            return translateStorageError(error);
          } finally {
            transactionDepth = 0;
          }
        },
        translate: translateStorageError,
      };
      const storage = new Storage(context, path, readOnly);
      Object.defineProperty(storage, "diagnostics", {
        value: Object.freeze({ journalMode, synchronous, foreignKeys: true, busyTimeoutMs, schemaVersion: version.version }),
        enumerable: true,
      });
      return storage;
    } catch (error) {
      try { db.close(); } catch { /* The constructor failure is the useful diagnostic. */ }
      if (error instanceof StorageError || error instanceof StorageSchemaError || error instanceof StorageMigrationError) throw error;
      throw translateStorageError(error);
    }
  }

  readonly diagnostics!: StorageDiagnostics;
  transaction<T>(callback: () => T): T { return this.context.atomic(() => callback()); }
  close(): void { if (this.context.db.isOpen) this.context.db.close(); }
}

export function openStorage(options: StorageOptions = {}): Storage { return Storage.open(options); }

export class ProjectRepository {
  constructor(private readonly context: Context) {}
  create(input: Omit<ProjectRecord, "createdAt" | "lastAccessedAt"> & Partial<Pick<ProjectRecord, "createdAt" | "lastAccessedAt">>): ProjectRecord {
    const now = new Date().toISOString();
    const value = { ...input, createdAt: input.createdAt ?? now, lastAccessedAt: input.lastAccessedAt ?? now };
    assertId(value.id, "Project id");
    if (!value.displayName.trim() || !isAbsolute(value.canonicalRoot)) throw new StorageError("invalid_input", "Project fields are invalid");
    assertTimestamp(value.createdAt); assertTimestamp(value.lastAccessedAt);
    this.context.atomic((db) => db.prepare(`INSERT INTO projects(id, display_name, canonical_root, directory_identity, validation_state, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(value.id, value.displayName, resolve(value.canonicalRoot), value.directoryIdentity, value.validationState, value.createdAt, value.lastAccessedAt));
    return this.get(value.id)!;
  }
  get(id: string): ProjectRecord | undefined {
    const row = this.context.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row && mapProject(row);
  }
  getByRoot(canonicalRoot: string): ProjectRecord | undefined {
    const row = this.context.db.prepare("SELECT * FROM projects WHERE canonical_root = ?").get(resolve(canonicalRoot)) as ProjectRow | undefined;
    return row && mapProject(row);
  }
  list(): ProjectRecord[] {
    return (this.context.db.prepare("SELECT * FROM projects ORDER BY last_accessed_at DESC, id").all() as ProjectRow[]).map(mapProject);
  }
  touch(id: string, lastAccessedAt = new Date().toISOString()): void {
    assertTimestamp(lastAccessedAt);
    const result = this.context.atomic((db) => db.prepare("UPDATE projects SET last_accessed_at = ? WHERE id = ?").run(lastAccessedAt, id));
    if (result.changes !== 1) throw new StorageError("not_found", "Project was not found");
  }
  updateValidation(id: string, validationState: ProjectRecord["validationState"], directoryIdentity: string | null): ProjectRecord {
    const result = this.context.atomic((db) => db.prepare("UPDATE projects SET validation_state = ?, directory_identity = ? WHERE id = ?")
      .run(validationState, directoryIdentity, id));
    if (result.changes !== 1) throw new StorageError("not_found", "Project was not found");
    return this.get(id)!;
  }
}

export class AttachmentRepository {
  constructor(private readonly context: Context) {}
  add(input: Omit<AttachmentRecord, "createdAt"> & { createdAt?: string }): AttachmentRecord {
    assertId(input.id, "Attachment id"); assertId(input.conversationId, "Conversation id");
    if (!/^[a-f0-9]{64}$/u.test(input.objectSha256)) throw new StorageError("invalid_input", "Attachment object hash is invalid");
    if (!input.fileName.trim() || input.fileName.length > 512 || !input.relativePath.trim() || input.relativePath.length > 4096) throw new StorageError("invalid_input", "Attachment name is invalid");
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0 || input.byteSize > 20 * 1024 * 1024) throw new StorageError("invalid_input", "Attachment size is invalid");
    const createdAt = input.createdAt ?? new Date().toISOString(); assertTimestamp(createdAt);
    this.context.atomic((db) => {
      const queued = db.prepare("SELECT status FROM garbage_queue WHERE kind = 'attachment_object' AND object_ref = ?").get(input.objectSha256) as { status: string } | undefined;
      if (queued?.status === "deleting") throw new StorageError("conflict", "Attachment object is being reclaimed; retry the import");
      if (queued) db.prepare("DELETE FROM garbage_queue WHERE kind = 'attachment_object' AND object_ref = ?").run(input.objectSha256);
      db.prepare("INSERT INTO attachment_objects(sha256, byte_size, created_at) VALUES (?, ?, ?) ON CONFLICT(sha256) DO NOTHING")
        .run(input.objectSha256, input.byteSize, createdAt);
      const object = db.prepare("SELECT byte_size FROM attachment_objects WHERE sha256 = ?").get(input.objectSha256) as { byte_size: number } | undefined;
      if (!object || object.byte_size !== input.byteSize) throw new StorageError("conflict", "Attachment object metadata does not match");
      db.prepare(`INSERT INTO attachments(id, conversation_id, object_sha256, file_name, relative_path, byte_size, media_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.conversationId, input.objectSha256, input.fileName, input.relativePath, input.byteSize, input.mediaType, createdAt);
    });
    return this.get(input.id)!;
  }
  addMany(inputs: Array<Omit<AttachmentRecord, "createdAt"> & { createdAt?: string }>): AttachmentRecord[] {
    const ids: string[] = [];
    this.context.atomic(() => { for (const input of inputs) ids.push(this.add(input).id); });
    return ids.map((id) => this.get(id)!);
  }
  get(id: string): AttachmentRecord | undefined {
    const row = this.context.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
    return row && mapAttachment(row);
  }
  getForConversation(id: string, conversationId: string): AttachmentRecord | undefined {
    const row = this.context.db.prepare("SELECT * FROM attachments WHERE id = ? AND conversation_id = ?").get(id, conversationId) as AttachmentRow | undefined;
    return row && mapAttachment(row);
  }
  list(conversationId: string): AttachmentRecord[] {
    return (this.context.db.prepare("SELECT * FROM attachments WHERE conversation_id = ? ORDER BY created_at, id").all(conversationId) as AttachmentRow[]).map(mapAttachment);
  }
  referenceCount(sha256: string): number {
    return numberFrom(this.context.db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE object_sha256 = ?").get(sha256), "count");
  }
}

export class ProjectRulesRepository {
  constructor(private readonly context: Context) {}
  get(projectId: string): ProjectRulesRecord | undefined {
    const row = this.context.db.prepare("SELECT * FROM project_rules WHERE project_id = ?").get(projectId) as ProjectRulesRow | undefined;
    return row && mapProjectRules(row);
  }
  accept(input: ProjectRulesRecord): ProjectRulesRecord {
    assertId(input.projectId, "Project id");
    if (!/^[a-f0-9]{64}$/u.test(input.sourceSha256) || input.content.length > 65_536 || !input.sourcePath || !input.sourceVersion) throw new StorageError("invalid_input", "Project rules record is invalid");
    assertTimestamp(input.acceptedAt);
    if (input.revokedAt) assertTimestamp(input.revokedAt);
    this.context.atomic((db) => db.prepare(`INSERT INTO project_rules(project_id, source_path, source_sha256, source_version, content, accepted_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(project_id) DO UPDATE SET source_path=excluded.source_path, source_sha256=excluded.source_sha256,
      source_version=excluded.source_version, content=excluded.content, accepted_at=excluded.accepted_at, revoked_at=NULL`)
      .run(input.projectId, input.sourcePath, input.sourceSha256, input.sourceVersion, input.content, input.acceptedAt));
    return this.get(input.projectId)!;
  }
  revoke(projectId: string, revokedAt = new Date().toISOString()): ProjectRulesRecord {
    assertTimestamp(revokedAt);
    const result = this.context.atomic((db) => db.prepare("UPDATE project_rules SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL").run(revokedAt, projectId));
    if (result.changes !== 1) throw new StorageError("not_found", "Active project rules were not found");
    return this.get(projectId)!;
  }
}

export class GarbageRepository {
  constructor(private readonly context: Context) {}
  list(limit = 100): GarbageRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("Garbage queue limit is invalid");
    const rows = this.context.db.prepare("SELECT kind, object_ref, attempts FROM garbage_queue ORDER BY queued_at, kind, object_ref LIMIT ?").all(limit) as GarbageRow[];
    return rows.map((row) => ({ kind: row.kind, objectRef: row.object_ref, attempts: row.attempts }));
  }
  enqueue(item: Pick<GarbageRecord, "kind" | "objectRef">): void {
    if (item.kind === "attachment_object" && !/^[a-f0-9]{64}$/u.test(item.objectRef)) throw new StorageError("invalid_input", "Attachment object reference is invalid");
    if (item.kind === "run_artifacts") assertId(item.objectRef, "Run id");
    this.context.atomic((db) => db.prepare("INSERT INTO garbage_queue(kind, object_ref, queued_at) VALUES (?, ?, ?) ON CONFLICT(kind, object_ref) DO NOTHING")
      .run(item.kind, item.objectRef, new Date().toISOString()));
  }
  claim(item: Pick<GarbageRecord, "kind" | "objectRef">): boolean {
    return this.context.atomic((db) => {
      const row = db.prepare("SELECT status FROM garbage_queue WHERE kind = ? AND object_ref = ?").get(item.kind, item.objectRef) as { status: string } | undefined;
      if (!row) return false;
      if (item.kind === "attachment_object") {
        const refs = numberFrom(db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE object_sha256 = ?").get(item.objectRef), "count");
        if (refs > 0) { db.prepare("DELETE FROM garbage_queue WHERE kind = ? AND object_ref = ?").run(item.kind, item.objectRef); return false; }
      }
      if (row.status !== "pending") return false;
      return db.prepare("UPDATE garbage_queue SET status = 'deleting' WHERE kind = ? AND object_ref = ? AND status = 'pending'").run(item.kind, item.objectRef).changes === 1;
    });
  }
  resetClaims(): void { this.context.atomic((db) => db.prepare("UPDATE garbage_queue SET status = 'pending' WHERE status = 'deleting'").run()); }
  complete(item: Pick<GarbageRecord, "kind" | "objectRef">): void {
    this.context.atomic((db) => {
      if (item.kind === "attachment_object") {
        const refs = numberFrom(db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE object_sha256 = ?").get(item.objectRef), "count");
        if (refs > 0) { db.prepare("DELETE FROM garbage_queue WHERE kind = ? AND object_ref = ?").run(item.kind, item.objectRef); return; }
        db.prepare("DELETE FROM attachment_objects WHERE sha256 = ?").run(item.objectRef);
      }
      db.prepare("DELETE FROM garbage_queue WHERE kind = ? AND object_ref = ?").run(item.kind, item.objectRef);
    });
  }
  fail(item: Pick<GarbageRecord, "kind" | "objectRef">, error: string): void {
    this.context.atomic((db) => db.prepare("UPDATE garbage_queue SET status = 'pending', attempts = attempts + 1, last_error = ? WHERE kind = ? AND object_ref = ?")
      .run(error.slice(0, 512), item.kind, item.objectRef));
  }
}

export class ConversationRepository {
  constructor(private readonly context: Context) {}
  create(input: Omit<ConversationRecord, "createdAt" | "updatedAt" | "status"> & Partial<Pick<ConversationRecord, "createdAt" | "updatedAt" | "status">>): ConversationRecord {
    const now = new Date().toISOString();
    const value = { ...input, createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now, status: input.status ?? "active" };
    assertId(value.id, "Conversation id");
    if (!value.title.trim()) throw new StorageError("invalid_input", "Conversation title is invalid");
    assertTimestamp(value.createdAt); assertTimestamp(value.updatedAt);
    this.context.atomic((db) => db.prepare(`INSERT INTO conversations(id, project_id, pi_session_id, title, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(value.id, value.projectId, value.piSessionId, value.title, value.status, value.createdAt, value.updatedAt));
    return this.get(value.id)!;
  }
  get(id: string): ConversationRecord | undefined {
    const row = this.context.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined;
    return row && mapConversation(row);
  }
  list(projectId?: string | null): ConversationRecord[] {
    const rows = projectId === undefined
      ? this.context.db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC, id").all()
      : projectId === null
        ? this.context.db.prepare("SELECT * FROM conversations WHERE project_id IS NULL ORDER BY updated_at DESC, id").all()
        : this.context.db.prepare("SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC, id").all(projectId);
    return (rows as ConversationRow[]).map(mapConversation);
  }
  updateStatus(id: string, status: ConversationRecord["status"], updatedAt = new Date().toISOString()): ConversationRecord {
    assertTimestamp(updatedAt);
    const result = this.context.atomic((db) => db.prepare("UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, id));
    if (result.changes !== 1) throw new StorageError("not_found", "Conversation was not found");
    return this.get(id)!;
  }
  update(id: string, patch: { title?: string; status?: ConversationRecord["status"]; piSessionId?: string | null; updatedAt?: string }): ConversationRecord {
    const current = this.get(id);
    if (!current) throw new StorageError("not_found", "Conversation was not found");
    const updatedAt = patch.updatedAt ?? new Date().toISOString();
    assertTimestamp(updatedAt);
    const title = patch.title ?? current.title;
    if (!title.trim() || title.length > 256) throw new StorageError("invalid_input", "Conversation title is invalid");
    const piSessionId = patch.piSessionId === undefined ? current.piSessionId : patch.piSessionId;
    if (piSessionId !== null) assertId(piSessionId, "PI session id");
    this.context.atomic((db) => {
      const result = db.prepare("UPDATE conversations SET title = ?, status = ?, pi_session_id = ?, updated_at = ? WHERE id = ?")
        .run(title, patch.status ?? current.status, piSessionId, updatedAt, id);
      if (result.changes !== 1) throw new StorageError("not_found", "Conversation was not found");
    });
    return this.get(id)!;
  }
  deletePermanently(id: string): void {
    this.context.atomic((db) => {
      if (!db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id)) throw new StorageError("not_found", "Conversation was not found");
      const active = db.prepare(`SELECT 1 FROM runs WHERE conversation_id = ? AND status IN ('accepted', 'running', 'cancelling') LIMIT 1`).get(id);
      if (active) throw new StorageError("active_task", "Conversation has a run that has not stopped");
      const slot = db.prepare(`SELECT 1 FROM global_slot WHERE singleton = 1 AND active_run_id IN (SELECT id FROM runs WHERE conversation_id = ?)`).get(id);
      if (slot) throw new StorageError("active_task", "Conversation worker exit has not been confirmed");
      const worker = db.prepare("SELECT status FROM worker_identity WHERE singleton = 1").get() as { status: string } | undefined;
      if (worker && (worker.status === "stopping" || worker.status === "uncertain")) throw new StorageError("active_task", "Worker exit has not been confirmed");

      const objectHashes = db.prepare("SELECT DISTINCT object_sha256 FROM attachments WHERE conversation_id = ?").all(id) as Array<{ object_sha256: string }>;
      const runIds = db.prepare("SELECT id FROM runs WHERE conversation_id = ?").all(id) as Array<{ id: string }>;
      const queuedAt = new Date().toISOString();
      db.prepare("DELETE FROM attachments WHERE conversation_id = ?").run(id);
      for (const { object_sha256 } of objectHashes) {
        const refs = numberFrom(db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE object_sha256 = ?").get(object_sha256), "count");
        if (refs === 0) db.prepare(`INSERT INTO garbage_queue(kind, object_ref, queued_at) VALUES ('attachment_object', ?, ?)
          ON CONFLICT(kind, object_ref) DO NOTHING`).run(object_sha256, queuedAt);
      }
      for (const { id: runId } of runIds) db.prepare(`INSERT INTO garbage_queue(kind, object_ref, queued_at) VALUES ('run_artifacts', ?, ?)
        ON CONFLICT(kind, object_ref) DO NOTHING`).run(runId, queuedAt);

      db.prepare("DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ?)").run(id);
      db.prepare("DELETE FROM checkpoints WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ?)").run(id);
      db.prepare("DELETE FROM usage_records WHERE attempt_id IN (SELECT a.id FROM run_attempts a JOIN runs r ON r.id = a.run_id WHERE r.conversation_id = ?)").run(id);
      db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
      db.prepare("DELETE FROM run_attempts WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ?)").run(id);
      db.prepare("DELETE FROM run_results WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = ?)").run(id);
      db.prepare("UPDATE runs SET retry_of_run_id = NULL WHERE conversation_id = ?").run(id);
      db.prepare("DELETE FROM idempotency_keys WHERE (resource_kind = 'conversation' AND resource_id = ?) OR resource_id IN (SELECT id FROM runs WHERE conversation_id = ?)").run(id, id);
      db.prepare("DELETE FROM runs WHERE conversation_id = ?").run(id);
      db.prepare("DELETE FROM session_snapshots WHERE conversation_id = ?").run(id);
      db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    });
  }
}

export class MessageRepository {
  constructor(private readonly context: Context) {}
  append(input: Omit<MessageRecord, "sequence" | "createdAt" | "attachmentRefs"> & Partial<Pick<MessageRecord, "createdAt" | "attachmentRefs">>): MessageRecord {
    assertLikelyCredentialFree(input.content);
    const createdAt = input.createdAt ?? new Date().toISOString();
    assertId(input.id, "Message id"); assertId(input.conversationId, "Conversation id");
    if (input.runId) assertId(input.runId, "Run id");
    if (input.extensionId) assertId(input.extensionId, "Extension id");
    for (const ref of input.attachmentRefs ?? []) assertId(ref, "Attachment reference");
    assertTimestamp(createdAt);
    const refs = input.attachmentRefs ?? [];
    this.context.atomic((db) => {
      const next = numberFrom(db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM messages WHERE conversation_id = ?").get(input.conversationId), "next");
      db.prepare(`INSERT INTO messages(id, conversation_id, run_id, sequence, role, content, source, extension_id, attachment_refs_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.conversationId, input.runId, next, input.role, input.content, input.source, input.extensionId, safeJson(refs), createdAt);
      return next;
    });
    return this.get(input.id)!;
  }
  get(id: string): MessageRecord | undefined {
    const row = this.context.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
    return row && mapMessage(row);
  }
  list(conversationId: string): MessageRecord[] {
    return (this.context.db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY sequence").all(conversationId) as MessageRow[]).map(mapMessage);
  }
}

export class SessionSnapshotRepository {
  constructor(private readonly context: Context) {}
  save(input: Omit<SessionSnapshotRecord, "version"> & { version?: number }): SessionSnapshotRecord {
    assertId(input.id, "Snapshot id"); assertId(input.conversationId, "Conversation id");
    assertTimestamp(input.createdAt);
    const encoded = safeJson(input.snapshot);
    const version = this.context.atomic((db) => {
      const next = numberFrom(db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS next FROM session_snapshots WHERE conversation_id = ?").get(input.conversationId), "next");
      const chosen = input.version ?? next;
      if (chosen !== next) throw new StorageError("conflict", "Snapshot version must be the next conversation version");
      db.prepare(`INSERT INTO session_snapshots(id, conversation_id, version, sdk_version, format_version, snapshot_json, summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.conversationId, chosen, input.sdkVersion, input.formatVersion, encoded, input.summary, input.createdAt);
      return chosen;
    });
    return this.get(input.conversationId, version)!;
  }
  get(conversationId: string, version: number): SessionSnapshotRecord | undefined {
    const row = this.context.db.prepare("SELECT * FROM session_snapshots WHERE conversation_id = ? AND version = ?").get(conversationId, version) as SnapshotRow | undefined;
    return row && mapSnapshot(row);
  }
  latest(conversationId: string): SessionSnapshotRecord | undefined {
    const row = this.context.db.prepare("SELECT * FROM session_snapshots WHERE conversation_id = ? ORDER BY version DESC LIMIT 1").get(conversationId) as SnapshotRow | undefined;
    return row && mapSnapshot(row);
  }
}

export interface CreateRunInput {
  runId: string; conversationId: string; projectId?: string | null; extensionId?: string | null;
  request: unknown; requestHash?: string; retryOfRunId?: string; createdAt?: string;
}
export interface InitialRunAdmission {
  attemptId: string; claimToken: string; workerBootId: string;
  heartbeatAt: string; leaseExpiresAt: string; updatedAt: string;
  conversationTitle: string; acceptedEventId: string; startedEventId: string;
  message: { id: string; role: MessageRecord["role"]; content: string; extensionId: string | null; createdAt: string };
}
export interface AdmittedRunState { slot: ActiveSlot; attemptId: string; events: V2RunEvent[]; }
export interface ResumeRunAdmission {
  attemptId: string; claimToken: string; workerBootId: string;
  heartbeatAt: string; leaseExpiresAt: string; updatedAt: string; startedEventId: string;
}
export class RunRepository {
  constructor(private readonly context: Context) {}
  create(input: CreateRunInput): RunRecord {
    assertId(input.runId, "Run id"); assertId(input.conversationId, "Conversation id");
    if (input.projectId) assertId(input.projectId, "Project id");
    if (input.extensionId) assertId(input.extensionId, "Extension id");
    if (input.retryOfRunId) assertId(input.retryOfRunId, "Retry source run id");
    const requestJson = safeJson(input.request);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const conversation = this.context.db.prepare("SELECT project_id FROM conversations WHERE id = ?").get(input.conversationId) as { project_id: string | null } | undefined;
    if (!conversation) throw new StorageError("not_found", "Conversation was not found");
    const projectId = input.projectId === undefined ? conversation.project_id : input.projectId;
    if (projectId !== conversation.project_id) throw new StorageError("conflict", "Run project must match its conversation");
    const requestHash = hashRunRequest(input, projectId, requestJson);
    if (input.requestHash && input.requestHash !== requestHash) throw new StorageError("invalid_input", "Run request hash does not match its request");
    const run: V2Run = parseV2Run({
      schemaVersion: 2, runId: input.runId, conversationId: input.conversationId,
      projectId, extensionId: input.extensionId ?? null, status: "accepted", requestHash,
      ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      createdAt, updatedAt: createdAt,
    });
    this.context.atomic((db) => db.prepare(`INSERT INTO runs(id, conversation_id, project_id, extension_id, status, request_hash, request_json, retry_of_run_id, created_at, updated_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(run.runId, run.conversationId, run.projectId ?? null, run.extensionId ?? null, run.status, requestHash, requestJson, run.retryOfRunId ?? null, createdAt, createdAt));
    return this.get(input.runId)!;
  }
  createIdempotent(input: CreateRunInput, key: Omit<V2IdempotencyRequest, "schemaVersion" | "requestHash">, admission?: InitialRunAdmission): IdempotencyResolution & { run: RunRecord; admission?: AdmittedRunState } {
    assertId(input.runId, "Run id"); assertId(input.conversationId, "Conversation id");
    if (input.projectId) assertId(input.projectId, "Project id");
    if (input.extensionId) assertId(input.extensionId, "Extension id");
    if (input.retryOfRunId) assertId(input.retryOfRunId, "Retry source run id");
    parseV2IdempotencyRequest({ schemaVersion: 2, ...key, requestHash: "0".repeat(64) });
    const requestJson = safeJson(input.request);
    const createdAt = input.createdAt ?? new Date().toISOString();
    if (admission) {
      assertId(admission.attemptId, "Attempt id"); assertId(admission.claimToken, "Claim token"); assertId(admission.workerBootId, "Worker boot id");
      assertId(admission.message.id, "Message id"); assertTimestamp(admission.heartbeatAt); assertTimestamp(admission.leaseExpiresAt); assertTimestamp(admission.updatedAt); assertTimestamp(admission.message.createdAt);
      assertLikelyCredentialFree(admission.message.content);
      if (!admission.conversationTitle.trim() || admission.conversationTitle.length > 256) throw new StorageError("invalid_input", "Conversation title is invalid");
    }
    const result = this.context.atomic((db) => {
      const conversation = db.prepare("SELECT project_id FROM conversations WHERE id = ?").get(input.conversationId) as { project_id: string | null } | undefined;
      if (!conversation) throw new StorageError("not_found", "Conversation was not found");
      const projectId = input.projectId === undefined ? conversation.project_id : input.projectId;
      if (projectId !== conversation.project_id) throw new StorageError("conflict", "Run project must match its conversation");
      const requestHash = hashRunRequest(input, projectId, requestJson);
      if (input.requestHash && input.requestHash !== requestHash) throw new StorageError("invalid_input", "Run request hash does not match its request");
      let nextGeneration: number | undefined;
      const existing = db.prepare(`SELECT request_hash, resource_kind, resource_id FROM idempotency_keys
        WHERE scope = ? AND endpoint = ? AND idempotency_key = ?`).get(key.scope, key.endpoint, key.key) as IdempotencyRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) throw new StorageError("conflict", "Idempotency key was already used for a different request");
        if (existing.resource_kind !== "run") throw new StorageError("conflict", "Idempotency key refers to a different resource kind");
        const stored = db.prepare("SELECT * FROM runs WHERE id = ?").get(existing.resource_id) as RunRow | undefined;
        if (!stored) throw new StorageError("conflict", "Idempotent run no longer exists");
        return { runId: stored.id, replayed: true };
      }
      if (admission) {
        const slot = db.prepare("SELECT active_run_id, generation FROM global_slot WHERE singleton = 1").get() as { active_run_id: string | null; generation: number } | undefined;
        if (!slot) throw new StorageError("conflict", "Global active slot is missing");
        if (slot.active_run_id !== null) throw new StorageError("active_task", "Another run already holds the global active slot");
        nextGeneration = slot.generation + 1;
        const identity = db.prepare("SELECT boot_id, status FROM worker_identity WHERE singleton = 1").get() as { boot_id: string; status: string } | undefined;
        if (!identity || identity.boot_id !== admission.workerBootId || identity.status !== "idle") throw new StorageError("conflict", "Worker identity is not idle and confirmed");
      }
      const run = parseV2Run({
        schemaVersion: 2, runId: input.runId, conversationId: input.conversationId,
        projectId, extensionId: input.extensionId ?? null, status: "accepted", requestHash,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}), createdAt, updatedAt: createdAt,
      });
      db.prepare(`INSERT INTO runs(id, conversation_id, project_id, extension_id, status, request_hash, request_json, retry_of_run_id, created_at, updated_at, ended_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(run.runId, run.conversationId, run.projectId ?? null, run.extensionId ?? null, run.status, requestHash, requestJson, run.retryOfRunId ?? null, createdAt, createdAt);
      db.prepare(`INSERT INTO idempotency_keys(scope, endpoint, idempotency_key, request_hash, resource_kind, resource_id, created_at)
        VALUES (?, ?, ?, ?, 'run', ?, ?)`)
        .run(key.scope, key.endpoint, key.key, requestHash, run.runId, createdAt);
      if (!admission) return { runId: run.runId, replayed: false };

      if (nextGeneration === undefined) throw new StorageError("conflict", "Run admission slot generation was not initialized");
      const slotUpdate = db.prepare(`UPDATE global_slot SET active_run_id = ?, claim_token = ?, generation = ?, worker_boot_id = ?, heartbeat_at = ?, lease_expires_at = ?
        WHERE singleton = 1 AND active_run_id IS NULL`).run(run.runId, admission.claimToken, nextGeneration, admission.workerBootId, admission.heartbeatAt, admission.leaseExpiresAt);
      if (slotUpdate.changes !== 1) throw new StorageError("active_task", "Another run claimed the global active slot");
      const attempt = parseV2RunAttempt({
        schemaVersion: 2, runId: run.runId, attemptId: admission.attemptId, attemptNumber: 1,
        status: "running", usageComplete: false, workerBootId: admission.workerBootId, startedAt: admission.updatedAt,
      });
      db.prepare(`INSERT INTO run_attempts(id, run_id, attempt_number, status, usage_complete, worker_boot_id, started_at, ended_at, error_json)
        VALUES (?, ?, ?, ?, 0, ?, ?, NULL, NULL)`).run(attempt.attemptId, attempt.runId, attempt.attemptNumber, attempt.status, admission.workerBootId, attempt.startedAt);
      const running = parseV2Run({ ...run, status: "running", updatedAt: admission.updatedAt });
      db.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'accepted'").run(admission.updatedAt, run.runId);
      const messageSequence = numberFrom(db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM messages WHERE conversation_id = ?").get(run.conversationId), "next");
      db.prepare(`INSERT INTO messages(id, conversation_id, run_id, sequence, role, content, source, extension_id, attachment_refs_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'user', ?, '[]', ?)`).run(admission.message.id, run.conversationId, run.runId, messageSequence, admission.message.role, admission.message.content, admission.message.extensionId, admission.message.createdAt);
      db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(admission.conversationTitle, admission.updatedAt, run.conversationId);
      const events = [
        parseV2RunEvent({ schemaVersion: 2, eventId: admission.acceptedEventId, runId: run.runId, attemptId: attempt.attemptId, sequence: 1, timestamp: admission.updatedAt, type: "run.accepted", data: { conversationId: run.conversationId, requestHash } }),
        parseV2RunEvent({ schemaVersion: 2, eventId: admission.startedEventId, runId: run.runId, attemptId: attempt.attemptId, sequence: 2, timestamp: admission.updatedAt, type: "run.started", data: { workerBootId: admission.workerBootId } }),
      ];
      const insertEvent = db.prepare(`INSERT INTO run_events(event_id, run_id, attempt_id, sequence, event_type, event_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const event of events) insertEvent.run(event.eventId, event.runId, event.attemptId, event.sequence, event.type, safeJson(event), event.timestamp);
      const workerUpdate = db.prepare("UPDATE worker_identity SET status = 'running', heartbeat_at = ? WHERE singleton = 1 AND boot_id = ? AND status = 'idle'").run(admission.heartbeatAt, admission.workerBootId);
      if (workerUpdate.changes !== 1) throw new StorageError("conflict", "Worker identity changed during run admission");
      return {
        runId: running.runId, replayed: false,
        admission: { slot: { runId: running.runId, claimToken: admission.claimToken, generation: nextGeneration, workerBootId: admission.workerBootId, heartbeatAt: admission.heartbeatAt, leaseExpiresAt: admission.leaseExpiresAt }, attemptId: attempt.attemptId, events },
      };
    });
    const run = this.get(result.runId)!;
    return { result: { schemaVersion: 2, resourceKind: "run", resourceId: result.runId }, replayed: result.replayed, run, ...(result.admission ? { admission: result.admission } : {}) };
  }
  continueIdempotent(runId: string, key: Omit<V2IdempotencyRequest, "schemaVersion">, admission: ResumeRunAdmission): IdempotencyResolution & { run: RunRecord; replayed: boolean; admission?: AdmittedRunState } {
    assertId(runId, "Run id");
    parseV2IdempotencyRequest({ schemaVersion: 2, ...key });
    assertId(admission.attemptId, "Attempt id"); assertId(admission.claimToken, "Claim token"); assertId(admission.workerBootId, "Worker boot id"); assertId(admission.startedEventId, "Event id");
    assertTimestamp(admission.heartbeatAt); assertTimestamp(admission.leaseExpiresAt); assertTimestamp(admission.updatedAt);
    const result = this.context.atomic((db) => {
      const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
      if (!run) throw new StorageError("not_found", "Run was not found");
      const existing = db.prepare(`SELECT request_hash, resource_kind, resource_id FROM idempotency_keys
        WHERE scope = ? AND endpoint = ? AND idempotency_key = ?`).get(key.scope, key.endpoint, key.key) as IdempotencyRow | undefined;
      if (existing) {
        if (existing.request_hash !== key.requestHash) throw new StorageError("conflict", "Idempotency key was already used for a different request");
        if (existing.resource_kind !== "run" || existing.resource_id !== runId) throw new StorageError("conflict", "Idempotency key refers to a different resource");
        return { runId, replayed: true };
      }
      if (run.status !== "interrupted") throw new StorageError("conflict", "Only interrupted runs can be continued");
      const slot = db.prepare("SELECT active_run_id, generation FROM global_slot WHERE singleton = 1").get() as { active_run_id: string | null; generation: number } | undefined;
      if (!slot) throw new StorageError("conflict", "Global active slot is missing");
      if (slot.active_run_id !== null) throw new StorageError("active_task", "Another run already holds the global active slot");
      const identity = db.prepare("SELECT boot_id, status FROM worker_identity WHERE singleton = 1").get() as { boot_id: string; status: string } | undefined;
      if (!identity || identity.boot_id !== admission.workerBootId || identity.status !== "idle") throw new StorageError("conflict", "Worker identity is not idle and confirmed");
      const generation = slot.generation + 1;
      db.prepare(`INSERT INTO idempotency_keys(scope, endpoint, idempotency_key, request_hash, resource_kind, resource_id, created_at)
        VALUES (?, ?, ?, ?, 'run', ?, ?)`).run(key.scope, key.endpoint, key.key, key.requestHash, runId, admission.updatedAt);
      const slotUpdate = db.prepare(`UPDATE global_slot SET active_run_id = ?, claim_token = ?, generation = ?, worker_boot_id = ?, heartbeat_at = ?, lease_expires_at = ?
        WHERE singleton = 1 AND active_run_id IS NULL`).run(runId, admission.claimToken, generation, admission.workerBootId, admission.heartbeatAt, admission.leaseExpiresAt);
      if (slotUpdate.changes !== 1) throw new StorageError("active_task", "Another run claimed the global active slot");
      const attemptNumber = numberFrom(db.prepare("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM run_attempts WHERE run_id = ?").get(runId), "next");
      const attempt = parseV2RunAttempt({
        schemaVersion: 2, runId, attemptId: admission.attemptId, attemptNumber, status: "running",
        usageComplete: false, workerBootId: admission.workerBootId, startedAt: admission.updatedAt,
      });
      db.prepare(`INSERT INTO run_attempts(id, run_id, attempt_number, status, usage_complete, worker_boot_id, started_at, ended_at, error_json)
        VALUES (?, ?, ?, 'running', 0, ?, ?, NULL, NULL)`).run(attempt.attemptId, runId, attempt.attemptNumber, admission.workerBootId, admission.updatedAt);
      const eventSequence = numberFrom(db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM run_events WHERE run_id = ?").get(runId), "next");
      const event = parseV2RunEvent({ schemaVersion: 2, eventId: admission.startedEventId, runId, attemptId: attempt.attemptId, sequence: eventSequence,
        timestamp: admission.updatedAt, type: "run.started", data: { workerBootId: admission.workerBootId } });
      db.prepare(`INSERT INTO run_events(event_id, run_id, attempt_id, sequence, event_type, event_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(event.eventId, event.runId, event.attemptId, event.sequence, event.type, safeJson(event), event.timestamp);
      const runUpdate = db.prepare("UPDATE runs SET status = 'running', updated_at = ?, ended_at = NULL WHERE id = ? AND status = 'interrupted'").run(admission.updatedAt, runId);
      if (runUpdate.changes !== 1) throw new StorageError("conflict", "Run state changed before continuation was committed");
      const workerUpdate = db.prepare("UPDATE worker_identity SET status = 'running', heartbeat_at = ? WHERE singleton = 1 AND boot_id = ? AND status = 'idle'").run(admission.heartbeatAt, admission.workerBootId);
      if (workerUpdate.changes !== 1) throw new StorageError("conflict", "Worker identity changed during run continuation");
      return { runId, replayed: false, admission: { slot: { runId, claimToken: admission.claimToken, generation, workerBootId: admission.workerBootId, heartbeatAt: admission.heartbeatAt, leaseExpiresAt: admission.leaseExpiresAt }, attemptId: attempt.attemptId, events: [event] } };
    });
    const run = this.get(result.runId)!;
    return { result: { schemaVersion: 2, resourceKind: "run", resourceId: result.runId }, replayed: result.replayed, run, ...(result.admission ? { admission: result.admission } : {}) };
  }
  get(id: string): RunRecord | undefined {
    const row = this.context.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!row) return undefined;
    const parsed = parseV2Run({
      schemaVersion: 2, runId: row.id, conversationId: row.conversation_id,
      projectId: row.project_id, extensionId: row.extension_id, status: row.status,
      requestHash: row.request_hash, ...(row.retry_of_run_id ? { retryOfRunId: row.retry_of_run_id } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at, endedAt: row.ended_at,
    });
    return { ...parsed, request: parseJson(row.request_json) };
  }
  list(conversationId: string): RunRecord[] {
    assertId(conversationId, "Conversation id");
    return (this.context.db.prepare("SELECT id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, id").all(conversationId) as Array<{ id: string }>).map((row) => this.get(row.id)!).filter(Boolean);
  }
  updateStatus(id: string, status: V2RunStatus, updatedAt = new Date().toISOString(), endedAt?: string | null): RunRecord {
    assertId(id, "Run id"); assertTimestamp(updatedAt);
    if (endedAt) assertTimestamp(endedAt);
    this.context.atomic((db) => {
      const row = db.prepare("SELECT status, created_at FROM runs WHERE id = ?").get(id) as { status: V2RunStatus; created_at: string } | undefined;
      if (!row) throw new StorageError("not_found", "Run was not found");
      const allowed = RUN_TRANSITIONS[row.status];
      if (!allowed || !allowed.includes(status)) throw new StorageError("conflict", `Run cannot transition from ${row.status} to ${status}`);
      const terminal = isTerminalRunStatus(status);
      const nextEndedAt = terminal ? (endedAt ?? updatedAt) : null;
      const current = this.get(id);
      if (!current) throw new StorageError("not_found", "Run was not found");
      const { request: _request, ...currentRun } = current;
      const next = parseV2Run({
        ...currentRun, status, updatedAt, endedAt: nextEndedAt,
      });
      if (Date.parse(next.updatedAt) < Date.parse(row.created_at)) throw new StorageError("invalid_input", "Run timestamp precedes creation");
      db.prepare("UPDATE runs SET status = ?, updated_at = ?, ended_at = ? WHERE id = ?").run(status, updatedAt, nextEndedAt, id);
    });
    return this.get(id)!;
  }
}

export class RunResultRepository {
  constructor(private readonly context: Context) {}
  save(runId: string, result: unknown, updatedAt = new Date().toISOString()): JsonValue {
    assertId(runId, "Run id"); assertTimestamp(updatedAt);
    const encoded = safeJson(result);
    this.context.atomic((db) => {
      if (!db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId)) throw new StorageError("not_found", "Run was not found");
      db.prepare(`INSERT INTO run_results(run_id, result_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET result_json = excluded.result_json, updated_at = excluded.updated_at`)
        .run(runId, encoded, updatedAt);
    });
    return parseJson(encoded);
  }
  get(runId: string): JsonValue | undefined {
    const row = this.context.db.prepare("SELECT result_json FROM run_results WHERE run_id = ?").get(runId) as { result_json: string } | undefined;
    return row && parseJson(row.result_json);
  }
}

export class WorkerIdentityRepository {
  constructor(private readonly context: Context) {}
  get(): WorkerIdentityRecord | undefined {
    const row = this.context.db.prepare("SELECT * FROM worker_identity WHERE singleton = 1").get() as WorkerIdentityRow | undefined;
    return row && { bootId: row.boot_id, pid: row.pid, processStart: row.process_start, status: row.status, startedAt: row.started_at, heartbeatAt: row.heartbeat_at };
  }
  save(record: WorkerIdentityRecord): WorkerIdentityRecord {
    assertId(record.bootId, "Worker boot id");
    if (!Number.isSafeInteger(record.pid) || record.pid < 1 || !record.processStart || record.processStart.length > 128) throw new StorageError("invalid_input", "Worker process identity is invalid");
    assertTimestamp(record.startedAt); assertTimestamp(record.heartbeatAt);
    this.context.atomic((db) => db.prepare(`INSERT INTO worker_identity(singleton, boot_id, pid, process_start, status, started_at, heartbeat_at)
      VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET boot_id = excluded.boot_id, pid = excluded.pid,
      process_start = excluded.process_start, status = excluded.status, started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`)
      .run(record.bootId, record.pid, record.processStart, record.status, record.startedAt, record.heartbeatAt));
    return record;
  }
  setStatus(bootId: string, status: WorkerIdentityRecord["status"], heartbeatAt = new Date().toISOString()): void {
    assertId(bootId, "Worker boot id"); assertTimestamp(heartbeatAt);
    this.context.atomic((db) => {
      const result = db.prepare("UPDATE worker_identity SET status = ?, heartbeat_at = ? WHERE singleton = 1 AND boot_id = ?").run(status, heartbeatAt, bootId);
      if (result.changes !== 1) throw new StorageError("conflict", "Worker identity changed before status update");
    });
  }
  clear(bootId: string): void {
    assertId(bootId, "Worker boot id");
    this.context.atomic((db) => db.prepare("DELETE FROM worker_identity WHERE singleton = 1 AND boot_id = ?").run(bootId));
  }
}

export class RunAttemptRepository {
  constructor(private readonly context: Context) {}
  create(input: { attemptId: string; runId: string; workerBootId?: string; startedAt?: string }): RunAttemptRecord {
    assertId(input.attemptId, "Attempt id"); assertId(input.runId, "Run id");
    if (input.workerBootId) assertId(input.workerBootId, "Worker boot id");
    const startedAt = input.startedAt ?? new Date().toISOString();
    this.context.atomic((db) => {
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(input.runId) as { status: string } | undefined;
      if (!run) throw new StorageError("not_found", "Run was not found");
      if (run.status !== "accepted" && run.status !== "interrupted") throw new StorageError("conflict", "Run is not ready for another attempt");
      const attemptNumber = numberFrom(db.prepare("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM run_attempts WHERE run_id = ?").get(input.runId), "next");
      const attempt = parseV2RunAttempt({
        schemaVersion: 2, runId: input.runId, attemptId: input.attemptId, attemptNumber,
        status: "running", usageComplete: false, ...(input.workerBootId ? { workerBootId: input.workerBootId } : {}), startedAt,
      });
      db.prepare(`INSERT INTO run_attempts(id, run_id, attempt_number, status, usage_complete, worker_boot_id, started_at, ended_at, error_json)
        VALUES (?, ?, ?, ?, 0, ?, ?, NULL, NULL)`)
        .run(attempt.attemptId, attempt.runId, attempt.attemptNumber, attempt.status, attempt.workerBootId ?? null, attempt.startedAt);
    });
    return this.get(input.attemptId)!;
  }
  finish(attemptId: string, status: Exclude<V2RunAttempt["status"], "running">, endedAt = new Date().toISOString(), error?: V2Error, usageComplete = false): RunAttemptRecord {
    assertId(attemptId, "Attempt id"); assertTimestamp(endedAt);
    if (error) parseV2Error(error);
    this.context.atomic((db) => {
      const row = db.prepare("SELECT * FROM run_attempts WHERE id = ?").get(attemptId) as AttemptRow | undefined;
      if (!row) throw new StorageError("not_found", "Run attempt was not found");
      if (row.status !== "running") throw new StorageError("conflict", "Run attempt is already terminal");
      if (status === "failed" && !error) throw new StorageError("invalid_input", "Failed run attempts require a versioned error");
      if (status !== "failed" && error) throw new StorageError("invalid_input", "Only failed attempts may include an error");
      if (usageComplete) {
        const usage = db.prepare("SELECT cost_status FROM usage_records WHERE attempt_id = ?").get(attemptId) as { cost_status: string } | undefined;
        if (!usage || usage.cost_status === "unknown") throw new StorageError("invalid_input", "Complete attempt usage requires recorded cost provenance");
      }
      const attempt = parseV2RunAttempt({
        schemaVersion: 2, runId: row.run_id, attemptId: row.id, attemptNumber: row.attempt_number,
        status, usageComplete, ...(row.worker_boot_id ? { workerBootId: row.worker_boot_id } : {}),
        startedAt: row.started_at, endedAt, ...(error ? { error } : {}),
      });
      db.prepare("UPDATE run_attempts SET status = ?, usage_complete = ?, ended_at = ?, error_json = ? WHERE id = ?")
        .run(attempt.status, attempt.usageComplete ? 1 : 0, attempt.endedAt ?? null, error ? safeJson(error) : null, attemptId);
    });
    return this.get(attemptId)!;
  }
  get(attemptId: string): RunAttemptRecord | undefined {
    const row = this.context.db.prepare("SELECT * FROM run_attempts WHERE id = ?").get(attemptId) as AttemptRow | undefined;
    return row && mapAttempt(row);
  }
  list(runId: string): RunAttemptRecord[] {
    return (this.context.db.prepare("SELECT * FROM run_attempts WHERE run_id = ? ORDER BY attempt_number").all(runId) as AttemptRow[]).map(mapAttempt);
  }
}

export interface AppendEventInput {
  eventId: string; runId: string; attemptId: string; type: V2RunEvent["type"];
  timestamp?: string; data: V2RunEvent["data"];
}
export class RunEventRepository {
  constructor(private readonly context: Context) {}
  append(input: AppendEventInput): V2RunEvent {
    const timestamp = input.timestamp ?? new Date().toISOString();
    const event = this.context.atomic((db) => {
      const owner = db.prepare("SELECT run_id FROM run_attempts WHERE id = ?").get(input.attemptId) as { run_id: string } | undefined;
      if (!owner) throw new StorageError("not_found", "Run attempt was not found");
      if (owner.run_id !== input.runId) throw new StorageError("conflict", "Event attempt does not belong to the run");
      const sequence = numberFrom(db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM run_events WHERE run_id = ?").get(input.runId), "next");
      const parsed = parseV2RunEvent({ schemaVersion: 2, ...input, timestamp, sequence });
      const json = safeJson(parsed);
      db.prepare(`INSERT INTO run_events(event_id, run_id, attempt_id, sequence, event_type, event_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(parsed.eventId, parsed.runId, parsed.attemptId, parsed.sequence, parsed.type, json, parsed.timestamp);
      return parsed;
    });
    return event;
  }
  after(cursor: V2EventCursor, limit = 100): ReturnType<typeof parseV2RunEventPage> {
    parseV2EventCursor(cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new StorageError("invalid_input", "Event page limit must be from 1 to 1000");
    if (cursor.lastEventId) {
      const last = this.context.db.prepare("SELECT sequence FROM run_events WHERE run_id = ? AND event_id = ?").get(cursor.runId, cursor.lastEventId) as { sequence: number } | undefined;
      if (!last || last.sequence !== cursor.afterSequence) throw new StorageError("conflict", "Event cursor does not match stored history");
    }
    const rows = this.context.db.prepare("SELECT event_json FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
      .all(cursor.runId, cursor.afterSequence, limit) as Array<{ event_json: string }>;
    const events = rows.map((row) => parseV2RunEvent(parseJson(row.event_json)));
    const latest = events.at(-1);
    const nextCursor: V2EventCursor = latest
      ? { schemaVersion: 2, runId: cursor.runId, afterSequence: latest.sequence, lastEventId: latest.eventId }
      : cursor;
    const page = { schemaVersion: 2 as const, runId: cursor.runId, afterSequence: cursor.afterSequence, events, nextCursor };
    return parseV2RunEventPage(page);
  }
  latestSequence(runId: string): number {
    return numberFrom(this.context.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS latest FROM run_events WHERE run_id = ?").get(runId), "latest");
  }
  sequenceById(runId: string, eventId: string): number | undefined {
    assertId(runId, "Run id"); assertId(eventId, "Event id");
    const row = this.context.db.prepare("SELECT sequence FROM run_events WHERE run_id = ? AND event_id = ?").get(runId, eventId) as { sequence: number } | undefined;
    return row?.sequence;
  }
}

export class CheckpointRepository {
  constructor(private readonly context: Context) {}
  create(input: CheckpointRecord): CheckpointRecord {
    assertId(input.id, "Checkpoint id"); assertId(input.runId, "Run id"); assertId(input.attemptId, "Attempt id");
    assertTimestamp(input.createdAt);
    if (!/^[a-f0-9]{64}$/.test(input.inputSha256)) throw new StorageError("invalid_input", "Checkpoint input digest is invalid");
    this.context.atomic((db) => db.prepare(`INSERT INTO checkpoints(id, run_id, attempt_id, phase_id, input_sha256, output_ref, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.runId, input.attemptId, input.phaseId, input.inputSha256, input.outputRef, input.status, input.createdAt));
    return this.get(input.id)!;
  }
  get(id: string): CheckpointRecord | undefined {
    const row = this.context.db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as CheckpointRow | undefined;
    return row && mapCheckpoint(row);
  }
  list(runId: string): CheckpointRecord[] {
    return (this.context.db.prepare("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created_at, id").all(runId) as CheckpointRow[]).map(mapCheckpoint);
  }
}

export class UsageRepository {
  constructor(private readonly context: Context) {}
  record(input: UsageRecord): UsageRecord {
    assertId(input.attemptId, "Attempt id"); assertTimestamp(input.updatedAt);
    if (input.modelId !== null && input.modelId.length > 128) throw new StorageError("invalid_input", "Model id is too long");
    for (const count of [input.modelCalls, input.toolCalls, input.inputTokens, input.outputTokens, input.cacheReadTokens, input.cacheWriteTokens, input.totalTokens]) {
      if (!Number.isSafeInteger(count) || count < 0) throw new StorageError("invalid_input", "Usage counters must be nonnegative safe integers");
    }
    if (input.estimatedCostUsd !== null && (!Number.isFinite(input.estimatedCostUsd) || input.estimatedCostUsd < 0)) throw new StorageError("invalid_input", "Usage cost must be finite and nonnegative");
    if (input.totalTokens !== input.inputTokens + input.outputTokens + input.cacheReadTokens + input.cacheWriteTokens) throw new StorageError("invalid_input", "Usage token totals are inconsistent");
    if ((input.costStatus === "unknown") !== (input.estimatedCostUsd === null)) throw new StorageError("invalid_input", "Usage cost status and estimate do not match");
    if (input.costStatus === "estimate" && !input.pricingVersion) throw new StorageError("invalid_input", "Estimated cost requires a pricing version");
    this.context.atomic((db) => db.prepare(`INSERT INTO usage_records(attempt_id, model_id, model_calls, tool_calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, estimated_cost_usd, cost_status, pricing_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO UPDATE SET model_id = excluded.model_id, model_calls = excluded.model_calls, tool_calls = excluded.tool_calls,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens, total_tokens = excluded.total_tokens,
      estimated_cost_usd = excluded.estimated_cost_usd, cost_status = excluded.cost_status, pricing_version = excluded.pricing_version, updated_at = excluded.updated_at`)
      .run(input.attemptId, input.modelId, input.modelCalls, input.toolCalls, input.inputTokens, input.outputTokens, input.cacheReadTokens, input.cacheWriteTokens, input.totalTokens,
        input.estimatedCostUsd, input.costStatus, input.pricingVersion, input.updatedAt));
    return this.get(input.attemptId)!;
  }
  get(attemptId: string): UsageRecord | undefined {
    const row = this.context.db.prepare("SELECT * FROM usage_records WHERE attempt_id = ?").get(attemptId) as UsageRow | undefined;
    return row && mapUsage(row);
  }
}

export class IdempotencyRepository {
  constructor(private readonly context: Context) {}
  resolve(input: V2IdempotencyRequest, result: V2IdempotencyResult, createdAt = new Date().toISOString()): IdempotencyResolution {
    parseV2IdempotencyRequest(input);
    parseV2IdempotencyResult(result);
    assertTimestamp(createdAt);
    const resolution = this.context.atomic((db) => {
      const existing = db.prepare(`SELECT request_hash, resource_kind, resource_id FROM idempotency_keys
        WHERE scope = ? AND endpoint = ? AND idempotency_key = ?`).get(input.scope, input.endpoint, input.key) as IdempotencyRow | undefined;
      if (existing) {
        if (existing.request_hash !== input.requestHash) throw new StorageError("conflict", "Idempotency key was already used for a different request");
        return {
          result: { schemaVersion: 2 as const, resourceKind: existing.resource_kind, resourceId: existing.resource_id },
          replayed: true,
        };
      }
      const resourceExists = result.resourceKind === "run"
        ? db.prepare("SELECT 1 FROM runs WHERE id = ?").get(result.resourceId)
        : db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(result.resourceId);
      if (!resourceExists) throw new StorageError("not_found", "Idempotency resource was not found");
      db.prepare(`INSERT INTO idempotency_keys(scope, endpoint, idempotency_key, request_hash, resource_kind, resource_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(input.scope, input.endpoint, input.key, input.requestHash, result.resourceKind, result.resourceId, createdAt);
      return { result, replayed: false };
    });
    return resolution;
  }
}

export class ActiveSlotRepository {
  constructor(private readonly context: Context) {}
  get(): ActiveSlot {
    const row = this.context.db.prepare("SELECT active_run_id, claim_token, generation, worker_boot_id, heartbeat_at, lease_expires_at FROM global_slot WHERE singleton = 1").get() as SlotRow;
    return mapSlot(row);
  }
  claim(input: { runId: string; claimToken: string; workerBootId?: string | null; heartbeatAt?: string; leaseExpiresAt?: string | null; resume?: boolean }): ActiveSlot {
    const heartbeatAt = input.heartbeatAt ?? new Date().toISOString();
    assertId(input.runId, "Run id"); assertId(input.claimToken, "Claim token"); assertTimestamp(heartbeatAt);
    if (input.workerBootId) assertId(input.workerBootId, "Worker boot id");
    if (input.leaseExpiresAt) assertTimestamp(input.leaseExpiresAt);
    const slot = this.context.atomic((db) => {
      const current = db.prepare("SELECT * FROM global_slot WHERE singleton = 1").get() as SlotRow;
      if (current.active_run_id !== null) throw new StorageError("active_task", "Another run already holds the global active slot");
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(input.runId) as { status: string } | undefined;
      if (!run) throw new StorageError("not_found", "Run was not found");
      if (run.status !== "accepted" && !(input.resume && run.status === "interrupted")) throw new StorageError("conflict", "Only an accepted or explicitly resumed interrupted run can claim the active slot");
      const generation = current.generation + 1;
      db.prepare(`UPDATE global_slot SET active_run_id = ?, claim_token = ?, generation = ?, worker_boot_id = ?, heartbeat_at = ?, lease_expires_at = ?
        WHERE singleton = 1 AND active_run_id IS NULL`)
        .run(input.runId, input.claimToken, generation, input.workerBootId ?? null, heartbeatAt, input.leaseExpiresAt ?? null);
      return { runId: input.runId, claimToken: input.claimToken, generation, workerBootId: input.workerBootId ?? null, heartbeatAt, leaseExpiresAt: input.leaseExpiresAt ?? null };
    });
    return slot;
  }
  heartbeat(input: { runId: string; claimToken: string; generation: number; heartbeatAt?: string; leaseExpiresAt?: string | null }): ActiveSlot {
    const heartbeatAt = input.heartbeatAt ?? new Date().toISOString();
    assertId(input.runId, "Run id"); assertId(input.claimToken, "Claim token"); assertTimestamp(heartbeatAt);
    if (input.leaseExpiresAt) assertTimestamp(input.leaseExpiresAt);
    this.context.atomic((db) => {
      const result = db.prepare(`UPDATE global_slot SET heartbeat_at = ?, lease_expires_at = ?
        WHERE singleton = 1 AND active_run_id = ? AND claim_token = ? AND generation = ?`)
        .run(heartbeatAt, input.leaseExpiresAt ?? null, input.runId, input.claimToken, input.generation);
      if (result.changes !== 1) throw new StorageError("conflict", "Active slot claim is stale");
    });
    return this.get();
  }
  release(input: { runId: string; claimToken: string; generation: number }): void {
    assertId(input.runId, "Run id"); assertId(input.claimToken, "Claim token");
    this.context.atomic((db) => {
      const result = db.prepare(`UPDATE global_slot SET active_run_id = NULL, claim_token = NULL, worker_boot_id = NULL,
        heartbeat_at = NULL, lease_expires_at = NULL
        WHERE singleton = 1 AND active_run_id = ? AND claim_token = ? AND generation = ?`)
        .run(input.runId, input.claimToken, input.generation);
      if (result.changes !== 1) throw new StorageError("conflict", "Active slot claim is stale");
    });
  }
}

const RUN_TRANSITIONS: Record<V2RunStatus, readonly V2RunStatus[]> = {
  accepted: ["running", "cancelling", "failed", "cancelled", "interrupted"],
  running: ["cancelling", "completed", "failed", "cancelled", "interrupted"],
  cancelling: ["failed", "cancelled", "interrupted"],
  completed: [], failed: [], cancelled: [], interrupted: ["running"],
};
function isTerminalRunStatus(status: V2RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

type ProjectRow = { id: string; display_name: string; canonical_root: string; directory_identity: string | null; validation_state: ProjectRecord["validationState"]; created_at: string; last_accessed_at: string };
type AttachmentRow = { id: string; conversation_id: string; object_sha256: string; file_name: string; relative_path: string; byte_size: number; media_type: AttachmentRecord["mediaType"]; created_at: string };
type ProjectRulesRow = { project_id: string; source_path: string; source_sha256: string; source_version: string; content: string; accepted_at: string; revoked_at: string | null };
type GarbageRow = { kind: GarbageRecord["kind"]; object_ref: string; attempts: number };
type ConversationRow = { id: string; project_id: string | null; pi_session_id: string | null; title: string; status: ConversationRecord["status"]; created_at: string; updated_at: string };
type MessageRow = { id: string; conversation_id: string; run_id: string | null; sequence: number; role: MessageRecord["role"]; content: string; source: MessageRecord["source"]; extension_id: string | null; attachment_refs_json: string; created_at: string };
type SnapshotRow = { id: string; conversation_id: string; version: number; sdk_version: string; format_version: string; snapshot_json: string; summary: string | null; created_at: string };
type RunRow = { id: string; conversation_id: string; project_id: string | null; extension_id: string | null; status: V2RunStatus; request_hash: string; request_json: string; retry_of_run_id: string | null; created_at: string; updated_at: string; ended_at: string | null };
type AttemptRow = { id: string; run_id: string; attempt_number: number; status: "running" | "completed" | "failed" | "cancelled" | "interrupted"; usage_complete: number; worker_boot_id: string | null; started_at: string; ended_at: string | null; error_json: string | null };
type CheckpointRow = { id: string; run_id: string; attempt_id: string; phase_id: string; input_sha256: string; output_ref: string | null; status: CheckpointRecord["status"]; created_at: string };
type UsageRow = { attempt_id: string; model_id: string | null; model_calls: number; tool_calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; total_tokens: number; estimated_cost_usd: number | null; cost_status: UsageRecord["costStatus"]; pricing_version: string | null; updated_at: string };
type IdempotencyRow = { request_hash: string; resource_kind: "run" | "conversation"; resource_id: string };
type SlotRow = { active_run_id: string | null; claim_token: string | null; generation: number; worker_boot_id: string | null; heartbeat_at: string | null; lease_expires_at: string | null };
type WorkerIdentityRow = { boot_id: string; pid: number; process_start: string; status: WorkerIdentityRecord["status"]; started_at: string; heartbeat_at: string };

function mapProject(row: ProjectRow): ProjectRecord {
  return { id: row.id, displayName: row.display_name, canonicalRoot: row.canonical_root, directoryIdentity: row.directory_identity,
    validationState: row.validation_state, createdAt: row.created_at, lastAccessedAt: row.last_accessed_at };
}
function mapAttachment(row: AttachmentRow): AttachmentRecord {
  return { id: row.id, conversationId: row.conversation_id, objectSha256: row.object_sha256, fileName: row.file_name,
    relativePath: row.relative_path, byteSize: row.byte_size, mediaType: row.media_type, createdAt: row.created_at };
}
function mapProjectRules(row: ProjectRulesRow): ProjectRulesRecord {
  return { projectId: row.project_id, sourcePath: row.source_path, sourceSha256: row.source_sha256,
    sourceVersion: row.source_version, content: row.content, acceptedAt: row.accepted_at, revokedAt: row.revoked_at };
}
function mapConversation(row: ConversationRow): ConversationRecord {
  return { id: row.id, projectId: row.project_id, piSessionId: row.pi_session_id, title: row.title,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapMessage(row: MessageRow): MessageRecord {
  return { id: row.id, conversationId: row.conversation_id, runId: row.run_id, sequence: row.sequence,
    role: row.role, content: row.content, source: row.source, extensionId: row.extension_id,
    attachmentRefs: parseJson(row.attachment_refs_json) as string[], createdAt: row.created_at };
}
function mapSnapshot(row: SnapshotRow): SessionSnapshotRecord {
  return { id: row.id, conversationId: row.conversation_id, version: row.version, sdkVersion: row.sdk_version,
    formatVersion: row.format_version, snapshot: parseJson(row.snapshot_json), summary: row.summary, createdAt: row.created_at };
}
function mapAttempt(row: AttemptRow): RunAttemptRecord {
  return parseV2RunAttempt({ schemaVersion: 2, runId: row.run_id, attemptId: row.id, attemptNumber: row.attempt_number,
    status: row.status, usageComplete: row.usage_complete === 1, ...(row.worker_boot_id ? { workerBootId: row.worker_boot_id } : {}), startedAt: row.started_at,
    endedAt: row.ended_at, ...(row.error_json ? { error: parseJson(row.error_json) } : {}) });
}
function mapCheckpoint(row: CheckpointRow): CheckpointRecord {
  return { id: row.id, runId: row.run_id, attemptId: row.attempt_id, phaseId: row.phase_id,
    inputSha256: row.input_sha256, outputRef: row.output_ref, status: row.status, createdAt: row.created_at };
}
function mapUsage(row: UsageRow): UsageRecord {
  return { attemptId: row.attempt_id, modelId: row.model_id, modelCalls: row.model_calls, toolCalls: row.tool_calls,
    inputTokens: row.input_tokens, outputTokens: row.output_tokens, cacheReadTokens: row.cache_read_tokens, cacheWriteTokens: row.cache_write_tokens, totalTokens: row.total_tokens,
    estimatedCostUsd: row.estimated_cost_usd, costStatus: row.cost_status, pricingVersion: row.pricing_version, updatedAt: row.updated_at };
}
function mapSlot(row: SlotRow): ActiveSlot {
  return { runId: row.active_run_id, claimToken: row.claim_token, generation: row.generation,
    workerBootId: row.worker_boot_id, heartbeatAt: row.heartbeat_at, leaseExpiresAt: row.lease_expires_at };
}
function numberFrom(value: unknown, key: string): number {
  if (!value || typeof value !== "object" || !(key in value) || typeof (value as Record<string, unknown>)[key] !== "number") throw new Error("Invalid SQLite numeric result");
  return (value as Record<string, number>)[key]!;
}

function safeJson(value: unknown): string {
  const normalized = normalizeJson(value, 0);
  const text = JSON.stringify(normalized);
  if (Buffer.byteLength(text) > 1_048_576) throw new StorageError("invalid_input", "JSON payload exceeds the 1 MiB storage limit");
  return text;
}
function normalizeJson(value: unknown, depth: number): JsonValue {
  if (depth > 32) throw new StorageError("invalid_input", "JSON payload is too deeply nested");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertLikelyCredentialFree(value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StorageError("invalid_input", "JSON numbers must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, depth + 1));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new StorageError("invalid_input", "Only plain JSON objects may be stored");
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|authorization|credential|secret)/i.test(key)) {
        throw new StorageError("invalid_input", "Credential-like fields must not be persisted");
      }
      result[key] = normalizeJson(item, depth + 1);
    }
    return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
  }
  throw new StorageError("invalid_input", "Value is not JSON serializable");
}
function parseJson(text: string): JsonValue {
  try { return JSON.parse(text) as JsonValue; } catch { throw new StorageError("conflict", "Stored JSON payload is invalid"); }
}
function assertId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new StorageError("invalid_input", `${label} is invalid`);
}
function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new StorageError("invalid_input", "Timestamp must be canonical UTC ISO-8601");
}
function hashRunRequest(input: CreateRunInput, projectId: string | null, requestJson: string): string {
  const canonical = safeJson({
    conversationId: input.conversationId, projectId, extensionId: input.extensionId ?? null,
    retryOfRunId: input.retryOfRunId ?? null, request: parseJson(requestJson),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
function assertLikelyCredentialFree(text: string): void {
  const highConfidenceSecret = /(?:\bsk-[A-Za-z0-9_-]{20,}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+/-]{24,})/i;
  if (highConfidenceSecret.test(text)) throw new StorageError("invalid_input", "Credential-like content must not be persisted");
}
function translateStorageError(error: unknown): never {
  if (error instanceof StorageError || error instanceof StorageSchemaError || error instanceof StorageMigrationError) throw error;
  const record = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : undefined;
  const code = typeof record?.code === "string" ? record.code : "";
  const message = typeof record?.message === "string" ? record.message : "";
  if (/SQLITE_BUSY|SQLITE_LOCKED/.test(code) || /database (?:is )?(?:busy|locked)|database table is locked/i.test(message)) {
    throw new StorageError("db_busy", "Database is busy; retry the operation later", { cause: error });
  }
  if (/SQLITE_READONLY/.test(code) || /readonly|read-only/i.test(message)) {
    throw new StorageError("db_readonly", "Database is read-only", { cause: error });
  }
  if (/constraint failed|UNIQUE constraint|FOREIGN KEY constraint/i.test(message)) {
    throw new StorageError("conflict", "Storage constraint rejected the operation", { cause: error });
  }
  throw error instanceof Error ? error : new Error("Storage operation failed", { cause: error });
}
