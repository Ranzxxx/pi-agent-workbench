import { randomUUID } from "node:crypto";
import {
  createAgentSession, ModelRuntime, SessionManager, SettingsManager,
  type AgentSessionEvent, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, type AssistantMessageEventStream, type AssistantMessage, type CredentialStore, type Model, type Provider,
} from "@earendil-works/pi-ai";
import {
  RunInputSchema, CancelReasonSchema, parse, parseArtifacts, parseEvent, parseResult,
  type Artifact, type Budget, type CancelReason, type Pricing, type RunEvent,
  type RunInput, type RunResult, type RunState, type Usage,
} from "@pi-workbench/protocol";
import { BudgetLedger } from "./budget.js";
import { resources } from "./resources.js";

// Composition roots and tool packages can use these through the adapter boundary.
export { InMemoryCredentialStore } from "@earendil-works/pi-ai";
export { defineTool } from "@earendil-works/pi-coding-agent";
export type { CredentialStore, Model, Provider, ToolDefinition };
export {
  createConversationSession,
  type ConversationRuntimeOptions,
  type ConversationPromptOptions,
  type ConversationTurnResult,
} from "./conversation.js";

export interface RuntimeOptions {
  cwd: string;
  credentials: CredentialStore;
  provider: Provider;
  model: Model<string>;
  systemPrompt: string;
  tools: ToolDefinition[];
  budget: Budget;
  /** USD per million tokens; callers must supply a known, versioned price table. */
  pricing: Pricing;
  /**
   * 应用层的成功门：先校验报告内容/证据，再发布产物并返回引用。
   * 运行时只校验引用协议；不能仅凭模型 stop 就认定业务完成。
   */
  finalize: (input: { text: string; signal: AbortSignal; usage: Usage }) => Promise<Artifact[]>;
  onEvent?: (event: RunEvent) => void;
  cancellationGraceMs?: number;
}

export class CancellationPendingError extends Error {
  constructor() { super("Cancellation requested; operation has not settled"); }
}

