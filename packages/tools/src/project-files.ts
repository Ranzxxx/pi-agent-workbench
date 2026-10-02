import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, link, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const PROJECT_FILE_LIMITS = Object.freeze({
  readBytes: 64 * 1024,
  writeBytes: 64 * 1024,
  searchFiles: 1000,
  searchMatches: 200,
  listEntries: 1000,
  searchTimeMs: 5000,
  resultBytes: 64 * 1024,
});

const EXCLUDED_SEGMENTS = new Set([
  ".git", ".next", ".pi", ".cache", ".turbo", ".venv", "venv", "__pycache__", ".ssh", ".gnupg", ".aws", ".kube", ".docker",
  "node_modules", "vendor", "dist", "build", "coverage", "target", "out", "tmp", "temp",
]);
const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ed25519)|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore|jks|ppk))$/iu;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".mdx", ".json", ".jsonc", ".csv", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".css", ".html", ".xml",
  ".yaml", ".yml", ".toml", ".sql", ".sh", ".log", ".ini", ".properties",
]);

export type ProjectFileChangeKind = "create" | "replace" | "restore" | "remove_created";
export type ProjectFileOperationState = "not_applied" | "conflict" | "uncertain";

export interface ProjectFileVersion {
  token: string;
  sha256: string;
  byteSize: number;
  identity: string;
}

export interface ProjectFileJournal {
  prepare(input: {
    relativePath: string;
    kind: ProjectFileChangeKind;
    preVersion: string | null;
    preHash: string | null;
    preimage: Buffer | null;
    postimage: Buffer | null;
    postHash: string | null;
  }): Promise<{ operationId: string; changesetId: string }>;
  applied(input: { operationId: string; postVersion: string | null; postHash: string | null }): Promise<void>;
  expectPostIdentity(input: { operationId: string; identity: string }): Promise<void>;
  failed(input: { operationId: string; state: ProjectFileOperationState; code: string }): Promise<void>;
}

export interface ProjectFileEntry { path: string; kind: "file" | "directory"; byteSize?: number; }
export interface ProjectFileContents extends ProjectFileVersion { path: string; text: string; }
export interface ProjectFileSearchMatch { path: string; line: number; text: string; }
export interface ProjectFileError extends Error {
  code: "invalid_path" | "excluded_path" | "not_found" | "conflict" | "not_text" | "too_large" | "limit_exceeded" | "io_error";
}

function fail(code: ProjectFileError["code"], message: string): ProjectFileError {
  return Object.assign(new Error(message), { code }) as ProjectFileError;
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function identity(info: { dev: number | bigint; ino: number | bigint }): string { return String(info.dev) + ":" + String(info.ino); }
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}
function safeText(bytes: Buffer): string {
  if (bytes.includes(0)) throw fail("not_text", "目标不是允许的 UTF-8 文本文件。");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw fail("not_text", "目标不是允许的 UTF-8 文本文件。"); }
}
function validateText(text: string): Buffer {
  if (typeof text !== "string" || text.includes("\u0000")) throw fail("not_text", "只允许写入 UTF-8 文本。");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.toString("utf8") !== text) throw fail("not_text", "文本包含无法无损编码的字符。");
  if (bytes.byteLength > PROJECT_FILE_LIMITS.writeBytes) throw fail("too_large", "单个文本文件写入上限为 64 KiB。");
  return bytes;
}
function segmentsOf(relativePath: string): string[] {
  if (typeof relativePath !== "string" || !relativePath || relativePath.length > 1024 || relativePath.startsWith("/") ||
      relativePath.includes("\\") || relativePath.includes(":") || /[\u0000-\u001f\u007f]/u.test(relativePath)) {
    throw fail("invalid_path", "路径必须是安全的项目内相对路径。");
  }
  const segments = relativePath.split("/");
  if (segments.length > 32 || segments.some((part) => !part || part === "." || part === ".." || RESERVED_NAME.test(part))) {
    throw fail("invalid_path", "路径包含无效、越界或保留名称。");
  }
  if (segments.some((part) => EXCLUDED_SEGMENTS.has(part.toLowerCase()))) throw fail("excluded_path", "此路径位于默认排除目录中。");
  if (segments.some((part) => SENSITIVE_FILE.test(part))) throw fail("excluded_path", "此路径可能包含凭据或敏感内容。");
  return segments;
}
function hasTextExtension(name: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()) || name === ".gitignore" || name === ".editorconfig";
}

/** A project-scoped text-only filesystem adapter; callers supply a validated root grant. */
export class ProjectFileAccess {
  private readonly root: string;
  private rootIdentity: string;

