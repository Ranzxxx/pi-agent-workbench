import assert from "node:assert/strict";
import test from "node:test";
import { createProjectFileTools, type AttachmentToolsAccess, type ProjectFileToolsAccess } from "../src/project-file-tools.js";

const OUTPUT_LIMIT_BYTES = 60 * 1024;
type TextToolResult = { content: Array<{ type: string; text?: string }> };
type ExecutableTool = { name: string; execute: (toolCallId: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: never) => Promise<TextToolResult> };

function textResult(result: TextToolResult): { value: Record<string, unknown>; encoded: string } {
  const block = result.content.find((item) => item.type === "text");
  assert.ok(block?.text);
  return { value: JSON.parse(block.text) as Record<string, unknown>, encoded: block.text };
}

function toolNamed(name: string, access: ProjectFileToolsAccess | undefined, attachments?: AttachmentToolsAccess): ExecutableTool {
  const tool = createProjectFileTools(access, attachments).find((item) => item.name === name);
  assert.ok(tool);
  return tool as unknown as ExecutableTool;
}

async function read(tool: ExecutableTool, args: Record<string, unknown>) {
  return textResult(await tool.execute("read-page-test", args, undefined, undefined, undefined as never));
}

test("project file output truncation advances nextChar by the returned UTF-16 text length", async () => {
  const text = "中".repeat(21_000);
  const access: ProjectFileToolsAccess = {
    async listFiles() { return []; },
    async readFile(filePath) { return { path: filePath, text, token: "version", sha256: "a".repeat(64), byteSize: Buffer.byteLength(text), identity: "1:1" }; },
    async searchFiles() { return []; }, async createFile() { return {}; }, async editFile() { return {}; },
  };
  const { value, encoded } = await read(toolNamed("read_project_file", access), { path: "large.md" });
  assert.ok(Buffer.byteLength(encoded, "utf8") <= OUTPUT_LIMIT_BYTES);
  assert.equal(value.truncated, true);
  assert.equal(value.nextChar, (value.startChar as number) + (value.text as string).length,
    "nextChar must identify the first UTF-16 code unit not present in the serialized page");
});

test("project file pages can be concatenated without skips or split surrogate pairs", async () => {
  const text = `中文“quoted” \\path 😀🧪 ${"片段😀\\\"quote\" ".repeat(4200)}`;
  const access: ProjectFileToolsAccess = {
    async listFiles() { return []; },
    async readFile(filePath) { return { path: filePath, text, token: "version", sha256: "b".repeat(64), byteSize: Buffer.byteLength(text), identity: "1:1" }; },
    async searchFiles() { return []; }, async createFile() { return {}; }, async editFile() { return {}; },
  };
  const tool = toolNamed("read_project_file", access);
  const chunks: string[] = [];
  let cursor = 0;
  while (true) {
    const { value, encoded } = await read(tool, { path: "large.md", startChar: cursor, maxChars: 24_000 });
    const chunk = value.text as string;
    assert.ok(Buffer.byteLength(encoded, "utf8") <= OUTPUT_LIMIT_BYTES);
    assert.equal(value.startChar, cursor);
    assert.equal(value.nextChar, cursor + chunk.length);
    if (chunk.length > 0) assert.ok((value.nextChar as number) > cursor);
    const next = value.nextChar as number;
    if (next < text.length) {
      const last = chunk.charCodeAt(chunk.length - 1);
      const following = text.charCodeAt(next);
      assert.equal(last >= 0xd800 && last <= 0xdbff && following >= 0xdc00 && following <= 0xdfff, false,
        "a page may not end between the two UTF-16 code units of an emoji");
    }
    chunks.push(chunk);
    cursor = next;
    if (!value.truncated) break;
  }
  assert.equal(cursor, text.length);
  assert.equal(chunks.join(""), text);
});

test("a one-code-unit page still returns a whole emoji and mid-surrogate input cursors are rejected", async () => {
  const text = "😀X";
  const access: ProjectFileToolsAccess = {
    async listFiles() { return []; },
    async readFile(filePath) { return { path: filePath, text, token: "version", sha256: "c".repeat(64), byteSize: Buffer.byteLength(text), identity: "1:1" }; },
    async searchFiles() { return []; }, async createFile() { return {}; }, async editFile() { return {}; },
  };
  const tool = toolNamed("read_project_file", access);
  const first = await read(tool, { path: "emoji.md", startChar: 0, maxChars: 1 });
  assert.equal(first.value.text, "😀");
  assert.equal(first.value.nextChar, 2);
  const second = await read(tool, { path: "emoji.md", startChar: 2, maxChars: 1 });
  assert.equal(second.value.text, "X");
  assert.equal(second.value.nextChar, 3);
  await assert.rejects(read(tool, { path: "emoji.md", startChar: 1, maxChars: 1 }), /不能位于 Unicode 字符内部/u);
});

test("attachment tool output adjusts its pagination cursor after size truncation", async () => {
  const text = `引号“quoted” 路径\\folder 😀 ${"中文\\x \"quoted\" 🧭 ".repeat(6200)}`;
  const attachments: AttachmentToolsAccess = {
    async listAttachments() { return []; },
    async readAttachment(attachmentId, startChar, maxChars) {
      const end = Math.min(text.length, startChar + maxChars);
      return { attachmentId, fileName: "synthetic.txt", sha256: "d".repeat(64), byteSize: Buffer.byteLength(text),
        text: text.slice(startChar, end), startChar, nextChar: end, truncated: end < text.length };
    },
    async saveTextResult() { return {}; },
  };
  const tool = toolNamed("read_attachment", undefined, attachments);
  const { value, encoded } = await read(tool, { attachmentId: "attachment_1", startChar: 0, maxChars: 32_768 });
  assert.ok(Buffer.byteLength(encoded, "utf8") <= OUTPUT_LIMIT_BYTES);
  assert.equal(value.truncated, true);
  assert.equal(value.nextChar, (value.startChar as number) + (value.text as string).length);
});
