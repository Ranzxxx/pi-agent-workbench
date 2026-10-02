ALTER TABLE file_operations ADD COLUMN expected_post_identity TEXT
  CHECK (expected_post_identity IS NULL OR length(expected_post_identity) BETWEEN 3 AND 128);
