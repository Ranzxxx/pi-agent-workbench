CREATE TABLE content_objects (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 0 AND 65536),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE file_changesets (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE SET NULL,
  undo_of_changeset_id TEXT REFERENCES file_changesets(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'applied', 'partial', 'conflict', 'undone')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX file_changesets_conversation ON file_changesets(conversation_id, created_at, id);
CREATE INDEX file_changesets_project ON file_changesets(project_id, created_at, id);

CREATE TABLE file_operations (
  id TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL REFERENCES file_changesets(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 1000000),
  relative_path TEXT NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 1024),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create', 'replace', 'restore', 'remove_created')),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'applied', 'not_applied', 'conflict', 'uncertain', 'undone')),
  pre_version TEXT,
  pre_hash TEXT CHECK (pre_hash IS NULL OR (length(pre_hash) = 64 AND pre_hash NOT GLOB '*[^a-f0-9]*')),
  expected_post_hash TEXT CHECK (expected_post_hash IS NULL OR (length(expected_post_hash) = 64 AND expected_post_hash NOT GLOB '*[^a-f0-9]*')),
  post_version TEXT,
  post_hash TEXT CHECK (post_hash IS NULL OR (length(post_hash) = 64 AND post_hash NOT GLOB '*[^a-f0-9]*')),
  backup_sha256 TEXT REFERENCES content_objects(sha256) ON DELETE RESTRICT,
  result_sha256 TEXT REFERENCES content_objects(sha256) ON DELETE RESTRICT,
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(changeset_id, sequence)
) STRICT;
CREATE INDEX file_operations_changeset ON file_operations(changeset_id, sequence);
CREATE INDEX file_operations_path ON file_operations(relative_path, status);
CREATE INDEX file_operations_prepared ON file_operations(status) WHERE status IN ('prepared', 'uncertain');

CREATE TABLE file_object_garbage (
  sha256 TEXT PRIMARY KEY REFERENCES content_objects(sha256) ON DELETE CASCADE,
  queued_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deleting')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 512)
) STRICT;

CREATE TABLE attachment_results (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  source_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  object_sha256 TEXT NOT NULL REFERENCES attachment_objects(sha256) ON DELETE RESTRICT,
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 512),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 0 AND 65536),
  media_type TEXT NOT NULL CHECK (media_type = 'text/plain; charset=utf-8'),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX attachment_results_conversation ON attachment_results(conversation_id, created_at, id);
CREATE INDEX attachment_results_object ON attachment_results(object_sha256);

CREATE TABLE garbage_queue_v3 (
  kind TEXT NOT NULL CHECK (kind IN ('attachment_object', 'run_artifacts')),
  object_ref TEXT NOT NULL CHECK (length(object_ref) BETWEEN 1 AND 128),
  queued_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deleting')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 512),
  PRIMARY KEY (kind, object_ref)
) STRICT;
INSERT INTO garbage_queue_v3(kind, object_ref, queued_at, status, attempts, last_error)
  SELECT kind, object_ref, queued_at, status, attempts, last_error FROM garbage_queue;
DROP TABLE garbage_queue;
CREATE TABLE garbage_queue (
  kind TEXT NOT NULL CHECK (kind IN ('attachment_object', 'run_artifacts', 'file_backup_object')),
  object_ref TEXT NOT NULL CHECK (length(object_ref) BETWEEN 1 AND 128),
  queued_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deleting')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 512),
  PRIMARY KEY (kind, object_ref)
) STRICT;
INSERT INTO garbage_queue(kind, object_ref, queued_at, status, attempts, last_error)
  SELECT kind, object_ref, queued_at, status, attempts, last_error FROM garbage_queue_v3;
DROP TABLE garbage_queue_v3;
