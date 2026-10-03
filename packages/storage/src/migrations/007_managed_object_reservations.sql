CREATE TABLE managed_object_reservations (
  reservation_id TEXT PRIMARY KEY,
  area TEXT NOT NULL CHECK (area IN ('objects', 'file-objects')),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 0 AND 20971520),
  owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
  owner_start TEXT NOT NULL CHECK (length(owner_start) BETWEEN 1 AND 64),
  owner_boot_id TEXT NOT NULL CHECK (length(owner_boot_id) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL,
  stale_marked_at TEXT,
  UNIQUE (area, sha256)
) STRICT;
CREATE INDEX managed_object_reservations_owner ON managed_object_reservations(owner_pid, owner_boot_id, owner_start);

ALTER TABLE garbage_queue ADD COLUMN claim_pid INTEGER CHECK (claim_pid IS NULL OR claim_pid > 0);
ALTER TABLE garbage_queue ADD COLUMN claim_start TEXT CHECK (claim_start IS NULL OR length(claim_start) BETWEEN 1 AND 64);
ALTER TABLE garbage_queue ADD COLUMN claim_boot_id TEXT CHECK (claim_boot_id IS NULL OR length(claim_boot_id) BETWEEN 1 AND 64);

ALTER TABLE file_object_garbage ADD COLUMN claim_pid INTEGER CHECK (claim_pid IS NULL OR claim_pid > 0);
ALTER TABLE file_object_garbage ADD COLUMN claim_start TEXT CHECK (claim_start IS NULL OR length(claim_start) BETWEEN 1 AND 64);
ALTER TABLE file_object_garbage ADD COLUMN claim_boot_id TEXT CHECK (claim_boot_id IS NULL OR length(claim_boot_id) BETWEEN 1 AND 64);
