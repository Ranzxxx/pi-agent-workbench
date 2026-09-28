import { createGunzip } from "node:zlib";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type SnapshotErrorCode = "invalid_repository" | "repository_not_found" | "ref_not_found" | "rate_limited" | "network_error" | "timeout" | "redirect_rejected" | "http_error" | "download_limit" | "archive_invalid" | "archive_unsafe" | "archive_limit";

/** Safe-to-report failure; messages deliberately exclude URLs, response bodies and credentials. */
export class SnapshotError extends Error {
  constructor(readonly code: SnapshotErrorCode, message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

export interface PublicRepositoryInput {
  url: string;
  ref?: string;
}

export interface SnapshotLimits {
  maxDownloadBytes: number;
  maxExpandedBytes: number;
  maxFiles: number;
  timeoutMs: number;
}

export interface SnapshotInfo {
  owner: string;
  repo: string;
  canonicalUrl: string;
  ref: string;
  sha: string;
  root: string;
  downloadedBytes: number;
  expandedBytes: number;
  fileCount: number;
}

export interface SnapshotOptions {
  cacheDirectory: string;
  /** Optional token for GitHub API metadata/ref requests only; never sent to codeload. */
  githubToken?: string;
  fetch?: typeof fetch;
  limits?: Partial<SnapshotLimits>;
  signal?: AbortSignal;
}

const defaultLimits: SnapshotLimits = { maxDownloadBytes: 20 * 1024 * 1024, maxExpandedBytes: 100 * 1024 * 1024, maxFiles: 5000, timeoutMs: 30_000 };
const shaPattern = /^[a-f0-9]{40}$/u;
const ownerRepoPattern = /^[A-Za-z0-9_.-]{1,100}$/u;

function parseRepository(input: PublicRepositoryInput): { owner: string; repo: string; ref: string } {
  if (!input || typeof input.url !== "string") throw new SnapshotError("invalid_repository", "Repository URL is invalid");
  let parsed: URL;
  try { parsed = new URL(input.url); } catch { throw new SnapshotError("invalid_repository", "Repository URL is invalid"); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new SnapshotError("invalid_repository", "Only public github.com HTTPS repository URLs are accepted");
  }
  const parts = parsed.pathname.slice(1).split("/");
  if (parts.at(-1) === "") parts.pop();
  if (parts.length !== 2 || !ownerRepoPattern.test(parts[0]!) || !ownerRepoPattern.test(parts[1]!)) {
    throw new SnapshotError("invalid_repository", "Repository URL must identify exactly one owner and repository");
  }
  const repo = parts[1]!.replace(/\.git$/u, "");
  if (!repo || repo === "." || repo === "..") throw new SnapshotError("invalid_repository", "Repository URL is invalid");
  const ref = input.ref ?? "HEAD";
  if (typeof ref !== "string" || ref.length < 1 || ref.length > 256 || ref.startsWith("-") || /[\u0000-\u0020\u007f~^:?*[\\]/u.test(ref) || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".lock")) {
    throw new SnapshotError("invalid_repository", "Git ref is invalid");
  }
  return { owner: parts[0]!, repo, ref };
}

function safeResponseUrl(response: Response, expectedHosts: string[]): void {
  let actual: URL;
  try { actual = new URL(response.url); } catch { throw new SnapshotError("redirect_rejected", "GitHub returned a response from an untrusted URL"); }
  if (actual.protocol !== "https:" || !expectedHosts.includes(actual.hostname) || actual.username || actual.password || actual.port) {
    throw new SnapshotError("redirect_rejected", "GitHub response used an untrusted redirect target");
  }
}

async function fetchChecked(fetcher: typeof fetch, url: string, hosts: string[], signal: AbortSignal, githubToken?: string): Promise<Response> {
  if (signal.aborted) throw new SnapshotError("timeout", "GitHub snapshot request timed out");
  let response: Response;
  const headers = new Headers({ accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "pi-agent-workbench" });
  if (hosts.includes("api.github.com") && githubToken) headers.set("authorization", `Bearer ${githubToken}`);
  try { response = await fetcher(url, { redirect: "manual", signal, headers }); }
  catch {
    const code = signal.aborted ? "timeout" : "network_error";
    throw new SnapshotError(code, code === "timeout" ? "GitHub snapshot request timed out" : "GitHub snapshot request failed");
  }
  safeResponseUrl(response, hosts);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new SnapshotError("redirect_rejected", "GitHub redirects are not followed");
  }
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0" || response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    throw new SnapshotError("rate_limited", "GitHub rate limit was reached");
  }
  return response;
}

