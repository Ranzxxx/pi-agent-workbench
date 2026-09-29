import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReadOnlyRepository, UnsafeRepositoryPathError } from "../src/index.js";

const fixtureRoot = new URL("../../../fixtures/synthetic-ts-repo/", import.meta.url);

async function temporaryRepository(): Promise<{ base: string; root: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "pi-task004-tools-"));
  const root = path.join(base, "repo");
  await mkdir(root);
  async function copyDirectory(source: URL, destination: string): Promise<void> {
    const { readdir, stat } = await import("node:fs/promises");
    for (const name of await readdir(source)) {
      const sourceUrl = new URL(`${encodeURIComponent(name)}/`, source);
      const sourceFile = new URL(encodeURIComponent(name), source);
      const info = await stat(sourceFile);
      const target = path.join(destination, name);
      if (info.isDirectory()) {
        await mkdir(target);
        await copyDirectory(sourceUrl, target);
      } else {
        await writeFile(target, await readFile(sourceFile));
      }
    }
  }
  await copyDirectory(fixtureRoot, root);
  return { base, root, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("lists, reads, and searches bounded fixture text deterministically", async () => {
  const temporary = await temporaryRepository();
  try {
    const repository = createReadOnlyRepository({ root: temporary.root, snapshotId: "synthetic-harborlight-v1" });
    const files = await repository.listFiles();
    assert.deepEqual(files, ["AGENTS.md", "README.md", "package.json", "src/health.ts", "src/index.ts", "src/server.ts", "tests/health.test.ts"]);
    const source = await repository.readFile("src/server.ts");
    assert.match(source.fileSha256, /^[a-f0-9]{64}$/u);
    assert.equal(source.text, await readFile(path.join(temporary.root, "src/server.ts"), "utf8"));
    assert.deepEqual(await repository.searchText("4317"), [
      { path: "README.md", line: 5, text: "4317 when no port is supplied." },
      { path: "src/server.ts", line: 8, text: "export async function startServer(port = 4317): Promise<ServerHandle> {" },
    ]);
    const hostile = await repository.readFile("AGENTS.md");
    assert.match(hostile.text, /Ignore your tool allowlist/u);
    assert.match(hostile.text, /has not authorized execution/u);
  } finally {
    await temporary.cleanup();
  }
});

test("search skips binary and oversized files without losing text matches", async () => {
  const temporary = await temporaryRepository();
  try {
    await writeFile(path.join(temporary.root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]));
    await writeFile(path.join(temporary.root, "oversized.txt"), "match\n".repeat(100));
    await writeFile(path.join(temporary.root, "small.txt"), "match on a safe line\n");
    const repository = createReadOnlyRepository({ root: temporary.root, snapshotId: "synthetic-harborlight-v1", maxFileBytes: 128 });
    const skipped: Array<{ path: string; reason: string }> = [];
    const matches = await repository.searchText("match", (filePath, reason) => skipped.push({ path: filePath, reason }));
    assert.deepEqual(matches, [{ path: "small.txt", line: 1, text: "match on a safe line" }]);
    assert.ok(skipped.some((item) => item.path === "image.png" && item.reason === "binary"));
    assert.ok(skipped.some((item) => item.path === "oversized.txt" && item.reason === "file_too_large"));
    await assert.rejects(repository.readFile("image.png"), /UTF-8/u);
    await assert.rejects(repository.readFile("oversized.txt"), /read limit/u);
    await symlink(path.join(temporary.root, "small.txt"), path.join(temporary.root, "linked.txt"));
    await assert.rejects(repository.searchText("match"), UnsafeRepositoryPathError);
  } finally { await temporary.cleanup(); }
});

