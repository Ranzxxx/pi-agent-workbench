import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface StorageMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export class StorageSchemaError extends Error {
  readonly code = "unknown_schema";
  constructor(message: string) { super(message); this.name = "StorageSchemaError"; }
}

export class StorageMigrationError extends Error {
  readonly code = "migration_failed";
  constructor(readonly version: number, cause?: unknown) {
    super(`Storage migration ${version} failed`, { cause });
    this.name = "StorageMigrationError";
  }
}

export function loadCoreMigrations(): readonly StorageMigration[] {
  const core = readFileSync(new URL("./migrations/001_core.sql", import.meta.url), "utf8");
  const worker = readFileSync(new URL("./migrations/002_worker_recovery.sql", import.meta.url), "utf8");
  const projectAttachments = readFileSync(new URL("./migrations/003_project_attachments.sql", import.meta.url), "utf8");
  const fileChanges = readFileSync(new URL("./migrations/004_file_changes.sql", import.meta.url), "utf8");
  const filePostIdentity = readFileSync(new URL("./migrations/005_file_post_identity.sql", import.meta.url), "utf8");
  return [
    { version: 1, name: "core", sql: core },
    { version: 2, name: "worker_recovery", sql: worker },
    { version: 3, name: "project_attachments", sql: projectAttachments },
    { version: 4, name: "file_changes", sql: fileChanges },
    { version: 5, name: "file_post_identity", sql: filePostIdentity },
  ];
}

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

// TASK-013's development database shipped before result_sha256 was added to 004.
// Keep both identities pinned: this is a specific upgrade, never a checksum bypass.
const legacyFileChangesChecksum = "6649247133cebd5f7bc79fa425bfa0e204c6792acf5923f2173ff5008c5b6a64";
const currentFileChangesChecksum = "b8f53ed99693bafb3b8ff07352aadff636e7052d01e52bde1be214bdec06023e";
const resultColumn = "  result_sha256 TEXT REFERENCES content_objects(sha256) ON DELETE RESTRICT,\n";
type AppliedMigration = { version: number; name: string; checksum: string };

function isLegacyFileChanges(record: AppliedMigration, migration: StorageMigration): boolean {
  return record.version === 4 && record.name === "file_changes" && record.checksum === legacyFileChangesChecksum &&
    migration.version === 4 && migration.name === record.name && migrationChecksum(migration.sql) === currentFileChangesChecksum;
}

function assertLegacySchema(db: DatabaseSync, sorted: readonly StorageMigration[], appliedCount: number): void {
  const expected = new DatabaseSync(":memory:");
  try {
    for (const migration of sorted.slice(0, appliedCount)) {
      const sql = migration.version === 4 ? migration.sql.replace(resultColumn, "") : migration.sql;
      if (migration.version === 4 && migrationChecksum(sql) !== legacyFileChangesChecksum) throw new StorageSchemaError("Unknown legacy file migration");
      expected.exec(sql);
    }
    const schema = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name";
    if (JSON.stringify(db.prepare(schema).all()) !== JSON.stringify(expected.prepare(schema).all())) {
      throw new StorageSchemaError("Legacy migration 4 database structure does not match the known schema");
    }
  } finally { expected.close(); }
}

export function applyMigrations(db: DatabaseSync, migrations: readonly StorageMigration[]): void {
  const sorted = validateMigrationList(migrations);
  let applied = readAndValidateAppliedMigrations(db, sorted);

  if (applied.some((record, index) => isLegacyFileChanges(record, sorted[index]!))) {
    begin(db);
    try {
      // Recheck after taking the write lock so another opener cannot race this repair.
      const locked = readAndValidateAppliedMigrations(db, sorted);
      const legacy = locked.find((record, index) => isLegacyFileChanges(record, sorted[index]!));
      if (legacy) {
        db.exec("ALTER TABLE file_operations ADD COLUMN result_sha256 TEXT REFERENCES content_objects(sha256) ON DELETE RESTRICT");
        db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 4 AND name = 'file_changes' AND checksum = ?")
          .run(currentFileChangesChecksum, legacyFileChangesChecksum);
      }
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw new StorageMigrationError(4, error);
    }
    applied = readAndValidateAppliedMigrations(db, sorted);
  }

  for (const migration of sorted.slice(applied.length)) {
    begin(db);
    try {
      db.exec(migration.sql);
      if (!tableExists(db, "schema_migrations")) throw new Error("Migration did not create schema_migrations");
      db.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)")
        .run(migration.version, migration.name, migrationChecksum(migration.sql), new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw new StorageMigrationError(migration.version, error);
    }
  }
}

/** Validate existing migration history without changing the database. Safe to run before write PRAGMAs. */
export function assertMigrationsCompatible(db: DatabaseSync, migrations: readonly StorageMigration[]): void {
  readAndValidateAppliedMigrations(db, validateMigrationList(migrations));
}

export function assertMigrationsCurrent(db: DatabaseSync, migrations: readonly StorageMigration[]): void {
  const sorted = validateMigrationList(migrations);
  if (!tableExists(db, "schema_migrations")) throw new StorageSchemaError("Database schema has not been initialized");
  const applied = db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as Array<{ version: number; name: string; checksum: string }>;
  if (applied.length !== sorted.length) throw new StorageSchemaError("Database schema requires a migration");
  for (let index = 0; index < sorted.length; index += 1) {
    const migration = sorted[index]!;
    const record = applied[index];
    if (!record || record.version !== migration.version || record.name !== migration.name || record.checksum !== migrationChecksum(migration.sql)) {
      throw new StorageSchemaError("Database schema does not match the installed migrations");
    }
  }
}

function validateMigrationList(migrations: readonly StorageMigration[]): StorageMigration[] {
  const sorted = [...migrations].sort((left, right) => left.version - right.version);
  for (let index = 0; index < sorted.length; index += 1) {
    const migration = sorted[index]!;
    if (!Number.isSafeInteger(migration.version) || migration.version !== index + 1 || !/^[a-z0-9_-]{1,64}$/.test(migration.name) || !migration.sql.trim()) {
      throw new TypeError("Storage migrations must have sequential positive versions, safe names, and SQL");
    }
  }
  return sorted;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function readAndValidateAppliedMigrations(db: DatabaseSync, sorted: readonly StorageMigration[]): AppliedMigration[] {
  const applied = tableExists(db, "schema_migrations")
    ? db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as Array<{ version: number; name: string; checksum: string }>
    : [];
  const latestKnown = sorted.at(-1)?.version ?? 0;
  const latestApplied = applied.at(-1)?.version ?? 0;
  if (latestApplied > latestKnown) throw new StorageSchemaError("Database schema is newer than this application");
  for (let index = 0; index < applied.length; index += 1) {
    const record = applied[index]!;
    const migration = sorted[index];
    if (!migration || migration.version !== record.version) throw new StorageSchemaError("Database migration history is incomplete or unknown");
    if ((record.name !== migration.name || record.checksum !== migrationChecksum(migration.sql)) && !isLegacyFileChanges(record, migration)) {
      throw new StorageSchemaError(`Database migration ${record.version} does not match the installed migration`);
    }
  }
  if (applied.some((record, index) => isLegacyFileChanges(record, sorted[index]!))) assertLegacySchema(db, sorted, applied.length);
  return applied;
}

function begin(db: DatabaseSync): void { db.exec("BEGIN IMMEDIATE"); }
function rollback(db: DatabaseSync): void {
  try { if (db.isTransaction) db.exec("ROLLBACK"); } catch { /* Preserve the migration failure. */ }
}