async function json(response: Response, code: SnapshotErrorCode): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) throw new SnapshotError(code, code === "repository_not_found" ? "Public GitHub repository was not found" : "Git ref was not found");
    if (response.status >= 500) throw new SnapshotError("http_error", "GitHub API returned a server error");
    if (response.status === 403 || response.status === 429) throw new SnapshotError("rate_limited", "GitHub rate limit or access restriction was reached");
    throw new SnapshotError("http_error", "GitHub API request failed");
  }
  try {
    const value: unknown = await response.json();
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* sanitized below */ }
  throw new SnapshotError("http_error", "GitHub API returned an invalid response");
}

function fieldText(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }

interface ExtractStats { compressed: number; expanded: number; files: number; entries: number }

/** Incremental reader over gunzip output; payload bytes are never accumulated as a whole archive. */
class ChunkReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private chunks: Buffer[] = [];
  private available = 0;
  private ended = false;
  constructor(stream: Readable) { this.iterator = stream[Symbol.asyncIterator](); }
  private async fill(minimum: number): Promise<void> {
    while (this.available < minimum && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) this.ended = true;
      else { this.chunks.push(Buffer.from(next.value)); this.available += next.value.length; }
    }
  }
  async readExact(size: number): Promise<Buffer | undefined> {
    await this.fill(size);
    if (this.available === 0 && this.ended) return undefined;
    if (this.available < size) throw new SnapshotError("archive_invalid", "GitHub archive ended unexpectedly");
    const result = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const head = this.chunks[0]!;
      const count = Math.min(head.length, size - offset);
      head.copy(result, offset, 0, count);
      offset += count; this.available -= count;
      if (count === head.length) this.chunks.shift(); else this.chunks[0] = head.subarray(count);
    }
    return result;
  }
  async readAvailable(maximum: number): Promise<Buffer | undefined> {
    await this.fill(1);
    if (!this.available) return undefined;
    const size = Math.min(this.available, maximum);
    const result = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const head = this.chunks[0]!;
      const count = Math.min(head.length, size - offset);
      head.copy(result, offset, 0, count);
      offset += count; this.available -= count;
      if (count === head.length) this.chunks.shift(); else this.chunks[0] = head.subarray(count);
    }
    return result;
  }
  async copyTo(handle: Awaited<ReturnType<typeof open>>, size: number, stats: ExtractStats, maxExpanded: number): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      await this.fill(1);
      if (!this.available) throw new SnapshotError("archive_invalid", "GitHub archive ended inside a file");
      const head = this.chunks[0]!;
      const count = Math.min(head.length, remaining);
      stats.expanded += count;
      if (stats.expanded > maxExpanded) throw new SnapshotError("archive_limit", "Expanded GitHub archive exceeds the configured limit");
      await handle.write(head, 0, count);
      remaining -= count; this.available -= count;
      if (count === head.length) this.chunks.shift(); else this.chunks[0] = head.subarray(count);
    }
  }
  async discard(size: number): Promise<void> {
    let remaining = size;
    while (remaining > 0) { const chunk = await this.readExact(Math.min(remaining, 64 * 1024)); if (!chunk) throw new SnapshotError("archive_invalid", "GitHub archive ended unexpectedly"); remaining -= chunk.length; }
  }
}

