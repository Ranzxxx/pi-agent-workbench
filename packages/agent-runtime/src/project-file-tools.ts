import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export interface ProjectFileToolsAccess {
  listFiles(path?: string): Promise<unknown>;
  readFile(path: string): Promise<{ path: string; text: string; token: string; sha256: string; byteSize: number; identity: string }>;
  searchFiles(query: string): Promise<unknown>;
  createFile(path: string, text: string): Promise<unknown>;
  editFile(path: string, version: string, text: string): Promise<unknown>;
}

export interface AttachmentToolsAccess {
  listAttachments(): Promise<unknown>;
  readAttachment(attachmentId: string, startChar: number, maxChars: number): Promise<unknown>;
  saveTextResult(input: { fileName: string; text: string; sourceAttachmentId?: string }): Promise<unknown>;
}

const OUTPUT_LIMIT_BYTES = 60 * 1024;
function isHighSurrogate(codeUnit: number): boolean { return codeUnit >= 0xd800 && codeUnit <= 0xdbff; }
function isLowSurrogate(codeUnit: number): boolean { return codeUnit >= 0xdc00 && codeUnit <= 0xdfff; }
function prefixLengthAtBoundary(text: string, requestedLength: number): number {
  let length = Math.max(0, Math.min(text.length, requestedLength));
  if (length > 0 && length < text.length && isHighSurrogate(text.charCodeAt(length - 1)) && isLowSurrogate(text.charCodeAt(length))) length--;
  return length;
}
function assertPageBoundary(text: string, index: number): void {
  if (index > 0 && index < text.length && isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index))) {
    throw new Error("分页游标不能位于 Unicode 字符内部。");
  }
}
function pageEnd(text: string, start: number, maxChars: number): number {
  let end = Math.min(text.length, start + maxChars);
  if (end > start && end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
    end = end - start === 1 ? end + 1 : end - 1;
  }
  return end;
}

function output(value: unknown) {
  let encoded = JSON.stringify(value) ?? "null";
  if (Buffer.byteLength(encoded, "utf8") > OUTPUT_LIMIT_BYTES) {
    if (typeof value === "object" && value !== null && Array.isArray((value as { matches?: unknown }).matches)) {
      const source = value as { matches: unknown[]; [key: string]: unknown };
      let count = source.matches.length;
      do {
        count = Math.floor(count / 2);
        encoded = JSON.stringify({ ...source, matches: source.matches.slice(0, count), truncated: true, omittedMatches: source.matches.length - count });
      } while (count > 0 && Buffer.byteLength(encoded, "utf8") > OUTPUT_LIMIT_BYTES);
    } else if (typeof value === "object" && value !== null && typeof (value as { text?: unknown }).text === "string") {
      const source = value as { text: string; startChar?: unknown; nextChar?: unknown; [key: string]: unknown };
      const hasPageCursor = Number.isSafeInteger(source.startChar) && Number.isSafeInteger(source.nextChar) &&
        (source.nextChar as number) - (source.startChar as number) === source.text.length;
      let length = source.text.length;
      do {
        length = prefixLengthAtBoundary(source.text, Math.floor(length / 2));
        const text = source.text.slice(0, length);
        encoded = JSON.stringify({ ...source, text, ...(hasPageCursor ? { nextChar: (source.startChar as number) + text.length } : {}), truncated: true });
      } while (length > 0 && Buffer.byteLength(encoded, "utf8") > OUTPUT_LIMIT_BYTES);
    }
    if (Buffer.byteLength(encoded, "utf8") > OUTPUT_LIMIT_BYTES) {
      const original = encoded;
      let previewLength = Math.min(original.length, 50_000);
      do {
        previewLength = prefixLengthAtBoundary(original, previewLength);
        encoded = JSON.stringify({ truncated: true, outputPreview: original.slice(0, previewLength) });
        if (Buffer.byteLength(encoded, "utf8") <= OUTPUT_LIMIT_BYTES) break;
        previewLength = Math.floor(previewLength / 2);
      } while (previewLength > 0);
    }
  }
  return { content: [{ type: "text" as const, text: encoded }], details: {} };
}

