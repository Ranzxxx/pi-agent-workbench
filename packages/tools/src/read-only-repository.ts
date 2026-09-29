import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, readdir } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_MATCHES = 50;
const MAX_PATH_LENGTH = 512;

export class UnsafeRepositoryPathError extends Error {
  constructor() {
    super("Repository paths must be safe, in-root relative paths to regular files or directories");
    this.name = "UnsafeRepositoryPathError";
  }
}

type SkippedSearchReason = "binary" | "file_too_large";
class UnsearchableRepositoryFileError extends Error {
  constructor(message: string, readonly reason: SkippedSearchReason) { super(message); }
}

export interface ReadOnlyRepositoryOptions {
  root: string;
  snapshotId: string;
  maxFileBytes?: number;
  maxOutputBytes?: number;
  maxEntries?: number;
  maxMatches?: number;
}

export interface RepositoryFile {
  path: string;
  text: string;
  fileSha256: string;
  byteLength: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SnapshotFingerprint {
  fileCount: number;
  contentDigestSha256: string;
  syntheticEventSha: string;
}

export interface ReadOnlyRepository {
  readonly snapshotId: string;
  listFiles(relativePath?: string): Promise<string[]>;
  readFile(relativePath: string): Promise<RepositoryFile>;
  searchText(query: string, onSkippedFile?: (path: string, reason: SkippedSearchReason) => void): Promise<SearchMatch[]>;
  fingerprint(): Promise<SnapshotFingerprint>;
}

interface CheckedPath {
  absolutePath: string;
  stat: Awaited<ReturnType<typeof lstat>>;
}

function boundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

/** Validate syntax before any filesystem access, so paths never get normalized into acceptance. */
function validateRelativePath(candidate: string): string[] {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_PATH_LENGTH) throw new UnsafeRepositoryPathError();
  if (candidate.startsWith("/") || candidate.includes("\\") || candidate.includes(":") || /[\u0000-\u001f\u007f]/u.test(candidate)) {
    throw new UnsafeRepositoryPathError();
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw new UnsafeRepositoryPathError();
  return segments;
}

function insideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function utf8(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new UnsearchableRepositoryFileError("Repository file is not valid UTF-8 text", "binary");
  }
}