function tarString(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start);
  return block.toString("utf8", start, end < 0 || end >= start + length ? start + length : end);
}

function tarOctal(block: Buffer, start: number, length: number): number {
  const raw = block.toString("ascii", start, start + length).replace(/\0.*$/u, "").trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/u.test(raw)) throw new SnapshotError("archive_invalid", "GitHub archive contains an invalid tar header");
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value)) throw new SnapshotError("archive_limit", "GitHub archive entry is too large");
  return value;
}

function validateGlobalPaxMetadata(metadata: Buffer, expectedSha: string): void {
  let offset = 0;
  while (offset < metadata.length) {
    const space = metadata.indexOf(0x20, offset);
    if (space < 0) throw new SnapshotError("archive_invalid", "GitHub archive has malformed PAX metadata");
    const lengthText = metadata.toString("ascii", offset, space);
    if (!/^[1-9][0-9]{0,5}$/u.test(lengthText)) throw new SnapshotError("archive_invalid", "GitHub archive has malformed PAX metadata");
    const recordLength = Number(lengthText);
    const end = offset + recordLength;
    if (!Number.isSafeInteger(recordLength) || end > metadata.length || recordLength <= space - offset + 2 || metadata[end - 1] !== 0x0a) {
      throw new SnapshotError("archive_invalid", "GitHub archive has malformed PAX metadata");
    }
    const record = metadata.toString("utf8", space + 1, end - 1);
    const separator = record.indexOf("=");
    if (separator <= 0) throw new SnapshotError("archive_invalid", "GitHub archive has malformed PAX metadata");
    const key = record.slice(0, separator);
    const value = record.slice(separator + 1);
    // Codeload's comment is informational. Reject path, linkpath, size and all unknown global overrides.
    if (key !== "comment" || value !== expectedSha) throw new SnapshotError("archive_unsafe", "GitHub archive has unsupported global PAX metadata");
    offset = end;
  }
}

function archivePath(header: Buffer): { prefix: string; relative: string; type: string; size: number } {
  const name = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  const raw = prefix ? `${prefix}/${name}` : name;
  const normalized = raw.replace(/\/$/u, "");
  const components = normalized.split("/");
  // Strip exactly the single top-level GitHub archive directory.
  if (components.length < 1 || !components[0] || components.some((part) => !part || part === "." || part === "..") || normalized.startsWith("/") || normalized.includes("\\") || /^[A-Za-z]:/u.test(normalized) || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new SnapshotError("archive_unsafe", "GitHub archive contains an unsafe path");
  }
  const relative = components.slice(1).join("/");
  return { prefix: components[0]!, relative, type: String.fromCharCode(header[156] ?? 0), size: tarOctal(header, 124, 12) };
}

