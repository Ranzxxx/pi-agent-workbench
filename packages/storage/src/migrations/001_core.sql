CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
  canonical_root TEXT NOT NULL UNIQUE CHECK (length(canonical_root) BETWEEN 1 AND 4096),
  directory_identity TEXT,
  validation_state TEXT NOT NULL CHECK (validation_state IN ('valid', 'missing', 'needs_review')),
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
) STRICT;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  pi_session_id TEXT UNIQUE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'recovery_required')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX conversations_project_updated ON conversations(project_id, updated_at DESC);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  extension_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted')),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  retry_of_run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (id, conversation_id)
) STRICT;
CREATE INDEX runs_conversation_created ON runs(conversation_id, created_at DESC);
CREATE INDEX runs_status_created ON runs(status, created_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'capability')),
  content TEXT NOT NULL CHECK (length(content) <= 65536),
  source TEXT NOT NULL CHECK (source IN ('user', 'agent', 'extension', 'system')),
  extension_id TEXT,
  attachment_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attachment_refs_json)),
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, sequence),
  FOREIGN KEY (run_id, conversation_id) REFERENCES runs(id, conversation_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX messages_conversation_sequence ON messages(conversation_id, sequence);

CREATE TABLE session_snapshots (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  sdk_version TEXT NOT NULL CHECK (length(sdk_version) BETWEEN 1 AND 128),
  format_version TEXT NOT NULL CHECK (length(format_version) BETWEEN 1 AND 128),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  summary TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, version)
) STRICT;

CREATE TABLE run_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
  usage_complete INTEGER NOT NULL DEFAULT 0 CHECK (usage_complete IN (0, 1)),
  worker_boot_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  UNIQUE (run_id, attempt_number),
  UNIQUE (run_id, id),
  CHECK ((status = 'running' AND ended_at IS NULL) OR (status <> 'running' AND ended_at IS NOT NULL)),
  CHECK (error_json IS NULL OR status = 'failed')
) STRICT;
CREATE INDEX attempts_run_number ON run_attempts(run_id, attempt_number);

CREATE TABLE run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, sequence),
  FOREIGN KEY (run_id, attempt_id) REFERENCES run_attempts(run_id, id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX run_events_attempt_sequence ON run_events(attempt_id, sequence);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE RESTRICT,
  phase_id TEXT NOT NULL CHECK (length(phase_id) BETWEEN 1 AND 128),
  input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
  output_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'interrupted')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id, attempt_id) REFERENCES run_attempts(run_id, id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX checkpoints_run_created ON checkpoints(run_id, created_at);

CREATE TABLE usage_records (
  attempt_id TEXT PRIMARY KEY REFERENCES run_attempts(id) ON DELETE RESTRICT,
  model_id TEXT,
  model_calls INTEGER NOT NULL CHECK (model_calls >= 0),
  tool_calls INTEGER NOT NULL CHECK (tool_calls >= 0),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
  total_tokens INTEGER NOT NULL CHECK (total_tokens = input_tokens + output_tokens + cache_read_tokens + cache_write_tokens),
  estimated_cost_usd REAL CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  cost_status TEXT NOT NULL CHECK (cost_status IN ('unknown', 'estimate', 'known')),
  pricing_version TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((cost_status = 'unknown' AND estimated_cost_usd IS NULL) OR
    (cost_status IN ('estimate', 'known') AND estimated_cost_usd IS NOT NULL))
) STRICT;

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 128),
  endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 128),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('run', 'conversation')),
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, endpoint, idempotency_key)
) STRICT;

CREATE TABLE global_slot (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
  claim_token TEXT UNIQUE,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  worker_boot_id TEXT,
  heartbeat_at TEXT,
  lease_expires_at TEXT,
  CHECK ((active_run_id IS NULL AND claim_token IS NULL) OR (active_run_id IS NOT NULL AND claim_token IS NOT NULL))
) STRICT;
INSERT INTO global_slot(singleton, active_run_id, claim_token, generation, worker_boot_id, heartbeat_at, lease_expires_at)
VALUES (1, NULL, NULL, 0, NULL, NULL, NULL);
