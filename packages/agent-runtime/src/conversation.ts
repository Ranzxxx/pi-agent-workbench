import { randomUUID } from "node:crypto";
import {
  createAgentSession, ModelRuntime, parseSessionEntries, SessionManager, SettingsManager,
  type FileEntry, type SessionEntry, type SessionHeader,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream,
  type CredentialStore, type Model, type Provider,
} from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Budget, CancelReason, Pricing, Usage } from "@pi-workbench/protocol";
import { BudgetLedger } from "./budget.js";
import { resources } from "./resources.js";

export interface ConversationRuntimeOptions {
  cwd: string;
  credentials: CredentialStore;
  provider: Provider;
  model: Model<string>;
  systemPrompt: string;
  tools?: ToolDefinition[];
  budget: Budget;
  pricing: Pricing;
  /** A continuation shares limits with earlier attempts, while each turn reports its own usage. */
  initialUsage?: Usage;
  initialUsageComplete?: boolean;
  compactionSettings?: { reserveTokens: number; keepRecentTokens: number };
  cancellationGraceMs?: number;
  sessionId?: string;
  restoredSnapshot?: ConversationSessionSnapshot;
  persistSnapshot?: (snapshot: ConversationSessionSnapshot) => void | Promise<void>;
}

export interface ConversationSessionSnapshot {
  formatVersion: "pi-session-v3";
  sdkVersion: "0.86.1";
  sessionId: string;
  header: SessionHeader;
  entries: SessionEntry[];
  leafId: string | null;
}

export interface ConversationPromptOptions {
  signal?: AbortSignal;
  initialUsage?: Usage;
  initialUsageComplete?: boolean;
  onTextDelta?: (text: string) => void;
  onCancellationPending?: () => void;
  onCompactionStatus?: (status: { state: "started" | "completed" | "aborted" | "failed"; reason: "manual" | "threshold" | "overflow" }) => void;
  onToolEvent?: (event: { phase: "started" | "finished"; toolCallId: string; toolName: string; isError?: boolean }) => void;
}

export type ConversationTurnResult =
  | { status: "completed"; text: string; usage: Usage; usageComplete: boolean }
  | { status: "failed"; error: { code: "model_error" | "runtime_error"; message: string }; usage: Usage; usageComplete: boolean }
  | { status: "cancelled"; reason: CancelReason; usage: Usage; usageComplete: boolean };

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
 * A process-local, multi-turn PI session. Only explicitly supplied tools are
 * installed; ordinary conversation callers continue to pass no tools.
 */
