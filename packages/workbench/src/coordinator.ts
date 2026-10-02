import { randomUUID, createHash } from "node:crypto";
import { readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { StorageError, openStorage, resolveDataDirectory, type JsonValue, type Storage, type WorkerIdentityRecord } from "@pi-workbench/storage";
import {
  parse, parseV2Error, parseV2Run, parseV2RunEvent, parseV2EventCursor, parseWorkbenchEvent, parseWorkbenchResult,
  RunSubmissionSchema, V2CreateRunSubmissionSchema, V2RunSubmissionSchema, V2ImportResultSchema, V2ProjectSchema, V2ProjectRulesSchema, V2ChangesetSchema, V2ChangesetSummarySchema,
  V2FileOperationSchema, V2FileDiffSchema, V2AttachmentResultSchema, V2CleanupPreviewSchema, V2CleanupResultSchema, V2ChangesetUndoResultSchema,
  WorkbenchStreamResetSchema,
  type Conversation, type ConversationMessage, type ConversationSummary, type V2Conversation,
  type V2ConversationSummary, type V2CreateRunSubmission, type V2Error, type V2EventCursor, type V2ImportResult, type V2Project, type V2ProjectRules, type V2Run, type V2RunEvent, type V2RunStatus, type V2RunSubmission,
  type V2Changeset, type V2ChangesetSummary, type V2AttachmentResult, type V2CleanupPreview, type V2CleanupResult, type V2ChangesetUndoResult,
  type WorkbenchArtifact, type WorkbenchEvent, type WorkbenchResult, type WorkbenchRun, type WorkbenchRunStatus, type WorkbenchStreamReset,
} from "@pi-workbench/protocol";
import type { ConversationSessionSnapshot } from "@pi-workbench/agent-runtime";
import { WorkerClient, type WorkerTaskResult } from "./worker-client.js";
import type { WorkerEventPayload } from "./worker-ipc.js";
import { createCapabilityRegistry, CapabilityRegistryError, publicRepositoryCapability } from "./registry.js";
import { createPublicRepositoryAnalysisExtension } from "./public-repository-extension.js";
import { createDevelopmentGreetingExtension } from "./development-extension.js";
import type { WorkbenchMode } from "./model-config.js";
import { ProjectPickerService, type PickerSessionStart } from "./project-picker.js";
import { recoverPreparedFileOperations } from "./file-journal.js";
import { createPersistedFileJournal } from "./file-journal.js";
import { createProjectFileAccess } from "@pi-workbench/tools";
import { readFileBackup, readManagedObject } from "./managed-object-store.js";

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const EVENT_LIMIT = 1000;
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export interface WorkbenchServiceOptions {
  mode: WorkbenchMode; apiKey?: string; githubToken?: string; dataDirectory?: string; fixtureRoot?: string;
  workerEntryPath?: string; workerStartupTimeoutMs?: number; pickerRoots?: string[];
}
export interface WorkbenchError extends Error {
  statusCode: number;
  code: V2Error["code"] | "unsupported_capability" | "idempotency_conflict";
  retryable?: boolean;
}
export interface EventSubscription {
  replay: WorkbenchEvent[]; reset?: WorkbenchStreamReset;
  finished: boolean; unsubscribe: () => void;
}
export interface V2EventSubscription {
  replay: V2RunEvent[]; reset?: { schemaVersion: 2; type: "stream.reset"; runId: string; data: { reason: "event_history_expired"; earliestAvailableSequence: number; latestSequence: number; latestEventId?: string } };
  finished: boolean; unsubscribe: () => void;
}

function makeError(code: WorkbenchError["code"], message: string, statusCode: number, retryable = false): WorkbenchError {
  const error = new Error(message) as WorkbenchError;
  error.code = code; error.statusCode = statusCode; error.retryable = retryable;
  return error;
}
function now(): string { return new Date().toISOString(); }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function terminal(status: V2RunStatus): boolean { return ["completed", "failed", "cancelled", "interrupted"].includes(status); }
function extensionPrompt(input: Extract<V2RunSubmission, { kind: "capability" }>): string {
  return input.prompt ?? (typeof input.input.goal === "string" ? input.input.goal : "");
}
function workerFailureError(code: string, message: string): V2Error {
  const extensionCodes = new Set([
    "unknown_extension", "extension_disabled", "extension_unconfigured", "extension_incompatible",
    "extension_permission_denied", "extension_invalid_input", "extension_invalid_config",
  ]);
  return parseV2Error({ schemaVersion: 2, code: extensionCodes.has(code) ? code : "internal_error", message: message.slice(0, 512) || "Run failed.", retryable: false });
}
function legacyStatus(status: V2RunStatus): WorkbenchRunStatus {
  if (status === "accepted") return "queued";
  if (status === "interrupted") throw makeError("upgrade_required", "This run uses the v2 interrupted state; use the v2 API.", 426);
  return status;
}
function displayText(input: V2CreateRunSubmission | V2RunSubmission, capabilityName: string): string {
  return input.kind === "message" ? input.text : `已请求“${capabilityName}”：${extensionPrompt(input)}`;
}
function titleFor(input: V2CreateRunSubmission | V2RunSubmission, capabilityName: string): string {
  const text = input.kind === "message" ? input.text : `${capabilityName}：${extensionPrompt(input)}`;
  return text.replace(/\s+/gu, " ").trim().slice(0, 72) || "新对话";
}
type CapabilityConversationMessage = Extract<ConversationMessage, { role: "capability" }>;
function parseCapabilityMessage(record: { role: string; content: string; extensionId: string | null }): Pick<CapabilityConversationMessage, "capabilityId" | "input"> | undefined {
  if (record.role !== "capability" || record.extensionId !== publicRepositoryCapability.id) return undefined;
  try {
    const parsed = JSON.parse(record.content) as { display?: unknown; input?: unknown };
    if (typeof parsed.display !== "string") return undefined;
    const input = parse(RunSubmissionSchema, { kind: "capability", capabilityId: publicRepositoryCapability.id, input: parsed.input });
    return input.kind === "capability" ? { capabilityId: input.capabilityId, input: input.input } : undefined;
  } catch { return undefined; }
}
function storedCapabilityMessage(record: { role: string; content: string; extensionId: string | null }): { capabilityId: string; input: Record<string, unknown>; display: string } | undefined {
  if (record.role !== "capability" || !record.extensionId) return undefined;
  try {
    const parsed = JSON.parse(record.content) as { display?: unknown; input?: unknown };
    if (typeof parsed.display !== "string" || !parsed.input || typeof parsed.input !== "object" || Array.isArray(parsed.input)) return undefined;
    return { capabilityId: record.extensionId, input: parsed.input as Record<string, unknown>, display: parsed.display };
  } catch { return undefined; }
}
function serializeCapabilityContent(input: Extract<V2RunSubmission, { kind: "capability" }>, capabilityName: string): string {
  return JSON.stringify({ display: displayText(input, capabilityName), input: input.input });
}

function procStart(pid: number): Promise<string | undefined> {
  return readFile(`/proc/${pid}/stat`, "utf8").then((text) => {
    const end = text.lastIndexOf(") ");
    if (end < 0) return undefined;
    return text.slice(end + 2).trim().split(/\s+/u)[19];
  }).catch(() => undefined);
}
async function identityState(identity: WorkerIdentityRecord, entryPath: string): Promise<"alive" | "dead" | "unknown"> {
  const started = await procStart(identity.pid);
  if (started === undefined) return "dead";
  if (started !== identity.processStart) return "dead";
  try {
    const command = await readFile(`/proc/${identity.pid}/cmdline`, "utf8");
    return command.includes(entryPath) ? "alive" : "dead";
  } catch { return "unknown"; }
}
async function waitIdentityGone(identity: WorkerIdentityRecord, entryPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await identityState(identity, entryPath) === "dead") return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return (await identityState(identity, entryPath)) === "dead";
}

