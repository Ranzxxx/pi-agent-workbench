import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchPublicGitHubSnapshot, SnapshotError, type SnapshotErrorCode } from "../src/public-github-snapshot.js";

const sha = "7c318bd1aa4b4affab29761f15a9604323fe2a3b";
function octal(value: number, size: number): string { return value.toString(8).padStart(size - 1, "0") + "\0"; }
function tarEntry(name: string, content: string, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(octal(0o100644, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(Buffer.byteLength(content), 12), 124, 12, "ascii");
  header.write(octal(0, 12), 136, 12, "ascii");
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  const body = Buffer.from(content);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}
function archive(entries: Array<{ name: string; content: string; type?: string }>): Buffer {
  return gzipSync(Buffer.concat([...entries.map(({ name, content, type }) => tarEntry(name, content, type)), Buffer.alloc(1024)]));
}
function paxRecord(key: string, value: string): string {
  const body = key + "=" + value + "\n";
  let length = body.length + 2;
  while (String(length).length + 1 + body.length !== length) length = String(length).length + 1 + body.length;
  return String(length) + " " + body;
}
function response(body: BodyInit | null, url: string, status = 200, headers?: HeadersInit): Response {
  const result = new Response(body, { status, headers });
  Object.defineProperty(result, "url", { value: url });
  return result;
}
function fixtureFetch(contents = archive([
  { name: "slugify-7c318bd/package.json", content: "{\"license\":\"MIT\"}\n" },
  { name: "slugify-7c318bd/index.js", content: "export default true;\n" },
])) {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input); urls.push(url);
    if (url === "https://api.github.com/repos/sindresorhus/slugify") return response(JSON.stringify({ default_branch: "main" }), url);
    if (url.endsWith("/commits/v3.0.0")) return response(JSON.stringify({ sha, commit: { sha } }), url);
    if (url.endsWith("/commits/main")) return response(JSON.stringify({ sha, commit: { sha } }), url);
    if (url.endsWith("/legacy.tar.gz/" + sha)) return response(contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength) as ArrayBuffer, url);
    return response("", url, 404);
  };
  return { fetcher, urls };
}
async function temp(): Promise<string> { return mkdtemp(path.join(os.tmpdir(), "pi-task005-snapshot-")); }
async function assertCode(promise: Promise<unknown>, code: SnapshotErrorCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof SnapshotError && error.code === code);
}

test("strictly parses GitHub repository URLs and refs", async () => {
    const cacheDirectory = await temp();
  try {
    for (const url of ["http://github.com/a/b", "https://github.com.evil/a/b", "https://user@github.com/a/b", "https://github.com/a/b?x=1", "https://github.com/a/b/tree/main", "https://github.com/a//b"]) {
      await assertCode(fetchPublicGitHubSnapshot({ url }, { cacheDirectory, fetch: fixtureFetch().fetcher }), "invalid_repository");
    }
    await assertCode(fetchPublicGitHubSnapshot({ url: "https://github.com/sindresorhus/slugify", ref: "../main" }, { cacheDirectory }), "invalid_repository");
  } finally { await rm(cacheDirectory, { recursive: true, force: true }); }
});

test("resolves the ref to a full SHA before downloading and extracts only bounded regular files", async () => {
  const cacheDirectory = await temp(); const fake = fixtureFetch();
  try {
    const snapshot = await fetchPublicGitHubSnapshot({ url: "https://github.com/sindresorhus/slugify", ref: "v3.0.0" }, { cacheDirectory, fetch: fake.fetcher });
    assert.equal(snapshot.sha, sha);
    assert.equal(snapshot.ref, "v3.0.0");
    assert.equal(snapshot.fileCount, 2);
    assert.match(fake.urls[1]!, /\/commits\/v3\.0\.0$/u);
    assert.ok(fake.urls[2]!.endsWith("/legacy.tar.gz/" + sha));
    assert.equal(await readFile(path.join(snapshot.root, "package.json"), "utf8"), "{\"license\":\"MIT\"}\n");
    assert.equal(await readFile(path.join(snapshot.root, "index.js"), "utf8"), "export default true;\n");
    assert.ok(snapshot.downloadedBytes > 0 && snapshot.expandedBytes > 0);
  } finally { await rm(cacheDirectory, { recursive: true, force: true }); }
});

