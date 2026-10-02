import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import type { ConversationSessionSnapshot } from "@pi-workbench/agent-runtime";
import type { RunSubmission, Usage, WorkbenchResult } from "@pi-workbench/protocol";
import type { WorkerCommand, WorkerEventPayload, WorkerInbound, WorkerOutbound, WorkerProjectContext } from "./worker-ipc.js";

export interface WorkerClientOptions {
  entryPath: string; dataDirectory: string; fixtureRoot: string; mode: "fake" | "online";
  apiKey?: string; githubToken?: string; startupTimeoutMs?: number;
}
export interface WorkerTaskResult { result: WorkbenchResult; usage?: Usage; artifacts?: Array<{ kind: string; path: string; sha256: string }>; snapshot?: ConversationSessionSnapshot; }
export interface WorkerTaskHandlers {
  onEvent(event: WorkerEventPayload): void | Promise<void>;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
  });
}

async function terminateChild(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const graceful = waitForExit(child, 1_000);
  child.kill("SIGTERM");
  if (await graceful) return true;
  const forced = waitForExit(child, 2_000);
  child.kill("SIGKILL");
  return forced;
}

export class WorkerClient {
  readonly bootId: string;
  readonly pid: number;
  private readonly child: ChildProcess;
  private closed = false;
  private activeRunId?: string;
  private taskResolve?: (result: WorkerTaskResult) => void;
  private taskReject?: (error: Error) => void;
  private readonly acknowledgements = new Set<Promise<void>>();
  get isAlive(): boolean { return !this.closed && this.child.exitCode === null && this.child.signalCode === null; }

  private constructor(child: ChildProcess, bootId: string) {
    this.child = child;
    this.bootId = bootId;
    if (!child.pid) throw new Error("Worker process did not receive a PID");
    this.pid = child.pid;
    child.on("message", (message: WorkerInbound) => { void this.onMessage(message); });
    child.on("exit", (code, signal) => {
      this.closed = true;
      if (this.taskReject) this.taskReject(new Error(`Worker exited before completing the task (${signal ?? code ?? "unknown"})`));
      this.taskResolve = undefined; this.taskReject = undefined; this.activeRunId = undefined;
    });
    child.on("error", (error) => {
      if (this.taskReject) this.taskReject(error);
    });
  }

  static async start(options: WorkerClientOptions): Promise<WorkerClient> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: process.env.NODE_ENV,
      WORKBENCH_MODE: options.mode, PI_WORKBENCH_DATA_DIR: options.dataDirectory,
      PI_WORKBENCH_FIXTURE_ROOT: options.fixtureRoot,
      ...(options.mode === "online" && options.apiKey ? { DEEPSEEK_API_KEY: options.apiKey } : {}),
      ...(options.mode === "online" && options.githubToken ? { GITHUB_TOKEN: options.githubToken } : {}),
    };
    const child = fork(options.entryPath, [], { execArgv: ["--import", "tsx/esm"], env, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const timeout = options.startupTimeoutMs ?? 10_000;
    let timer: NodeJS.Timeout | undefined;
    const ready = new Promise<string>((resolve, reject) => {
      const onMessage = (message: WorkerInbound) => {
        if (message.type === "ready") { child.off("message", onMessage); resolve(message.bootId); }
        else if (message.type === "worker_error") { child.off("message", onMessage); reject(new Error("Worker failed during startup")); }
      };
      child.on("message", onMessage);
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`Worker exited during startup (${signal ?? code ?? "unknown"})`)));
      timer = setTimeout(() => reject(new Error("Worker startup timed out")), timeout);
      timer.unref();
    });
    try { return new WorkerClient(child, await ready); }
    catch (error) { await terminateChild(child); throw error; }
    finally { if (timer) clearTimeout(timer); }
  }

  async execute(input: { runId: string; conversationId: string; input: RunSubmission; snapshot?: ConversationSessionSnapshot; project?: WorkerProjectContext }, handlers: WorkerTaskHandlers): Promise<WorkerTaskResult> {
    if (this.closed || this.activeRunId) throw new Error("Worker is unavailable or busy");
    this.activeRunId = input.runId;
    const result = new Promise<WorkerTaskResult>((resolve, reject) => { this.taskResolve = resolve; this.taskReject = reject; });
    const command: WorkerCommand = { type: "execute", ...input };
    this.handlers = handlers;
    try { this.send(command); }
    catch (error) { this.activeRunId = undefined; this.taskResolve = undefined; this.taskReject = undefined; throw error; }
    return result.finally(() => {
      this.activeRunId = undefined;
      this.taskResolve = undefined; this.taskReject = undefined;
      this.handlers = undefined;
    });
  }

  private handlers?: WorkerTaskHandlers;

  cancel(runId: string): boolean {
    if (this.closed || this.activeRunId !== runId) return false;
    this.send({ type: "cancel", runId });
    return true;
  }

  private send(command: WorkerOutbound): void {
    if (this.closed || !this.child.connected) throw new Error("Worker IPC channel is unavailable");
    this.child.send(command, (error) => { if (error) this.taskReject?.(error); });
  }

  private async onMessage(message: WorkerInbound): Promise<void> {
    if (message.type === "ack" || message.type === "ready") return;
    if (message.type === "worker_error") {
      this.taskReject?.(new Error("Worker rejected the task"));
      return;
    }
    if (message.type === "done") {
      if (message.runId === this.activeRunId) this.taskResolve?.({ result: message.result, ...(message.usage ? { usage: message.usage } : {}), ...(message.artifacts ? { artifacts: message.artifacts } : {}), ...(message.snapshot ? { snapshot: message.snapshot } : {}) });
      return;
    }
    // Invoke the persistence handler inside a promise boundary. It may throw
    // synchronously (for example when SQLite rejects an event insert); without
    // this boundary the async message listener would reject unobserved and can
    // terminate the API process before the Worker is fenced.
    const callback = Promise.resolve().then(() => this.handlers?.onEvent(message.event));
    const acknowledgement = callback.then(
      () => this.send({ type: "ack", requestId: message.requestId, ok: true }),
      () => { this.send({ type: "ack", requestId: message.requestId, ok: false, error: "Persistence failed" }); throw new Error("Worker output could not be persisted"); },
    );
    this.acknowledgements.add(acknowledgement);
    try { await acknowledgement; }
    catch (error) { this.cancel(message.type === "event" ? message.runId : this.activeRunId ?? ""); this.taskReject?.(error as Error); }
    finally { this.acknowledgements.delete(acknowledgement); }
  }

  async shutdown(timeoutMs = 5_000): Promise<boolean> {
    if (this.closed || this.child.exitCode !== null || this.child.signalCode !== null) return true;
    const graceful = waitForExit(this.child, timeoutMs);
    try { this.send({ type: "shutdown" }); } catch { /* A closed IPC channel still requires process identity confirmation below. */ }
    if (await graceful) return true;
    const terminated = waitForExit(this.child, 1_000);
    this.child.kill("SIGTERM");
    if (await terminated) return true;
    const killed = waitForExit(this.child, 2_000);
    this.child.kill("SIGKILL");
    return killed;
  }
}