async function extractTarGzip(body: ReadableStream<Uint8Array>, destination: string, limits: SnapshotLimits, stats: ExtractStats, signal: AbortSignal, expectedSha: string): Promise<void> {
  const source = Readable.from((async function* () {
    const reader = body.getReader();
    const cancelOnAbort = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", cancelOnAbort, { once: true });
    try {
      while (true) {
      if (signal.aborted) throw new SnapshotError("timeout", "GitHub snapshot request timed out");
      const next = await reader.read();
      if (signal.aborted) throw new SnapshotError("timeout", "GitHub snapshot request timed out");
      if (next.done) break;
        stats.compressed += next.value.byteLength;
        if (stats.compressed > limits.maxDownloadBytes) throw new SnapshotError("download_limit", "GitHub archive exceeds the download limit");
        yield Buffer.from(next.value);
      }
    } finally { signal.removeEventListener("abort", cancelOnAbort); reader.releaseLock(); }
  })());
  const gunzip = createGunzip();
  const decompressed = new PassThrough();
  const decompression = pipeline(source, gunzip, decompressed);
  void decompression.catch(() => {});
  const reader = new ChunkReader(decompressed);
  let sawEnd = false;
  let archivePrefix: string | undefined;
  const created = new Set<string>();
  try {
    while (true) {
      if (signal.aborted) throw new SnapshotError("timeout", "GitHub snapshot request timed out");
      const header = await reader.readExact(512);
      if (!header) break;
      if (header.every((byte) => byte === 0)) { sawEnd = true; break; }
      stats.expanded += header.length;
      if (stats.expanded > limits.maxExpandedBytes) throw new SnapshotError("archive_limit", "Expanded GitHub archive exceeds the configured limit");
      const checksumExpected = tarOctal(header, 148, 8);
      let checksum = 0;
      for (let i = 0; i < header.length; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
      if (checksum !== checksumExpected) throw new SnapshotError("archive_invalid", "GitHub archive tar checksum is invalid");
      const headerType = String.fromCharCode(header[156] ?? 0);
      if (headerType === "g") {
        // GitHub codeload emits a commit SHA comment. Structural PAX overrides are rejected.
        const metadataBytes = tarOctal(header, 124, 12);
        if (metadataBytes > 64 * 1024 || stats.expanded + metadataBytes > limits.maxExpandedBytes) throw new SnapshotError("archive_limit", "GitHub archive metadata exceeds the configured limit");
        const metadata = metadataBytes ? await reader.readExact(metadataBytes) : Buffer.alloc(0);
        if (!metadata) throw new SnapshotError("archive_invalid", "GitHub archive metadata is truncated");
        validateGlobalPaxMetadata(metadata, expectedSha);
        stats.expanded += metadataBytes;
        const padding = (512 - (metadataBytes % 512)) % 512;
        if (padding) {
          if (stats.expanded + padding > limits.maxExpandedBytes) throw new SnapshotError("archive_limit", "Expanded GitHub archive exceeds the configured limit");
          await reader.discard(padding); stats.expanded += padding;
        }
        continue;
      }
      const entry = archivePath(header);
      archivePrefix ??= entry.prefix;
      if (archivePrefix !== entry.prefix) throw new SnapshotError("archive_unsafe", "GitHub archive has multiple root directories");
      const type = entry.type === "\0" ? "0" : entry.type;
      if (type !== "0" && type !== "5") throw new SnapshotError("archive_unsafe", "GitHub archive contains a link or special file");
      if (type === "5" && entry.size !== 0) throw new SnapshotError("archive_invalid", "GitHub archive directory entry has a payload");
      if (!entry.relative) {
        if (type !== "5") throw new SnapshotError("archive_unsafe", "GitHub archive root entry is not a directory");
        continue;
      }
      const target = path.resolve(destination, entry.relative);
      const relative = path.relative(destination, target);
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new SnapshotError("archive_unsafe", "GitHub archive path escapes the snapshot root");
      for (let parent = path.dirname(target); parent !== destination && parent.startsWith(`${destination}${path.sep}`); parent = path.dirname(parent)) await mkdir(parent, { recursive: true });
      const mode = tarOctal(header, 100, 8);
      if (mode & 0o6000) throw new SnapshotError("archive_unsafe", "GitHub archive contains a privileged file mode");
      stats.entries++;
      if (stats.entries > limits.maxFiles) throw new SnapshotError("archive_limit", "GitHub archive contains too many entries");
      if (type === "5") {
        await mkdir(target, { recursive: true, mode: 0o700 });
      } else {
        if (created.has(entry.relative)) throw new SnapshotError("archive_unsafe", "GitHub archive contains duplicate file paths");
        created.add(entry.relative);
        stats.files++;
        if (stats.files > limits.maxFiles) throw new SnapshotError("archive_limit", "GitHub archive contains too many files");
        if (stats.expanded + entry.size > limits.maxExpandedBytes) throw new SnapshotError("archive_limit", "Expanded GitHub archive exceeds the configured limit");
        const file = await open(target, "wx", 0o600);
        try { await reader.copyTo(file, entry.size, stats, limits.maxExpandedBytes); } finally { await file.close(); }
      }
      const padding = (512 - (entry.size % 512)) % 512;
      if (padding) {
        stats.expanded += padding;
        if (stats.expanded > limits.maxExpandedBytes) throw new SnapshotError("archive_limit", "Expanded GitHub archive exceeds the configured limit");
        await reader.discard(padding);
      }
    }
    if (!sawEnd) throw new SnapshotError("archive_invalid", "GitHub archive is missing its end marker");
    // Drain the gzip stream after the tar terminator so corruption and decompression bombs cannot hide in its tail.
    while (true) {
      const tail = await reader.readAvailable(64 * 1024);
      if (!tail) break;
      stats.expanded += tail.length;
      if (stats.expanded > limits.maxExpandedBytes) throw new SnapshotError("archive_limit", "Expanded GitHub archive exceeds the configured limit");
      if (tail.some((byte) => byte !== 0)) throw new SnapshotError("archive_invalid", "GitHub archive has data after its end marker");
    }
    await decompression;
  } catch (error) {
    decompressed.destroy();
    await decompression.catch(() => undefined);
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError("archive_invalid", "GitHub archive could not be safely unpacked");
  }
}

function validateLimits(overrides: Partial<SnapshotLimits> = {}): SnapshotLimits {
  const limits = { ...defaultLimits, ...overrides };
  if (![limits.maxDownloadBytes, limits.maxExpandedBytes, limits.maxFiles, limits.timeoutMs].every((x) => Number.isSafeInteger(x) && x > 0)) throw new SnapshotError("invalid_repository", "Snapshot limits must be positive bounded integers");
  if (limits.maxDownloadBytes > 1024 ** 3 || limits.maxExpandedBytes > 2 * 1024 ** 3 || limits.maxFiles > 100_000 || limits.timeoutMs > 3_600_000) throw new SnapshotError("invalid_repository", "Snapshot limits exceed the supported maximum");
  return limits;
}

async function ensureDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  await mkdir(absolute, { recursive: true });
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(absolute) !== absolute) throw new SnapshotError("invalid_repository", "Snapshot cache must be a real directory");
  return absolute;
}