export async function createWorkbenchService(options: WorkbenchServiceOptions) {
  const dataDirectory = path.resolve(options.dataDirectory ?? resolveDataDirectory());
  const fixtureRoot = path.resolve(options.fixtureRoot ?? path.join(process.cwd(), "fixtures", "synthetic-ts-repo"));
  const workerEntryPath = path.resolve(options.workerEntryPath ?? new URL("../../../apps/worker/src/main.ts", import.meta.url).pathname);
  const storage = openStorage({ dataDirectory: { dataDirectory } });
  const picker = new ProjectPickerService(storage, dataDirectory, options.pickerRoots ?? []);
  await picker.initialize();
  const capabilityRegistry = createCapabilityRegistry([
    createPublicRepositoryAnalysisExtension({ mode: options.mode, dataDirectory, fixtureRoot, apiKey: options.apiKey, githubToken: options.githubToken }),
    createDevelopmentGreetingExtension(),
  ]);
  const subscribers = new Map<string, Set<(event: V2RunEvent) => void>>();
  let worker: WorkerClient | undefined;
  let activeExecution: Promise<void> | undefined;
  let workerUnavailable = false;
  let fileMutationActive = false;
  let closing = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function getRunRecord(runId: string) {
    const run = storage.runs.get(runId);
    if (!run) throw makeError("not_found", "Run not found.", 404);
    return run;
  }
  function getConversationRecord(conversationId: string) {
    const record = storage.conversations.get(conversationId);
    if (!record) throw makeError("not_found", "Conversation not found.", 404);
    return record;
  }
  function conversationMessages(conversationId: string): ConversationMessage[] {
    return storage.messages.list(conversationId).map((message) => {
      if (message.role === "capability") {
        const restored = parseCapabilityMessage(message);
        if (restored) return { schemaVersion: 1 as const, id: message.id, role: "capability" as const, text: JSON.parse(message.content).display as string, createdAt: message.createdAt, ...restored };
        const generic = storedCapabilityMessage(message);
        if (generic) return { schemaVersion: 1 as const, id: message.id, role: "assistant" as const, text: generic.display.slice(0, 16_000), createdAt: message.createdAt };
      }
      return { schemaVersion: 1 as const, id: message.id, role: message.role as "user" | "assistant", text: message.content.slice(0, 16_000), createdAt: message.createdAt };
    });
  }
  function v2Conversation(conversationId: string): V2Conversation {
    const record = getConversationRecord(conversationId);
    const messages = storage.messages.list(conversationId).map((message) => {
      const capability = storedCapabilityMessage(message);
      return {
        schemaVersion: 2 as const, messageId: message.id, conversationId, sequence: message.sequence,
        role: message.role, content: capability ? capability.display : message.content,
        createdAt: message.createdAt, extensionId: message.extensionId, ...(capability ? { capabilityInput: capability.input } : {}),
      };
    });
    const last = messages.at(-1);
    return {
      schemaVersion: 2, conversationId, title: record.title, projectId: record.projectId, createdAt: record.createdAt, updatedAt: record.updatedAt,
      preview: (last?.content ?? "").replace(/\s+/gu, " ").slice(0, 256), messageCount: messages.length, messages,
    };
  }
  function v2Summary(conversationId: string): V2ConversationSummary {
    const conversation = v2Conversation(conversationId);
    return {
      schemaVersion: 2, conversationId, title: conversation.title, projectId: conversation.projectId, createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt, preview: conversation.preview, messageCount: conversation.messageCount,
    };
  }
  function v2Run(runId: string): V2Run {
    const record = getRunRecord(runId);
    const { request, ...base } = record;
    const input = parse(V2RunSubmissionSchema, request);
    const stored = storage.results.get(runId) as { result?: unknown; artifacts?: unknown } | undefined;
    const result = stored?.result ? parseWorkbenchResult(stored.result) : undefined;
    const currentAttempt = storage.attempts.list(runId).at(-1);
    return parseV2Run({
      ...base, input, ...(currentAttempt ? { currentAttemptId: currentAttempt.attemptId } : {}),
      ...(result ? { result } : {}), endedAt: record.endedAt,
    });
  }
  function legacyConversation(conversationId: string): Conversation {
    const value = v2Conversation(conversationId);
    const messages = conversationMessages(conversationId);
    return { schemaVersion: 1, conversationId, title: value.title.slice(0, 128), createdAt: value.createdAt, updatedAt: value.updatedAt, preview: value.preview, messageCount: messages.length, messages };
  }
  function legacySummary(conversationId: string): ConversationSummary {
    const conversation = legacyConversation(conversationId);
    return { schemaVersion: 1, conversationId, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, preview: conversation.preview, messageCount: conversation.messageCount };
  }
  function legacyRun(runId: string): WorkbenchRun {
    const run = v2Run(runId);
    const input = run.input?.kind === "capability"
      ? (run.input.capabilityId === publicRepositoryCapability.id
        ? { kind: "capability" as const, capabilityId: publicRepositoryCapability.id as "public_repository_analysis", input: {
          repositoryUrl: String(run.input.input.repositoryUrl ?? "https://github.com/demo/harborlight"),
          ...(typeof run.input.input.ref === "string" ? { ref: run.input.input.ref } : {}),
          goal: run.input.prompt ?? (typeof run.input.input.goal === "string" ? run.input.input.goal : "扩展运行记录"),
        } }
        : { kind: "message" as const, text: `已调用扩展 ${run.input.capabilityId}：${run.input.prompt ?? ""}` })
      : run.input!;
    return {
      schemaVersion: 1, runId: run.runId, conversationId: run.conversationId,
      status: legacyStatus(run.status), createdAt: run.createdAt, updatedAt: run.updatedAt,
      input, ...(run.retryOfRunId ? { retryOfRunId: run.retryOfRunId } : {}), ...(run.result ? { result: run.result } : {}),
    };
  }

  function publish(runId: string, event: V2RunEvent): void {
    for (const listener of [...(subscribers.get(runId) ?? [])]) { try { listener(structuredClone(event)); } catch { /* SSE observers do not control execution. */ } }
  }
  function appendV2(runId: string, event: Omit<V2RunEvent, "schemaVersion" | "eventId" | "runId" | "attemptId" | "sequence" | "timestamp">, publishAfterInsert = true): V2RunEvent {
    const run = getRunRecord(runId);
    const attempt = storage.attempts.list(runId).at(-1);
    if (!attempt) throw makeError("conflict", "Run has no attempt for event persistence.", 409);
    const persisted = storage.events.append({
      eventId: randomUUID(), runId, attemptId: attempt.attemptId, type: event.type, data: event.data,
    });
    if (publishAfterInsert) publish(runId, persisted);
    return persisted;
  }
  function appendAccepted(runId: string): void {
    const run = getRunRecord(runId);
    appendV2(runId, { type: "run.accepted", data: { conversationId: run.conversationId, requestHash: run.requestHash } });
  }
  function appendStarted(runId: string, bootId: string): void {
    appendV2(runId, { type: "run.started", data: { workerBootId: bootId } });
  }
  function persistWorkerEvent(runId: string, event: WorkerEventPayload): void {
    const run = getRunRecord(runId);
    if (event.type === "run.started" || event.type === "run.finished") return;
    if (event.type === "message.delta") appendV2(runId, { type: "message.delta", data: event.data });
    else if (event.type === "capability.started") appendV2(runId, { type: "run.progress", data: { phase: "capability", message: event.data.label } });
    else if (event.type === "tool.started") appendV2(runId, { type: "tool.started", data: { toolCallId: event.data.toolCallId, toolName: event.data.toolName, argumentsSummary: "omitted" } });
    else if (event.type === "tool.finished") appendV2(runId, { type: "tool.finished", data: { toolCallId: event.data.toolCallId, toolName: event.data.toolName, isError: event.data.isError } });
    else if (event.type === "file_change_prepared") appendV2(runId, { type: "file_change_prepared", data: event.data });
    else if (event.type === "file_change_applied") appendV2(runId, { type: "file_change_applied", data: event.data });
    else if (event.type === "file_change_conflict") appendV2(runId, { type: "file_change_conflict", data: event.data });
    else if (event.type === "workflow_progress") appendV2(runId, { type: "run.progress", data: event.data });
    else if (event.type === "checkpoint_saved") appendV2(runId, { type: "checkpoint.saved", data: event.data });
    else if (event.type === "runtime_status") appendV2(runId, { type: "run.progress", data: {
      phase: "compaction", message: `Context compaction ${event.data.state} (${event.data.reason}).`,
    } });
    else if (event.type === "run.cancelling") {
      if (run.status !== "cancelling") storage.runs.updateStatus(runId, "cancelling");
      appendV2(runId, { type: "run.cancelling", data: { reason: event.data.reason } });
    } else if (event.type === "run.warning") appendV2(runId, { type: "run.progress", data: { phase: "cancellation", message: "Cancellation is waiting for active work to stop." } });
  }

  async function setWorkerIdentityStatus(status: WorkerIdentityRecord["status"]): Promise<void> {
    if (!worker) return;
    storage.workerIdentity.setStatus(worker.bootId, status);
  }
  async function markInterrupted(runId: string, reason: "process_exit" | "state_uncertain"): Promise<void> {
    let event: V2RunEvent | undefined;
    storage.transaction(() => {
      const run = storage.runs.get(runId);
      if (!run || terminal(run.status)) return;
      const attempt = storage.attempts.list(runId).at(-1);
      if (attempt?.status === "running") storage.attempts.finish(attempt.attemptId, "interrupted", now());
      const current = storage.runs.get(runId)!;
      if (["accepted", "running", "cancelling"].includes(current.status)) storage.runs.updateStatus(runId, "interrupted", now(), now());
      if (attempt) event = appendV2(runId, { type: "run.interrupted", data: { reason } }, false);
      const slot = storage.activeSlot.get();
      if (slot.runId === runId && slot.claimToken) storage.activeSlot.release({ runId, claimToken: slot.claimToken, generation: slot.generation });
    });
    if (event) publish(runId, event);
  }
  async function recoverPreviousWorker(): Promise<void> {
    const identity = storage.workerIdentity.get();
    const slot = storage.activeSlot.get();
    if (!identity) {
      if (slot.runId) {
        workerUnavailable = true;
        const active = storage.runs.get(slot.runId);
        if (active) storage.conversations.update(active.conversationId, { status: "recovery_required" });
        return;
      }
      return;
    }
    const state = await identityState(identity, workerEntryPath);
    if (state === "unknown") {
      storage.workerIdentity.setStatus(identity.bootId, "uncertain");
      workerUnavailable = true;
      return;
    }
    if (state === "alive") {
      try { process.kill(identity.pid, "SIGTERM"); } catch { /* Identity is checked again below. */ }
      let stopped = await waitIdentityGone(identity, workerEntryPath, 4_000);
      if (!stopped) {
        try { process.kill(identity.pid, "SIGKILL"); } catch { /* Keep the active slot unless exit is confirmed. */ }
        stopped = await waitIdentityGone(identity, workerEntryPath, 2_000);
      }
      if (!stopped) {
        storage.workerIdentity.setStatus(identity.bootId, "uncertain");
        workerUnavailable = true;
        return;
      }
    }
    storage.workerIdentity.clear(identity.bootId);
    if (slot.runId) await markInterrupted(slot.runId, "process_exit");
  }
  async function startWorker(): Promise<void> {
    if (workerUnavailable || storage.activeSlot.get().runId) return;
    let candidate: WorkerClient | undefined;
    try {
      candidate = await WorkerClient.start({
        entryPath: workerEntryPath, dataDirectory, fixtureRoot, mode: options.mode,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}), ...(options.githubToken ? { githubToken: options.githubToken } : {}),
        ...(options.workerStartupTimeoutMs ? { startupTimeoutMs: options.workerStartupTimeoutMs } : {}),
      });
      const processStart = await procStart(candidate.pid);
      if (!processStart) throw new Error("Worker process identity could not be verified");
      const startedAt = now();
      storage.workerIdentity.save({ bootId: candidate.bootId, pid: candidate.pid, processStart, status: "idle", startedAt, heartbeatAt: startedAt });
      worker = candidate;
    } catch {
      workerUnavailable = true;
      if (candidate && await candidate.shutdown()) worker = undefined;
      else worker = candidate;
    }
  }
  function recoverRunAfterExit(runId: string): void {
    void markInterrupted(runId, "process_exit").then(async () => {
      if (worker && !worker.isAlive) {
        storage.workerIdentity.clear(worker.bootId);
        worker = undefined;
      }
      await recoverPreparedFileOperations(storage);
      if (!closing) await startWorker();
    }).catch(() => {
      workerUnavailable = true;
      if (worker) { try { storage.workerIdentity.setStatus(worker.bootId, "uncertain"); } catch { /* Preserve DB failure state. */ } }
    });
  }

  await recoverPreviousWorker();
  if (!workerUnavailable) await recoverPreparedFileOperations(storage);
  await startWorker();
  heartbeat = setInterval(() => {
    const slot = storage.activeSlot.get();
    if (!slot.runId || !slot.claimToken) return;
    try {
      const heartbeatAt = now();
      storage.activeSlot.heartbeat({ runId: slot.runId, claimToken: slot.claimToken, generation: slot.generation, heartbeatAt, leaseExpiresAt: new Date(Date.now() + 5_000).toISOString() });
      if (worker) storage.workerIdentity.setStatus(worker.bootId, "running", heartbeatAt);
    } catch {
      workerUnavailable = true;
      if (worker && slot.runId) worker.cancel(slot.runId);
    }
  }, 1_000);
  heartbeat.unref();

  async function beginExecution(runId: string): Promise<void> {
    const client = worker;
    if (!client || workerUnavailable) throw makeError("worker_unavailable", "The Worker is not confirmed ready; no model call was started.", 503, true);
    const run = getRunRecord(runId);
    const attempts = storage.attempts.list(runId);
    const currentAttempt = attempts.at(-1);
    if (!currentAttempt) throw makeError("conflict", "Run has no active attempt.", 409);
    const priorAttempts = attempts.slice(0, -1);
    let initialUsage: import("@pi-workbench/protocol").Usage | undefined;
    let initialUsageComplete = true;
    if (priorAttempts.length) {
      const records = priorAttempts.map((attempt) => ({ attempt, usage: storage.usage.get(attempt.attemptId) }));
      const pricingVersion = records.find((item) => item.usage?.pricingVersion)?.usage?.pricingVersion ?? "unknown-pricing";
      initialUsageComplete = records.every((item) => item.attempt.usageComplete && item.usage && item.usage.costStatus !== "unknown" && item.usage.pricingVersion === pricingVersion);
      if (records.every((item) => item.usage)) {
        initialUsage = {
          modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          totalTokens: 0, estimatedCostUsd: 0, pricingVersion,
        };
        for (const { usage } of records) {
          initialUsage.modelCalls += usage!.modelCalls; initialUsage.toolCalls += usage!.toolCalls;
          initialUsage.inputTokens += usage!.inputTokens; initialUsage.outputTokens += usage!.outputTokens;
          initialUsage.cacheReadTokens += usage!.cacheReadTokens; initialUsage.cacheWriteTokens += usage!.cacheWriteTokens;
          initialUsage.totalTokens += usage!.totalTokens;
          if (usage!.estimatedCostUsd !== null) initialUsage.estimatedCostUsd += usage!.estimatedCostUsd;
          else initialUsageComplete = false;
        }
        if (!records.every((item) => item.usage?.pricingVersion === pricingVersion)) initialUsageComplete = false;
      }
    }
    const snapshotRecord = storage.snapshots.latest(run.conversationId);
    const snapshot = snapshotRecord?.snapshot as unknown as ConversationSessionSnapshot | undefined;
    const conversation = getConversationRecord(run.conversationId);
    const projectRecord = conversation.projectId ? storage.projects.get(conversation.projectId) : undefined;
    const rulesRecord = conversation.projectId ? storage.projectRules.get(conversation.projectId) : undefined;
    const project = projectRecord ? {
      projectId: projectRecord.id, canonicalRoot: projectRecord.canonicalRoot, directoryIdentity: projectRecord.directoryIdentity,
      ...(rulesRecord && !rulesRecord.revokedAt ? { acceptedRules: { sourcePath: rulesRecord.sourcePath, sourceSha256: rulesRecord.sourceSha256, content: rulesRecord.content } } : {}),
    } : undefined;
    try {
      const result = await client.execute({ runId, attemptId: currentAttempt.attemptId, conversationId: run.conversationId, input: parse(V2RunSubmissionSchema, run.request),
        ...(initialUsage ? { initialUsage } : {}), initialUsageComplete,
        ...(snapshot ? { snapshot } : {}), ...(project ? { project } : {}) }, {
        onEvent: (event) => { persistWorkerEvent(runId, event); },
      });
      await finalizeRun(runId, result);
    } catch {
      if (client.isAlive) {
        // A live worker that could not prove a durable result keeps the slot fenced.
        workerUnavailable = true;
        try { storage.workerIdentity.setStatus(client.bootId, "uncertain"); } catch { /* Keep the original storage failure. */ }
      } else recoverRunAfterExit(runId);
    }
  }

  function usageUpdated(runId: string, usage: import("@pi-workbench/protocol").Usage, usageComplete: boolean): V2RunEvent | undefined {
    const attempts = storage.attempts.list(runId);
    const attempt = attempts.at(-1);
    if (!attempt) return undefined;
    const updatedAt = now();
    const record = storage.usage.record({
      attemptId: attempt.attemptId, modelId: null, modelCalls: usage.modelCalls, toolCalls: usage.toolCalls,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens, totalTokens: usage.totalTokens,
      estimatedCostUsd: usageComplete ? usage.estimatedCostUsd : null, costStatus: usageComplete ? "estimate" : "unknown",
      pricingVersion: usageComplete ? usage.pricingVersion : null, updatedAt,
    });
    return appendV2(runId, { type: "usage.updated", data: {
      modelCalls: record.modelCalls, toolCalls: record.toolCalls, inputTokens: record.inputTokens, outputTokens: record.outputTokens,
      cacheReadTokens: record.cacheReadTokens, cacheWriteTokens: record.cacheWriteTokens, totalTokens: record.totalTokens,
      costStatus: record.costStatus, ...(record.estimatedCostUsd !== null ? { estimatedCostUsd: record.estimatedCostUsd } : {}),
    } }, false);
  }
  async function finalizeRun(runId: string, task: WorkerTaskResult): Promise<void> {
    let record = getRunRecord(runId);
    let result = task.result;
    if (result.runId !== runId || result.conversationId !== record.conversationId) throw makeError("conflict", "Worker result identity does not match the active run.", 409);
    if (record.status === "cancelling" && result.status === "completed") {
      result = parseWorkbenchResult({ schemaVersion: 1, status: "cancelled", runId, conversationId: record.conversationId, endedAt: now(), reason: "user" });
    }
    const locations = task.artifacts ?? [];
    const status: V2RunStatus = result.status;
    const terminalAt = now();
    const published: V2RunEvent[] = [];
    storage.transaction(() => {
      record = getRunRecord(runId);
      if (record.status !== "running" && record.status !== "cancelling") throw makeError("conflict", "Run is no longer owned by this Worker.", 409);
      const slot = storage.activeSlot.get();
      if (!worker || slot.runId !== runId || !slot.claimToken || slot.workerBootId !== worker.bootId) throw makeError("conflict", "Worker no longer holds the active run claim.", 409);
      const attempt = storage.attempts.list(runId).at(-1);
      if (!attempt || attempt.workerBootId !== worker.bootId || attempt.status !== "running") throw makeError("conflict", "Worker attempt identity changed before finalization.", 409);
      if (result.status === "completed") {
        const snapshot = task.snapshot;
        if (!snapshot || snapshot.sessionId !== snapshot.header.id || snapshot.header.type !== "session" ||
          snapshot.header.cwd !== process.cwd() || snapshot.formatVersion !== "pi-session-v3" || snapshot.sdkVersion !== "0.86.1" ||
          !Array.isArray(snapshot.entries) || (snapshot.leafId !== null && !snapshot.entries.some((entry) => entry.id === snapshot.leafId))) {
          throw makeError("conflict", "Worker did not return a compatible completed session snapshot.", 409);
        }
        storage.snapshots.save({ id: randomUUID(), conversationId: record.conversationId, sdkVersion: snapshot.sdkVersion,
          formatVersion: snapshot.formatVersion, snapshot: snapshot as unknown as JsonValue, summary: null, createdAt: terminalAt });
        storage.conversations.update(record.conversationId, { piSessionId: snapshot.sessionId, updatedAt: terminalAt });
        storage.messages.append({ id: randomUUID(), conversationId: record.conversationId, runId, role: "assistant", content: result.reply, source: "agent", extensionId: null, createdAt: terminalAt });
      }
      if (task.usage) {
        const usageEvent = usageUpdated(runId, task.usage, task.usageComplete !== false);
        if (usageEvent) published.push(usageEvent);
      }
      storage.fileChangesets.finalizeRun(runId, terminalAt);
      storage.results.save(runId, { result, artifacts: locations.map((entry) => ({ kind: entry.kind, path: entry.path, sha256: entry.sha256 })) }, terminalAt);
      if (attempt.status === "running") {
        const error = result.status === "failed" ? workerFailureError(result.error.code, result.error.message) : undefined;
        storage.attempts.finish(attempt.attemptId, result.status, terminalAt, error, Boolean(task.usage) && task.usageComplete !== false);
      }
      if (result.status === "completed") published.push(appendV2(runId, { type: "run.completed", data: { resultRef: runId } }, false));
      else if (result.status === "failed") published.push(appendV2(runId, { type: "run.failed", data: { error: workerFailureError(result.error.code, result.error.message) } }, false));
      else published.push(appendV2(runId, { type: "run.cancelled", data: { reason: result.reason } }, false));
      storage.runs.updateStatus(runId, status, terminalAt, terminalAt);
      storage.activeSlot.release({ runId, claimToken: slot.claimToken, generation: slot.generation });
      storage.workerIdentity.setStatus(worker.bootId, "idle", terminalAt);
    });
    for (const event of published) publish(runId, event);
  }

  function admit(conversationId: string, rawInput: unknown, key: string, retryOfRunId?: string): { runId: string; replayed: boolean } {
    if (closing) throw makeError("conflict", "Service is shutting down.", 503, true);
    if (fileMutationActive) throw makeError("active_task", "当前正在撤销文件修改，暂不能启动新任务。", 409);
    getConversationRecord(conversationId);
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) throw makeError("invalid_request", "A valid Idempotency-Key header is required.", 400);
    const submitted = parse(V2CreateRunSubmissionSchema, rawInput);
    let input: V2RunSubmission = submitted;
    let capabilityName = "";
    if (submitted.kind === "capability") {
      try {
        const definition = capabilityRegistry.get(submitted.capabilityId);
        capabilityName = definition.manifest.name;
        const permissions = new Set<import("@pi-workbench/protocol").CapabilityPermission>(["results.write"]);
        if (submitted.capabilityId === publicRepositoryCapability.id) permissions.add("public_repository.read");
        input = capabilityRegistry.prepareInvocation(submitted, storage.capabilityStates.get(submitted.capabilityId), permissions);
      }
      catch (error) {
        if (!(error instanceof CapabilityRegistryError)) throw error;
        const status = error.code === "extension_permission_denied" ? 403
          : error.code === "unknown_extension" || error.code === "extension_invalid_input" || error.code === "extension_invalid_config" ? 400 : 409;
        throw makeError(error.code, error.message, status);
      }
    }
    if (workerUnavailable || !worker?.isAlive) throw makeError("worker_unavailable", "The Worker is not confirmed ready; no run was accepted.", 503, true);
    const createdAt = now();
    const scope = conversationId;
    const endpoint = retryOfRunId ? "POST /api/v2/runs/:id/retry" : "POST /api/v2/runs";
    const workerClient = worker;
    const heartbeatAt = now();
    const title = getConversationRecord(conversationId).title === "新对话" ? titleFor(input, capabilityName) : getConversationRecord(conversationId).title;
    let created: ReturnType<typeof storage.runs.createIdempotent>;
    try {
      created = storage.runs.createIdempotent({
        runId: randomUUID(), conversationId, extensionId: input.kind === "capability" ? input.capabilityId : null,
        request: input, ...(retryOfRunId ? { retryOfRunId } : {}), createdAt,
      }, { scope, endpoint, key }, {
        attemptId: randomUUID(), claimToken: randomUUID(), workerBootId: workerClient.bootId,
        heartbeatAt, leaseExpiresAt: new Date(Date.parse(heartbeatAt) + 5_000).toISOString(), updatedAt: heartbeatAt,
        conversationTitle: title, acceptedEventId: randomUUID(), startedEventId: randomUUID(),
        message: {
          id: randomUUID(), role: input.kind === "message" ? "user" : "capability",
          content: input.kind === "message" ? input.text : serializeCapabilityContent(input, capabilityName),
          extensionId: input.kind === "capability" ? input.capabilityId : null, createdAt,
        },
      });
    } catch (error) { translateError(error); }
    if (created.replayed) return { runId: created.run.runId, replayed: true };
    if (!created.admission) {
      workerUnavailable = true;
      try { storage.workerIdentity.setStatus(workerClient.bootId, "uncertain"); } catch { /* Fail closed if the committed admission result is incomplete. */ }
      throw makeError("internal_error", "Run admission committed without its execution claim.", 500);
    }
    const runId = created.run.runId;
    for (const event of created.admission.events) publish(runId, event);
    activeExecution = beginExecution(runId).finally(() => { activeExecution = undefined; });
    return { runId, replayed: false };
  }

  function subscribeV2(runId: string, rawCursor?: string, listener?: (event: V2RunEvent) => void): V2EventSubscription {
    getRunRecord(runId);
    let afterSequence = 0;
    let reset: V2EventSubscription["reset"];
    const latestSequence = storage.events.latestSequence(runId);
    let lastEventId: string | undefined;
    if (rawCursor && rawCursor !== "0") {
      const cursorSequence = storage.events.sequenceById(runId, rawCursor);
      if (cursorSequence === undefined) {
        const page = storage.events.after({ schemaVersion: 2, runId, afterSequence: latestSequence }, EVENT_LIMIT);
        const latestEvent = page.nextCursor.lastEventId;
        reset = {
          schemaVersion: 2, type: "stream.reset", runId,
          data: { reason: "event_history_expired", earliestAvailableSequence: latestSequence ? Math.max(1, latestSequence - EVENT_LIMIT + 1) : 1, latestSequence, ...(latestEvent ? { latestEventId: latestEvent } : {}) },
        };
        afterSequence = latestSequence; lastEventId = latestEvent;
      } else { afterSequence = cursorSequence; lastEventId = rawCursor; }
    }
    const seen = new Set<string>();
    const listeners = subscribers.get(runId) ?? new Set<(event: V2RunEvent) => void>();
    subscribers.set(runId, listeners);
    const wrapped = (event: V2RunEvent) => {
      if (event.sequence <= afterSequence || seen.has(event.eventId)) return;
      seen.add(event.eventId); listener?.(event);
    };
    if (listener) listeners.add(wrapped);
    const page = storage.events.after({ schemaVersion: 2, runId, afterSequence, ...(lastEventId ? { lastEventId } : {}) }, EVENT_LIMIT);
    for (const event of page.events) { seen.add(event.eventId); }
    return {
      replay: page.events, ...(reset ? { reset } : {}), finished: terminal(getRunRecord(runId).status),
      unsubscribe: () => { if (listener) listeners.delete(wrapped); if (listeners.size === 0) subscribers.delete(runId); },
    };
  }

  function legacyEvent(event: V2RunEvent): WorkbenchEvent | undefined {
    const run = getRunRecord(event.runId);
    const common = { schemaVersion: 1 as const, eventId: event.eventId, runId: event.runId, conversationId: run.conversationId, sequence: event.sequence, timestamp: event.timestamp };
    if (event.type === "run.started") {
      const input = parse(V2RunSubmissionSchema, run.request);
      const legacyInput = input.kind === "message" ? input : input.capabilityId === publicRepositoryCapability.id
        ? { kind: "capability" as const, capabilityId: publicRepositoryCapability.id, input: {
          repositoryUrl: String(input.input.repositoryUrl ?? "https://github.com/demo/harborlight"),
          ...(typeof input.input.ref === "string" ? { ref: input.input.ref } : {}), goal: input.prompt ?? (typeof input.input.goal === "string" ? input.input.goal : "扩展运行记录"),
        } }
        : { kind: "message" as const, text: `已调用扩展 ${input.capabilityId}：${input.prompt ?? ""}` };
      return parseWorkbenchEvent({ ...common, type: "run.started", data: { input: parse(RunSubmissionSchema, legacyInput), ...(run.retryOfRunId ? { retryOfRunId: run.retryOfRunId } : {}) } });
    }
    if (event.type === "message.delta") return parseWorkbenchEvent({ ...common, type: "message.delta", data: event.data });
    if (event.type === "tool.started") return parseWorkbenchEvent({ ...common, type: "tool.started", data: { toolCallId: event.data.toolCallId, toolName: event.data.toolName } });
    if (event.type === "tool.finished") return parseWorkbenchEvent({ ...common, type: "tool.finished", data: { toolCallId: event.data.toolCallId, toolName: event.data.toolName, isError: event.data.isError } });
    if (event.type === "run.cancelling") return parseWorkbenchEvent({ ...common, type: "run.cancelling", data: { reason: event.data.reason === "shutdown" ? "user" : event.data.reason } });
    if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") {
      const stored = storage.results.get(event.runId) as { result?: unknown } | undefined;
      if (!stored?.result) return undefined;
      return parseWorkbenchEvent({ ...common, type: "run.finished", data: parseWorkbenchResult(stored.result) });
    }
    if (event.type === "run.progress") return parseWorkbenchEvent({ ...common, type: "capability.started", data: { capabilityId: publicRepositoryCapability.id, label: event.data.message.slice(0, 128) || publicRepositoryCapability.name } });
    return undefined;
  }
  function subscribeLegacy(runId: string, cursor?: string, listener?: (event: WorkbenchEvent) => void): EventSubscription {
    const v2Listener = listener ? (event: V2RunEvent) => { const mapped = legacyEvent(event); if (mapped) listener(mapped); } : undefined;
    const subscription = subscribeV2(runId, cursor, v2Listener);
    const replay = subscription.replay.map(legacyEvent).filter((item): item is WorkbenchEvent => item !== undefined);
    return {
      replay,
      ...(subscription.reset ? { reset: { schemaVersion: 1, eventId: randomUUID(), runId, type: "stream.reset", data: {
        reason: "event_history_expired", earliestAvailableSequence: subscription.reset.data.earliestAvailableSequence,
        latestSequence: subscription.reset.data.latestSequence, ...(subscription.reset.data.latestEventId ? { latestEventId: subscription.reset.data.latestEventId } : {}),
      } } } : {}),
      finished: subscription.finished, unsubscribe: subscription.unsubscribe,
    };
  }
  function readStoredResult(runId: string): { result?: WorkbenchResult; artifacts?: Array<{ kind: string; path: string; sha256: string }> } {
    const value = storage.results.get(runId) as { result?: unknown; artifacts?: Array<{ kind: string; path: string; sha256: string }> } | undefined;
    if (!value?.result) return {};
    return { result: parseWorkbenchResult(value.result), ...(value.artifacts ? { artifacts: value.artifacts } : {}) };
  }
  function v2RunWithResult(runId: string): V2Run { return v2Run(runId); }
  function createConversationV2(): V2Conversation { return createConversationRecord(null); }
  function createConversationRecord(projectId: string | null): V2Conversation {
    const id = randomUUID();
    const createdAt = now();
    storage.conversations.create({ id, projectId, piSessionId: null, title: "新对话", createdAt, updatedAt: createdAt });
    return v2Conversation(id);
  }
  function listConversationV2(): V2ConversationSummary[] {
    return storage.conversations.list().map((item) => v2Summary(item.id));
  }
  function deleteConversation(conversationId: string): void {
    if (fileMutationActive) throw makeError("active_task", "当前正在撤销文件修改，暂不能删除对话。", 409);
    try { storage.conversations.deletePermanently(conversationId); void picker.flushGarbage().catch(() => undefined); }
    catch (error) { translateError(error); }
  }
  function listRunsV2(conversationId: string): V2Run[] {
    getConversationRecord(conversationId);
    return storage.runs.list(conversationId).map((run) => v2Run(run.runId));
  }
  function getRunV2(runId: string): V2Run { return v2Run(runId); }
  function submitV2(conversationId: string, input: unknown, key: string): { run: V2Run; replayed: boolean } {
    const admitted = admit(conversationId, input, key);
    return { run: v2Run(admitted.runId), replayed: admitted.replayed };
  }
  function retryV2(runId: string, key: string): { run: V2Run; replayed: boolean } {
    const previous = getRunRecord(runId);
    if (!(previous.status === "failed" || previous.status === "cancelled")) throw makeError("conflict", "Only failed or cancelled runs can be retried.", 409);
    const stored = parse(V2RunSubmissionSchema, previous.request);
    const input = stored.kind === "message" ? stored : { kind: "capability" as const, capabilityId: stored.capabilityId, input: stored.input, prompt: stored.prompt };
    const admitted = admit(previous.conversationId, input, key, previous.runId);
    return { run: v2Run(admitted.runId), replayed: admitted.replayed };
  }
  function continueV2(runId: string, key: string): { run: V2Run; replayed: boolean } {
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) throw makeError("invalid_request", "A valid Idempotency-Key header is required.", 400);
    if (fileMutationActive) throw makeError("active_task", "当前正在撤销文件修改，暂不能继续任务。", 409);
    if (workerUnavailable || !worker?.isAlive) throw makeError("worker_unavailable", "The Worker is not confirmed ready.", 503, true);
    const workerClient = worker;
    const heartbeatAt = now();
    const inputHash = hash({ runId, operation: "continue" });
    let continued: ReturnType<typeof storage.runs.continueIdempotent>;
    try {
      continued = storage.runs.continueIdempotent(runId, {
        scope: runId, endpoint: "POST /api/v2/runs/:id/continue", key, requestHash: inputHash,
      }, {
        attemptId: randomUUID(), claimToken: randomUUID(), workerBootId: workerClient.bootId,
        heartbeatAt, leaseExpiresAt: new Date(Date.parse(heartbeatAt) + 5_000).toISOString(), updatedAt: heartbeatAt,
        startedEventId: randomUUID(),
      });
    } catch (error) { translateError(error); }
    if (continued.replayed) return { run: v2Run(runId), replayed: true };
    if (!continued.admission) {
      workerUnavailable = true;
      try { storage.workerIdentity.setStatus(workerClient.bootId, "uncertain"); } catch { /* Fail closed if continuation committed incompletely. */ }
      throw makeError("internal_error", "Run continuation committed without its execution claim.", 500);
    }
    for (const event of continued.admission.events) publish(runId, event);
    activeExecution = beginExecution(runId).finally(() => { activeExecution = undefined; });
    return { run: v2Run(runId), replayed: false };
  }
  function cancelV2(runId: string): V2Run {
    const run = getRunRecord(runId);
    if (terminal(run.status)) return v2Run(runId);
    if (run.status !== "cancelling") {
      storage.runs.updateStatus(runId, "cancelling", now());
      appendV2(runId, { type: "run.cancelling", data: { reason: "user" } });
      if (!worker?.cancel(runId)) throw makeError("worker_unavailable", "Cancel could not be delivered to the active Worker.", 503, true);
    }
    return v2Run(runId);
  }
  function readEventsPage(runId: string, cursor: V2EventCursor, limit = 100) {
    getRunRecord(runId);
    if (cursor.runId !== runId) throw makeError("invalid_request", "Event cursor run ID does not match the route.", 400);
    return storage.events.after(cursor, limit);
  }
  async function readArtifact(runId: string, kind: string): Promise<{ bytes: Buffer; contentType: string }> {
    if (!KEY_PATTERN.test(runId) || !/^(report\.json|report\.md|manifest\.json|events\.jsonl)$/u.test(kind)) throw makeError("not_found", "Artifact not found.", 404);
    const locations = readStoredResult(runId).artifacts ?? [];
    const location = locations.find((artifact) => artifact.kind === kind);
    if (!location) throw makeError("not_found", "Artifact not found.", 404);
    const root = path.resolve(dataDirectory, "runs");
    const absolute = path.resolve(location.path);
    if (!absolute.startsWith(root + path.sep)) throw makeError("not_found", "Artifact not found.", 404);
    const stat = await lstat(absolute).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_BYTES || await realpath(absolute) !== absolute) throw makeError("not_found", "Artifact not found.", 404);
    const bytes = await readFile(absolute);
    if (createHash("sha256").update(bytes).digest("hex") !== location.sha256) throw makeError("not_found", "Artifact integrity validation failed.", 404);
    return { bytes, contentType: kind.endsWith(".json") ? "application/json; charset=utf-8" : "text/plain; charset=utf-8" };
  }
  function v2Project(record: ReturnType<typeof storage.projects.get>): V2Project {
    if (!record) throw makeError("not_found", "Project not found.", 404);
    return parse(V2ProjectSchema, { schemaVersion: 2, projectId: record.id, displayName: record.displayName,
      canonicalRoot: record.canonicalRoot, validationState: record.validationState, createdAt: record.createdAt, lastAccessedAt: record.lastAccessedAt });
  }
  function v2ProjectRules(record: ReturnType<typeof storage.projectRules.get>): V2ProjectRules | null {
    if (!record || record.revokedAt) return null;
    return parse(V2ProjectRulesSchema, { schemaVersion: 2, projectId: record.projectId, sourcePath: record.sourcePath,
      sourceSha256: record.sourceSha256, sourceVersion: record.sourceVersion, content: record.content, acceptedAt: record.acceptedAt, revokedAt: null });
  }
  async function openProject(sessionId: string, token: string, displayName?: string) {
    const project = await picker.openProject(sessionId, token, displayName);
    return { schemaVersion: 2 as const, project: v2Project(project), conversation: createConversationRecord(project.id) };
  }
  async function createProjectConversation(projectId: string) {
    const project = await picker.reopenProject(projectId);
    return createConversationRecord(project.id);
  }
  async function importAttachments(sessionId: string, conversationId: string, fileTokens: string[], directoryToken?: string): Promise<V2ImportResult> {
    getConversationRecord(conversationId);
    const imported = await picker.importAttachments(sessionId, conversationId, fileTokens, directoryToken);
    const value = parse(V2ImportResultSchema, { schemaVersion: 2,
      attachments: imported.attachments.map((item) => ({ schemaVersion: 2, attachmentId: item.id, conversationId: item.conversationId,
        fileName: item.fileName, relativePath: item.relativePath, byteSize: item.byteSize, mediaType: item.mediaType, createdAt: item.createdAt })),
      skipped: imported.skipped, totalBytes: imported.totalBytes,
    });
    return value;
  }
  async function readConversationAttachment(conversationId: string, attachmentId: string) {
    getConversationRecord(conversationId);
    const attachment = storage.attachments.getForConversation(attachmentId, conversationId);
    if (!attachment) throw makeError("not_found", "Attachment not found.", 404);
    return { attachment, bytes: await picker.readAttachment(attachment) };
  }
  function listConversationChangesets(conversationId: string): V2ChangesetSummary[] {
    getConversationRecord(conversationId);
    return storage.fileChangesets.list(conversationId).flatMap((item) => {
      const operationCount = storage.fileOperations.list(item.id).length;
      if (!operationCount) return [];
      return [parse(V2ChangesetSummarySchema, { schemaVersion: 2, changesetId: item.id, conversationId: item.conversationId,
        projectId: item.projectId, runId: item.runId, undoOfChangesetId: item.undoOfChangesetId, status: item.status,
        operationCount, createdAt: item.createdAt, updatedAt: item.updatedAt })];
    });
  }
  async function getConversationChangeset(conversationId: string, changesetId: string): Promise<V2Changeset> {
    getConversationRecord(conversationId);
    const changeset = storage.fileChangesets.getForConversation(changesetId, conversationId);
    if (!changeset) throw makeError("not_found", "File changeset not found.", 404);
    const operations = storage.fileOperations.list(changesetId);
    if (operations.length > 1000) throw makeError("conflict", "File changeset exceeds the display limit.", 409);
    const views = operations.map((operation) => parse(V2FileOperationSchema, {
      schemaVersion: 2, operationId: operation.id, changesetId, sequence: operation.sequence, path: operation.relativePath,
      kind: operation.kind, status: operation.status, preHash: operation.preHash, postHash: operation.postHash,
      errorCode: operation.errorCode,
    }));
    const byPath = new Map<string, typeof operations>();
    for (const operation of operations) byPath.set(operation.relativePath, [...(byPath.get(operation.relativePath) ?? []), operation]);
    const diffs = [];
    for (const [filePath, group] of byPath) {
      if (diffs.length >= 200) break;
      const firstApplied = group.find((operation) => operation.status === "applied" || operation.status === "undone");
      const lastApplied = [...group].reverse().find((operation) => operation.status === "applied" || operation.status === "undone");
      const first = firstApplied ?? group[0]!;
      const last = lastApplied ?? group.at(-1)!;
      const beforeBytes = first.preHash === null ? null : first.backupSha256 ? await readFileBackup(storage, dataDirectory, first.backupSha256) : null;
      const afterBytes = last.expectedPostHash === null ? null : last.resultSha256 ? await readFileBackup(storage, dataDirectory, last.resultSha256) : null;
      if ((first.preHash !== null && !beforeBytes) || (last.expectedPostHash !== null && !afterBytes)) throw makeError("conflict", "A file diff object is missing or failed integrity checks.", 409);
      const beforeText = beforeBytes ? new TextDecoder("utf-8", { fatal: true }).decode(beforeBytes) : null;
      const afterText = afterBytes ? new TextDecoder("utf-8", { fatal: true }).decode(afterBytes) : null;
      const status = group.some((item) => item.status === "uncertain" || item.status === "prepared") ? "uncertain"
        : group.some((item) => item.status === "conflict") ? "conflict"
          : group.some((item) => item.status === "applied") ? "applied"
            : group.every((item) => item.status === "undone") ? "undone" : "not_applied";
      const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];
      if (beforeText !== null) lines.push(...beforeText.split(/\r?\n/u).map((line) => `-${line}`));
      if (afterText !== null) lines.push(...afterText.split(/\r?\n/u).map((line) => `+${line}`));
      let diffText = lines.join("\n");
      const truncated = Buffer.byteLength(diffText, "utf8") > 131_072;
      if (truncated) diffText = Buffer.from(diffText, "utf8").subarray(0, 130_000).toString("utf8");
      diffs.push(parse(V2FileDiffSchema, { path: filePath, status, beforeText, afterText, diffText, truncated }));
    }
    return parse(V2ChangesetSchema, { schemaVersion: 2, changesetId, conversationId, projectId: changeset.projectId,
      runId: changeset.runId, undoOfChangesetId: changeset.undoOfChangesetId, status: changeset.status,
      createdAt: changeset.createdAt, updatedAt: changeset.updatedAt, operations: views, diffs });
  }
  async function listConversationAttachmentResults(conversationId: string): Promise<V2AttachmentResult[]> {
    getConversationRecord(conversationId);
    return storage.attachmentResults.list(conversationId).map((record) => parse(V2AttachmentResultSchema, {
      schemaVersion: 2, resultId: record.id, conversationId: record.conversationId, sourceAttachmentId: record.sourceAttachmentId,
      fileName: record.fileName, byteSize: record.byteSize, mediaType: record.mediaType, createdAt: record.createdAt,
    }));
  }
  async function readConversationAttachmentResult(conversationId: string, resultId: string) {
    getConversationRecord(conversationId);
    const record = storage.attachmentResults.getForConversation(resultId, conversationId);
    if (!record) throw makeError("not_found", "Attachment result not found.", 404);
    const object = await readManagedObject(dataDirectory, "objects", record.objectSha256);
    if (!object || object.byteLength !== record.byteSize) throw makeError("not_found", "Attachment result is missing or failed integrity checks.", 404);
    return { result: record, bytes: object };
  }
  function previewFileCleanup(conversationId: string): V2CleanupPreview {
    getConversationRecord(conversationId);
    const changesets = storage.fileChangesets.list(conversationId).filter((item) => storage.fileOperations.list(item.id).length > 0).slice(0, 100);
    const changesetIds = changesets.map((item) => item.id);
    const impact = changesetIds.length ? storage.fileChangesets.cleanupImpact(conversationId, changesetIds)
      : { changesetCount: 0, operationCount: 0, objectCount: 0, objectBytes: 0 };
    return parse(V2CleanupPreviewSchema, { schemaVersion: 2, changesetIds, changesetCount: impact.changesetCount,
      backupObjectCount: impact.objectCount, backupBytes: impact.objectBytes, losesUndoHistory: impact.changesetCount > 0,
      note: "删除所选变更记录会清除应用内差异和撤销能力；项目目录中的当前文件不会回滚或删除。共享备份对象可能保留。" });
  }
  function cleanupFileChangesets(conversationId: string, changesetIds: string[]): V2CleanupResult {
    getConversationRecord(conversationId);
    if (storage.activeSlot.get().runId || fileMutationActive) throw makeError("active_task", "当前有运行中的任务或文件撤销，暂不能清理文件记录。", 409);
    let result: ReturnType<typeof storage.fileChangesets.deleteForCleanup>;
    try { result = storage.fileChangesets.deleteForCleanup(conversationId, changesetIds); }
    catch (error) { translateError(error); }
    void picker.flushGarbage().catch(() => undefined);
    return parse(V2CleanupResultSchema, { schemaVersion: 2, ...result });
  }
  function capabilityStates() {
    return new Map(storage.capabilityStates.list().map((state) => [state.capabilityId, state]));
  }
  function updateCapabilityState(capabilityId: string, patch: { enabled?: boolean; config?: Record<string, unknown> }) {
    try {
      const definition = capabilityRegistry.get(capabilityId);
      const state = capabilityRegistry.updateState(definition, storage.capabilityStates.get(capabilityId), patch);
      storage.capabilityStates.set(state);
      return capabilityRegistry.catalog(capabilityStates()).find((entry) => entry.manifest.id === capabilityId)!;
    } catch (error) {
      if (error instanceof CapabilityRegistryError) {
        const status = error.code === "unknown_extension" || error.code === "extension_invalid_config" ? 400 : 409;
        throw makeError(error.code, error.message, status);
      }
      if (error instanceof TypeError) throw makeError("invalid_request", "能力状态更新无效。", 400);
      throw error;
    }
  }
  async function undoFileChangeset(conversationId: string, changesetId: string): Promise<V2ChangesetUndoResult> {
    getConversationRecord(conversationId);
    if (storage.activeSlot.get().runId || fileMutationActive) throw makeError("active_task", "当前有运行中的任务或文件撤销；停止后才能撤销文件修改。", 409);
    fileMutationActive = true;
    try {
    const original = storage.fileChangesets.getForConversation(changesetId, conversationId);
    if (!original) throw makeError("not_found", "File changeset not found.", 404);
    const operations = storage.fileOperations.list(changesetId);
    const applied = operations.filter((operation) => operation.status === "applied");
    if (!applied.length) return parse(V2ChangesetUndoResultSchema, { schemaVersion: 2, changesetId, status: "conflict", undonePaths: [], conflictPaths: [] });
    const project = await picker.reopenProject(original.projectId);
    const undo = storage.fileChangesets.createUndo({ id: randomUUID(), originalChangesetId: changesetId });
    const journal = createPersistedFileJournal({ storage, dataDirectory, changesetId: undo.id });
    const access = createProjectFileAccess(project.canonicalRoot, project.directoryIdentity, journal);
    await access.initialize();
    const byPath = new Map<string, typeof applied>();
    for (const operation of applied) byPath.set(operation.relativePath, [...(byPath.get(operation.relativePath) ?? []), operation]);
    const undonePaths: string[] = [];
    const conflictPaths: string[] = [];
    for (const [filePath, group] of byPath) {
      const first = group[0]!;
      const last = group.at(-1)!;
      try {
        const current = await access.versionOf(filePath);
        if ((last.postVersion === null && current !== null) || (last.postVersion !== null && current?.token !== last.postVersion)) {
          conflictPaths.push(filePath); continue;
        }
        if (first.preHash === null) {
          if (current) await access.removeCreatedFile(filePath, current.token);
        } else {
          if (!first.backupSha256) throw new Error("Missing file backup");
          const before = await readFileBackup(storage, dataDirectory, first.backupSha256);
          if (!before) throw new Error("Missing file backup");
          const text = new TextDecoder("utf-8", { fatal: true }).decode(before);
          if (current) await access.restoreFile(filePath, current.token, text);
          else await access.createFile(filePath, text);
        }
        storage.fileOperations.markUndone(group.map((operation) => operation.id));
        undonePaths.push(filePath);
      } catch {
        conflictPaths.push(filePath);
      }
    }
    const status = conflictPaths.length ? (undonePaths.length ? "partial" : "conflict") : "undone";
    storage.fileChangesets.updateStatus(undo.id, undonePaths.length ? "applied" : status);
    const remainingApplied = storage.fileOperations.list(changesetId).some((operation) => operation.status === "applied");
    storage.fileChangesets.updateStatus(changesetId, remainingApplied ? (conflictPaths.length ? "partial" : "applied") : status);
    return parse(V2ChangesetUndoResultSchema, { schemaVersion: 2, changesetId, status, undonePaths, conflictPaths });
    } finally { fileMutationActive = false; }
  }
  function translateError(error: unknown): never {
    if (error instanceof StorageError) {
      const status = error.code === "not_found" ? 404 : error.code === "active_task" ? 409 : error.code === "db_busy" ? 503 : error.code === "db_readonly" ? 503 : 409;
      const code = error.code === "conflict" && /Idempotency key/u.test(error.message) ? "idempotency_conflict"
        : error.code === "active_task" ? "active_task" : error.code === "invalid_input" ? "invalid_request" : error.code;
      throw makeError(code, error.message, status, error.code === "db_busy");
    }
    throw error;
  }

  return {
    mode: options.mode,
    get workerReady() { return Boolean(worker && worker.isAlive && !workerUnavailable); },
    listCapabilities: () => capabilityRegistry.catalog(capabilityStates()),
    listLegacyCapabilities: () => [{
      id: publicRepositoryCapability.id, name: publicRepositoryCapability.name, description: publicRepositoryCapability.description,
      inputs: [
        { id: "repositoryUrl", label: "公开 GitHub 仓库", required: true, description: "填写仓库 HTTPS 地址。", control: "text" as const, maxLength: 512 },
        { id: "ref", label: "分支、标签或提交", required: false, description: "可选；留空时分析默认分支的当前提交。", control: "text" as const, maxLength: 256 },
      ],
    }],
    updateCapabilityState,
    createConversation: () => legacyConversation(createConversationRecord(null).conversationId),
    listConversations: () => listConversationV2().map((item) => legacySummary(item.conversationId)),
    getConversation: (id: string) => legacyConversation(id),
    deleteConversation,
    listConversationRuns: (id: string) => listRunsV2(id).map((run) => legacyRun(run.runId)),
    submit: (_id: string, _input: unknown, _key: string): never => { throw makeError("upgrade_required", "v1 write endpoints have been retired; use the v2 API.", 426); },
    retry: (_id: string, _key: string): never => { throw makeError("upgrade_required", "v1 write endpoints have been retired; use the v2 API.", 426); },
    getRun: (id: string) => legacyRun(id),
    cancel: (_id: string): never => { throw makeError("upgrade_required", "v1 write endpoints have been retired; use the v2 API.", 426); },
    subscribeEvents: subscribeLegacy,
    readArtifact,
    createConversationV2,
    createConversationRecord,
    createPickerSession: (origin: string): PickerSessionStart => picker.startSession(origin),
    validatePickerSession: picker.validateSession.bind(picker),
    pickerRoots: picker.listRoots.bind(picker),
    browsePickerDirectory: picker.browse.bind(picker),
    prepareProjectSelection: picker.prepareProjectSelection.bind(picker),
    openProject,
    listProjects: async () => (await picker.recentProjects()).map((record) => v2Project(record)),
    createProjectConversation,
    listConversationAttachments: (conversationId: string) => {
      getConversationRecord(conversationId);
      return storage.attachments.list(conversationId).map((item) => ({ schemaVersion: 2 as const, attachmentId: item.id,
        conversationId: item.conversationId, fileName: item.fileName, relativePath: item.relativePath, byteSize: item.byteSize,
        mediaType: item.mediaType, createdAt: item.createdAt }));
    },
    importAttachments,
    readConversationAttachment,
    listConversationAttachmentResults,
    readConversationAttachmentResult,
    listConversationChangesets,
    getConversationChangeset,
    undoFileChangeset,
    previewFileCleanup,
    cleanupFileChangesets,
    projectRules: (projectId: string) => v2ProjectRules(storage.projectRules.get(projectId)),
    previewProjectRules: picker.previewRules.bind(picker),
    acceptProjectRules: picker.acceptRules.bind(picker),
    revokeProjectRules: picker.revokeRules.bind(picker),
    listConversationV2,
    getConversationV2: v2Conversation,
    deleteConversationV2: deleteConversation,
    listRunsV2,
    getRunV2,
    submitV2,
    retryV2,
    continueV2,
    cancelV2,
    subscribeEventsV2: subscribeV2,
    readEventsPage,
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      if (heartbeat) clearInterval(heartbeat);
      const slot = storage.activeSlot.get();
      if (slot.runId) worker?.cancel(slot.runId);
      if (activeExecution) await Promise.race([activeExecution.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (worker) {
        const oldWorker = worker;
        try { storage.workerIdentity.setStatus(oldWorker.bootId, "stopping"); } catch { /* Keep the run fenced if DB state is unavailable. */ }
        const stopped = await oldWorker.shutdown();
        if (stopped) {
          const currentSlot = storage.activeSlot.get();
          if (currentSlot.runId) await markInterrupted(currentSlot.runId, "process_exit").catch(() => undefined);
          try { storage.workerIdentity.clear(oldWorker.bootId); } catch { /* Preserve DB state for startup recovery. */ }
        } else {
          workerUnavailable = true;
          try { storage.workerIdentity.setStatus(oldWorker.bootId, "uncertain"); } catch { /* Keep existing recovery state. */ }
        }
      }
      storage.close();
    },
  };
}
