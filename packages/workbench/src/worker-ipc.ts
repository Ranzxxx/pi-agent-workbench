import type { RunSubmission, Usage, WorkbenchEvent, WorkbenchResult } from "@pi-workbench/protocol";
import type { ConversationSessionSnapshot } from "@pi-workbench/agent-runtime";

export type WorkerEventPayload = {
  [EventType in WorkbenchEvent["type"]]: Extract<WorkbenchEvent, { type: EventType }> extends { type: EventType; data: infer Data }
    ? { type: EventType; data: Data }
    : never
}[WorkbenchEvent["type"]]
  | { type: "file_change_prepared"; data: { changesetId: string; operationId: string; path: string; kind: "create" | "replace" | "restore" | "remove_created"; preHash: string | null; postHash: string | null } }
  | { type: "file_change_applied"; data: { changesetId: string; operationId: string; path: string; postHash: string | null } }
  | { type: "file_change_conflict"; data: { changesetId: string; operationId: string; path: string; reason: string } };

export interface WorkerProjectContext {
  projectId: string;
  canonicalRoot: string;
  directoryIdentity: string | null;
  acceptedRules?: { sourcePath: string; sourceSha256: string; content: string };
}

export type WorkerCommand =
  | { type: "execute"; runId: string; conversationId: string; input: RunSubmission; snapshot?: ConversationSessionSnapshot; project?: WorkerProjectContext }
  | { type: "cancel"; runId: string }
  | { type: "shutdown" };

export type WorkerInbound =
  | { type: "ready"; bootId: string }
  | { type: "event"; requestId: string; runId: string; conversationId: string; event: WorkerEventPayload }
  | { type: "done"; runId: string; result: WorkbenchResult; usage?: Usage; artifacts?: Array<{ kind: string; path: string; sha256: string }>; snapshot?: ConversationSessionSnapshot }
  | { type: "ack"; requestId: string; ok: boolean; error?: string }
  | { type: "worker_error"; message: string };

export type WorkerOutbound =
  | { type: "execute"; runId: string; conversationId: string; input: RunSubmission; snapshot?: ConversationSessionSnapshot; project?: WorkerProjectContext }
  | { type: "cancel"; runId: string }
  | { type: "shutdown" }
  | { type: "ack"; requestId: string; ok: boolean; error?: string };
