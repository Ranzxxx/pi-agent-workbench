import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat, realpath, readdir, link, unlink, rm } from "node:fs/promises";
import path from "node:path";
import { StorageError, type AttachmentRecord, type ProjectRecord, type ProjectRulesRecord, type Storage } from "@pi-workbench/storage";

const SESSION_MS = 4 * 60 * 60 * 1000;
const TOKEN_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 16;
const MAX_TOKENS_PER_SESSION = 1024;
const MAX_FILES = 100;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_RULE_BYTES = 64 * 1024;
const MAX_SCAN_ENTRIES = 5000;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".mdx", ".json", ".jsonc", ".csv", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".css", ".html", ".xml", ".yaml", ".yml", ".toml", ".sql", ".sh", ".log"]);
const EXCLUDED_SEGMENTS = new Set([".git", ".next", "node_modules", "dist", "build", "coverage", ".pi", ".cache"]);
const SENSITIVE_NAME = /(^|\/)(\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore|jks)|credentials?(?:\..*)?|secrets?(?:\..*)?)$/iu;

interface Session { csrf: string; origin: string; expiresAt: number; tokens: Map<string, Token>; }
type PickerPurpose = "project" | "attachment" | "rules";
interface BaseToken { expiresAt: number; purpose: PickerPurpose; root: string; path: string; relativePath: string; }
interface DirectoryToken extends BaseToken { type: "directory"; identity: string; }
interface FileToken extends BaseToken { type: "file"; identity: string; size: number; mtimeMs: number; }
interface ProjectSelectionToken extends BaseToken { type: "project_selection"; identity: string; }
interface RulesToken extends BaseToken { type: "rules_preview"; identity: string; sourceSha256: string; }
type Token = DirectoryToken | FileToken | ProjectSelectionToken | RulesToken;
type TokenInput = Token extends infer T ? T extends Token ? Omit<T, "expiresAt"> : never : never;
interface AllowedRoot { path: string; label: string; identity: string; }
interface ImportedFile { root: string; path: string; relativePath: string; name: string; size: number; identity?: string; mtimeMs?: number; }
export interface PickerError extends Error { statusCode: number; code: "invalid_request" | "not_found" | "conflict"; }

function fail(code: PickerError["code"], message: string, statusCode = code === "not_found" ? 404 : code === "conflict" ? 409 : 400): PickerError {
  return Object.assign(new Error(message), { code, statusCode }) as PickerError;
}
function identity(info: { dev: number | bigint; ino: number | bigint }): string { return `${info.dev}:${info.ino}`; }
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function inside(root: string, target: string): boolean { const rel = path.relative(root, target); return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); }
function assertPlainName(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || /[\u0000-\u001f]/u.test(name)) throw fail("invalid_request", "文件或目录名称无效。");
}
function tokenId(): string { return randomBytes(24).toString("base64url"); }
function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface PickerSessionStart { sessionId: string; csrfToken: string; expiresAt: string; }
export interface PickerDirectoryView {
  schemaVersion: 2; directoryToken: string; parentToken?: string; displayPath: string; canSelectProject: boolean; truncated: boolean;
  entries: Array<{ name: string; kind: "directory" | "file" | "excluded"; token?: string; byteSize?: number; reason?: string }>;
}
export interface PickerImportResult { attachments: AttachmentRecord[]; skipped: Array<{ path: string; reason: string }>; totalBytes: number; }

/** User-only, process-local picker capabilities. Tokens are short-lived and bound to one cookie session. */
export class ProjectPickerService {
  private readonly sessions = new Map<string, Session>();
  private roots: AllowedRoot[] = [];
  private readonly objectRoot: string;

  constructor(private readonly storage: Storage, private readonly dataDirectory: string, private readonly configuredRoots: string[]) {
    this.objectRoot = path.join(dataDirectory, "objects");
  }

