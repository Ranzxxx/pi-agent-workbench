CREATE TABLE run_results (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE worker_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  boot_id TEXT NOT NULL,
  pid INTEGER NOT NULL CHECK (pid > 0),
  process_start TEXT NOT NULL CHECK (length(process_start) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'stopping', 'uncertain')),
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
) STRICT;
