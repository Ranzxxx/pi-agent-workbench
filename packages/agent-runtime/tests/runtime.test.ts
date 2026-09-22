import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type Usage as ProviderUsage } from "@earendil-works/pi-ai";
import { parseEvent, type Artifact, type RunEvent } from "@pi-workbench/protocol";
import { createSession, defineTool, InMemoryCredentialStore, CancellationPendingError, type RuntimeOptions } from "../src/index.js";

const input = { repository: { url: "https://github.com/example/fixture", sha: "a".repeat(40) }, goal: "Analyze synthetic fixture" };
const artifacts: Artifact[] = [{ kind: "report.json", path: "report.json", sha256: "b".repeat(64) }];
const budget = { timeoutMs: 2000, maxModelCalls: 8, maxToolCalls: 20, maxTokens: 32000, maxOutputTokens: 2000, maxCostUsd: 0.2 };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
async function aborted(signal?: AbortSignal) {
  assert.ok(signal);
  if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
async function fixture(responses: FauxResponseStep[], overrides: Partial<RuntimeOptions> = {}) {
  const faux = fauxProvider({ api: "runtime-test", provider: "runtime-test", models: [{ id: "test" }], tokenSize: { min: 8, max: 8 } });
  faux.setResponses(responses);
  const events: RunEvent[] = [];
  const reported: ProviderUsage[] = [];
  const originalStream = faux.provider.streamSimple.bind(faux.provider);
  const provider: RuntimeOptions["provider"] = {
    ...faux.provider,
    streamSimple(model, context, options) {
      const stream = originalStream(model, context, options);
      void stream.result().then((message) => { reported.push(structuredClone(message.usage)); });
      return stream;
    },
  };
  const session = await createSession({
    cwd: process.cwd(), provider, model: faux.getModel(), credentials: new InMemoryCredentialStore(),
    systemPrompt: "Only analyze provided data using explicitly supplied tools.", tools: [], budget,
    pricing: { version: "offline-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    finalize: async () => artifacts, onEvent: (event) => events.push(event), ...overrides,
  });
  return { session, faux, events, reported };
}
function assertEvents(events: RunEvent[], terminal: string) {
  assert.equal(events[0]?.type, "run.started");
  assert.equal(events.at(-1)?.type, "run.finished");
  assert.equal(events.filter((e) => e.type === "run.finished").length, 1);
  const last = events.at(-1);
  assert.ok(last?.type === "run.finished");
  assert.equal(last.data.status, terminal);
  assert.equal(new Set(events.map((e) => e.eventId)).size, events.length);
  events.forEach((event, i) => { parseEvent(event); assert.equal(event.sequence, i + 1); assert.equal(event.runId, events[0]?.runId); });
}

test("SDK success requires application validation; events and identity are stable", { timeout: 5000 }, async () => {
  let finalText = "";
  const f = await fixture([fauxAssistantMessage("synthetic report")], { finalize: async ({ text }) => { finalText = text; return artifacts; } });
  const result = await f.session.run(input);
  assert.equal(result.status, "completed");
  assert.equal(finalText, "synthetic report");
  assert.equal(result.runId, f.session.runId);
  assert.equal(result.usage.modelCalls, 1);
  assertEvents(f.events, "completed");
  assert.equal(f.events.filter((e) => e.type === "text.delta").map((e) => e.data.text).join(""), finalText);
  assert.equal(f.session.abort(), false);
  await assert.rejects(f.session.run(input), /single-use/);
  await f.session.dispose(); await f.session.dispose();
});

test("model errors and invalid application results never count as success", { timeout: 5000 }, async () => {
  const a = await fixture([fauxAssistantMessage("", { stopReason: "error", errorMessage: "secret-credential" })]);
  const result = await a.session.run(input);
  assert.ok(result.status === "failed"); assert.equal(result.error.code, "model_error");
  assert.equal(JSON.stringify(a.events).includes("secret-credential"), false);
  assertEvents(a.events, "failed");
  for (const finalize of [async () => [], async () => { throw new Error("unrelated failure"); }]) {
    const b = await fixture([fauxAssistantMessage("done")], { finalize });
    const result = await b.session.run(input);
    assert.ok(result.status === "failed"); assert.equal(result.error.code, "invalid_result");
    assertEvents(b.events, "failed");
  }
});

test("typed tools, invalid arguments and recoverable tool errors are distinct", { timeout: 5000 }, async () => {
  for (const mode of ["normal", "invalid", "throws"] as const) {
    let calls = 0;
    const tool = defineTool({ name: "inspect", label: "Inspect", description: "Synthetic read", parameters: Type.Object({ value: Type.String() }),
      async execute(_id, args) { calls++; if (mode === "throws") throw new Error("secret-tool-error"); return { content: [{ type: "text", text: args.value }], details: {} }; },
    });
    const f = await fixture([
      fauxAssistantMessage(fauxToolCall("inspect", mode === "invalid" ? {} : { value: "hello" }, { id: "provider:arbitrary/id" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ], { tools: [tool] });
    const result = await f.session.run(input);
    assert.equal(result.status, "completed");
    assert.equal(result.usage.modelCalls, 2);
    assert.equal(result.usage.toolCalls, 1);
    assert.equal(result.usage.totalTokens, f.reported.reduce((sum, u) => sum + u.input + u.output + u.cacheRead + u.cacheWrite, 0));
    assert.equal(calls, mode === "invalid" ? 0 : 1);
    const start = f.events.find((e) => e.type === "tool.started");
    const end = f.events.find((e) => e.type === "tool.finished");
    assert.ok(start?.type === "tool.started" && end?.type === "tool.finished");
    assert.equal(start.data.toolCallId, end.data.toolCallId);
    assert.ok(start.sequence < end.sequence);
    assert.equal(end.data.isError, mode !== "normal");
    assert.equal(end.data.summary, mode === "normal" ? "ok" : "tool_error");
    assert.equal(JSON.stringify(f.events).includes("secret-tool-error"), false);
    assertEvents(f.events, "completed");
  }
});

test("user cancellation, timeout and tool cancellation propagate after work starts", { timeout: 10000 }, async () => {
  for (const mode of ["user", "timeout", "tool"] as const) {
    const started = gate(); let observed = false;
    const wait = async (signal?: AbortSignal) => { started.resolve(); await aborted(signal); observed = signal?.aborted === true; };
    const tool = defineTool({ name: "wait_read", label: "Wait", description: "Cooperative synthetic read", parameters: Type.Object({}),
      async execute(_id, _args, signal) { await wait(signal); throw new Error("Read cancelled"); },
    });
    const f = await fixture(mode === "tool" ? [fauxAssistantMessage(fauxToolCall("wait_read", {}), { stopReason: "toolUse" })] : [async (_context, options) => { await wait(options?.signal); return fauxAssistantMessage("", { stopReason: "aborted" }); }], {
      tools: mode === "tool" ? [tool] : [], budget: { ...budget, timeoutMs: mode === "timeout" ? 200 : 2000 },
    });
    const running = f.session.run(input);
    await started.promise;
    if (mode !== "timeout") assert.equal(f.session.abort(), true);
    const result = await running;
    assert.ok(result.status === "cancelled");
    assert.equal(result.reason, mode === "timeout" ? "timeout" : "user");
    assert.equal(observed, true);
    assertEvents(f.events, "cancelled");
  }
});

test("accepted cancellation wins over pending finalization; late cancellation cannot rewrite success", { timeout: 5000 }, async () => {
  const started = gate(), release = gate();
  const f = await fixture([fauxAssistantMessage("done")], { finalize: async ({ signal }) => { started.resolve(); await release.promise; assert.equal(signal.aborted, true); return artifacts; } });
  const running = f.session.run(input);
  await started.promise;
  assert.equal(f.session.abort("user"), true);
  assert.equal(f.session.abort("timeout"), false);
  release.resolve();
  const result = await running;
  assert.ok(result.status === "cancelled"); assert.equal(result.reason, "user");
  assertEvents(f.events, "cancelled");
});

test("noncooperative operation remains cancelling until it actually exits", { timeout: 5000 }, async () => {
  const started = gate(), release = gate();
  const f = await fixture([async () => { started.resolve(); await release.promise; return fauxAssistantMessage("done"); }], { cancellationGraceMs: 20 });
  const running = f.session.run(input);
  await started.promise; f.session.abort();
  try {
    await assert.rejects(running, CancellationPendingError);
    assert.equal(f.session.state, "cancelling");
    assert.equal(f.events.some((e) => e.type === "run.finished"), false);
    assert.equal(f.events.filter((e) => e.type === "run.warning").length, 1);
  } finally { release.resolve(); }
  assert.equal((await f.session.waitForResult()).status, "cancelled");
  assertEvents(f.events, "cancelled");
});

test("model and tool limits prevent additional provider calls and tool bodies", { timeout: 5000 }, async () => {
  for (const mode of ["model", "tool"] as const) {
    let executions = 0;
    const tool = defineTool({ name: "inspect", label: "Inspect", description: "Synthetic", parameters: Type.Object({}),
      async execute() { executions++; return { content: [{ type: "text", text: "ok" }], details: {} }; },
    });
    const f = await fixture([fauxAssistantMessage(fauxToolCall("inspect", {}), { stopReason: "toolUse" }), fauxAssistantMessage("should not be requested")], {
      tools: [tool], budget: { ...budget, maxModelCalls: 1, maxToolCalls: mode === "tool" ? 0 : 1 },
    });
    const result = await f.session.run(input);
    assert.ok(result.status === "cancelled"); assert.equal(result.reason, mode === "model" ? "call_limit" : "tool_limit");
    assert.equal(f.faux.state.callCount, 1);
    assert.equal(executions, mode === "model" ? 1 : 0);
    assertEvents(f.events, "cancelled");
  }
});

test("token and cost exhaustion stop runs and preserve returned usage", { timeout: 5000 }, async () => {
  for (const mode of ["token", "cost"] as const) {
    let outputCap = 0;
    const response = fauxAssistantMessage("done");
    const f = await fixture([(_context, options) => { outputCap = options?.maxTokens ?? 0; return response; }], {
      budget: { ...budget, maxTokens: mode === "token" ? 60 : 32000, maxCostUsd: mode === "cost" ? 0.000001 : 1, maxOutputTokens: 10 },
      pricing: { version: "synthetic", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    const result = await f.session.run(input);
    assert.ok(result.status === "cancelled"); assert.equal(result.reason, mode === "token" ? "token_limit" : "cost_limit");
    const actual = f.reported[0]; assert.ok(actual);
    assert.equal(result.usage.totalTokens, actual.input + actual.output + actual.cacheRead + actual.cacheWrite);
    assert.ok(result.usage.totalTokens >= 60);
    assert.equal(result.usage.estimatedCostUsd, (actual.input + actual.output) / 1_000_000);
    assert.equal(outputCap, 10);
    assertEvents(f.events, "cancelled");
  }
});

test("untrusted local configuration is never loaded, tools default to an explicit empty set", { timeout: 5000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-runtime-pollution-"));
  const sentinel = "UNTRUSTED_CONTEXT_SENTINEL";
  const marker = join(cwd, "executed");
  try {
    await mkdir(join(cwd, ".pi/extensions"), { recursive: true });
    await writeFile(join(cwd, "auth.json"), "malformed auth");
    await writeFile(join(cwd, "AGENTS.md"), sentinel);
    await writeFile(join(cwd, ".pi/SYSTEM.md"), sentinel);
    await writeFile(join(cwd, ".pi/extensions/evil.ts"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); throw new Error('extension loaded');`);
    const f = await fixture([(context) => {
      assert.equal(JSON.stringify(context).includes(sentinel), false);
      const systems = context.messages.filter((m) => m.role === "system");
      assert.ok(systems.every((m) => !m.toolsAdded?.length));
      return fauxAssistantMessage("done");
    }], { cwd });
    assert.equal((await f.session.run(input)).status, "completed");
    await assert.rejects(access(marker));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("invalid requests do not start a run; observer mutations cannot corrupt results", { timeout: 5000 }, async () => {
  const f = await fixture([fauxAssistantMessage("done")], { onEvent: (event) => { event.runId = "corrupted"; throw new Error("UI disconnected"); } });
  assert.throws(() => f.session.run({ ...input, repository: { ...input.repository, sha: "main" } }));
  assert.equal(f.session.state, "queued");
  assert.throws(() => f.session.abort("invalid" as "user"));
  assert.equal(f.session.state, "queued");
  const result = await f.session.run(input);
  assert.equal(result.status, "completed"); assert.equal(result.runId, f.session.runId);
  assert.ok(f.session.observerErrors > 0);
});

test("credentials must be explicit, and an unused session can be disposed safely", async () => {
  await assert.rejects(fixture([], { credentials: undefined as never }), /Explicit credentials/);
  const f = await fixture([]);
  await f.session.dispose(); await f.session.dispose();
  await assert.rejects(f.session.run(input), /single-use/);
  assert.equal(f.faux.state.callCount, 0);
  assert.equal(f.events.length, 0);
});
