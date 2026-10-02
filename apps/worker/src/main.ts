import { randomUUID } from "node:crypto";
import { executeWorkerTask } from "@pi-workbench/workbench/execution";
import type { WorkerCommand, WorkerEventPayload, WorkerInbound, WorkerOutbound } from "@pi-workbench/workbench/worker-ipc";
import type { ConversationSessionSnapshot } from "@pi-workbench/agent-runtime";

if (!process.send) throw new Error("Worker must be started by the API supervisor");
const send = (message: WorkerInbound): void => { if (process.connected) process.send?.(message); };
const bootId = randomUUID();
let active: { runId: string; controller: AbortController; task: Promise<void> } | undefined;
let stopping = false;
const pendingAcks = new Map<string, { resolve(): void; reject(error: Error): void }>();

function acknowledged(message: Extract<WorkerInbound, { type: "event" | "snapshot" }>): Promise<void> {
  const requestId = message.requestId;
  return new Promise<void>((resolve, reject) => {
    pendingAcks.set(requestId, { resolve, reject });
    send(message);
  });
}

async function execute(command: Extract<WorkerCommand, { type: "execute" }>): Promise<void> {
  const controller = new AbortController();
  const queued: Promise<void>[] = [];
  let finalSnapshot: ConversationSessionSnapshot | undefined;
  const emit = (event: WorkerEventPayload) => {
    const pending = acknowledged({ type: "event", requestId: randomUUID(), runId: command.runId, conversationId: command.conversationId, event });
    queued.push(pending);
    void pending.catch(() => undefined);
    return pending;
  };
  const saveSnapshot = (snapshot: ConversationSessionSnapshot) => { finalSnapshot = snapshot; };
  const task = (async () => {
    try {
      const result = await executeWorkerTask({
        runId: command.runId, attemptId: command.attemptId, conversationId: command.conversationId, input: command.input,
        ...(command.initialUsage ? { initialUsage: command.initialUsage } : {}),
        ...(command.initialUsageComplete !== undefined ? { initialUsageComplete: command.initialUsageComplete } : {}),
        mode: process.env.WORKBENCH_MODE === "online" ? "online" : "fake",
        dataDirectory: process.env.PI_WORKBENCH_DATA_DIR ?? "",
        fixtureRoot: process.env.PI_WORKBENCH_FIXTURE_ROOT ?? "",
        ...(process.env.DEEPSEEK_API_KEY ? { apiKey: process.env.DEEPSEEK_API_KEY } : {}),
        ...(process.env.GITHUB_TOKEN ? { githubToken: process.env.GITHUB_TOKEN } : {}),
        ...(command.snapshot ? { snapshot: command.snapshot } : {}), ...(command.project ? { project: command.project } : {}), signal: controller.signal, emit,
        saveSnapshot: async (snapshot) => { saveSnapshot(snapshot); },
      });
      const pending = queued.splice(0);
      await Promise.all(pending);
      send({ type: "done", runId: command.runId, result: result.result, ...(result.usage ? { usage: result.usage } : {}), ...(result.usageComplete !== undefined ? { usageComplete: result.usageComplete } : {}), artifacts: result.artifacts,
        ...(result.result.status === "completed" && finalSnapshot ? { snapshot: finalSnapshot } : {}) });
    } catch {
      send({ type: "done", runId: command.runId, result: {
        schemaVersion: 1, status: "failed", runId: command.runId, conversationId: command.conversationId,
        endedAt: new Date().toISOString(), error: { code: "worker_error", message: "Worker could not safely complete or persist this run." },
      } });
    } finally {
      if (active?.runId === command.runId) active = undefined;
      if (stopping || !process.connected) process.exit(0);
    }
  })();
  active = { runId: command.runId, controller, task };
  await task;
}

process.on("message", (raw: unknown) => {
  const command = raw as WorkerCommand | WorkerOutbound;
  if (command.type === "ack") {
    const ack = pendingAcks.get(command.requestId);
    if (!ack) return;
    pendingAcks.delete(command.requestId);
    if (command.ok) ack.resolve(); else ack.reject(new Error(command.error ?? "API did not persist Worker output"));
  } else if (command.type === "cancel") {
    if (active?.runId === command.runId) active.controller.abort();
  } else if (command.type === "shutdown") {
    stopping = true;
    active?.controller.abort();
    if (!active) process.exit(0);
  } else if (command.type === "execute") {
    if (stopping || active) {
      send({ type: "worker_error", message: "Worker is busy or shutting down" });
      return;
    }
    void execute(command);
  }
});

process.on("disconnect", () => {
  stopping = true;
  active?.controller.abort();
  if (!active) process.exit(0);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  stopping = true;
  active?.controller.abort();
  if (!active) process.exit(0);
});
send({ type: "ready", bootId });