export function createReadOnlyRepository(options: ReadOnlyRepositoryOptions): ReadOnlyRepository {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(options.snapshotId)) throw new Error("A bounded snapshot ID is required");
  if (!boundedInteger(maxFileBytes, 1024 * 1024) || !boundedInteger(maxOutputBytes, 2 * 1024 * 1024)) throw new Error("Invalid repository byte limits");
  if (!boundedInteger(maxEntries, 10_000) || !boundedInteger(maxMatches, 1_000)) throw new Error("Invalid repository result limits");

  const configuredRoot = path.resolve(options.root);
  let rootPromise: Promise<string> | undefined;
  async function getRoot(): Promise<string> {
    rootPromise ??= (async () => {
      const entry = await lstat(configuredRoot);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new UnsafeRepositoryPathError();
      const resolved = await realpath(configuredRoot);
      if (resolved !== configuredRoot) throw new UnsafeRepositoryPathError();
      return resolved;
    })();
    return rootPromise;
  }

  async function inspect(relativePath: string, expected: "file" | "directory" | "either"): Promise<CheckedPath> {
    const segments = validateRelativePath(relativePath);
    const root = await getRoot();
    let current = root;
    let currentStat: Awaited<ReturnType<typeof lstat>> | undefined;
    for (let index = 0; index < segments.length; index++) {
      current = path.join(current, segments[index]!);
      if (!insideRoot(root, current)) throw new UnsafeRepositoryPathError();
      currentStat = await lstat(current);
      if (currentStat.isSymbolicLink()) throw new UnsafeRepositoryPathError();
      const isFinal = index === segments.length - 1;
      if (!isFinal && !currentStat.isDirectory()) throw new UnsafeRepositoryPathError();
      if (isFinal && expected === "file" && !currentStat.isFile()) throw new UnsafeRepositoryPathError();
      if (isFinal && expected === "directory" && !currentStat.isDirectory()) throw new UnsafeRepositoryPathError();
      if (isFinal && expected === "either" && !currentStat.isDirectory() && !currentStat.isFile()) throw new UnsafeRepositoryPathError();
    }
    if (!currentStat) throw new UnsafeRepositoryPathError();
    const resolved = await realpath(current);
    if (!insideRoot(root, resolved) || resolved !== current) throw new UnsafeRepositoryPathError();
    return { absolutePath: current, stat: currentStat };
  }

  async function readChecked(relativePath: string): Promise<RepositoryFile> {
    const checked = await inspect(relativePath, "file");
    if (checked.stat.size > maxFileBytes) throw new UnsearchableRepositoryFileError("Repository file exceeds the read limit", "file_too_large");
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const nonBlock = constants.O_NONBLOCK ?? 0;
    const handle = await open(checked.absolutePath, constants.O_RDONLY | noFollow | nonBlock);
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.dev !== checked.stat.dev || openedStat.ino !== checked.stat.ino) throw new UnsafeRepositoryPathError();
      if (openedStat.size > maxFileBytes) throw new UnsearchableRepositoryFileError("Repository file exceeds the read limit", "file_too_large");
      const chunks: Buffer[] = [];
      let total = 0;
      let position = 0;
      while (total <= maxFileBytes) {
        const chunk = Buffer.alloc(Math.min(8192, maxFileBytes + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
        position += bytesRead;
      }
      if (total > maxFileBytes) throw new UnsearchableRepositoryFileError("Repository file exceeds the read limit", "file_too_large");
      const bytes = Buffer.concat(chunks, total);
      const text = utf8(bytes);
      if (Buffer.byteLength(text, "utf8") > maxOutputBytes) throw new UnsearchableRepositoryFileError("Repository tool output exceeds the response limit", "file_too_large");
      return { path: relativePath, text, fileSha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length };
    } finally {
      await handle.close();
    }
  }

  async function listFiles(relativePath?: string): Promise<string[]> {
    const root = await getRoot();
    let start = root;
    let base = "";
    if (relativePath !== undefined) {
      const checked = await inspect(relativePath, "directory");
      start = checked.absolutePath;
      base = relativePath;
    }
    const files: string[] = [];
    let visitedEntries = 0;
    async function walk(directory: string, relativeDirectory: string): Promise<void> {
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const child of children) {
        visitedEntries++;
        if (visitedEntries > maxEntries) throw new Error("Repository listing exceeds the entry limit");
        const childRelative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
        const safeSegments = validateRelativePath(childRelative);
        const childAbsolute = path.join(directory, child.name);
        if (!insideRoot(root, childAbsolute)) throw new UnsafeRepositoryPathError();
        const childStat = await lstat(childAbsolute);
        if (childStat.isSymbolicLink()) throw new UnsafeRepositoryPathError();
        if (childStat.isDirectory()) {
          if (await realpath(childAbsolute) !== childAbsolute) throw new UnsafeRepositoryPathError();
          await walk(childAbsolute, childRelative);
        } else if (childStat.isFile()) {
          files.push(safeSegments.join("/"));
        } else {
          throw new UnsafeRepositoryPathError();
        }
      }
    }
    await walk(start, base);
    const bytes = Buffer.byteLength(JSON.stringify(files), "utf8");
    if (bytes > maxOutputBytes) throw new Error("Repository tool output exceeds the response limit");
    return files;
  }

  async function searchText(query: string, onSkippedFile?: (path: string, reason: SkippedSearchReason) => void): Promise<SearchMatch[]> {
    if (typeof query !== "string" || query.length === 0 || query.length > 256 || /[\u0000-\u001f\u007f]/u.test(query)) {
      throw new Error("Search query must be a bounded non-empty text string");
    }
    const matches: SearchMatch[] = [];
    for (const relativePath of await listFiles()) {
      let file: RepositoryFile;
      try { file = await readChecked(relativePath); }
      catch (error) {
        // Only content-format/size failures are skippable. Unsafe paths, links,
        // special files, and I/O errors must still fail the entire search.
        if (!(error instanceof UnsearchableRepositoryFileError)) throw error;
        onSkippedFile?.(relativePath, error.reason);
        continue;
      }
      const lines = file.text.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        if (!line.toLowerCase().includes(query.toLowerCase())) continue;
        matches.push({ path: relativePath, line: index + 1, text: line });
        if (matches.length > maxMatches) throw new Error("Repository search exceeds the match limit");
      }
    }
    if (Buffer.byteLength(JSON.stringify(matches), "utf8") > maxOutputBytes) throw new Error("Repository tool output exceeds the response limit");
    return matches;
  }

  async function fingerprint(): Promise<SnapshotFingerprint> {
    const files = (await listFiles()).sort();
    const contentDigest = createHash("sha256");
    const eventSha = createHash("sha1");
    for (const relativePath of files) {
      const file = await readChecked(relativePath);
      const record = `${relativePath}\0${file.fileSha256}\n`;
      contentDigest.update(record, "utf8");
      eventSha.update(record, "utf8");
    }
    return { fileCount: files.length, contentDigestSha256: contentDigest.digest("hex"), syntheticEventSha: eventSha.digest("hex") };
  }

  return { snapshotId: options.snapshotId, listFiles, readFile: readChecked, searchText, fingerprint };
}