test("uses the default branch when no ref is supplied", async () => {
  const cacheDirectory = await temp(); const fake = fixtureFetch();
  try {
    const snapshot = await fetchPublicGitHubSnapshot({ url: "https://github.com/sindresorhus/slugify" }, { cacheDirectory, fetch: fake.fetcher });
    assert.equal(snapshot.ref, "main");
    assert.ok(fake.urls[1]!.endsWith("/commits/main"));
  } finally { await rm(cacheDirectory, { recursive: true, force: true }); }
});

test("accepts an explicit full commit SHA without a mutable-ref lookup", async () => {
  const cacheDirectory = await temp(); const fake = fixtureFetch();
  try {
    const snapshot = await fetchPublicGitHubSnapshot({ url: "https://github.com/sindresorhus/slugify", ref: sha }, { cacheDirectory, fetch: fake.fetcher });
    assert.equal(snapshot.sha, sha);
    assert.equal(snapshot.ref, sha);
    assert.equal(fake.urls.length, 1);
    assert.ok(fake.urls[0]!.endsWith("/legacy.tar.gz/" + sha));
  } finally { await rm(cacheDirectory, { recursive: true, force: true }); }
});

test("reuses only an exact validated SHA cache tree and rejects tampering, extra paths, and links", async () => {
  const cacheDirectory = await temp();
  const input = { url: "https://github.com/sindresorhus/slugify", ref: sha };
  try {
    const first = await fetchPublicGitHubSnapshot(input, { cacheDirectory, fetch: fixtureFetch().fetcher });
    const hit = await fetchPublicGitHubSnapshot(input, { cacheDirectory, fetch: fixtureFetch().fetcher });
    assert.equal(hit.root, first.root);
    assert.equal(await readFile(path.join(hit.root, "index.js"), "utf8"), "export default true;\n");

    await writeFile(path.join(first.root, "index.js"), "tampered\n");
    await assertCode(fetchPublicGitHubSnapshot(input, { cacheDirectory, fetch: fixtureFetch().fetcher }), "archive_unsafe");
    await writeFile(path.join(first.root, "index.js"), "export default true;\n");

    await writeFile(path.join(first.root, "unexpected.txt"), "extra\n");
    await assertCode(fetchPublicGitHubSnapshot(input, { cacheDirectory, fetch: fixtureFetch().fetcher }), "archive_unsafe");
    await rm(path.join(first.root, "unexpected.txt"));

    await symlink("index.js", path.join(first.root, "linked.js"));
    await assertCode(fetchPublicGitHubSnapshot(input, { cacheDirectory, fetch: fixtureFetch().fetcher }), "archive_unsafe");
  } finally { await rm(cacheDirectory, { recursive: true, force: true }); }
});

test("accepts only the harmless codeload PAX comment and rejects structural overrides", async () => {
  const cacheDirectory = await temp();
  try {
    const safe = fixtureFetch(archive([
      { name: "pax_global_header", content: paxRecord("comment", sha), type: "g" },
      { name: "slugify-root/package.json", content: "{}\n" },
    ]));
    const snapshot = await fetchPublicGitHubSnapshot({ url: "https://github.com/sindresorhus/slugify", ref: sha }, { cacheDirectory, fetch: safe.fetcher });
    assert.equal(snapshot.fileCount, 1);
    await rm(snapshot.root, { recursive: true, force: true });
    const unsafe = fixtureFetch(archive([
      { name: "pax_global_header", content: paxRecord("path", "../escape"), type: "g" },
      { name: "slugify-root/package.json", content: "{}\n" },
    ]));
    await assertCode(fetchPublicGitHubSnapshot({ url: "https://github.com/sindresorhus/slugify", ref: sha }, { cacheDirectory, fetch: unsafe.fetcher }), "archive_unsafe");
  } finally { await rm(cacheDirectory, { recursive: true, force: true }); }
});