/** Reuse a SHA cache entry only when its complete tree exactly matches a freshly validated archive. */
async function assertCacheMatchesStage(cacheRoot: string, stageRoot: string, limits: SnapshotLimits): Promise<void> {
  type Entry = { kind: "directory" } | { kind: "file"; content: Buffer };
  async function collect(root: string): Promise<Map<string, Entry>> {
    const entries = new Map<string, Entry>();
    let totalBytes = 0;
    async function visit(directory: string, prefix = ""): Promise<void> {
      for (const item of await readdir(directory)) {
        const relative = prefix ? `${prefix}/${item}` : item;
        const absolute = path.join(directory, item);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw new SnapshotError("archive_unsafe", "Snapshot cache contains a symbolic link");
        if (info.isDirectory()) entries.set(relative, { kind: "directory" });
        else if (info.isFile()) {
          totalBytes += info.size;
          if (totalBytes > limits.maxExpandedBytes) throw new SnapshotError("archive_unsafe", "Snapshot cache exceeds the configured size limit");
          entries.set(relative, { kind: "file", content: await readFile(absolute) });
        } else throw new SnapshotError("archive_unsafe", "Snapshot cache contains a special file");
        if (entries.size > limits.maxFiles) throw new SnapshotError("archive_unsafe", "Snapshot cache contains too many entries");
        if (info.isDirectory()) await visit(absolute, relative);
      }
    }
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new SnapshotError("archive_unsafe", "Snapshot cache entry is not a real directory");
    await visit(root);
    return entries;
  }

  const [cached, validated] = await Promise.all([collect(cacheRoot), collect(stageRoot)]);
  if (cached.size !== validated.size) throw new SnapshotError("archive_unsafe", "Snapshot cache does not match the validated archive");
  for (const [relative, expected] of validated) {
    const actual = cached.get(relative);
    if (!actual || actual.kind !== expected.kind || (actual.kind === "file" && expected.kind === "file" && !actual.content.equals(expected.content))) {
      throw new SnapshotError("archive_unsafe", "Snapshot cache does not match the validated archive");
    }
  }
}

