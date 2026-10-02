CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  object_sha256 TEXT NOT NULL CHECK (length(object_sha256) = 64),
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 512),
  relative_path TEXT NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 4096),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 0 AND 20971520),
  media_type TEXT NOT NULL CHECK (media_type = 'text/plain; charset=utf-8'),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX attachments_conversation_created ON attachments(conversation_id, created_at, id);
CREATE INDEX attachments_object_sha256 ON attachments(object_sha256);

CREATE TABLE attachment_objects (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 0 AND 20971520),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE project_rules (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  source_path TEXT NOT NULL CHECK (length(source_path) BETWEEN 1 AND 4096),
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  content TEXT NOT NULL CHECK (length(content) <= 65536),
  accepted_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE TABLE garbage_queue (
  kind TEXT NOT NULL CHECK (kind IN ('attachment_object', 'run_artifacts')),
  object_ref TEXT NOT NULL CHECK (length(object_ref) BETWEEN 1 AND 128),
  queued_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deleting')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 512),
  PRIMARY KEY (kind, object_ref)
) STRICT;
