import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { parseEvent, parseManifest, parseReport, type RunEvent } from "@pi-workbench/protocol";
import { InMemoryCredentialStore } from "@pi-workbench/agent-runtime";
import { PublicAnalysisCancelledError, runPublicRepositoryAnalysis, type WorkflowCheckpointRecord } from "../src/public-runner.js";

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
    fauxAssistantMessage('{"status":"complete"}'),
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
      budget: { timeoutMs: 5000, maxModelCalls: 5, maxToolCalls: 8, maxTokens: 32000, maxOutputTokens: 2000, maxCostUsd: 0.2 },
      pricing: { version: "offline-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      fetch: fetcher,
      onEvent(event) { events.push(event); },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.snapshot.sha, sha);
    assert.equal(result.result.usage.modelCalls, 5);
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

test("the workflow deadline also cancels fixed-snapshot download and preserves timeout reason", { timeout: 5000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-task014-deadline-"));
  const faux = fauxProvider({ api: "workflow-timeout", provider: "workflow-timeout", models: [{ id: "test" }] });
  let fetchStarted = false;
  const fetcher: typeof fetch = async (_input, init) => {
    fetchStarted = true;
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason;
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  try {
    await assert.rejects(runPublicRepositoryAnalysis({
      repository: { url: "https://github.com/sindresorhus/slugify", ref: "main" },
      cacheDirectory: path.join(root, "cache"), outputDirectory: path.join(root, "runs"),
      credentials: new InMemoryCredentialStore(), provider: faux.provider, model: faux.getModel(),
      budget: { timeoutMs: 30, maxModelCalls: 2, maxToolCalls: 2, maxTokens: 1000, maxOutputTokens: 200, maxCostUsd: 0.2 },
      pricing: { version: "offline-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, fetch: fetcher,
    }), (error: unknown) => error instanceof PublicAnalysisCancelledError && error.reason === "timeout");
    assert.equal(fetchStarted, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("continues from durable stage checkpoints with the same fixed snapshot and run budget", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-task014-recovery-"));
  const archive = fixtureArchive();
  let fetchCalls = 0;
  const fetcher: typeof fetch = async (input) => {
    fetchCalls++;
    const url = String(input);
    if (url === "https://api.github.com/repos/sindresorhus/slugify") return response(JSON.stringify({ default_branch: "main" }), url);
    if (url.endsWith("/commits/main")) return response(JSON.stringify({ sha, commit: { sha } }), url);
    if (url.endsWith("/legacy.tar.gz/" + sha)) return response(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer, url);
    return new Response("", { status: 404 });
  };
  const faux = fauxProvider({ api: "public-resume-test", provider: "public-resume-test", models: [{ id: "test" }], tokenSize: { min: 8, max: 8 } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("list_files", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read_file", { path: "package.json" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("register_evidence", { id: "ev-license", path: "package.json", startLine: 3, endLine: 3, excerpt: "  \"license\": \"MIT\"" }), { stopReason: "toolUse" }),
    fauxAssistantMessage('{"status":"complete"}'),
    fauxAssistantMessage(JSON.stringify({ title: "Recovered fixture report", claims: [
      { id: "license", kind: "fact", text: "The package declares the MIT license.", evidenceIds: ["ev-license"] },
    ] })),
  ]);
  const checkpointRows: WorkflowCheckpointRecord[] = [];
  const checkpointStore = {
    list(runId: string) { return checkpointRows.filter((record) => record.runId === runId); },
    create(record: WorkflowCheckpointRecord) { checkpointRows.push(record); return record; },
  };
  const controller = new AbortController();
  const common = {
    repository: { url: "https://github.com/sindresorhus/slugify", ref: "main" },
    cacheDirectory: path.join(root, "cache"), outputDirectory: path.join(root, "runs"),
    workflowDirectory: path.join(root, "workflows", "run-recovery"), checkpointStore,
    credentials: new InMemoryCredentialStore(), provider: faux.provider, model: faux.getModel(),
    budget: { timeoutMs: 5000, maxModelCalls: 6, maxToolCalls: 8, maxTokens: 32000, maxOutputTokens: 2000, maxCostUsd: 0.2 },
    pricing: { version: "offline-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, fetch: fetcher,
    runId: "run-recovery", attemptId: "attempt-one",
  };
  try {
    const first = await runPublicRepositoryAnalysis({ ...common, signal: controller.signal, onWorkflowProgress(event) {
      if (event.type === "checkpoint_saved" && event.data.phase === "validation") controller.abort();
    } });
    assert.equal(first.status, "cancelled");
    assert.equal(first.result.usage.modelCalls, 5);
    assert.equal(first.usageComplete, true);
    const firstFetchCalls = fetchCalls;
    assert.ok(checkpointRows.some((record) => record.phaseId === "snapshot" && record.status === "completed"));
    assert.ok(checkpointRows.some((record) => record.phaseId === "evidence" && record.status === "completed"));
    assert.ok(checkpointRows.some((record) => record.phaseId === "analysis" && record.status === "completed"));
    assert.ok(checkpointRows.some((record) => record.phaseId === "validation" && record.status === "completed"));

    const recovered = await runPublicRepositoryAnalysis({ ...common, attemptId: "attempt-two", initialUsage: first.result.usage,
      initialUsageComplete: first.usageComplete, signal: new AbortController().signal });
    assert.equal(recovered.status, "completed", JSON.stringify(recovered));
    assert.equal(recovered.snapshot.sha, first.snapshot.sha);
    assert.equal(fetchCalls, firstFetchCalls, "resume must use its stored immutable snapshot checkpoint");
    assert.equal(recovered.result.usage.modelCalls, 0, "the result reports only the new attempt's usage");
    assert.equal(checkpointRows.some((record) => record.phaseId === "validation" && record.status === "completed"), true);
    assert.equal(checkpointRows.some((record) => record.phaseId === "publication" && record.status === "completed"), true);
    assert.deepEqual((await readdir(path.join(root, "runs", "run-recovery"))).sort(), ["attempt-one", "final"].sort());
    const eventLog = (await readFile(path.join(recovered.directory!, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as RunEvent);
    assert.equal(eventLog[0]?.type, "run.started", "a cache-only resume still produces a valid attempt event log");
    assert.equal(eventLog.at(-1)?.type, "run.finished");
    const callCount = faux.state.callCount;
    const checkpointCount = checkpointRows.length;
    const replay = await runPublicRepositoryAnalysis({ ...common, attemptId: "attempt-two", initialUsage: first.result.usage,
      initialUsageComplete: first.usageComplete, signal: new AbortController().signal });
    assert.equal(replay.status, "completed");
    assert.deepEqual(replay.artifacts, recovered.artifacts);
    assert.deepEqual(replay.result.usage, recovered.result.usage);
    assert.equal(faux.state.callCount, callCount, "idempotent replay must not call the model again");
    assert.equal(checkpointRows.length, checkpointCount, "idempotent replay must not duplicate stage checkpoints");
  } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
});

test("reuses a completed publication across attempts without rebilling or rewriting artifacts", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-task017-publication-reuse-"));
  const archive = fixtureArchive();
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/sindresorhus/slugify") return response(JSON.stringify({ default_branch: "main" }), url);
    if (url.endsWith("/commits/main")) return response(JSON.stringify({ sha, commit: { sha } }), url);
    if (url.endsWith("/legacy.tar.gz/" + sha)) return response(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer, url);
    return new Response("", { status: 404 });
  };
  const faux = fauxProvider({ api: "publication-resume-test", provider: "publication-resume-test", models: [{ id: "test" }], tokenSize: { min: 8, max: 8 } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("list_files", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read_file", { path: "package.json" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("register_evidence", { id: "ev-license", path: "package.json", startLine: 3, endLine: 3, excerpt: "  \"license\": \"MIT\"" }), { stopReason: "toolUse" }),
    fauxAssistantMessage('{"status":"complete"}'),
    fauxAssistantMessage(JSON.stringify({ title: "Publication recovery report", claims: [
      { id: "license", kind: "fact", text: "The package declares the MIT license.", evidenceIds: ["ev-license"] },
    ] })),
  ]);
  const checkpointRows: WorkflowCheckpointRecord[] = [];
  const checkpointStore = {
    list(runId: string) { return checkpointRows.filter((record) => record.runId === runId); },
    create(record: WorkflowCheckpointRecord) { checkpointRows.push(record); return record; },
  };
  const common = {
    repository: { url: "https://github.com/sindresorhus/slugify", ref: "main" },
    cacheDirectory: path.join(root, "cache"), outputDirectory: path.join(root, "runs"),
    workflowDirectory: path.join(root, "workflows", "run-publication-recovery"), checkpointStore,
    credentials: new InMemoryCredentialStore(), provider: faux.provider, model: faux.getModel(),
    budget: { timeoutMs: 5000, maxModelCalls: 6, maxToolCalls: 8, maxTokens: 32000, maxOutputTokens: 2000, maxCostUsd: 0.2 },
    pricing: { version: "offline-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, fetch: fetcher,
    runId: "run-publication-recovery",
  };
  try {
    const first = await runPublicRepositoryAnalysis({ ...common, attemptId: "attempt-publication-one" });
    assert.equal(first.status, "completed", JSON.stringify(first));
    assert.equal(first.result.usage.modelCalls, 5);
    assert.equal(checkpointRows.some((record) => record.phaseId === "publication" && record.status === "completed"), true);
    const final = path.join(root, "runs", common.runId, "final");
    const originalFiles = await Promise.all(["report.json", "report.md", "events.jsonl", "manifest.json"].map(async (name) => {
      const filePath = path.join(final, name);
      const [bytes, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
      return [name, createHash("sha256").update(bytes).digest("hex"), metadata.ino, metadata.mtimeMs] as const;
    }));
    const callsBeforeResume = faux.state.callCount;

    const resumed = await runPublicRepositoryAnalysis({ ...common, attemptId: "attempt-publication-two",
      initialUsage: first.result.usage, initialUsageComplete: first.usageComplete });
    assert.equal(resumed.status, "completed", JSON.stringify(resumed));
    assert.equal(resumed.result.usage.modelCalls, 0, "a resumed attempt reports only work it performed");
    assert.equal(faux.state.callCount, callsBeforeResume, "a publication-only recovery must not call the provider");
    const resumedFiles = await Promise.all(originalFiles.map(async ([name]) => {
      const filePath = path.join(final, name);
      const [bytes, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
      return [name, createHash("sha256").update(bytes).digest("hex"), metadata.ino, metadata.mtimeMs] as const;
    }));
    assert.deepEqual(resumedFiles, originalFiles, "recovery must preserve the original published bytes and files");
    assert.deepEqual(resumed.artifacts, first.artifacts);
    assert.equal(checkpointRows.filter((record) => record.phaseId === "publication" && record.status === "completed").length, 1);

    faux.appendResponses([
      fauxAssistantMessage('{"status":"complete"}'),
      fauxAssistantMessage(JSON.stringify({ title: "Changed goal report", claims: [
        { id: "different", kind: "unknown", text: "The requested value is not established.", reason: "No matching source evidence was found.", evidenceIds: [] },
      ] })),
    ]);
    const changedGoal = await runPublicRepositoryAnalysis({ ...common, attemptId: "attempt-publication-three",
      questions: [{ id: "different", question: "What is the release codename?" }],
      initialUsage: first.result.usage, initialUsageComplete: first.usageComplete,
      budget: { ...common.budget, maxModelCalls: 10 } });
    assert.equal(changedGoal.status, "failed", "a valid old publication must not satisfy a changed analysis goal");
    assert.match(changedGoal.result.status === "failed" ? changedGoal.result.error.message : "", /goal does not match/u);
    assert.equal(faux.state.callCount, callsBeforeResume + 2, "the changed goal runs its own evidence and analysis calls before refusing reuse");
    const afterChangedGoal = await Promise.all(originalFiles.map(async ([name]) => {
      const filePath = path.join(final, name);
      const [bytes, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
      return [name, createHash("sha256").update(bytes).digest("hex"), metadata.ino, metadata.mtimeMs] as const;
    }));
    assert.deepEqual(afterChangedGoal, originalFiles, "refusing mismatched inputs must not rewrite the old publication");

    const originalPublicationCheckpoint = checkpointRows.find((record) => record.phaseId === "publication" && record.status === "completed");
    assert.ok(originalPublicationCheckpoint?.outputRef);
    const checkpointOutputPath = path.join(root, "workflows", "run-publication-recovery", originalPublicationCheckpoint.outputRef);
    const checkpointEnvelope = JSON.parse(await readFile(checkpointOutputPath, "utf8")) as Record<string, unknown>;
    await writeFile(checkpointOutputPath, JSON.stringify({ ...checkpointEnvelope, payloadSha256: "0".repeat(64) }) + "\n");
    const recoveredCorruptCheckpoint = await runPublicRepositoryAnalysis({ ...common, attemptId: "attempt-publication-four",
      initialUsage: first.result.usage, initialUsageComplete: first.usageComplete });
    assert.equal(recoveredCorruptCheckpoint.status, "completed", "a corrupt stage envelope may be recomputed from a verified final publication");
    assert.equal(recoveredCorruptCheckpoint.result.usage.modelCalls, 0);
    assert.equal(faux.state.callCount, callsBeforeResume + 2, "stage checkpoint recovery must not repeat provider calls");
    const afterCheckpointRecovery = await Promise.all(originalFiles.map(async ([name]) => {
      const filePath = path.join(final, name);
      const [bytes, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
      return [name, createHash("sha256").update(bytes).digest("hex"), metadata.ino, metadata.mtimeMs] as const;
    }));
    assert.deepEqual(afterCheckpointRecovery, originalFiles, "checkpoint recomputation must not rewrite the final publication");

    const reportMarkdown = path.join(final, "report.md");
    await writeFile(reportMarkdown, (await readFile(reportMarkdown)) + "corruption\n");
    const corrupt = await runPublicRepositoryAnalysis({ ...common, attemptId: "attempt-publication-five",
      initialUsage: first.result.usage, initialUsageComplete: first.usageComplete });
    assert.equal(corrupt.status, "failed", "a final artifact that no longer matches its manifest must be rejected");
    assert.match(corrupt.result.status === "failed" ? corrupt.result.error.message : "", /integrity validation/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("analysis requests a bounded evidence refresh and invalidates downstream inputs", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-task014-evidence-refresh-"));
  const archive = fixtureArchive();
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/sindresorhus/slugify") return response(JSON.stringify({ default_branch: "main" }), url);
    if (url.endsWith("/commits/" + sha)) return response(JSON.stringify({ sha, commit: { sha } }), url);
    if (url.endsWith("/legacy.tar.gz/" + sha)) return response(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer, url);
    return new Response("", { status: 404 });
  };
  const faux = fauxProvider({ api: "public-evidence-refresh-test", provider: "public-evidence-refresh-test", models: [{ id: "test" }], tokenSize: { min: 8, max: 8 } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("list_files", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("register_evidence", { id: "ev-license", path: "package.json", startLine: 3, endLine: 3, excerpt: "  \"license\": \"MIT\"" }), { stopReason: "toolUse" }),
    fauxAssistantMessage('{"status":"complete"}'),
    fauxAssistantMessage(JSON.stringify({ title: "Draft", claims: [{ id: "license", kind: "fact", text: "License detail.", evidenceIds: ["ev-license"] }], evidenceRequests: ["Find the package name declaration."] })),
    fauxAssistantMessage(fauxToolCall("search_text", { query: "name" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("register_evidence", { id: "ev-name", path: "package.json", startLine: 2, endLine: 2, excerpt: "  \"name\": \"fixture\"," }), { stopReason: "toolUse" }),
    fauxAssistantMessage('{"status":"complete"}'),
    fauxAssistantMessage(JSON.stringify({ title: "Fixture package", claims: [
      { id: "license", kind: "fact", text: "License is MIT.", evidenceIds: ["ev-license"] },
      { id: "name", kind: "fact", text: "The package name is fixture.", evidenceIds: ["ev-name"] },
    ] })),
  ]);
  const checkpointRows: WorkflowCheckpointRecord[] = [];
  const checkpointStore = {
    list(runId: string) { return checkpointRows.filter((record) => record.runId === runId); },
    create(record: WorkflowCheckpointRecord) { checkpointRows.push(record); return record; },
  };
  try {
    const result = await runPublicRepositoryAnalysis({
      repository: { url: "https://github.com/sindresorhus/slugify", ref: sha },
      cacheDirectory: path.join(root, "cache"), outputDirectory: path.join(root, "runs"),
      workflowDirectory: path.join(root, "workflows", "run-refresh"), checkpointStore,
      credentials: new InMemoryCredentialStore(), provider: faux.provider, model: faux.getModel(),
      budget: { timeoutMs: 8000, maxModelCalls: 9, maxToolCalls: 8, maxTokens: 32000, maxOutputTokens: 2000, maxCostUsd: 0.2 },
      pricing: { version: "offline-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, fetch: fetcher,
      runId: "run-refresh", attemptId: "attempt-refresh",
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.report?.evidence.map((item) => item.id).sort(), ["ev-license", "ev-name"]);
    const completed = checkpointRows.filter((record) => record.status === "completed");
    assert.equal(new Set(completed.filter((record) => record.phaseId === "evidence").map((record) => record.inputSha256)).size, 2);
    assert.equal(new Set(completed.filter((record) => record.phaseId === "analysis").map((record) => record.inputSha256)).size, 2);
    assert.equal(completed.filter((record) => record.phaseId === "validation").length, 1);
    assert.equal(completed.filter((record) => record.phaseId === "publication").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