test("classifies missing repo/ref, rate limit, network failure, timeout and redirects without leaking response bodies", async () => {
  const cacheDirectory = await temp();
  try {
    const missingRepo: typeof fetch = async (input) => response("private-repository-name", String(input), 404);
    await assertCode(fetchPublicGitHubSnapshot({ url: "https://github.com/a/b" }, { cacheDirectory, fetch: missingRepo }), "repository_not_found");
    const missingRef: typeof fetch = async (input) => String(input).includes("/commits/") ? response("secret response", String(input), 404) : response("{}", String(input));
    await assertCode(fetchPublicGitHubSnapshot({ url: "https://github.com/a/b", ref: "nope" }, { cacheDirectory, fetch: missingRef }), "ref_not_found");
    const limited: typeof fetch = async (input) => response("", String(input), 403, { "x-ratelimit-remaining": "0" });
    await assertCode(fetchPublicGitHubSnapshot({ url: "https://github.com/a/b" }, { cacheDirectory, fetch: limited }), "rate_limited");
    const network: typeof fetch = async () => { throw new Error("secret-token"); };
    const networkFailure: unknown = await fetchPublicGitHubSnapshot({ url: "https://github.com/a/b" }, { cacheDirectory, fetch: network }).then(
      () => { throw new Error("Expected the network request to fail"); },
      (error: unknown) => error,
    );
    assert.equal(networkFailure instanceof SnapshotError, true);
    assert.equal((networkFailure as SnapshotError).code, "network_error");
    assert.equal((networkFailure as Error).message.includes("secret-token"), false);
    assert.equal((networkFailure as SnapshotError).cause, undefined);
    const queryFailure: unknown = await fetchPublicGitHubSnapshot({ url: "https://github.com/a/b?token=secret-query" }, { cacheDirectory, fetch: network }).then(
      () => { throw new Error("Expected the URL to be rejected"); },
      (error: unknown) => error,
    );
    assert.equal((queryFailure as Error).message.includes("secret-query"), false);
    const redirect: typeof fetch = async (input) => response("", String(input), 302, { location: "https://evil.example/archive" });
    await assertCode(fetchPublicGitHubSnapshot({ url: "https://github.com/a/b" }, { cacheDirectory, fetch: redirect }), "redirect_rejected");
    const timeout = new AbortController(); timeout.abort();
    await assertCode(fetchPublicGitHubSnapshot({ url: "https://github.com/a/b" }, { cacheDirectory, fetch: network, signal: timeout.signal }), "timeout");
    const shaArchive: typeof fetch = async (input) => {
      const url = String(input);
      const stalled = new ReadableStream<Uint8Array>({ start() {} });
      return response(stalled, url);
    };
    await assertCode(fetchPublicGitHubSnapshot({ url: "https://github.com/a/b", ref: sha }, { cacheDirectory, fetch: shaArchive, limits: { timeoutMs: 20 } }), "timeout");
  } finally { await rm(cacheDirectory, { recursive: true, force: true }); }
});

test("rejects archive traversal, links, special entries, file-count, expanded-size and download overages", async () => {
  const cacheDirectory = await temp();
  try {
    const invalid = [
      { data: archive([{ name: "root/../escape", content: "x" }]), limits: {}, code: "archive_unsafe" as const },
      { data: archive([{ name: "root/link", content: "target", type: "2" }]), limits: {}, code: "archive_unsafe" as const },
      { data: archive([{ name: "root/fifo", content: "", type: "6" }]), limits: {}, code: "archive_unsafe" as const },
      { data: archive([{ name: "root/a", content: "a" }, { name: "root/b", content: "b" }]), limits: { maxFiles: 1 }, code: "archive_limit" as const },
      { data: archive([{ name: "root/a/", content: "", type: "5" }, { name: "root/b/", content: "", type: "5" }]), limits: { maxFiles: 1 }, code: "archive_limit" as const },
      { data: archive([{ name: "root/a", content: "x".repeat(1024) }]), limits: { maxExpandedBytes: 700 }, code: "archive_limit" as const },
      { data: archive([{ name: "root/a", content: "x" }]), limits: { maxDownloadBytes: 1 }, code: "download_limit" as const },
    ];
    for (const item of invalid) {
      const fake = fixtureFetch(item.data);
      await assertCode(fetchPublicGitHubSnapshot({ url: "https://github.com/sindresorhus/slugify", ref: "v3.0.0" }, { cacheDirectory, fetch: fake.fetcher, limits: item.limits }), item.code);
      assert.deepEqual((await readdir(cacheDirectory)).filter((name) => name.startsWith(".snapshot-")), []);
    }
  } finally { await rm(cacheDirectory, { recursive: true, force: true }); }
});
