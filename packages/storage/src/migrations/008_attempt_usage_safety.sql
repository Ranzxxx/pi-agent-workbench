CREATE TABLE attempt_execution_safety (
  attempt_id TEXT PRIMARY KEY REFERENCES run_attempts(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('unknown', 'in_flight', 'safe')),
  checkpoint_kind TEXT CHECK (checkpoint_kind IN ('pre_call', 'conversation_turn', 'workflow_stage')),
  checkpoint_id TEXT,
  snapshot_id TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'safe' AND checkpoint_kind IS NOT NULL) OR
    (state IN ('unknown', 'in_flight') AND checkpoint_kind IS NULL AND checkpoint_id IS NULL AND snapshot_id IS NULL))
) STRICT;

INSERT INTO attempt_execution_safety(attempt_id, state, checkpoint_kind, checkpoint_id, snapshot_id, updated_at)
SELECT id, 'unknown', NULL, NULL, NULL, started_at FROM run_attempts;

CREATE TRIGGER attempt_execution_safety_default AFTER INSERT ON run_attempts
BEGIN
  INSERT INTO attempt_execution_safety(attempt_id, state, checkpoint_kind, checkpoint_id, snapshot_id, updated_at)
  VALUES (NEW.id, 'unknown', NULL, NULL, NULL, NEW.started_at);
END;
