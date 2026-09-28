import {
  createAgentSession, ModelRuntime, SessionManager, SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream,
  type CredentialStore, type Model, type Provider,
} from "@earendil-works/pi-ai";
import type { Budget, CancelReason, Pricing, Usage } from "@pi-workbench/protocol";
import { BudgetLedger } from "./budget.js";
import { resources } from "./resources.js";

export interface ConversationRuntimeOptions {
  cwd: string;
  credentials: CredentialStore;
  provider: Provider;
  model: Model<string>;
  systemPrompt: string;
  budget: Budget;
  pricing: Pricing;
  cancellationGraceMs?: number;
}

export interface ConversationPromptOptions {
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void;
  onCancellationPending?: () => void;
}

export type ConversationTurnResult =
  | { status: "completed"; text: string; usage: Usage }
  | { status: "failed"; error: { code: "model_error" | "runtime_error"; message: string }; usage: Usage }
  | { status: "cancelled"; reason: CancelReason; usage: Usage };

function blockedStream(model: Model<string>): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), stopReason: "aborted", errorMessage: "Runtime cancelled",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  stream.push({ type: "error", reason: "aborted", error: message });
  stream.end(message);
  return stream;
}

/**
 * A process-local, multi-turn PI session for ordinary conversation. This API
 * deliberately has no tools argument: only explicitly registered capability
 * handlers may receive a privileged tool set.
 */