  async initialize(): Promise<void> {
    const defaults = this.configuredRoots.length ? this.configuredRoots : [path.join(process.env.HOME ?? "/", "Projects")];
    const roots: AllowedRoot[] = [];
    for (const configured of defaults) {
      if (!path.isAbsolute(configured)) continue;
      const absolute = path.resolve(configured);
      const info = await lstat(absolute).catch(() => undefined);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      const canonical = await realpath(absolute).catch(() => undefined);
      if (!canonical || canonical !== absolute) continue;
      roots.push({ path: canonical, label: path.basename(canonical) || canonical, identity: identity(info) });
    }
    this.roots = roots.filter((root, index) => roots.findIndex((other) => other.path === root.path) === index);
    await mkdir(this.objectRoot, { recursive: true, mode: 0o700 });
    if (await realpath(this.objectRoot).catch(() => "") !== this.objectRoot) throw fail("conflict", "本地附件对象目录路径不安全。");
    await mkdir(path.join(this.objectRoot, ".staging"), { recursive: true, mode: 0o700 });
    if (await realpath(path.join(this.objectRoot, ".staging")).catch(() => "") !== path.join(this.objectRoot, ".staging")) throw fail("conflict", "本地附件暂存目录路径不安全。");
    this.storage.garbage.resetClaims();
    await this.flushGarbage();
  }

  startSession(origin: string): PickerSessionStart {
    const sessionId = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_MS;
    this.sessions.set(sessionId, { csrf: csrfToken, origin, expiresAt, tokens: new Map() });
    this.pruneSessions();
    return { sessionId, csrfToken, expiresAt: new Date(expiresAt).toISOString() };
  }

