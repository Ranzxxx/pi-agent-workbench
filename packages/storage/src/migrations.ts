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
  return [
    { version: 1, name: "core", sql: core },
    { version: 2, name: "worker_recovery", sql: worker },
    { version: 3, name: "project_attachments", sql: projectAttachments },
  ];
}

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export function applyMigrations(db: DatabaseSync, migrations: readonly StorageMigration[]): void {
  const sorted = validateMigrationList(migrations);
  const applied = readAndValidateAppliedMigrations(db, sorted);

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

function readAndValidateAppliedMigrations(db: DatabaseSync, sorted: readonly StorageMigration[]): Array<{ version: number; name: string; checksum: string }> {
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
    if (record.name !== migration.name || record.checksum !== migrationChecksum(migration.sql)) {
      throw new StorageSchemaError(`Database migration ${record.version} does not match the installed migration`);
    }
  }
  return applied;
}

function begin(db: DatabaseSync): void { db.exec("BEGIN IMMEDIATE"); }
function rollback(db: DatabaseSync): void {
  try { if (db.isTransaction) db.exec("ROLLBACK"); } catch { /* Preserve the migration failure. */ }
}