function blockedStream(model: Model<string>): AssistantMessageEventStream {
  // SDK 期望拿到标准消息流；预算/取消拒绝调用时，用 aborted 流结束 Agent 循环。
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

export async function createSession(options: RuntimeOptions) {
  const ledger = new BudgetLedger(options.budget, options.pricing);
  // 配置必须由应用显式注入，避免悄悄退回用户本机的模型配置或提示词。
  if (!options.credentials || typeof options.credentials.read !== "function") throw new Error("Explicit credentials are required");
  const graceMs = options.cancellationGraceMs ?? 1000;
  if (!Number.isInteger(graceMs) || graceMs < 1 || graceMs > 1000) throw new Error("Invalid cancellation grace");
  if (!options.systemPrompt.trim()) throw new Error("An explicit system prompt is required");
  const tools = [...options.tools];
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("Duplicate tool name");
  if (tools.some((tool) => !/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name))) throw new Error("Invalid tool name");
  if (options.model.provider !== options.provider.id || !options.provider.getModels().some((m) => m.id === options.model.id && m.api === options.model.api)) throw new Error("Model/provider mismatch");
  const runtime = await ModelRuntime.create({ credentials: options.credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerNativeProvider(options.provider);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  try {
    ({ session } = await createAgentSession({
      // 会话数据只在内存中；resourceLoader 与显式工具列表同时关闭本机资源自动发现。
      cwd: options.cwd, agentDir: options.cwd, modelRuntime: runtime, model: options.model,
      resourceLoader: resources(options.systemPrompt), tools: tools.map((tool) => tool.name), customTools: tools,
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    }));
  } catch (error) {
    runtime.unregisterProvider(options.provider.id);
    throw error;
  }
  const runId = randomUUID(), attemptId = randomUUID();
  let state: RunState = "queued";
  let sequence = 0, observerErrors = 0;
  let cancelReason: CancelReason | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let eventError = false;
  let completion: Promise<RunResult> | undefined;
  let lastAssistant: AssistantMessage | undefined;
  const finalization = new AbortController();
  const toolIds = new Map<string, string>();
  const admittedTools = new Set<string>();
  let rejectPending!: (error: Error) => void;
  const pending = new Promise<never>((_, reject) => { rejectPending = reject; });
  // A cancellation may happen before run() attaches its race handler.
  void pending.catch(() => {});

  type EventPayload = RunEvent extends infer E ? E extends RunEvent ? Pick<E, "type" | "data"> : never : never;
  function emit(payload: EventPayload): void {
    // 所有 SDK 事件先映射为版本化公共协议；观察者异常不能打断 Agent 执行。
    const event = parseEvent({ schemaVersion: 1, eventId: randomUUID(), runId, attemptId, sequence: ++sequence, timestamp: new Date().toISOString(), ...payload });
    try { options.onEvent?.(structuredClone(event)); } catch { observerErrors++; }
  }
  function abort(reason: CancelReason = "user"): boolean {
    parse(CancelReasonSchema, reason);
    // 只接受第一个取消原因；宽限期内等待 PI 协作退出，未退出时报告 pending 而不伪造终态。
    if (state !== "running") return false;
    cancelReason = reason;
    state = "cancelling";
    finalization.abort();
    session.agent.abort();
    graceTimer = setTimeout(() => {
      if (state === "cancelling") {
        emit({ type: "run.warning", data: { code: "cancellation_pending" } });
        rejectPending(new CancellationPendingError());
      }
    }, graceMs);
    emit({ type: "run.cancelling", data: { reason } });
    return true;
  }
  function checkDeadline(): void {
    if (deadline && performance.now() >= deadline) abort("timeout");
  }
  let deadline = 0;
  const originalStream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, streamOptions) => {
    // 每次真实模型调用前检查预算，并限制单次最大输出；在途调用的最终费用仍可能超估算。
    checkDeadline();
    if (cancelReason) return blockedStream(model);
    const reason = ledger.modelCall();
    if (reason) { abort(reason); return blockedStream(model); }
    return originalStream(model, context, {
      ...streamOptions,
      maxTokens: Math.min(model.maxTokens, ledger.budget.maxOutputTokens, ledger.budget.maxTokens - ledger.snapshot().totalTokens),
    });
  };
  // Admission is recorded on tool_execution_start (including invalid arguments).
  // The hook gates valid tool bodies after SDK argument validation.
  const originalBeforeTool = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    checkDeadline();
    if (cancelReason || !admittedTools.has(context.toolCall.id)) return { block: true, reason: "Runtime cancelled", terminate: true };
    return originalBeforeTool?.(context, signal);
  };
  session.agent.toolExecution = "sequential";
  function record(event: AgentSessionEvent): void {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" && !cancelReason) {
      const delta = event.assistantMessageEvent.delta;
      for (let i = 0; i < delta.length; i += 8192) emit({ type: "text.delta", data: { text: delta.slice(i, i + 8192) } });
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      // 用 provider 返回的实际 usage 累加预算；思考 Token 已包含在输出 Token 中。
      lastAssistant = event.message;
      ledger.record(event.message.usage);
      const reason = ledger.exhausted();
      if (reason) abort(reason);
    } else if (event.type === "tool_execution_start") {
      // 在 SDK 校验工具参数前计数，因而无效参数也消耗一次配额；执行体仍由 beforeToolCall 控门。
      checkDeadline();
      const reason = cancelReason ?? ledger.toolCall();
      if (reason) abort(reason); else admittedTools.add(event.toolCallId);
      const publicId = randomUUID();
      toolIds.set(event.toolCallId, publicId);
      emit({ type: "tool.started", data: { toolCallId: publicId, toolName: /^[a-zA-Z0-9_-]{1,128}$/.test(event.toolName) ? event.toolName : "unknown", argumentsSummary: "omitted" } });
    } else if (event.type === "tool_execution_end") {
      const publicId = toolIds.get(event.toolCallId);
      if (!publicId) throw new Error("Tool result without start");
      toolIds.delete(event.toolCallId);
      admittedTools.delete(event.toolCallId);
      emit({ type: "tool.finished", data: { toolCallId: publicId, toolName: /^[a-zA-Z0-9_-]{1,128}$/.test(event.toolName) ? event.toolName : "unknown", isError: event.isError, summary: cancelReason ? "cancelled" : event.isError ? "tool_error" : "ok" } });
    }
  }
  const unsubscribe = session.subscribe((event) => {
    try { record(event); } catch { eventError = true; session.agent.abort(); }
  });
  function cleanup(): void {
    // 结束时统一撤销监听、释放会话并注销 provider；重复清理保持安全。
    if (disposed) return;
    clearTimeout(timer); clearTimeout(graceTimer);
    unsubscribe(); session.dispose(); runtime.unregisterProvider(options.provider.id);
    disposed = true;
  }
  // 唯一的业务终态出口：结果先过协议校验，再更新 state 并发出 run.finished。
  function finish(outcome: { status: "completed"; artifacts: Artifact[] } | { status: "failed"; error: Extract<RunResult, { status: "failed" }>["error"] } | { status: "cancelled"; reason: CancelReason }): RunResult {
    const result = parseResult({ schemaVersion: 1, runId, attemptId, usage: ledger.snapshot(), endedAt: new Date().toISOString(), ...outcome });
    state = result.status;
    clearTimeout(timer); clearTimeout(graceTimer);
    emit({ type: "run.finished", data: result });
    return structuredClone(result);
  }
  function failure(code: "model_error" | "invalid_result" | "runtime_error", message: string): RunResult {
    return finish({ status: "failed", error: { code, message } });
  }
  async function execute(input: RunInput): Promise<RunResult> {
    try {
      await session.prompt(JSON.stringify(input));
      await session.agent.waitForIdle();
      checkDeadline();
      if (cancelReason) return finish({ status: "cancelled", reason: cancelReason });
      if (eventError) return failure("runtime_error", "Runtime event validation failed");
      if (lastAssistant?.stopReason !== "stop") return failure("model_error", "Model did not complete successfully");
      const text = lastAssistant.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      let artifacts: Artifact[];
      try {
        // finalize 承担应用的报告校验/发布；取消信号让应用避免取消后继续发布。
        artifacts = parseArtifacts(await options.finalize({ text, signal: finalization.signal, usage: ledger.snapshot() }));
      } catch {
        if (cancelReason) return finish({ status: "cancelled", reason: cancelReason });
        return failure("invalid_result", "Application result validation failed");
      }
      checkDeadline();
      if (cancelReason) return finish({ status: "cancelled", reason: cancelReason });
      return finish({ status: "completed", artifacts });
    } catch {
      if (cancelReason) return finish({ status: "cancelled", reason: cancelReason });
      return failure("runtime_error", "Agent execution failed");
    } finally { cleanup(); }
  }
  return {
    runId, attemptId,
    get state(): RunState { return state; },
    get observerErrors(): number { return observerErrors; },
    abort,
    run(input: RunInput): Promise<RunResult> {
      // 一个会话只运行一次；复制并校验输入，避免调用方修改运行中的数据。
      if (state !== "queued" || disposed) return Promise.reject(new Error("Session is single-use"));
      const validated = structuredClone(parse(RunInputSchema, input));
      state = "running";
      deadline = performance.now() + ledger.budget.timeoutMs;
      timer = setTimeout(() => abort("timeout"), ledger.budget.timeoutMs);
      emit({ type: "run.started", data: validated });
      completion = execute(validated);
      return Promise.race([completion, pending]);
    },
    /** Still resolves only when the underlying operation has really settled. */
    waitForResult(): Promise<RunResult> {
      return completion ?? Promise.reject(new Error("Run has not started"));
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      if (completion) {
        abort("user");
        await Promise.race([completion, pending]);
      } else cleanup();
    },
  };
}
