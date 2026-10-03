import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { AttemptExecutionSafetyRepository } from "@pi-workbench/storage";
import { executeWorkerTask } from "../../src/execution.js";
import type { WorkerCommand, WorkerEventPayload, WorkerInbound, WorkerOutbound } from "../../src/worker-ipc.js";
import type { ConversationSessionSnapshot } from "@pi-workbench/agent-runtime";

if (!process.send) throw new Error("Worker fixture must be started by the coordinator");
const dataDirectory = process.env.PI_WORKBENCH_DATA_DIR ?? "";
const fixtureRoot = process.env.PI_WORKBENCH_FIXTURE_ROOT ?? "";
const send = (message: WorkerInbound): void => { if (process.connected) process.send?.(message); };
const bootId = randomUUID();
let active: { runId: string; controller: AbortController } | undefined;
let stopping = false;
const pendingAcks = new Map<string, { resolve(): void; reject(error: Error): void }>();

function acknowledged(message: Extract<WorkerInbound, { type: "event" | "snapshot" }>): Promise<void> {
  return new Promise((resolve, reject) => {
    pendingAcks.set(message.requestId, { resolve, reject });
    send(message);
  });
}

async function execute(command: Extract<WorkerCommand, { type: "execute" }>): Promise<void> {
  const controller = new AbortController();
  active = { runId: command.runId, controller };
  if (command.input.kind === "capability" && command.input.capabilityId === "public_repository_analysis") {
    const originalSave = AttemptExecutionSafetyRepository.prototype.saveWorkflowCheckpoint;
    AttemptExecutionSafetyRepository.prototype.saveWorkflowCheckpoint = function (input) {
      const saved = originalSave.call(this, input);
      if (input.checkpoint.phaseId === "analysis") {
        const marker = path.join(dataDirectory, "usage-safety-analysis-checkpoint-paused");
        try {
          writeFileSync(marker, "analysis usage and checkpoint committed", { flag: "wx", mode: 0o600 });
          // The checkpoint transaction has committed. Hold this Worker here so
          // the parent can inject a process kill before later stages progress.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      return saved;
    };
  }
  if (command.input.kind === "message" && command.input.text.includes("[[test:before-call]]")) {
    const marker = path.join(dataDirectory, "usage-safety-before-call-paused");
    try {
      await writeFile(marker, "paused before provider call", { flag: "wx", mode: 0o600 });
      // The parent kills this first Worker after the coordinator's durable
      // pre-call checkpoint is visible. A restarted fixture delegates normally.
      await new Promise<void>(() => undefined);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  const queued: Promise<void>[] = [];
  let finalSnapshot: ConversationSessionSnapshot | undefined;
  const emit = (event: WorkerEventPayload) => {
    const pending = acknowledged({ type: "event", requestId: randomUUID(), runId: command.runId, conversationId: command.conversationId, event });
    queued.push(pending);
    void pending.catch(() => undefined);
    return pending;
  };
  try {
    const result = await executeWorkerTask({
      runId: command.runId, attemptId: command.attemptId, conversationId: command.conversationId,
      input: command.input, ...(command.initialUsage ? { initialUsage: command.initialUsage } : {}),
      ...(command.initialUsageComplete !== undefined ? { initialUsageComplete: command.initialUsageComplete } : {}),
      mode: process.env.WORKBENCH_MODE === "online" ? "online" : "fake", dataDirectory, fixtureRoot,
      ...(command.snapshot ? { snapshot: command.snapshot } : {}), ...(command.project ? { project: command.project } : {}),
      signal: controller.signal, emit, saveSnapshot: async (snapshot) => { finalSnapshot = snapshot; },
    });
    await Promise.all(queued.splice(0));
    send({ type: "done", runId: command.runId, result: result.result, ...(result.usage ? { usage: result.usage } : {}),
      ...(result.usageComplete !== undefined ? { usageComplete: result.usageComplete } : {}), artifacts: result.artifacts,
      ...(result.result.status === "completed" && finalSnapshot ? { snapshot: finalSnapshot } : {}) });
  } catch {
    send({ type: "done", runId: command.runId, result: {
      schemaVersion: 1, status: "failed", runId: command.runId, conversationId: command.conversationId,
      endedAt: new Date().toISOString(), error: { code: "worker_error", message: "Worker fixture could not complete this test task." },
    } });
  } finally {
    if (active?.runId === command.runId) active = undefined;
    if (stopping || !process.connected) process.exit(0);
  }
}

process.on("message", (raw: unknown) => {
  const command = raw as WorkerCommand | WorkerOutbound;
  if (command.type === "ack") {
    const ack = pendingAcks.get(command.requestId);
    if (!ack) return;
    pendingAcks.delete(command.requestId);
    if (command.ok) ack.resolve(); else ack.reject(new Error(command.error ?? "Persistence failed"));
  } else if (command.type === "cancel") {
    if (active?.runId === command.runId) active.controller.abort();
  } else if (command.type === "shutdown") {
    stopping = true;
    active?.controller.abort();
    if (!active) process.exit(0);
  } else if (command.type === "execute") {
    if (stopping || active) { send({ type: "worker_error", message: "Worker fixture is busy or shutting down" }); return; }
    void execute(command);
  }
});

for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => process.exit(0));
send({ type: "ready", bootId });