  constructor(root: string, expectedRootIdentity?: string | null, private readonly journal?: ProjectFileJournal) {
    if (!path.isAbsolute(root)) throw fail("invalid_path", "项目目录必须是绝对路径。");
    this.root = path.resolve(root);
    this.rootIdentity = expectedRootIdentity ?? "";
  }

  async initialize(): Promise<void> {
    const info = await lstat(this.root).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink() || await realpath(this.root).catch(() => "") !== this.root ||
        (this.rootIdentity && identity(info) !== this.rootIdentity)) {
      throw fail("conflict", "项目目录身份已变化或不再安全；请重新确认项目目录。");
    }
    if (!this.rootIdentity) this.rootIdentity = identity(info);
  }

  async listFiles(relativeDirectory = ""): Promise<{ entries: ProjectFileEntry[]; truncated: boolean }> {
    await this.initialize();
    const base = relativeDirectory ? await this.resolve(relativeDirectory, "directory") : this.root;
    const entries: ProjectFileEntry[] = [];
    let truncated = false;
    const walk = async (directory: string): Promise<void> => {
      const handle = await opendir(directory).catch(() => { throw fail("conflict", "项目目录无法安全读取。"); });
      for await (const dirent of handle) {
        if (entries.length >= PROJECT_FILE_LIMITS.listEntries) { truncated = true; return; }
        const fullPath = path.join(directory, dirent.name);
        const relativePath = path.relative(this.root, fullPath).split(path.sep).join("/");
        try { segmentsOf(relativePath); }
        catch (error) {
          const code = (error as ProjectFileError).code;
          if (code === "excluded_path" || code === "invalid_path") continue;
          throw error;
        }
        const info = await lstat(fullPath).catch(() => undefined);
        if (!info || info.isSymbolicLink() || await realpath(fullPath).catch(() => "") !== fullPath) continue;
        if (info.isDirectory()) {
          entries.push({ path: relativePath, kind: "directory" });
          if (entries.length >= PROJECT_FILE_LIMITS.listEntries) { truncated = true; return; }
          await walk(fullPath);
          if (truncated) return;
        } else if (info.isFile() && info.nlink === 1 && hasTextExtension(dirent.name)) {
          entries.push({ path: relativePath, kind: "file", byteSize: info.size });
          if (entries.length >= PROJECT_FILE_LIMITS.listEntries) { truncated = true; return; }
        }
      }
    };
    await walk(base);
    return { entries, truncated };
  }

  async readFile(relativePath: string): Promise<ProjectFileContents> {
    const { absolute, info } = await this.openRegularFile(relativePath);
    if (info.size > PROJECT_FILE_LIMITS.readBytes) throw fail("too_large", "单个文本文件读取上限为 64 KiB。");
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw fail("conflict", "文件已变化，未读取内容。"); });
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || identity(opened) !== identity(info)) throw fail("conflict", "文件身份已变化，未读取内容。");
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (bytes.byteLength !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
        throw fail("conflict", "文件读取期间发生变化，请重新读取。");
      }
      const text = safeText(bytes);
      const version = this.version(bytes, after);
      return { path: relativePath, text, ...version };
    } finally { await handle.close(); }
  }

  async searchFiles(query: string): Promise<{ matches: ProjectFileSearchMatch[]; scannedFiles: number; skippedFiles: number; truncated: boolean }> {
    if (typeof query !== "string" || !query.trim() || query.length > 256 || query.includes("\u0000")) throw fail("invalid_path", "搜索文本必须为 1 到 256 个字符。");
    const startedAt = Date.now();
    const matches: ProjectFileSearchMatch[] = [];
    let scannedFiles = 0;
    let skippedFiles = 0;
    let truncated = false;
    const needle = query.toLocaleLowerCase();
    const listing = await this.listFiles();
    for (const entry of listing.entries) {
      if (entry.kind !== "file") continue;
      if (scannedFiles >= PROJECT_FILE_LIMITS.searchFiles || Date.now() - startedAt > PROJECT_FILE_LIMITS.searchTimeMs) { truncated = true; break; }
      scannedFiles += 1;
      if ((entry.byteSize ?? PROJECT_FILE_LIMITS.readBytes + 1) > PROJECT_FILE_LIMITS.readBytes) { skippedFiles += 1; truncated = true; continue; }
      let file: ProjectFileContents;
      try { file = await this.readFile(entry.path); } catch { skippedFiles += 1; truncated = true; continue; }
      const lines = file.text.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (line.toLocaleLowerCase().includes(needle)) {
          matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 512) });
          if (matches.length >= PROJECT_FILE_LIMITS.searchMatches) { truncated = true; break; }
        }
      }
      if (truncated) break;
    }
    if (listing.truncated) truncated = true;
    return { matches, scannedFiles, skippedFiles, truncated };
  }

  async createFile(relativePath: string, text: string): Promise<ProjectFileContents> {
    if (!this.journal) throw fail("io_error", "文件写入日志不可用；已拒绝创建。");
    const bytes = validateText(text);
    const absolute = await this.resolve(relativePath, "missing");
    const mutation = await this.journal.prepare({ relativePath, kind: "create", preVersion: null, preHash: null, preimage: null, postimage: bytes, postHash: digest(bytes) });
    return this.write(relativePath, absolute, bytes, mutation, "create");
  }

  async editFile(relativePath: string, expectedVersion: string, text: string): Promise<ProjectFileContents> {
    if (!this.journal) throw fail("io_error", "文件写入日志不可用；已拒绝修改。");
    const current = await this.readFile(relativePath);
    if (!expectedVersion || current.token !== expectedVersion) throw fail("conflict", "文件版本已变化；请重新读取后再修改。");
    const bytes = validateText(text);
    if (Buffer.from(current.text, "utf8").equals(bytes)) return current;
    const mutation = await this.journal.prepare({ relativePath, kind: "replace", preVersion: current.token, preHash: current.sha256, preimage: Buffer.from(current.text, "utf8"), postimage: bytes, postHash: digest(bytes) });
    const absolute = path.join(this.root, ...segmentsOf(relativePath));
    return this.write(relativePath, absolute, bytes, mutation, "replace", current.token, (await lstat(absolute)).mode & 0o777);
  }

  async restoreFile(relativePath: string, expectedVersion: string, text: string): Promise<ProjectFileContents> {
    if (!this.journal) throw fail("io_error", "文件写入日志不可用；已拒绝撤销。");
    const current = await this.readFile(relativePath);
    if (current.token !== expectedVersion) throw fail("conflict", "撤销前文件发生变化，未覆盖当前内容。");
    const bytes = validateText(text);
    const mutation = await this.journal.prepare({ relativePath, kind: "restore", preVersion: current.token, preHash: current.sha256, preimage: Buffer.from(current.text, "utf8"), postimage: bytes, postHash: digest(bytes) });
    const absolute = path.join(this.root, ...segmentsOf(relativePath));
    return this.write(relativePath, absolute, bytes, mutation, "replace", current.token, (await lstat(absolute)).mode & 0o777);
  }

  async removeCreatedFile(relativePath: string, expectedVersion: string): Promise<void> {
    if (!this.journal) throw fail("io_error", "文件写入日志不可用；已拒绝撤销。");
    const current = await this.readFile(relativePath);
    if (current.token !== expectedVersion) throw fail("conflict", "新建文件已被修改，撤销不会删除当前内容。");
    const mutation = await this.journal.prepare({ relativePath, kind: "remove_created", preVersion: current.token, preHash: current.sha256, preimage: Buffer.from(current.text, "utf8"), postimage: null, postHash: null });
    const absolute = path.join(this.root, ...segmentsOf(relativePath));
    try {
      await this.revalidateParent(relativePath);
      const latest = await this.readFile(relativePath);
      if (latest.token !== expectedVersion) throw fail("conflict", "新建文件在撤销前发生变化，未删除。");
      await unlink(absolute);
      await this.syncDirectory(path.dirname(absolute));
      await this.journal.applied({ operationId: mutation.operationId, postVersion: null, postHash: null });
    } catch (error) {
      await this.journal.failed({ operationId: mutation.operationId, state: (error as ProjectFileError).code === "conflict" ? "conflict" : "uncertain", code: (error as ProjectFileError).code ?? "io_error" }).catch(() => undefined);
      throw error;
    }
  }

  async versionOf(relativePath: string): Promise<ProjectFileVersion | null> {
    try { const file = await this.readFile(relativePath); return { token: file.token, sha256: file.sha256, byteSize: file.byteSize, identity: file.identity }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as ProjectFileError).code === "not_found") return null;
      throw error;
    }
  }

  private async write(relativePath: string, absolute: string, bytes: Buffer, mutation: { operationId: string }, mode: "create" | "replace", expectedVersion?: string, fileMode = 0o600): Promise<ProjectFileContents> {
    const parent = path.dirname(absolute);
    const staging = path.join(parent, ".piwb-" + randomUUID() + ".tmp");
    try {
      await this.revalidateParent(relativePath);
      if (mode === "create") {
        if (await lstat(absolute).catch(() => undefined)) throw fail("conflict", "新建目标已存在，未覆盖。");
      } else {
        const current = await this.readFile(relativePath);
        if (current.token !== expectedVersion) throw fail("conflict", "文件版本在写入前发生变化，未覆盖。");
      }
      const stage = await open(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), fileMode & 0o777);
      let stagedIdentity: string;
      try {
        await stage.writeFile(bytes);
        await stage.sync();
        stagedIdentity = identity(await stage.stat());
      } finally { await stage.close(); }
      await this.journal!.expectPostIdentity({ operationId: mutation.operationId, identity: stagedIdentity });
      await this.revalidateParent(relativePath);
      if (mode === "create") {
        await link(staging, absolute).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") throw fail("conflict", "新建目标已被其他程序创建，未覆盖。");
          throw error;
        });
        await unlink(staging);
      } else {
        const current = await this.readFile(relativePath);
        if (current.token !== expectedVersion) throw fail("conflict", "文件版本在提交前发生变化，未覆盖。");
        await rename(staging, absolute);
      }
      await this.syncDirectory(parent);
      const written = await this.readFile(relativePath);
      if (written.identity !== stagedIdentity || written.sha256 !== digest(bytes)) throw fail("conflict", "文件提交后的身份或内容与已记录写入不匹配。");
      await this.journal!.applied({ operationId: mutation.operationId, postVersion: written.token, postHash: written.sha256 });
      return written;
    } catch (error) {
      await unlink(staging).catch(() => undefined);
      const current = await this.versionOf(relativePath).catch(() => null);
      const state = (error as ProjectFileError).code === "conflict" ? "conflict" : current?.sha256 === digest(bytes) ? "uncertain" : "not_applied";
      await this.journal!.failed({ operationId: mutation.operationId, state, code: (error as ProjectFileError).code ?? (error as NodeJS.ErrnoException).code ?? "io_error" }).catch(() => undefined);
      throw error;
    }
  }

  private async openRegularFile(relativePath: string): Promise<{ absolute: string; info: Awaited<ReturnType<typeof lstat>> }> {
    const absolute = await this.resolve(relativePath, "file");
    const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw fail("not_found", "文件不存在。");
      throw fail("io_error", "文件无法读取。");
    });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(absolute).catch(() => "") !== absolute) throw fail("conflict", "目标不是安全的普通文件。");
    if (!hasTextExtension(path.basename(relativePath))) throw fail("not_text", "此文件类型不在允许读取列表中。");
    return { absolute, info };
  }

  private async resolve(relativePath: string, final: "file" | "directory" | "missing"): Promise<string> {
    await this.initialize();
    const segments = segmentsOf(relativePath);
    let current = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]!);
      const isLast = index === segments.length - 1;
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && isLast && final === "missing") return undefined;
        if (error.code === "ENOENT") throw fail("not_found", "项目内路径不存在。");
        throw fail("io_error", "项目内路径无法访问。");
      });
      if (!info) break;
      if (info.isSymbolicLink() || !within(this.root, current) || await realpath(current).catch(() => "") !== current) throw fail("conflict", "路径包含符号链接或已离开项目目录。");
      if (!isLast && !info.isDirectory()) throw fail("not_found", "父路径不是目录。");
      if (isLast && final === "file" && !info.isFile()) throw fail("not_found", "目标不是文件。");
      if (isLast && final === "directory" && !info.isDirectory()) throw fail("not_found", "目标不是目录。");
      if (isLast && final === "missing") throw fail("conflict", "新建目标已存在。");
    }
    return current;
  }

  private async revalidateParent(relativePath: string): Promise<void> {
    const segments = segmentsOf(relativePath);
    const parent = segments.slice(0, -1).join("/");
    if (parent) await this.resolve(parent, "directory");
    else await this.initialize();
  }

  private version(bytes: Buffer, info: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number; ctimeMs: number; mode: number }): ProjectFileVersion {
    const sha256 = digest(bytes);
    const fileIdentity = identity(info);
    const token = "v1:" + sha256 + ":" + fileIdentity + ":" + info.size + ":" + info.mtimeMs + ":" + info.ctimeMs + ":" + info.mode;
    return { token, sha256, byteSize: bytes.byteLength, identity: fileIdentity };
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

export function createProjectFileAccess(root: string, expectedRootIdentity?: string | null, journal?: ProjectFileJournal): ProjectFileAccess {
  return new ProjectFileAccess(root, expectedRootIdentity, journal);
}
