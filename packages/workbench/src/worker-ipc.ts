import type { RunSubmission, Usage, WorkbenchEvent, WorkbenchResult } from "@pi-workbench/protocol";
import type { ConversationSessionSnapshot } from "@pi-workbench/agent-runtime";

export type WorkerEventPayload = {
  [EventType in WorkbenchEvent["type"]]: Extract<WorkbenchEvent, { type: EventType }> extends { type: EventType; data: infer Data }
    ? { type: EventType; data: Data }
    : never
}[WorkbenchEvent["type"]];

export type WorkerCommand =
  | { type: "execute"; runId: string; conversationId: string; input: RunSubmission; snapshot?: ConversationSessionSnapshot }
  | { type: "cancel"; runId: string }
  | { type: "shutdown" };

export type WorkerInbound =
  | { type: "ready"; bootId: string }
  | { type: "event"; requestId: string; runId: string; conversationId: string; event: WorkerEventPayload }
  | { type: "done"; runId: string; result: WorkbenchResult; usage?: Usage; artifacts?: Array<{ kind: string; path: string; sha256: string }>; snapshot?: ConversationSessionSnapshot }
  | { type: "ack"; requestId: string; ok: boolean; error?: string }
  | { type: "worker_error"; message: string };

export type WorkerOutbound =
  | { type: "execute"; runId: string; conversationId: string; input: RunSubmission; snapshot?: ConversationSessionSnapshot }
  | { type: "cancel"; runId: string }
  | { type: "shutdown" }
  | { type: "ack"; requestId: string; ok: boolean; error?: string };
