import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, type Provider } from "@earendil-works/pi-ai";
import { createConversationSession, InMemoryCredentialStore, type ConversationRuntimeOptions } from "../src/index.js";

const budget = { timeoutMs: 2000, maxModelCalls: 4, maxToolCalls: 0, maxTokens: 32000, maxOutputTokens: 2000, maxCostUsd: 0.2 };

test("ordinary conversation keeps multiple prompts in one in-memory PI session", { timeout: 5000 }, async () => {
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
  const conversation = await createConversationSession({
    cwd: process.cwd(), credentials: new InMemoryCredentialStore(), provider, model: faux.getModel(),
    systemPrompt: "Be concise. Do not use tools.", budget,
    pricing: { version: "test-zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  try {
    assert.deepEqual((await conversation.prompt("first question")).status, "completed");
    conversation.addContextMessage("Successfully validated capability result: {\"claims\":[\"bounded fact\"]}");
    const second = await conversation.prompt("follow-up question");
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
  } finally { await conversation.dispose(); }
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
