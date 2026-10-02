import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Provider } from "@earendil-works/pi-ai";
import { createConversationSession, defineTool, InMemoryCredentialStore, type ConversationRuntimeOptions, type ConversationSessionSnapshot } from "../src/index.js";

const budget = { timeoutMs: 2000, maxModelCalls: 4, maxToolCalls: 0, maxTokens: 32000, maxOutputTokens: 2000, maxCostUsd: 0.2 };

test("ordinary conversation snapshots and restores the public PI session tree", { timeout: 5000 }, async () => {
  const seenContexts: string[] = [];
  const faux = fauxProvider({ api: "conversation-context-test", provider: "conversation-context-test", models: [{ id: "test" }], tokenSize: { min: 8, max: 8 } });
  let calls = 0;
  const original = faux.provider.streamSimple.bind(faux.provider);
  const provider: Provider = {
    ...faux.provider,
    streamSimple(model, context, options) {
      calls++;
      seenContexts.push(JSON.stringify(context.messages));
      faux.setResponses([fauxAssistantMessage(`reply-${calls}`)]);
      return original(model, context, options);
    },
  };
  let persisted: ConversationSessionSnapshot | undefined;
  const createOptions = {
    cwd: process.cwd(), credentials: new InMemoryCredentialStore(), provider, model: faux.getModel(),
    systemPrompt: "Be concise. Do not use tools.", budget,
    pricing: { version: "test-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    persistSnapshot(snapshot: ConversationSessionSnapshot) { persisted = snapshot; },
  } satisfies ConversationRuntimeOptions;
  const conversation = await createConversationSession(createOptions);
  try {
    assert.deepEqual((await conversation.prompt("first question")).status, "completed");
    conversation.addContextMessage("Successfully validated capability result: {\"claims\":[\"bounded fact\"]}");
    await conversation.persistSnapshot();
    assert.ok(persisted);
  } finally { await conversation.dispose(); }
  assert.ok(persisted);
  const restored = await createConversationSession({ ...createOptions, restoredSnapshot: persisted });
  try {
    const second = await restored.prompt("follow-up question");
    assert.equal(second.status, "completed");
    if (second.status === "completed") assert.equal(second.text, "reply-2");
    assert.equal(second.usage.modelCalls, 1);
    assert.equal(second.usage.toolCalls, 0);
    assert.equal(second.usage.estimatedCostUsd, 0);
    assert.equal(seenContexts.length, 2);
    assert.match(seenContexts[1]!, /first question/u);
    assert.match(seenContexts[1]!, /reply-1/u);
    assert.match(seenContexts[1]!, /bounded fact/u);
    assert.match(seenContexts[1]!, /follow-up question/u);
  } finally { await restored.dispose(); }
});

test("ordinary conversation has no configured tools and reports model failures safely", { timeout: 5000 }, async () => {
  const faux = fauxProvider({ api: "conversation-failure-test", provider: "conversation-failure-test", models: [{ id: "test" }], tokenSize: { min: 8, max: 8 } });
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "private provider detail" })]);
  const provider: Provider = { ...faux.provider };
  const conversation = await createConversationSession({
    cwd: process.cwd(), credentials: new InMemoryCredentialStore(), provider, model: faux.getModel(),
    systemPrompt: "Be concise.", budget, pricing: { version: "test-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  try {
    const result = await conversation.prompt("please answer");
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.code, "model_error");
      assert.equal(result.error.message.includes("private provider detail"), false);
    }
    assert.equal("tools" in conversation, false);
  } finally { await conversation.dispose(); }
});