/** Closed, explicit tool catalog for a project-scoped or attachment-only conversation. */
export function createProjectFileTools(project?: ProjectFileToolsAccess, attachments?: AttachmentToolsAccess) {
  const tools = [];
  if (project) {
    tools.push(defineTool({
      name: "list_project_files", label: "List project files",
      description: "List allowed text files and directories within the opened project. Paths are project-relative.",
      parameters: Type.Object({ path: Type.Optional(Type.String({ maxLength: 1024 })) }),
      async execute(_id, args) { return output(await project.listFiles(args.path)); },
    }));
    tools.push(defineTool({
      name: "read_project_file", label: "Read project file",
      description: "Read an allowed UTF-8 text file within the opened project. The result includes a version token required for edits. Large files can be read in bounded character ranges.",
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }), startChar: Type.Optional(Type.Integer({ minimum: 0, maximum: 65536 })), maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 24000 })) }),
      async execute(_id, args) {
        const file = await project.readFile(args.path);
        const start = Math.min(args.startChar ?? 0, file.text.length);
        assertPageBoundary(file.text, start);
        const end = pageEnd(file.text, start, args.maxChars ?? 24000);
        return output({ ...file, text: file.text.slice(start, end), startChar: start, nextChar: end, truncated: end < file.text.length });
      },
    }));
    tools.push(defineTool({
      name: "search_project_files", label: "Search project files",
      description: "Search bounded text across allowed project files. Results may be truncated when a safety limit is reached.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 256 }) }),
      async execute(_id, args) { return output(await project.searchFiles(args.query)); },
    }));
    tools.push(defineTool({
      name: "create_project_file", label: "Create project file",
      description: "Create a new allowed UTF-8 text file inside the opened project. Existing paths are never overwritten.",
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }), text: Type.String({ maxLength: 65536 }) }),
      async execute(_id, args) { return output(await project.createFile(args.path, args.text)); },
    }));
    tools.push(defineTool({
      name: "edit_project_file", label: "Edit project file",
      description: "Replace an allowed UTF-8 text file only when its current version token still matches the version from read_project_file.",
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }), version: Type.String({ minLength: 1, maxLength: 512 }), text: Type.String({ maxLength: 65536 }) }),
      async execute(_id, args) { return output(await project.editFile(args.path, args.version, args.text)); },
    }));
  }
  if (attachments) {
    tools.push(defineTool({
      name: "list_attachments", label: "List conversation attachments",
      description: "List imported text attachments available in this conversation.",
      parameters: Type.Object({}),
      async execute() { return output(await attachments.listAttachments()); },
    }));
    tools.push(defineTool({
      name: "read_attachment", label: "Read conversation attachment",
      description: "Read one imported text attachment by its attachment ID. Source attachments are read-only. Large files can be read in bounded character ranges.",
      parameters: Type.Object({ attachmentId: Type.String({ minLength: 1, maxLength: 128 }), startChar: Type.Optional(Type.Integer({ minimum: 0, maximum: 20_971_520 })), maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 32768 })) }),
      async execute(_id, args) { return output(await attachments.readAttachment(args.attachmentId, args.startChar ?? 0, args.maxChars ?? 32768)); },
    }));
    tools.push(defineTool({
      name: "save_text_result", label: "Save downloadable text result",
      description: "Save edited or generated UTF-8 text as a new downloadable result attached to this conversation; this does not modify the source attachment.",
      parameters: Type.Object({ fileName: Type.String({ minLength: 1, maxLength: 128 }), text: Type.String({ maxLength: 65536 }), sourceAttachmentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      async execute(_id, args) { return output(await attachments.saveTextResult(args)); },
    }));
  }
  return tools;
}
