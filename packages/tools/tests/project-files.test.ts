import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectFileAccess, type ProjectFileJournal } from "../src/project-files.js";

function journalFixture() {
  let next = 0;
  const calls: string[] = [];
  const journal: ProjectFileJournal = {
    async prepare(input) { calls.push(`prepare:${input.kind}:${input.relativePath}`); next += 1; return { operationId: `operation_${next}`, changesetId: "changeset_test" }; },
    async applied(input) { calls.push(`applied:${input.operationId}`); },
    async expectPostIdentity(input) { calls.push(`identity:${input.operationId}`); },
    async failed(input) { calls.push(`failed:${input.operationId}:${input.state}`); },
  };
  return { journal, calls };
}

test("project files are confined to safe UTF-8 text and edits require the read version", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-project-files-"));
  const root = path.join(parent, "project");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "before\n", "utf8");
  const { journal, calls } = journalFixture();
  const files = createProjectFileAccess(root, undefined, journal);
  try {
    const initial = await files.readFile("src/a.ts");
    assert.equal(initial.text, "before\n");
    const created = await files.createFile("notes.md", "new text\n");
    assert.equal(created.text, "new text\n");
    await assert.rejects(files.createFile("notes.md", "overwrite"), /已存在|变化/u);
    const edited = await files.editFile("src/a.ts", initial.token, "after\n");
    assert.equal(edited.text, "after\n");
    await assert.rejects(files.editFile("src/a.ts", initial.token, "stale overwrite"), /版本已变化/u);
    assert.equal(await readFile(path.join(root, "src", "a.ts"), "utf8"), "after\n");
    const noOp = await files.editFile("src/a.ts", edited.token, "after\n");
    assert.equal(noOp.token, edited.token);
    assert.deepEqual(await files.searchFiles("after"), { matches: [{ path: "src/a.ts", line: 1, text: "after" }], scannedFiles: 2, skippedFiles: 0, truncated: false });
    await files.removeCreatedFile("notes.md", created.token);
    assert.equal(await files.versionOf("notes.md"), null);
    assert.equal(calls.filter((call) => call.startsWith("prepare:")).length, 3);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("path traversal, sensitive paths, symlinks, hard links, binary data, and large files fail closed", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-project-boundary-"));
  const root = path.join(parent, "project");
  const outside = path.join(parent, "outside.txt");
  await mkdir(root);
  await writeFile(outside, "outside", "utf8");
  await writeFile(path.join(root, "hard.md"), "hard", "utf8");
  await link(path.join(root, "hard.md"), path.join(root, "hard-copy.md"));
  await symlink(outside, path.join(root, "link.txt"));
  await writeFile(path.join(root, "binary.txt"), Buffer.from([0xff, 0x00, 0x12]));
  await writeFile(path.join(root, "large.txt"), Buffer.alloc(65_537, 0x61));
  const files = createProjectFileAccess(root);
  try {
    await assert.rejects(files.readFile("../outside.txt"), /路径|无效|越界/u);
    await assert.rejects(files.readFile(".env"), /敏感内容/u);
    await assert.rejects(files.readFile("link.txt"), /符号链接/u);
    await assert.rejects(files.readFile("hard.md"), /普通文件/u);
    await assert.rejects(files.readFile("binary.txt"), /UTF-8/u);
    await assert.rejects(files.readFile("large.txt"), /64 KiB/u);
    assert.equal((await files.listFiles()).entries.some((entry) => entry.path === "link.txt" || entry.path === "hard.md"), false);
    assert.equal(await readFile(outside, "utf8"), "outside");
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("a failed durable prepare prevents any project file write", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-project-journal-"));
  const root = path.join(parent, "project");
  await mkdir(root);
  const journal: ProjectFileJournal = {
    async prepare() { throw new Error("database unavailable"); },
    async applied() { throw new Error("unexpected apply"); },
    async expectPostIdentity() { throw new Error("unexpected identity"); },
    async failed() { throw new Error("unexpected failure callback"); },
  };
  const files = createProjectFileAccess(root, undefined, journal);
  try {
    await assert.rejects(files.createFile("new.md", "content"), /database unavailable/u);
    await assert.rejects(readFile(path.join(root, "new.md")));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("unsupported create types fail before preparing a journal or creating a file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-project-type-"));
  const { journal, calls } = journalFixture();
  const files = createProjectFileAccess(root, undefined, journal);
  try {
    for (const name of ["unsupported.bin", "Dockerfile", "image.png"]) {
      await assert.rejects(files.createFile(name, "valid text"), { code: "not_text" });
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(await readdir(root), []);
    assert.equal((await files.createFile("notes.MD", "allowed")).text, "allowed");
    assert.equal((await files.createFile(".gitignore", "node_modules\n")).text, "node_modules\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("post-commit read and identity failures remain uncertain for both create and replace", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-project-uncertain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mode of ["create", "replace"] as const) {
    for (const code of ["io_error", "conflict"] as const) {
      const name = `${mode}-${code}.txt`;
      const { journal, calls } = journalFixture();
      const files = createProjectFileAccess(root, undefined, journal);
      if (mode === "replace") await writeFile(path.join(root, name), "before");
      const before = mode === "replace" ? await files.readFile(name) : undefined;
      const realRead = files.readFile.bind(files);
      const mock = t.mock.method(files, "readFile", async (file: string) => {
        const result = await realRead(file);
        if (result.text === "after") throw Object.assign(new Error("injected post-commit failure"), { code });
        return result;
      });
      await assert.rejects(mode === "create" ? files.createFile(name, "after") : files.editFile(name, before!.token, "after"), { code });
      mock.mock.restore();
      assert.equal(await readFile(path.join(root, name), "utf8"), "after");
      assert.ok(calls.includes("failed:operation_1:uncertain"));
      assert.ok(!calls.some((call) => call.startsWith("applied:")));
    }
  }
  assert.ok(!(await readdir(root)).some((name) => name.startsWith(".piwb-")), "staging files are cleaned");
});

test("a failed identity journal before commit leaves the original file and records not_applied", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-project-precommit-"));
  const { journal, calls } = journalFixture();
  journal.expectPostIdentity = async () => { throw Object.assign(new Error("identity persistence failed"), { code: "io_error" }); };
  const files = createProjectFileAccess(root, undefined, journal);
  try {
    await writeFile(path.join(root, "notes.md"), "original");
    const before = await files.readFile("notes.md");
    await assert.rejects(files.editFile("notes.md", before.token, "after"), /identity persistence failed/u);
    assert.equal(await readFile(path.join(root, "notes.md"), "utf8"), "original");
    assert.ok(calls.includes("failed:operation_1:not_applied"));
    assert.deepEqual(await readdir(root), ["notes.md"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