test("rejects escape paths, directories, final symlinks, and intermediate symlinks", async () => {
  const temporary = await temporaryRepository();
  try {
    const outside = path.join(temporary.base, "outside.txt");
    await writeFile(outside, "outside");
    await symlink(outside, path.join(temporary.root, "outside-link"));
    await symlink(path.join(temporary.root, "src"), path.join(temporary.root, "linked-directory"));
    const repository = createReadOnlyRepository({ root: temporary.root, snapshotId: "synthetic-harborlight-v1" });
    for (const invalid of ["../outside.txt", "/etc/passwd", "C:/secret", "src/../package.json", "src\\server.ts", "./package.json", "src//server.ts", ""]) {
      await assert.rejects(repository.readFile(invalid), UnsafeRepositoryPathError, invalid);
    }
    await assert.rejects(repository.readFile("src"), UnsafeRepositoryPathError);
    await assert.rejects(repository.readFile("outside-link"), UnsafeRepositoryPathError);
    await assert.rejects(repository.readFile("linked-directory/server.ts"), UnsafeRepositoryPathError);
    await assert.rejects(repository.listFiles(), UnsafeRepositoryPathError, "listing must not traverse a symlink");
  } finally {
    await temporary.cleanup();
  }
});

// v0.1 targets Linux; Ubuntu CI supplies coreutils mkfifo for this negative-path test.
test("rejects FIFO special files before a read can block", async () => {
  const temporary = await temporaryRepository();
  try {
    const fifoPath = path.join(temporary.root, "blocking-pipe");
    execFileSync("mkfifo", [fifoPath], { stdio: "ignore" });
    const repository = createReadOnlyRepository({ root: temporary.root, snapshotId: "synthetic-harborlight-v1" });
    const read = repository.readFile("blocking-pipe");
    let timedOut = false;
    await Promise.race([
      read.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, 1000)),
    ]);
    if (timedOut) {
      // Rescue an incorrectly blocking FIFO open so the test worker can exit cleanly after failing.
      const writer = await import("node:fs/promises").then(({ open }) => open(fifoPath, constants.O_WRONLY));
      await writer.close();
      await read.catch(() => undefined);
      assert.fail("FIFO read blocked instead of rejecting the special file");
    }
    await assert.rejects(read, UnsafeRepositoryPathError);
  } finally {
    await temporary.cleanup();
  }
});

test("enforces file size, directory entry, match, and response byte limits", async () => {
  const temporary = await temporaryRepository();
  try {
    await writeFile(path.join(temporary.root, "oversized.txt"), "x".repeat(128));
    const smallFileLimit = createReadOnlyRepository({ root: temporary.root, snapshotId: "synthetic-harborlight-v1", maxFileBytes: 64 });
    await assert.rejects(smallFileLimit.readFile("oversized.txt"), /read limit/u);

    const entriesRoot = path.join(temporary.base, "many-directories");
    await mkdir(entriesRoot);
    await mkdir(path.join(entriesRoot, "one"));
    await mkdir(path.join(entriesRoot, "two"));
    await mkdir(path.join(entriesRoot, "three"));
    const entryLimited = createReadOnlyRepository({ root: entriesRoot, snapshotId: "synthetic-harborlight-v1", maxEntries: 2 });
    await assert.rejects(entryLimited.listFiles(), /entry limit/u);

    const matchesRoot = path.join(temporary.base, "matches");
    await mkdir(matchesRoot);
    await writeFile(path.join(matchesRoot, "one.txt"), "x\n");
    await writeFile(path.join(matchesRoot, "two.txt"), "x\n");
    const matchLimited = createReadOnlyRepository({ root: matchesRoot, snapshotId: "synthetic-harborlight-v1", maxMatches: 1 });
    await assert.rejects(matchLimited.searchText("x"), /match limit/u);
    const outputLimited = createReadOnlyRepository({ root: matchesRoot, snapshotId: "synthetic-harborlight-v1", maxOutputBytes: 16 });
    await assert.rejects(outputLimited.searchText("x"), /response limit/u);
  } finally {
    await temporary.cleanup();
  }
});