test("only explicitly injected tools run, consume budget, and report bounded lifecycle events", { timeout: 5000 }, async () => {
  const faux = fauxProvider({ api: "conversation-tools-test", provider: "conversation-tools-test", models: [{ id: "test" }], tokenSize: { min: 8, max: 8 } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_fixture", { path: "safe.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("read complete"),
  ]);
  let called = false;
  const tool = defineTool({ name: "read_fixture", label: "Read fixture", description: "Read the safe in-memory fixture.", parameters: Type.Object({ path: Type.String() }),
    async execute(_id, args) { called = true; return { content: [{ type: "text", text: args.path }], details: {} }; },
  });
  const events: Array<{ phase: string; toolCallId: string; toolName: string; isError?: boolean }> = [];
  const conversation = await createConversationSession({
    cwd: process.cwd(), credentials: new InMemoryCredentialStore(), provider: faux.provider, model: faux.getModel(),
    systemPrompt: "Use only the explicit read fixture tool.", tools: [tool],
    budget: { ...budget, maxToolCalls: 1 },
    pricing: { version: "test-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  try {
    const result = await conversation.prompt("read the fixture", { onToolEvent: (event) => events.push(event) });
    assert.equal(result.status, "completed");
    if (result.status === "completed") assert.equal(result.usage.toolCalls, 1);
    assert.equal(called, true);
    assert.deepEqual(events.map((event) => event.phase), ["started", "finished"]);
    assert.equal(events[0]?.toolCallId, events[1]?.toolCallId);
  } finally { await conversation.dispose(); }
});

test("ordinary conversation cancellation propagates and preserves the context session", { timeout: 5000 }, async () => {
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  const faux = fauxProvider({ api: "conversation-cancel-test", provider: "conversation-cancel-test", models: [{ id: "test" }], tokenSize: { min: 8, max: 8 } });
  faux.setResponses([async (_context, options) => {
    started();
    await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    return fauxAssistantMessage("", { stopReason: "aborted" });
  }]);
  const provider: Provider = { ...faux.provider };
  const conversation = await createConversationSession({
    cwd: process.cwd(), credentials: new InMemoryCredentialStore(), provider, model: faux.getModel(),
    systemPrompt: "Be concise.", budget, pricing: { version: "test-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const controller = new AbortController();
  try {
    const pending = conversation.prompt("cancel this", { signal: controller.signal });
    await start;
    controller.abort();
    const result = await pending;
    assert.equal(result.status, "cancelled");
    if (result.status === "cancelled") assert.equal(result.reason, "user");
    assert.equal(result.usage.modelCalls, 1);
    assert.equal(conversation.busy, false);
  } finally { await conversation.dispose(); }
});

test("PI compaction usage is budgeted and its summary is restored from the public session snapshot", { timeout: 10000 }, async () => {
  const contexts: string[] = [];
  const statuses: string[] = [];
  const faux = fauxProvider({ api: "conversation-compaction-test", provider: "conversation-compaction-test",
    models: [{ id: "test", contextWindow: 256, maxTokens: 64 }], tokenSize: { min: 8, max: 8 } });
  faux.setResponses([
    fauxAssistantMessage("old turn one response"),
    fauxAssistantMessage("old turn two response"),
    fauxAssistantMessage("A durable summary of old turn one."),
  ]);
  const original = faux.provider.streamSimple.bind(faux.provider);
  const provider: Provider = { ...faux.provider, streamSimple(model, context, options) {
    contexts.push(JSON.stringify(context.messages));
    return original(model, context, options);
  } };
  const base = {
    cwd: process.cwd(), credentials: new InMemoryCredentialStore(), provider, model: faux.getModel(),
    systemPrompt: "Answer concisely.", budget: { ...budget, maxModelCalls: 8, maxTokens: 10000 },
    pricing: { version: "compaction-test", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    compactionSettings: { reserveTokens: 240, keepRecentTokens: 16 },
  } satisfies ConversationRuntimeOptions;
  const conversation = await createConversationSession(base);
  let saved: ConversationSessionSnapshot | undefined;
  try {
    assert.equal((await conversation.prompt("old turn one prompt")).status, "completed");
    const second = await conversation.prompt("old turn two prompt", { onCompactionStatus: (status) => statuses.push(status.state) });
    assert.equal(second.status, "completed", JSON.stringify(second));
    if (second.status === "completed") {
      assert.equal(second.usage.modelCalls, 2);
      assert.ok(second.usage.totalTokens >= 100);
      assert.equal(second.usageComplete, true);
    }
    assert.ok(statuses.includes("started"));
    assert.ok(statuses.includes("completed"));
    saved = conversation.snapshot();
  } finally { await conversation.dispose(); }

  assert.ok(saved);
  assert.match(JSON.stringify(saved.entries), /old turn one prompt/u);
  const compactedEntry = saved.entries.find((entry) => entry.type === "compaction");
  assert.ok(compactedEntry);
  if (compactedEntry?.type === "compaction") assert.ok(compactedEntry.usage && compactedEntry.usage.totalTokens > 0);
  faux.setResponses([fauxAssistantMessage("restored successfully")]);
  const restored = await createConversationSession({ ...base, compactionSettings: { reserveTokens: 16, keepRecentTokens: 16 }, restoredSnapshot: saved });
  try {
    faux.setResponses([fauxAssistantMessage("restored successfully")]);
    const result = await restored.prompt("continue after restart");
    assert.equal(result.status, "completed");
    const restoredContext = contexts.at(-1) ?? "";
    assert.match(restoredContext, /A durable summary of old turn one/u);
    assert.doesNotMatch(restoredContext, /old turn one prompt/u);
    assert.match(restoredContext, /continue after restart/u);
  } finally { await restored.dispose(); }
});
