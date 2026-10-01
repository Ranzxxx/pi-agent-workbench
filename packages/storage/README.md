# `@pi-workbench/storage`

SQLite persistence for the v0.2 workbench foundation. It uses Node.js 24.21.0's built-in `node:sqlite`; it adds no SQLite driver or ORM dependency. All SQL is parameterized and kept inside this package's typed repositories.

## Database location and startup

`openStorage()` uses `PI_WORKBENCH_DATA_DIR` when set, otherwise `$XDG_DATA_HOME/pi-agent-workbench`, otherwise `~/.local/share/pi-agent-workbench`. The default database filename is `workbench.sqlite`. An explicit `path` is useful for isolated tests. The containing directory is created with mode `0700` when it does not exist.

Writable opens enable foreign keys, WAL mode, `synchronous=FULL`, and a 100 ms SQLite busy timeout by default. `busyTimeoutMs` can be set from 1 through 5000 ms; the package does not add unbounded retries. `diagnostics` reports the effective journal/synchronous settings and schema version. Read-only opens verify WAL and the current migration set, then fail instead of migrating.

Numbered migrations record the SHA-256 checksum of their SQL. A failed migration rolls back as a transaction. A newer, incomplete, or checksum-mismatched schema is rejected without an automatic downgrade or repair. SQLite's `quick_check(1)` runs during open. Use the database only on a local filesystem; WAL is not supported as a shared network-filesystem database.

## Persistence boundary

The initial migration contains projects, conversations, visible messages, session snapshots, runs and attempts, ordered run events, checkpoints, usage, idempotency keys, and the singleton active slot. Repositories allocate message/event/snapshot sequence values and claim/release the active slot in short `BEGIN IMMEDIATE` transactions. Run submission can create a run and its idempotency record atomically with `runs.createIdempotent()`.

JSON payloads are limited to 1 MiB and reject credential-like property names and common high-confidence token formats. Message text also rejects common high-confidence token formats. Callers must still keep credentials and hidden reasoning out of persisted user-facing messages and snapshots; arbitrary secrets cannot be detected reliably. No provider credential fields are part of this schema.

## Limits at this stage

All SQLite calls are synchronous and must remain short. Repository transactions do not await model, file, or network work. This package only records the global active-slot claim; a lease expiry or slot row does not prove that an old OS Worker stopped, and it does not itself supervise or recover that process. TASK-011 owns that boundary. WAL/FULL configuration and reopen tests do not prove recovery from power loss, hardware failure, network filesystems, or a corrupted storage device. No backup/restore workflow is implemented here.
