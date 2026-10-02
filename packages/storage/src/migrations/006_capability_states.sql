CREATE TABLE capability_states (
  capability_id TEXT PRIMARY KEY CHECK (length(capability_id) BETWEEN 1 AND 128),
  api_version TEXT NOT NULL CHECK (length(api_version) BETWEEN 1 AND 32),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  updated_at TEXT NOT NULL
) STRICT;
