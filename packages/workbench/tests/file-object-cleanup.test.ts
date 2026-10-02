import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openStorage } from "@pi-workbench/storage";
import { ProjectPickerService } from "../src/project-picker.js";
import { sha256 } from "../src/managed-object-store.js";

test("file backup cleanup refuses unexpected directories without deleting their contents", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-workbench-file-cleanup-"));
  const dataDirectory = path.join(parent, "state");
  const storage = openStorage({ dataDirectory: { dataDirectory } });
  const picker = new ProjectPickerService(storage, dataDirectory, []);
  try {
    await picker.initialize();
    const bytes = Buffer.from("expected backup");
    const digest = sha256(bytes);
    storage.contentObjects.register({ sha256: digest, byteSize: bytes.byteLength, createdAt: new Date().toISOString() });
    storage.garbage.enqueue({ kind: "file_backup_object", objectRef: digest });

    const target = path.join(dataDirectory, "file-objects", digest.slice(0, 2), digest);
    await mkdir(target, { recursive: true });
    const marker = path.join(target, "preserve-me.txt");
    await writeFile(marker, "not a managed backup object", "utf8");

    await picker.flushGarbage();

    assert.equal(await readFile(marker, "utf8"), "not a managed backup object");
    assert.equal(storage.contentObjects.get(digest)?.byteSize, bytes.byteLength);
    assert.equal(storage.garbage.list().some((item) => item.kind === "file_backup_object" && item.objectRef === digest), true);
  } finally {
    storage.close();
    await rm(parent, { recursive: true, force: true });
  }
});
