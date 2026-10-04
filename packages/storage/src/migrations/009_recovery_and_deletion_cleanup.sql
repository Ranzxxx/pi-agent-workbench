CREATE TABLE completed_conversation_results (
  attempt_id TEXT PRIMARY KEY REFERENCES run_attempts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  request_sha256 TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES session_snapshots(id) ON DELETE CASCADE,
  snapshot_sha256 TEXT NOT NULL,
  usage_sha256 TEXT NOT NULL,
  result_json TEXT NOT NULL,
  result_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE deletion_cleanup (
  conversation_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
) STRICT;

CREATE TABLE deletion_cleanup_items (
  conversation_id TEXT NOT NULL REFERENCES deletion_cleanup(conversation_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('attachment_object', 'file_backup_object', 'run_artifacts')),
  object_ref TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  PRIMARY KEY (conversation_id, kind, object_ref)
) STRICT;
