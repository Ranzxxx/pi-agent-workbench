import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyMigrations, loadCoreMigrations, migrationChecksum, openStorage, StorageMigrationError, StorageSchemaError } from "../src/index.js";

const legacyChecksum = "6649247133cebd5f7bc79fa425bfa0e204c6792acf5923f2173ff5008c5b6a64";
const at = "2026-10-01T00:00:00.000Z";
const backupHash = "a".repeat(64);

function createLegacy(db: DatabaseSync, version = 4): void {
  const migrations = loadCoreMigrations().slice(0, version).map((migration) => migration.version === 4
    ? { ...migration, sql: migration.sql.replace("  result_sha256 TEXT REFERENCES content_objects(sha256) ON DELETE RESTRICT,\n", "") }
    : migration);
  assert.equal(migrationChecksum(migrations[3]!.sql), legacyChecksum, "fixture must reproduce the observed historical SQL exactly");
  applyMigrations(db, migrations);
  db.exec(`
    INSERT INTO projects VALUES ('project', 'Synthetic project', '/tmp/synthetic-project', NULL, 'valid', '${at}', '${at}');
    INSERT INTO conversations VALUES ('conversation', 'project', NULL, 'Preserved conversation', 'active', '${at}', '${at}');
    INSERT INTO messages VALUES ('message', 'conversation', NULL, 1, 'user', 'Preserved message', 'user', NULL, '[]', '${at}');
    INSERT INTO content_objects VALUES ('${backupHash}', 3, '${at}');
    INSERT INTO file_changesets VALUES ('changeset', 'conversation', 'project', NULL, NULL, 'partial', '${at}', '${at}');
    INSERT INTO file_operations(id, changeset_id, sequence, relative_path, operation_kind, status, backup_sha256, created_at, updated_at)
      VALUES ('operation', 'changeset', 1, 'file.txt', 'replace', 'prepared', '${backupHash}', '${at}', '${at}');
  `);
}

for (const version of [4, 5]) {
  test(`known early migration 4 upgrades from schema ${version} without losing history or file backups`, () => {
    const root = mkdtempSync(join(tmpdir(), "pi-legacy-migration-"));
    const path = join(root, "workbench.sqlite");
    try {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA journal_mode=WAL");
      createLegacy(db, version);
      const appliedAt = db.prepare("SELECT applied_at FROM schema_migrations WHERE version = 4").get();
      db.close();
      assert.throws(() => openStorage({ path, readOnly: true }), StorageSchemaError);

      const store = openStorage({ path });
      assert.equal(store.diagnostics.schemaVersion, 6);
      assert.equal(store.projects.list().length, 1);
      assert.equal(store.messages.list("conversation")[0]?.content, "Preserved message");
      const operation = store.fileOperations.list("changeset")[0]!;
      assert.equal(operation.backupSha256, backupHash);
      assert.equal(operation.resultSha256, null);
      assert.equal(operation.expectedPostIdentity, null);
      store.close();

      const verify = new DatabaseSync(path);
      try {
        assert.deepEqual(verify.prepare("SELECT applied_at FROM schema_migrations WHERE version = 4").get(), appliedAt);
        assert.equal(verify.prepare("SELECT checksum FROM schema_migrations WHERE version = 4").get()?.checksum, migrationChecksum(loadCoreMigrations()[3]!.sql));
        assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 5);
        assert.throws(() => verify.prepare("UPDATE file_operations SET result_sha256 = ? WHERE id = 'operation'").run("b".repeat(64)), /FOREIGN KEY/);
        assert.deepEqual(verify.prepare("PRAGMA foreign_key_check").all(), []);
      } finally { verify.close(); }
      openStorage({ path }).close();
      openStorage({ path, readOnly: true }).close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const mutation of ["unknown_checksum", "unexpected_schema"] as const) {
  test(`legacy compatibility refuses ${mutation} without changing database history or journal mode`, () => {
    const root = mkdtempSync(join(tmpdir(), "pi-legacy-refusal-"));
    const path = join(root, "workbench.sqlite");
    try {
      const db = new DatabaseSync(path);
      createLegacy(db);
      if (mutation === "unknown_checksum") db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 4").run("f".repeat(64));
      else db.exec("ALTER TABLE file_operations ADD COLUMN unexpected TEXT");
      const schema = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
      const history = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      db.close();
      assert.throws(() => openStorage({ path }), StorageSchemaError);
      const verify = new DatabaseSync(path, { readOnly: true });
      try {
        assert.deepEqual(verify.prepare("SELECT * FROM sqlite_master ORDER BY name").all(), schema);
        assert.deepEqual(verify.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), history);
        assert.equal(verify.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
      } finally { verify.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("legacy column repair rolls back when updating migration history fails", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createLegacy(db);
    const schema = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    const history = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    db.setAuthorizer((action, table) => action === constants.SQLITE_UPDATE && table === "schema_migrations" ? constants.SQLITE_DENY : constants.SQLITE_OK);
    assert.throws(() => applyMigrations(db, loadCoreMigrations()), StorageMigrationError);
    db.setAuthorizer(null);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all(), schema);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), history);
    assert.equal(db.prepare("SELECT content FROM messages WHERE id = 'message'").get()?.content, "Preserved message");
  } finally { db.close(); }
});