  validateSession(sessionId: string | undefined, csrfToken: string | undefined, origin?: string): void {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || session.expiresAt <= Date.now()) {
      if (sessionId) this.sessions.delete(sessionId);
      throw fail("not_found", "本地选择会话已过期，请刷新页面重试。");
    }
    if (!csrfToken || !sameSecret(csrfToken, session.csrf)) throw fail("invalid_request", "本地请求校验失败，请刷新页面重试。");
    if (origin && origin !== session.origin) throw fail("invalid_request", "请求来源与当前工作台不匹配。");
  }

  listRoots(sessionId: string, purpose: "project" | "attachment"): { schemaVersion: 2; roots: Array<{ label: string; token: string }> } {
    const session = this.session(sessionId);
    const roots: Array<{ label: string; token: string }> = [];
    for (const root of this.roots.slice(0, 32)) {
      if (!this.currentDirectory(root.path, root.path, root.identity)) continue;
      roots.push({ label: root.label, token: this.putToken(session, { type: "directory", purpose, root: root.path, path: root.path, relativePath: "", identity: root.identity }) });
    }
    return { schemaVersion: 2, roots };
  }

  async browse(sessionId: string, directoryToken: string, purpose: "project" | "attachment"): Promise<PickerDirectoryView> {
    const session = this.session(sessionId);
    const token = this.getToken<DirectoryToken>(session, directoryToken, "directory");
    if (token.purpose !== purpose) throw fail("invalid_request", "目录凭据用途与当前操作不匹配。");
    if (!await this.currentDirectory(token.root, token.path, token.identity)) throw fail("conflict", "目录已变化或无法访问，请重新打开选择器。");
    const root = this.root(token.root);
    const entries = await readdir(token.path, { withFileTypes: true }).catch(() => { throw fail("conflict", "目录已变化或无法访问，请重新打开选择器。"); });
    const view: PickerDirectoryView = {
      schemaVersion: 2, directoryToken, displayPath: token.path, canSelectProject: token.path !== root.path, truncated: entries.length > 500, entries: [],
    };
    if (token.path !== root.path) {
      const parentPath = path.dirname(token.path);
      const parentInfo = await lstat(parentPath).catch(() => undefined);
      if (parentInfo?.isDirectory() && !parentInfo.isSymbolicLink() && inside(root.path, parentPath)) {
        view.parentToken = this.putToken(session, { type: "directory", purpose, root: root.path, path: parentPath,
          relativePath: path.relative(root.path, parentPath), identity: identity(parentInfo) });
      }
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en")).slice(0, 500)) {
      assertPlainName(entry.name);
      const absolute = path.join(token.path, entry.name);
      const relativePath = path.relative(root.path, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) { view.entries.push({ name: entry.name, kind: "excluded", reason: "symbolic_link" }); continue; }
      if (entry.isDirectory()) {
        if (EXCLUDED_SEGMENTS.has(entry.name.toLowerCase()) || entry.name.startsWith(".")) { view.entries.push({ name: entry.name, kind: "excluded", reason: "excluded_directory" }); continue; }
        const info = await lstat(absolute).catch(() => undefined);
        if (!info?.isDirectory() || info.isSymbolicLink() || await realpath(absolute).catch(() => "") !== absolute) { view.entries.push({ name: entry.name, kind: "excluded", reason: "directory_changed" }); continue; }
        view.entries.push({ name: entry.name, kind: "directory", token: this.putToken(session, { type: "directory", purpose, root: root.path, path: absolute, relativePath, identity: identity(info) }) });
      } else if (entry.isFile()) {
        const info = await lstat(absolute).catch(() => undefined);
        if (!info?.isFile() || info.isSymbolicLink()) { view.entries.push({ name: entry.name, kind: "excluded", reason: "file_changed" }); continue; }
        const reason = this.exclusionReason(relativePath, entry.name);
        if (reason) { view.entries.push({ name: entry.name, kind: "excluded", reason }); continue; }
        view.entries.push({ name: entry.name, kind: "file", byteSize: info.size,
          ...(purpose === "attachment" ? { token: this.putToken(session, { type: "file", purpose, root: root.path, path: absolute, relativePath, identity: identity(info), size: info.size, mtimeMs: info.mtimeMs }) } : {}) });
      }
    }
    return view;
  }

  prepareProjectSelection(sessionId: string, directoryToken: string): { selectionToken: string; displayPath: string } {
    const session = this.session(sessionId);
    const directory = this.getToken<DirectoryToken>(session, directoryToken, "directory");
    if (directory.purpose !== "project") throw fail("invalid_request", "目录凭据用途与项目选择不匹配。");
    if (directory.path === directory.root) throw fail("invalid_request", "请选择允许目录中的具体项目文件夹。");
    if (!this.currentDirectory(directory.root, directory.path, directory.identity)) throw fail("conflict", "目录已变化，请重新打开选择器。");
    const selectionToken = this.putToken(session, { ...directory, type: "project_selection" });
    return { selectionToken, displayPath: directory.path };
  }

  async openProject(sessionId: string, selectionToken: string, displayName?: string): Promise<ProjectRecord> {
    const session = this.session(sessionId);
    const selected = this.getToken<ProjectSelectionToken>(session, selectionToken, "project_selection");
    if (!await this.currentDirectory(selected.root, selected.path, selected.identity)) throw fail("conflict", "项目目录已变化，请重新选择。");
    for (const existing of this.storage.projects.list()) {
      if (existing.canonicalRoot === selected.path) {
        if (existing.directoryIdentity !== selected.identity) this.storage.projects.updateValidation(existing.id, "valid", selected.identity);
        else await this.revalidateProject(existing);
        this.storage.projects.touch(existing.id);
        return this.storage.projects.get(existing.id)!;
      }
      if (inside(existing.canonicalRoot, selected.path) || inside(selected.path, existing.canonicalRoot)) throw fail("conflict", "所选目录与已有项目目录重叠，请选择不重叠的目录。");
    }
    const name = displayName?.trim() || path.basename(selected.path);
    if (!name || name.length > 256) throw fail("invalid_request", "项目名称长度必须为 1 到 256 个字符。");
    try {
      return this.storage.projects.create({ id: randomUUID(), displayName: name, canonicalRoot: selected.path,
        directoryIdentity: selected.identity, validationState: "valid" });
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw fail("conflict", "无法登记该项目目录。");
    }
  }

  async recentProjects(): Promise<ProjectRecord[]> {
    const projects = this.storage.projects.list();
    const result: ProjectRecord[] = [];
    for (const project of projects) {
      const current = await this.revalidateProject(project);
      result.push(current);
    }
    return result;
  }

  async reopenProject(projectId: string): Promise<ProjectRecord> {
    const project = this.storage.projects.get(projectId);
    if (!project) throw fail("not_found", "项目不存在。");
    const current = await this.revalidateProject(project);
    if (current.validationState !== "valid") throw fail("conflict", "项目目录已失效或身份发生变化，请重新选择并确认目录。");
    this.storage.projects.touch(project.id);
    return this.storage.projects.get(project.id)!;
  }

  async previewRules(sessionId: string, projectId: string): Promise<{ previewToken: string; sourcePath: string; content: string; sourceSha256: string; sourceVersion: string }> {
    const session = this.session(sessionId);
    const project = await this.reopenProject(projectId);
    const filePath = path.join(project.canonicalRoot, "AGENTS.md");
    const stat = await lstat(filePath).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_RULE_BYTES || await realpath(filePath).catch(() => "") !== filePath) throw fail("not_found", "项目根目录没有可预览的 AGENTS.md 规则文件。");
    const content = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).then(async (handle) => {
      try { const value = await handle.readFile(); if (value.byteLength > MAX_RULE_BYTES) throw fail("invalid_request", "规则文件超过 64 KiB，未读取。"); return new TextDecoder("utf-8", { fatal: true }).decode(value); }
      finally { await handle.close(); }
    }).catch((error) => { if ((error as PickerError).statusCode) throw error; throw fail("conflict", "规则文件已变化或无法安全读取。"); });
    const sourceSha256 = digest(Buffer.from(content, "utf8"));
    const previewToken = this.putToken(session, { type: "rules_preview", purpose: "rules", root: project.canonicalRoot, path: filePath,
      relativePath: "AGENTS.md", identity: identity(stat), sourceSha256 });
    return { previewToken, sourcePath: "AGENTS.md", content, sourceSha256, sourceVersion: `sha256:${sourceSha256}` };
  }

  async acceptRules(sessionId: string, previewToken: string, projectId: string): Promise<ProjectRulesRecord> {
    const session = this.session(sessionId);
    const token = this.getToken<RulesToken>(session, previewToken, "rules_preview");
    const project = await this.reopenProject(projectId);
    if (token.root !== project.canonicalRoot || token.path !== path.join(project.canonicalRoot, "AGENTS.md")) throw fail("invalid_request", "规则预览与当前项目不匹配。");
    const current = await this.readRulesFile(token.path, token.identity);
    if (digest(current) !== token.sourceSha256) throw fail("conflict", "规则文件在预览后发生变化，请重新预览。");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(current);
    const acceptedAt = new Date().toISOString();
    return this.storage.projectRules.accept({ projectId, sourcePath: "AGENTS.md", sourceSha256: token.sourceSha256,
      sourceVersion: `sha256:${token.sourceSha256}`, content, acceptedAt, revokedAt: null });
  }

  revokeRules(projectId: string): ProjectRulesRecord { return this.storage.projectRules.revoke(projectId); }

  async importAttachments(sessionId: string, conversationId: string, fileTokens: string[], directoryToken?: string): Promise<PickerImportResult> {
    const session = this.session(sessionId);
    if (fileTokens.length > MAX_FILES) throw fail("invalid_request", `一次最多选择 ${MAX_FILES} 个文件。`);
    const selected: ImportedFile[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const fileToken of fileTokens) {
      const token = this.getToken<FileToken>(session, fileToken, "file");
      if (token.purpose !== "attachment") throw fail("invalid_request", "文件凭据用途与附件导入不匹配。");
      selected.push({ root: token.root, path: token.path, relativePath: token.relativePath, name: path.basename(token.path), size: token.size, identity: token.identity, mtimeMs: token.mtimeMs });
    }
    if (directoryToken) {
      const directory = this.getToken<DirectoryToken>(session, directoryToken, "directory");
      if (directory.purpose !== "attachment") throw fail("invalid_request", "目录凭据用途与附件导入不匹配。");
      if (directory.path === directory.root) throw fail("invalid_request", "不能直接导入允许目录的根目录，请先选择其中的具体文件夹。");
      const found = await this.walkDirectory(directory.root, directory.path, directory.identity, skipped);
      for (const file of found) {
        if (selected.length >= MAX_FILES) { skipped.push({ path: file.relativePath, reason: "file_count_limit" }); continue; }
        selected.push(file);
      }
    }
    const candidates: Array<{ file: ImportedFile; bytes: Buffer; sha256: string }> = [];
    let totalBytes = 0;
    for (const file of selected) {
      const reason = this.exclusionReason(file.relativePath, file.name);
      if (reason) { skipped.push({ path: file.relativePath, reason }); continue; }
      if (file.size > MAX_TOTAL_BYTES || totalBytes + file.size > MAX_TOTAL_BYTES) { skipped.push({ path: file.relativePath, reason: "total_size_limit" }); continue; }
      const bytes = await this.readBoundFile(file);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { skipped.push({ path: file.relativePath, reason: "not_utf8_text" }); continue; }
      if (text.includes("\u0000")) { skipped.push({ path: file.relativePath, reason: "binary_content" }); continue; }
      const stableBytes = Buffer.from(text, "utf8");
      if (!stableBytes.equals(bytes)) { skipped.push({ path: file.relativePath, reason: "invalid_text_encoding" }); continue; }
      totalBytes += bytes.byteLength;
      candidates.push({ file, bytes, sha256: digest(bytes) });
    }
    if (!candidates.length) return { attachments: [], skipped: skipped.slice(0, 500), totalBytes: 0 };

    const written: string[] = [];
    try {
      for (const candidate of candidates) { await this.writeObject(candidate.sha256, candidate.bytes); written.push(candidate.sha256); }
      const attachments = this.storage.attachments.addMany(candidates.map(({ file, bytes, sha256 }) => ({
        id: randomUUID(), conversationId, objectSha256: sha256, fileName: file.name, relativePath: file.relativePath,
        byteSize: bytes.byteLength, mediaType: "text/plain; charset=utf-8" as const,
      })));
      return { attachments, skipped: skipped.slice(0, 500), totalBytes };
    } catch (error) {
      for (const sha256 of new Set(written)) if (this.storage.attachments.referenceCount(sha256) === 0) this.storage.garbage.enqueue({ kind: "attachment_object", objectRef: sha256 });
      await this.flushGarbage();
      if ((error as PickerError).statusCode) throw error;
      throw fail("conflict", "附件未能完整保存；没有创建附件记录，请重试。");
    }
  }

  async readAttachment(attachment: AttachmentRecord): Promise<Buffer> {
    const filePath = this.objectPath(attachment.objectSha256);
    const info = await lstat(filePath).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size !== attachment.byteSize || await realpath(filePath).catch(() => "") !== filePath) throw fail("not_found", "附件对象缺失或损坏。");
    const bytes = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).then(async (handle) => { try { return await handle.readFile(); } finally { await handle.close(); } });
    if (digest(bytes) !== attachment.objectSha256) throw fail("not_found", "附件完整性校验失败。");
    return bytes;
  }

  async flushGarbage(): Promise<void> {
    for (const item of this.storage.garbage.list(250)) {
      try {
        if (!this.storage.garbage.claim(item)) continue;
        const target = item.kind === "attachment_object" ? this.objectPath(item.objectRef) : path.join(this.dataDirectory, "runs", item.objectRef);
        if (item.kind === "attachment_object") {
          const parent = path.dirname(target);
          const parentInfo = await lstat(parent).catch(() => undefined);
          if (parentInfo && (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await realpath(parent).catch(() => "") !== parent)) throw new Error("attachment object directory is unsafe");
        }
        if (item.kind === "run_artifacts" && !/^[A-Za-z0-9_-]{1,128}$/u.test(item.objectRef)) throw new Error("invalid run artifact ref");
        if (item.kind === "run_artifacts") {
          const runsRoot = path.join(this.dataDirectory, "runs");
          const runsInfo = await lstat(runsRoot).catch(() => undefined);
          if (runsInfo && (!runsInfo.isDirectory() || runsInfo.isSymbolicLink() || await realpath(runsRoot).catch(() => "") !== runsRoot)) throw new Error("run artifact root is unsafe");
        }
        const info = await lstat(target).catch(() => undefined);
        if (info) {
          if (item.kind === "attachment_object") {
            if (info.isDirectory() && !info.isSymbolicLink()) throw new Error("object path is a directory");
            await unlink(target);
            const parent = path.dirname(target);
            await rm(parent, { recursive: false }).catch(() => undefined);
          } else if (info.isDirectory() && !info.isSymbolicLink()) await rm(target, { recursive: true, force: true });
          else await unlink(target);
        }
        this.storage.garbage.complete(item);
      } catch (error) {
        this.storage.garbage.fail(item, error instanceof Error ? error.message : "cleanup failed");
      }
    }
  }

  private session(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) { if (sessionId) this.sessions.delete(sessionId); throw fail("not_found", "本地选择会话已过期，请刷新页面重试。"); }
    return session;
  }
  private root(rootPath: string): AllowedRoot { const root = this.roots.find((item) => item.path === rootPath); if (!root) throw fail("not_found", "允许的项目目录不可用。"); return root; }
  private putToken(session: Session, data: TokenInput): string {
    const now = Date.now();
    for (const [id, value] of session.tokens) if (value.expiresAt <= now) session.tokens.delete(id);
    const token = tokenId(); session.tokens.set(token, { ...data, expiresAt: Math.min(session.expiresAt, now + TOKEN_MS) } as Token);
    while (session.tokens.size > MAX_TOKENS_PER_SESSION) session.tokens.delete(session.tokens.keys().next().value!);
    return token;
  }
  private getToken<T extends Token>(session: Session, token: string, type: T["type"]): T {
    const value = session.tokens.get(token);
    if (!value || value.expiresAt <= Date.now()) { session.tokens.delete(token); throw fail("not_found", "选择凭据已过期，请重新选择。"); }
    if (value.type !== type) throw fail("invalid_request", "选择凭据类型无效。");
    return value as T;
  }
  private async currentDirectory(root: string, target: string, expectedIdentity: string): Promise<boolean> {
    if (!inside(root, target)) return false;
    const allowed = this.roots.find((item) => item.path === root);
    if (!allowed) return false;
    const rootInfo = await lstat(root).catch(() => undefined);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || identity(rootInfo) !== allowed.identity || await realpath(root).catch(() => "") !== root) return false;
    const info = await lstat(target).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink() || identity(info) !== expectedIdentity) return false;
    return await realpath(target).catch(() => "") === target;
  }
  private async revalidateProject(project: ProjectRecord): Promise<ProjectRecord> {
    const root = this.roots.find((item) => inside(item.path, project.canonicalRoot));
    if (!root) return this.storage.projects.updateValidation(project.id, "needs_review", project.directoryIdentity);
    const info = await lstat(project.canonicalRoot).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink() || await realpath(project.canonicalRoot).catch(() => "") !== project.canonicalRoot) return this.storage.projects.updateValidation(project.id, "missing", project.directoryIdentity);
    const actual = identity(info);
    if (project.directoryIdentity && project.directoryIdentity !== actual) return this.storage.projects.updateValidation(project.id, "needs_review", project.directoryIdentity);
    return this.storage.projects.updateValidation(project.id, "valid", actual);
  }
  private exclusionReason(relativePath: string, name: string): string | undefined {
    const normalized = relativePath.replaceAll("\\", "/");
    if (normalized.split("/").some((part) => EXCLUDED_SEGMENTS.has(part.toLowerCase()))) return "excluded_directory";
    if (SENSITIVE_NAME.test(normalized) || name.startsWith(".env")) return "sensitive_file";
    if (!TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())) return "unsupported_file_type";
    return undefined;
  }
  private async walkDirectory(root: string, directory: string, expectedIdentity: string, skipped: Array<{ path: string; reason: string }>): Promise<ImportedFile[]> {
    if (!await this.currentDirectory(root, directory, expectedIdentity)) throw fail("conflict", "目录在选择后已变化，请重新打开选择器。");
    const results: ImportedFile[] = [];
    const stack = [directory]; let scanned = 0;
    while (stack.length) {
      const current = stack.pop()!;
      const entries = await readdir(current, { withFileTypes: true }).catch(() => { throw fail("conflict", "目录在读取期间发生变化；没有保存附件。"); });
      for (const entry of entries) {
        scanned += 1;
        const absolute = path.join(current, entry.name);
        const relativePath = path.relative(root, absolute).split(path.sep).join("/");
        if (scanned > MAX_SCAN_ENTRIES) { skipped.push({ path: relativePath, reason: "scan_limit" }); return results; }
        if (entry.isSymbolicLink()) { skipped.push({ path: relativePath, reason: "symbolic_link" }); continue; }
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || EXCLUDED_SEGMENTS.has(entry.name.toLowerCase())) { skipped.push({ path: relativePath, reason: "excluded_directory" }); continue; }
          const info = await lstat(absolute).catch(() => undefined);
          if (!info?.isDirectory() || info.isSymbolicLink() || await realpath(absolute).catch(() => "") !== absolute) { skipped.push({ path: relativePath, reason: "directory_changed" }); continue; }
          stack.push(absolute); continue;
        }
        if (!entry.isFile()) continue;
        const reason = this.exclusionReason(relativePath, entry.name);
        if (reason) { skipped.push({ path: relativePath, reason }); continue; }
        const info = await lstat(absolute).catch(() => undefined);
        if (!info?.isFile() || info.isSymbolicLink()) { skipped.push({ path: relativePath, reason: "file_changed" }); continue; }
        if (results.length >= MAX_FILES) { skipped.push({ path: relativePath, reason: "file_count_limit" }); continue; }
        results.push({ root, path: absolute, relativePath, name: entry.name, size: info.size, identity: identity(info), mtimeMs: info.mtimeMs });
      }
    }
    return results;
  }
  private async readBoundFile(file: ImportedFile): Promise<Buffer> {
    if (!inside(file.root, file.path) || !this.root(file.root)) throw fail("invalid_request", "文件选择越界。");
    if (await realpath(file.path).catch(() => "") !== file.path) throw fail("conflict", "所选文件路径已变化；没有保存附件。");
    const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw fail("conflict", "所选文件已变化或无法读取；没有保存附件。"); });
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== file.size || info.size > MAX_TOTAL_BYTES || (file.identity && identity(info) !== file.identity) || (file.mtimeMs !== undefined && info.mtimeMs !== file.mtimeMs)) throw fail("conflict", "所选文件在确认后发生变化；没有保存附件。");
      const bytes = await handle.readFile();
      if (bytes.byteLength !== info.size || bytes.byteLength > MAX_TOTAL_BYTES) throw fail("conflict", "所选文件读取期间发生变化；没有保存附件。");
      return bytes;
    } finally { await handle.close(); }
  }
  private async readRulesFile(filePath: string, expectedIdentity: string): Promise<Buffer> {
    const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw fail("conflict", "规则文件在确认后发生变化。"); });
    try {
      const info = await handle.stat();
      if (!info.isFile() || identity(info) !== expectedIdentity || info.size > MAX_RULE_BYTES) throw fail("conflict", "规则文件在确认后发生变化。");
      return await handle.readFile();
    } finally { await handle.close(); }
  }
  private objectPath(sha256: string): string {
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw fail("invalid_request", "附件引用无效。");
    return path.join(this.objectRoot, sha256.slice(0, 2), sha256);
  }
  private async writeObject(sha256: string, bytes: Buffer): Promise<void> {
    if (digest(bytes) !== sha256) throw fail("conflict", "附件内容校验失败。");
    const destination = this.objectPath(sha256);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (await realpath(path.dirname(destination)).catch(() => "") !== path.dirname(destination)) throw fail("conflict", "本地附件对象目录路径不安全。");
    const staging = path.join(this.objectRoot, ".staging", randomUUID());
    const stagingDirectory = path.dirname(staging);
    if (await realpath(stagingDirectory).catch(() => "") !== stagingDirectory) throw fail("conflict", "本地附件暂存目录路径不安全。");
    const handle = await open(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try {
      await link(staging, destination).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        const existing = await open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const stat = await existing.stat();
          if (!stat.isFile() || stat.size !== bytes.byteLength || digest(await existing.readFile()) !== sha256) throw fail("conflict", "已存在的附件对象校验失败。");
        } finally { await existing.close(); }
      });
      await unlink(staging);
      await this.syncDirectory(path.dirname(destination));
      await this.syncDirectory(stagingDirectory);
    } catch (error) { await unlink(staging).catch(() => undefined); throw error; }
  }
  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  private pruneSessions(): void {
    for (const [id, session] of this.sessions) if (session.expiresAt <= Date.now()) this.sessions.delete(id);
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
  }
}
