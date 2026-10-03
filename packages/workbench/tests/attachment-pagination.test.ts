import assert from "node:assert/strict";
import test from "node:test";
import { createProjectFileTools } from "@pi-workbench/agent-runtime";
import { sliceAttachmentTextPage } from "../src/execution.js";

type ExecutableTool = {
  name: string;
  execute: (toolCallId: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: never) => Promise<{
    content: Array<{ type: string; text?: string }>;
  }>;
};

function attachmentTool(text: string): ExecutableTool {
  const tool = createProjectFileTools(undefined, {
    async listAttachments() { return []; },
    async readAttachment(attachmentId, startChar, maxChars) {
      return {
        attachmentId, fileName: "synthetic.txt", sha256: "a".repeat(64), byteSize: Buffer.byteLength(text),
        ...sliceAttachmentTextPage(text, startChar, maxChars),
      };
    },
    async saveTextResult() { return {}; },
  }).find((item) => item.name === "read_attachment");
  assert.ok(tool);
  return tool as unknown as ExecutableTool;
}

test("attachment pagination advances through Unicode text without skips, duplicates, or split surrogate pairs", () => {
  const source = `中文 😀 引号\"和反斜杠\\；再来一段 emoji 🧪。`;
  let cursor = 0;
  let joined = "";
  while (cursor < source.length) {
    const page = sliceAttachmentTextPage(source, cursor, 5);
    assert.equal(page.startChar, cursor);
    assert.ok(page.nextChar > cursor);
    assert.equal(page.nextChar, cursor + page.text.length);
    assert.ok(!(/[\uD800-\uDBFF]$/.test(page.text)));
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 60 * 1024);
    joined += page.text;
    cursor = page.nextChar;
  }
  assert.equal(joined, source);
  assert.equal(cursor, source.length);
});

test("attachment maxChars=1 returns a whole emoji and rejects a cursor inside its surrogate pair", () => {
  const first = sliceAttachmentTextPage("😀x", 0, 1);
  assert.deepEqual(first, { text: "😀", startChar: 0, nextChar: 2, truncated: true });
  assert.deepEqual(sliceAttachmentTextPage("😀x", first.nextChar, 1), {
    text: "x", startChar: 2, nextChar: 3, truncated: false,
  });
  assert.throws(() => sliceAttachmentTextPage("😀x", 1, 1), /分页游标不能位于 Unicode 字符内部/);
});

test("attachment pagination rejects malformed ranges", () => {
  assert.throws(() => sliceAttachmentTextPage("abc", -1, 1), /分页参数无效/);
  assert.throws(() => sliceAttachmentTextPage("abc", 0, 0), /分页参数无效/);
  assert.throws(() => sliceAttachmentTextPage("abc", Number.NaN, 1), /分页参数无效/);
});

test("read_attachment tool pages large escaped Unicode text with accurate cursors under the JSON limit", async () => {
  const source = `中文 😀 引号\"和反斜杠\\ ${"片段🧪\\path \"quoted\" 中文 😀 ".repeat(1800)}`;
  assert.ok(source.length > 21_000);
  const tool = attachmentTool(source);
  const chunks: string[] = [];
  let cursor = 0;
  while (true) {
    const result = await tool.execute("attachment-pagination-test", {
      attachmentId: "attachment_test", startChar: cursor, maxChars: 32_768,
    }, undefined, undefined, undefined as never);
    const block = result.content.find((item) => item.type === "text");
    assert.ok(block?.text);
    assert.ok(Buffer.byteLength(block.text, "utf8") <= 60 * 1024);
    const page = JSON.parse(block.text) as { text: string; startChar: number; nextChar: number; truncated: boolean };
    assert.equal(page.startChar, cursor);
    assert.equal(page.nextChar, cursor + page.text.length);
    if (page.text.length > 0) assert.ok(page.nextChar > cursor);
    assert.equal(page.truncated, page.nextChar < source.length);
    chunks.push(page.text);
    cursor = page.nextChar;
    if (!page.truncated) break;
  }
  assert.equal(cursor, source.length);
  assert.equal(chunks.join(""), source);
});