/** Resolve a ref first, then fetch and incrementally unpack only the archive for its immutable SHA. */
export async function fetchPublicGitHubSnapshot(input: PublicRepositoryInput, options: SnapshotOptions): Promise<SnapshotInfo> {
  const identity = parseRepository(input);
  const limits = validateLimits(options.limits);
  const fetcher = options.fetch ?? fetch;
  const githubToken = options.githubToken?.trim();
  if (githubToken && (githubToken.length > 512 || /[\u0000-\u0020\u007f]/u.test(githubToken))) {
    throw new SnapshotError("http_error", "Optional GitHub API token is invalid");
  }
  const cache = await ensureDirectory(options.cacheDirectory);
  const canonicalUrl = `https://github.com/${identity.owner}/${identity.repo}`;
  const stats: ExtractStats = { compressed: 0, expanded: 0, files: 0, entries: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const relayAbort = () => controller.abort();
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const signal = controller.signal;
  let stage: string | undefined;
  try {
    stage = await mkdtemp(path.join(cache, ".snapshot-"));
    let resolvedRef = identity.ref;
    let sha = identity.ref;
    if (!shaPattern.test(identity.ref)) {
      const apiRoot = `https://api.github.com/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}`;
      const repository = await json(await fetchChecked(fetcher, apiRoot, ["api.github.com"], signal, githubToken), "repository_not_found");
      resolvedRef = identity.ref === "HEAD" ? fieldText(repository.default_branch) ?? "" : identity.ref;
      if (!resolvedRef) throw new SnapshotError("http_error", "GitHub repository did not report its default branch");
      const commitUrl = `${apiRoot}/commits/${encodeURIComponent(resolvedRef)}`;
      const commit = await json(await fetchChecked(fetcher, commitUrl, ["api.github.com"], signal, githubToken), "ref_not_found");
      sha = fieldText((commit.commit as Record<string, unknown> | undefined)?.sha) ?? fieldText(commit.sha) ?? "";
      if (!shaPattern.test(sha)) throw new SnapshotError("http_error", "GitHub did not return a full commit SHA");
    }
    const archiveUrl = `https://codeload.github.com/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}/legacy.tar.gz/${sha}`;
    const archive = await fetchChecked(fetcher, archiveUrl, ["codeload.github.com"], signal);
    if (!archive.ok || !archive.body) {
      if (archive.status === 404) throw new SnapshotError("repository_not_found", "Pinned GitHub archive was not found");
      if (archive.status === 429) throw new SnapshotError("rate_limited", "GitHub rate limit was reached");
      throw new SnapshotError("http_error", "GitHub archive request failed");
    }
    await extractTarGzip(archive.body, stage, limits, stats, signal, sha);
    const target = path.join(cache, sha);
    const existing = await lstat(target).then(() => true, () => false);
    if (existing) {
      await assertCacheMatchesStage(target, stage, limits);
      await rm(stage, { recursive: true, force: true });
    } else await rename(stage, target);
    return { ...identity, ref: resolvedRef, canonicalUrl, sha, root: target, downloadedBytes: stats.compressed, expandedBytes: stats.expanded, fileCount: stats.files };
  } catch (error) {
    if (stage) await rm(stage, { recursive: true, force: true });
    if (error instanceof SnapshotError) throw error;
    if (signal.aborted) throw new SnapshotError("timeout", "GitHub snapshot request timed out");
    throw new SnapshotError("archive_invalid", "GitHub snapshot could not be safely unpacked");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", relayAbort);
  }
}
