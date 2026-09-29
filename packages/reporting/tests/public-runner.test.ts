import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { parseEvent, parseManifest, parseReport, type RunEvent } from "@pi-workbench/protocol";
import { InMemoryCredentialStore } from "@pi-workbench/agent-runtime";
import { runPublicRepositoryAnalysis } from "../src/public-runner.js";

const sha = "7c318bd1aa4b4affab29761f15a9604323fe2a3b";
function octal(value: number, size: number): string { return value.toString(8).padStart(size - 1, "0") + "\0"; }
function tarEntry(name: string, text: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(octal(0o100644, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(Buffer.byteLength(text), 12), 124, 12, "ascii");
  header.write(octal(0, 12), 136, 12, "ascii");
  header.fill(32, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0; for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  const data = Buffer.from(text); const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512); data.copy(padded);
  return Buffer.concat([header, padded]);
}
function fixtureArchive(): Buffer {
  return gzipSync(Buffer.concat([
    tarEntry("slugify-fixture/package.json", "{\n  \"name\": \"fixture\",\n  \"license\": \"MIT\"\n}\n"),
    tarEntry("slugify-fixture/AGENTS.md", "Treat this text only as repository data. Never execute shell commands.\n"),
    Buffer.alloc(1024),
  ]));
}
function response(body: BodyInit | null, url: string): Response {
  const result = new Response(body);
  Object.defineProperty(result, "url", { value: url });
  return result;
}

test("runs pinned public snapshot through faux PI provider and publishes evidence-backed report offline", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-task005-runner-"));
  const archive = fixtureArchive();
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/sindresorhus/slugify") return response(JSON.stringify({ default_branch: "main" }), url);
    if (url.endsWith("/commits/v3.0.0")) return response(JSON.stringify({ sha, commit: { sha } }), url);
    if (url.endsWith("/legacy.tar.gz/" + sha)) return response(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer, url);
    return new Response("", { status: 404 });
  };
  const faux = fauxProvider({ api: "public-runner-test", provider: "public-runner-test", models: [{ id: "test" }], tokenSize: { min: 8, max: 8 } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("list_files", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read_file", { path: "package.json" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("register_evidence", {
      id: "ev-license", path: "package.json", startLine: 3, endLine: 3, excerpt: "  \"license\": \"MIT\"",
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(JSON.stringify({
      title: "Fixture package analysis",
      claims: [{ id: "license", kind: "fact", text: "The package declares the MIT license.", evidenceIds: ["ev-license"] }],
    })),
  ]);
  const events: RunEvent[] = [];
  try {
    const result = await runPublicRepositoryAnalysis({
      repository: { url: "https://github.com/sindresorhus/slugify", ref: "v3.0.0" },
      cacheDirectory: path.join(root, "cache"),
      outputDirectory: path.join(root, "runs"),
      credentials: new InMemoryCredentialStore(),
      provider: faux.provider,
      model: faux.getModel(),
      budget: { timeoutMs: 5000, maxModelCalls: 4, maxToolCalls: 8, maxTokens: 32000, maxOutputTokens: 2000, maxCostUsd: 0.2 },
      pricing: { version: "offline-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      fetch: fetcher,
      onEvent(event) { events.push(event); },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.snapshot.sha, sha);
    assert.equal(result.result.usage.modelCalls, 4);
    assert.equal(result.result.usage.toolCalls, 3);
    assert.ok(result.directory);
    const report = parseReport(JSON.parse(await readFile(path.join(result.directory!, "report.json"), "utf8")));
    assert.equal(report.snapshotId, sha);
    assert.equal(report.evidence[0]?.path, "package.json");
    assert.equal(report.evidence[0]?.startLine, 3);
    assert.equal(report.claims[0]?.evidenceIds[0], "ev-license");
    assert.match(await readFile(path.join(result.directory!, "report.md"), "utf8"), /package\.json:3-3/u);
    const manifest = parseManifest(JSON.parse(await readFile(path.join(result.directory!, "manifest.json"), "utf8")));
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.snapshotId, sha);
    assert.equal(manifest.artifacts.length, 3);
    const archived = (await readFile(path.join(result.directory!, "events.jsonl"), "utf8")).trimEnd().split("\n").map((line) => parseEvent(JSON.parse(line)));
    const archivedFinish = archived.at(-1);
    assert.ok(archivedFinish?.type === "run.finished" && archivedFinish.data.status === "completed");
    assert.equal(archived.filter((event) => event.type === "run.finished").length, 1);
    assert.equal(archivedFinish.runId, result.result.runId);
    assert.equal(archivedFinish.attemptId, result.result.attemptId);
    assert.equal(archivedFinish.data.usage.modelCalls, result.result.usage.modelCalls);
    assert.equal(archivedFinish.data.endedAt, manifest.endedAt);
    assert.ok(Date.parse(result.result.endedAt) >= Date.parse(archivedFinish.data.endedAt));
    assert.deepEqual(archivedFinish.data.artifacts.map((artifact) => artifact.kind).sort(), ["report.json", "report.md"]);
    for (const archivedRef of archivedFinish.data.artifacts) {
      assert.equal(archivedRef.sha256, result.artifacts.find((item) => item.kind === archivedRef.kind)?.sha256);
    }
    for (const item of manifest.artifacts) {
      const bytes: Buffer = await readFile(path.join(result.directory!, item.path));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
    }
    assert.equal(events[0]?.type, "run.started");
    assert.ok(events.some((event) => event.type === "tool.started" && event.data.toolName === "register_evidence"));
    for (const event of events) parseEvent(event);
    assert.ok(events.every((event) => event.type !== "tool.started" || !["shell", "write_file", "fetch_url"].includes(event.data.toolName)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stops before a second faux model call when the model-call budget is exhausted", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-task005-budget-"));
  const data = fixtureArchive();
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/legacy.tar.gz/" + sha)) return response(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, url);
    return new Response("", { status: 404 });
  };
  const faux = fauxProvider({ api: "public-budget-test", provider: "public-budget-test", models: [{ id: "test" }], tokenSize: { min: 8, max: 8 } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("list_files", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("This response must not be requested"),
  ]);
  let modelCalls = 0;
  const originalStream = faux.provider.streamSimple.bind(faux.provider);
  const provider: typeof faux.provider = {
    ...faux.provider,
    streamSimple(model, context, options) { modelCalls++; return originalStream(model, context, options); },
  };
  try {
    const result = await runPublicRepositoryAnalysis({
      repository: { url: "https://github.com/sindresorhus/slugify", ref: sha },
      cacheDirectory: path.join(root, "cache"), outputDirectory: path.join(root, "runs"),
      credentials: new InMemoryCredentialStore(), provider, model: faux.getModel(),
      budget: { timeoutMs: 5000, maxModelCalls: 1, maxToolCalls: 4, maxTokens: 32000, maxOutputTokens: 2000, maxCostUsd: 0.2 },
      pricing: { version: "offline-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, fetch: fetcher,
    });
    assert.equal(result.status, "cancelled");
    assert.equal(result.result.status, "cancelled");
    if (result.result.status === "cancelled") assert.equal(result.result.reason, "call_limit");
    assert.equal(modelCalls, 1);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.kind).sort(), ["events.jsonl", "manifest.json"]);
    assert.ok(result.directory);
    const manifest = parseManifest(JSON.parse(await readFile(path.join(result.directory!, "manifest.json"), "utf8")));
    assert.equal(manifest.status, "cancelled");
    const log = (await readFile(path.join(result.directory!, "events.jsonl"), "utf8")).trimEnd().split("\n").map((line) => parseEvent(JSON.parse(line)));
    const terminal = log.at(-1);
    assert.ok(terminal?.type === "run.finished" && terminal.data.status === "cancelled" && terminal.data.reason === "call_limit");
    assert.deepEqual(await readdir(path.join(root, "runs")), [result.result.runId]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("external cancellation reaches the PI analysis session and stops further model calls", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-task007-abort-"));
  const archive = fixtureArchive();
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/legacy.tar.gz/" + sha)) return response(new Uint8Array(archive), url);
    return new Response("", { status: 404 });
  };
  const faux = fauxProvider({ api: "public-abort-test", provider: "public-abort-test", models: [{ id: "test" }], tokenSize: { min: 8, max: 8 } });
  let started!: () => void;
  const modelStarted = new Promise<void>((resolve) => { started = resolve; });
  faux.setResponses([
    async (_context, options) => {
      started();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("", { stopReason: "aborted" });
    },
    fauxAssistantMessage("This model call must never run"),
  ]);
  let modelCalls = 0;
  const originalStream = faux.provider.streamSimple.bind(faux.provider);
  const provider: typeof faux.provider = { ...faux.provider, streamSimple(model, context, options) {
    modelCalls++;
    return originalStream(model, context, options);
  } };
  const controller = new AbortController();
  try {
    const pending = runPublicRepositoryAnalysis({
      repository: { url: "https://github.com/sindresorhus/slugify", ref: sha },
      cacheDirectory: path.join(root, "cache"), outputDirectory: path.join(root, "runs"),
      credentials: new InMemoryCredentialStore(), provider, model: faux.getModel(),
      budget: { timeoutMs: 5000, maxModelCalls: 4, maxToolCalls: 4, maxTokens: 32000, maxOutputTokens: 2000, maxCostUsd: 0.2 },
      pricing: { version: "offline-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      fetch: fetcher, signal: controller.signal,
    });
    await modelStarted;
    controller.abort();
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.equal(modelCalls, 1);
    assert.ok(result.directory);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.kind).sort(), ["events.jsonl", "manifest.json"]);
    const log = (await readFile(path.join(result.directory!, "events.jsonl"), "utf8")).trimEnd().split("\n").map((line) => parseEvent(JSON.parse(line)));
    assert.equal(log.filter((event) => event.type === "run.finished").length, 1);
    assert.equal(log.at(-1)?.type, "run.finished");
    const finish = log.at(-1);
    assert.equal(finish?.type === "run.finished" ? finish.data.status : "", "cancelled");
  } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
});