export async function createConversationSession(options: ConversationRuntimeOptions) {
  if (!options.credentials || typeof options.credentials.read !== "function") throw new Error("Explicit credentials are required");
  if (!options.systemPrompt.trim()) throw new Error("An explicit system prompt is required");
  const graceMs = options.cancellationGraceMs ?? 1000;
  if (!Number.isInteger(graceMs) || graceMs < 1 || graceMs > 1000) throw new Error("Invalid cancellation grace");
  if (options.model.provider !== options.provider.id || !options.provider.getModels().some((item) => item.id === options.model.id && item.api === options.model.api)) {
    throw new Error("Model/provider mismatch");
  }

  const runtime = await ModelRuntime.create({ credentials: options.credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerNativeProvider(options.provider);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  try {
    ({ session } = await createAgentSession({
      // Match the single-run adapter: no local resource discovery, built-in tools, extensions or persisted session files.
      cwd: options.cwd, agentDir: options.cwd, modelRuntime: runtime, model: options.model,
      resourceLoader: resources(options.systemPrompt), tools: [], customTools: [],
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    }));
  } catch (error) {
    runtime.unregisterProvider(options.provider.id);
    throw error;
  }

  type ActiveTurn = {
    ledger: BudgetLedger;
    cancelReason?: CancelReason;
    lastAssistant?: AssistantMessage;
    timer?: ReturnType<typeof setTimeout>;
    graceTimer?: ReturnType<typeof setTimeout>;
    eventError: boolean;
    onTextDelta?: (text: string) => void;
    onCancellationPending?: () => void;
  };
  let active: ActiveTurn | undefined;
  let disposed = false;
  let currentPrompt: Promise<ConversationTurnResult> | undefined;
  const originalStream = session.agent.streamFunction;

  function abort(reason: CancelReason): boolean {
    if (!active || active.cancelReason) return false;
    active.cancelReason = reason;
    session.agent.abort();
    active.graceTimer = setTimeout(() => {
      if (active?.cancelReason) {
        try { active.onCancellationPending?.(); } catch { /* Observers cannot break runtime control. */ }
      }
    }, graceMs);
    return true;
  }

  session.agent.streamFunction = (model, context, streamOptions) => {
    const turn = active;
    if (!turn || turn.cancelReason) return blockedStream(model);
    const reason = turn.ledger.modelCall();
    if (reason) { abort(reason); return blockedStream(model); }
    return originalStream(model, context, {
      ...streamOptions,
      maxTokens: Math.min(model.maxTokens, turn.ledger.budget.maxOutputTokens, turn.ledger.budget.maxTokens - turn.ledger.snapshot().totalTokens),
    });
  };
  // Defense in depth: even a future SDK default or extension change cannot expose a tool in ordinary chat.
  session.agent.beforeToolCall = async () => ({ block: true, reason: "No tools are enabled for ordinary conversation", terminate: true });
  session.agent.toolExecution = "sequential";

  function record(event: AgentSessionEvent): void {
    const turn = active;
    if (!turn) return;
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" && !turn.cancelReason) {
      const delta = event.assistantMessageEvent.delta;
      for (let index = 0; index < delta.length; index += 8192) {
        try { turn.onTextDelta?.(delta.slice(index, index + 8192)); } catch { /* UI observer errors do not interrupt the agent. */ }
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      turn.lastAssistant = event.message;
      try {
        turn.ledger.record(event.message.usage);
        const reason = turn.ledger.exhausted();
        if (reason) abort(reason);
      } catch {
        turn.eventError = true;
        session.agent.abort();
      }
    }
  }

  const unsubscribe = session.subscribe((event) => {
    try { record(event); } catch {
      if (active) active.eventError = true;
      session.agent.abort();
    }
  });

  async function prompt(text: string, promptOptions: ConversationPromptOptions = {}): Promise<ConversationTurnResult> {
    if (disposed) throw new Error("Conversation session is disposed");
    if (active) throw new Error("Conversation session is busy");
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 32 * 1024) throw new Error("Invalid conversation prompt");
    const turn: ActiveTurn = {
      ledger: new BudgetLedger(options.budget, options.pricing),
      eventError: false,
      onTextDelta: promptOptions.onTextDelta,
      onCancellationPending: promptOptions.onCancellationPending,
    };
    active = turn;
    const abortFromSignal = () => abort("user");
    if (promptOptions.signal?.aborted) abortFromSignal();
    else promptOptions.signal?.addEventListener("abort", abortFromSignal, { once: true });
    turn.timer = setTimeout(() => abort("timeout"), turn.ledger.budget.timeoutMs);

    const operation = (async (): Promise<ConversationTurnResult> => {
      try {
        if (!turn.cancelReason) {
          await session.prompt(text);
          await session.agent.waitForIdle();
        }
        if (turn.cancelReason) return { status: "cancelled", reason: turn.cancelReason, usage: turn.ledger.snapshot() };
        if (turn.eventError) return { status: "failed", error: { code: "runtime_error", message: "Conversation runtime event validation failed" }, usage: turn.ledger.snapshot() };
        if (!turn.lastAssistant || turn.lastAssistant.stopReason !== "stop") {
          return { status: "failed", error: { code: "model_error", message: "Model did not complete the conversation turn" }, usage: turn.ledger.snapshot() };
        }
        const response = turn.lastAssistant.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        return { status: "completed", text: response.slice(0, 16_000), usage: turn.ledger.snapshot() };
      } catch {
        if (turn.cancelReason) return { status: "cancelled", reason: turn.cancelReason, usage: turn.ledger.snapshot() };
        return { status: "failed", error: { code: "runtime_error", message: "Conversation execution failed" }, usage: turn.ledger.snapshot() };
      } finally {
        clearTimeout(turn.timer);
        clearTimeout(turn.graceTimer);
        promptOptions.signal?.removeEventListener("abort", abortFromSignal);
        if (active === turn) active = undefined;
        currentPrompt = undefined;
      }
    })();
    currentPrompt = operation;
    return operation;
  }

  return {
    prompt,
    addContextMessage(text: string): void {
      if (disposed) throw new Error("Conversation session is disposed");
      if (active) throw new Error("Conversation session is busy");
      if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 12 * 1024) throw new Error("Invalid conversation context message");
      // This is an application-authored user-context entry, not a new tool or model instruction source.
      // Callers may use it only for bounded, successfully validated capability results.
      const message = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
      session.sessionManager.appendMessage(message);
      // Agent owns the active context transcript; SessionManager is the replayable in-memory record.
      session.agent.state.messages = [...session.agent.state.messages, message];
    },
    abort(reason: CancelReason = "user"): boolean { return abort(reason); },
    get busy(): boolean { return active !== undefined; },
    async dispose(): Promise<void> {
      if (disposed) return;
      if (active) {
        abort("user");
        await currentPrompt;
      }
      unsubscribe();
      session.dispose();
      runtime.unregisterProvider(options.provider.id);
      disposed = true;
    },
  };
}