export async function createConversationSession(options: ConversationRuntimeOptions) {
  if (!options.credentials || typeof options.credentials.read !== "function") throw new Error("Explicit credentials are required");
  if (!options.systemPrompt.trim()) throw new Error("An explicit system prompt is required");
  if (options.compactionSettings && [options.compactionSettings.reserveTokens, options.compactionSettings.keepRecentTokens].some((value) => !Number.isSafeInteger(value) || value < 1 || value > 100_000)) {
    throw new Error("Invalid compaction settings");
  }
  const graceMs = options.cancellationGraceMs ?? 1000;
  if (!Number.isInteger(graceMs) || graceMs < 1 || graceMs > 1000) throw new Error("Invalid cancellation grace");
  if (options.model.provider !== options.provider.id || !options.provider.getModels().some((item) => item.id === options.model.id && item.api === options.model.api)) {
    throw new Error("Model/provider mismatch");
  }

  const runtime = await ModelRuntime.create({ credentials: options.credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerNativeProvider(options.provider);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  const sessionId = options.restoredSnapshot?.sessionId ?? options.sessionId ?? randomUUID();
  if (options.restoredSnapshot) {
    const restored = options.restoredSnapshot;
    if (restored.formatVersion !== "pi-session-v3" || restored.sdkVersion !== "0.86.1" || restored.sessionId !== restored.header.id ||
      restored.header.type !== "session" || restored.header.cwd !== options.cwd || !Array.isArray(restored.entries)) {
      runtime.unregisterProvider(options.provider.id);
      throw new Error("Stored PI session snapshot is incompatible; original snapshot was not modified");
    }
  }
  const sessionEntries: FileEntry[] = options.restoredSnapshot
    ? [options.restoredSnapshot.header, ...options.restoredSnapshot.entries]
    : [];
  if (options.restoredSnapshot) {
    try { parseSessionEntries(sessionEntries.map((entry) => JSON.stringify(entry)).join("\n")); }
    catch {
      runtime.unregisterProvider(options.provider.id);
      throw new Error("Stored PI session entries are invalid; original snapshot was not modified");
    }
    if (options.restoredSnapshot.leafId !== null && !options.restoredSnapshot.entries.some((entry) => entry.id === options.restoredSnapshot!.leafId)) {
      runtime.unregisterProvider(options.provider.id);
      throw new Error("Stored PI session leaf is invalid; original snapshot was not modified");
    }
  }
  try {
    ({ session } = await createAgentSession({
      // Match the single-run adapter: no local resource discovery, built-in tools, extensions or persisted session files.
      cwd: options.cwd, agentDir: options.cwd, modelRuntime: runtime, model: options.model,
      resourceLoader: resources(options.systemPrompt), tools: (options.tools ?? []).map((tool) => tool.name), customTools: options.tools ?? [],
      sessionManager: SessionManager.inMemory(options.cwd, { id: sessionId }, sessionEntries),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, ...options.compactionSettings }, retry: { enabled: false } }),
    }));
  } catch (error) {
    runtime.unregisterProvider(options.provider.id);
    throw error;
  }
  if (options.restoredSnapshot?.leafId) session.sessionManager.branch(options.restoredSnapshot.leafId);

  type ActiveTurn = {
    ledger: BudgetLedger;
    cancelReason?: CancelReason;
    lastAssistant?: AssistantMessage;
    timer?: ReturnType<typeof setTimeout>;
    graceTimer?: ReturnType<typeof setTimeout>;
    eventError: boolean;
    onCompactionStatus?: ConversationPromptOptions["onCompactionStatus"];
    onTextDelta?: (text: string) => void;
    onCancellationPending?: () => void;
    onToolEvent?: ConversationPromptOptions["onToolEvent"];
  };
  let active: ActiveTurn | undefined;
  let disposed = false;
  let currentPrompt: Promise<ConversationTurnResult> | undefined;
  const originalStream = session.agent.streamFunction;

  function abort(reason: CancelReason): boolean {
    if (!active || active.cancelReason) return false;
    active.cancelReason = reason;
    session.abortCompaction();
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
      maxTokens: Math.min(model.maxTokens, turn.ledger.budget.maxOutputTokens, turn.ledger.remainingTokens()),
    });
  };
  const admittedTools = new Set<string>();
  const toolIds = new Map<string, string>();
  const originalBeforeToolCall = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    const turn = active;
    if (!turn || turn.cancelReason || !admittedTools.has(context.toolCall.id)) {
      return { block: true, reason: "Tool call was not admitted by the workbench runtime", terminate: true };
    }
    return originalBeforeToolCall?.(context, signal);
  };
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
        if ((event.message.stopReason === "error" || event.message.stopReason === "aborted") && event.message.usage.totalTokens === 0 && turn.ledger.snapshot().modelCalls > 0) {
          turn.ledger.markIncomplete();
        }
        const reason = turn.ledger.exhausted();
        if (reason) abort(reason);
      } catch {
        turn.eventError = true;
        session.agent.abort();
      }
    } else if (event.type === "compaction_start") {
      try { turn.onCompactionStatus?.({ state: "started", reason: event.reason }); } catch { /* UI observers do not control runtime. */ }
    } else if (event.type === "compaction_end") {
      if (event.result?.usage) {
        const usage = event.result.usage;
        turn.ledger.record({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
        const reason = turn.ledger.exhausted();
        if (reason && !turn.cancelReason) abort(reason);
      } else turn.ledger.markIncomplete();
      try { turn.onCompactionStatus?.({ state: event.aborted ? "aborted" : event.errorMessage ? "failed" : "completed", reason: event.reason }); } catch { /* UI observers do not control runtime. */ }
    } else if (event.type === "tool_execution_start") {
      const reason = turn.ledger.toolCall();
      if (reason) abort(reason);
      else admittedTools.add(event.toolCallId);
      const toolCallId = randomUUID();
      toolIds.set(event.toolCallId, toolCallId);
      try { turn.onToolEvent?.({ phase: "started", toolCallId, toolName: event.toolName.slice(0, 128) }); } catch { /* UI observers do not control tool execution. */ }
    } else if (event.type === "tool_execution_end") {
      const toolCallId = toolIds.get(event.toolCallId);
      if (!toolCallId) { turn.eventError = true; session.agent.abort(); return; }
      toolIds.delete(event.toolCallId);
      admittedTools.delete(event.toolCallId);
      try { turn.onToolEvent?.({ phase: "finished", toolCallId, toolName: event.toolName.slice(0, 128), isError: event.isError }); } catch { /* UI observers do not control tool execution. */ }
    }
  }

  const unsubscribe = session.subscribe((event) => {
    try { record(event); } catch {
      if (active) { active.eventError = true; active.ledger.markIncomplete(); }
      session.agent.abort();
    }
  });

  function snapshot(): ConversationSessionSnapshot {
    const header = session.sessionManager.getHeader();
    if (!header || header.id !== session.sessionManager.getSessionId()) throw new Error("PI session did not expose a valid public session header");
    return {
      formatVersion: "pi-session-v3", sdkVersion: "0.86.1", sessionId: header.id,
      header: structuredClone(header), entries: structuredClone(session.sessionManager.getEntries()),
      leafId: session.sessionManager.getLeafId(),
    };
  }

  async function persistSnapshot(): Promise<void> {
    if (!options.persistSnapshot) return;
    // Persistence failure is a business failure: never let an unrecorded turn
    // be shown as successful or used as the starting point for another turn.
    await options.persistSnapshot(snapshot());
  }

  async function prompt(text: string, promptOptions: ConversationPromptOptions = {}): Promise<ConversationTurnResult> {
    if (disposed) throw new Error("Conversation session is disposed");
    if (active) throw new Error("Conversation session is busy");
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 32 * 1024) throw new Error("Invalid conversation prompt");
    const turn: ActiveTurn = {
      ledger: new BudgetLedger(options.budget, options.pricing, promptOptions.initialUsage ?? options.initialUsage,
        promptOptions.initialUsageComplete ?? options.initialUsageComplete),
      eventError: false,
      onCompactionStatus: promptOptions.onCompactionStatus,
      onTextDelta: promptOptions.onTextDelta,
      onCancellationPending: promptOptions.onCancellationPending,
      onToolEvent: promptOptions.onToolEvent,
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
        await persistSnapshot();
        if (turn.cancelReason) return { status: "cancelled", reason: turn.cancelReason, usage: turn.ledger.snapshot(), usageComplete: turn.ledger.usageComplete };
        if (turn.eventError) return { status: "failed", error: { code: "runtime_error", message: "Conversation runtime event validation failed" }, usage: turn.ledger.snapshot(), usageComplete: turn.ledger.usageComplete };
        if (!turn.lastAssistant || turn.lastAssistant.stopReason !== "stop") {
          return { status: "failed", error: { code: "model_error", message: "Model did not complete the conversation turn" }, usage: turn.ledger.snapshot(), usageComplete: turn.ledger.usageComplete };
        }
        const response = turn.lastAssistant.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        return { status: "completed", text: response.slice(0, 16_000), usage: turn.ledger.snapshot(), usageComplete: turn.ledger.usageComplete };
      } catch {
        try { await persistSnapshot(); } catch {
          return { status: "failed", error: { code: "runtime_error", message: "Conversation session could not be persisted" }, usage: turn.ledger.snapshot(), usageComplete: turn.ledger.usageComplete };
        }
        if (turn.cancelReason) return { status: "cancelled", reason: turn.cancelReason, usage: turn.ledger.snapshot(), usageComplete: turn.ledger.usageComplete };
        return { status: "failed", error: { code: "runtime_error", message: "Conversation execution failed" }, usage: turn.ledger.snapshot(), usageComplete: turn.ledger.usageComplete };
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
    snapshot,
    persistSnapshot,
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
