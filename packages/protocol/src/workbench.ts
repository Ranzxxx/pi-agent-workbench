import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const object = <T extends Record<string, import("typebox").TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" });
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });

export const RepositoryAnalysisInputSchema = object({
  repositoryUrl: Type.String({ minLength: 1, maxLength: 512, pattern: "^https://github\\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$" }),
  ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  goal: Type.String({ minLength: 1, maxLength: 8000, pattern: "\\S" }),
});
export const CapabilityInvocationSchema = object({
  kind: Type.Literal("capability"),
  capabilityId: Type.Literal("public_repository_analysis"),
  input: RepositoryAnalysisInputSchema,
});
export const PromptSubmissionSchema = object({
  kind: Type.Literal("message"),
  text: Type.String({ minLength: 1, maxLength: 16_000, pattern: "\\S" }),
});
export const RunSubmissionSchema = Type.Union([PromptSubmissionSchema, CapabilityInvocationSchema]);
export const CreateRunRequestSchema = object({ schemaVersion: Type.Literal(1), input: RunSubmissionSchema });

export const ConversationMessageSchema = Type.Union([
  object({ schemaVersion: Type.Literal(1), id, role: Type.Literal("user"), text: Type.String({ maxLength: 16_000 }), createdAt: timestamp }),
  object({ schemaVersion: Type.Literal(1), id, role: Type.Literal("assistant"), text: Type.String({ maxLength: 16_000 }), createdAt: timestamp }),
  object({
    schemaVersion: Type.Literal(1), id, role: Type.Literal("capability"), text: Type.String({ maxLength: 16_000 }), createdAt: timestamp,
    capabilityId: Type.Literal("public_repository_analysis"), input: RepositoryAnalysisInputSchema,
  }),
]);
export const ConversationSummarySchema = object({
  schemaVersion: Type.Literal(1), conversationId: id, title: Type.String({ minLength: 1, maxLength: 128 }),
  createdAt: timestamp, updatedAt: timestamp, preview: Type.String({ maxLength: 256 }), messageCount: Type.Integer({ minimum: 0, maximum: 1000 }),
});
export const ConversationSchema = object({
  schemaVersion: Type.Literal(1), conversationId: id, title: Type.String({ minLength: 1, maxLength: 128 }),
  createdAt: timestamp, updatedAt: timestamp, preview: Type.String({ maxLength: 256 }),
  messageCount: Type.Integer({ minimum: 0, maximum: 1000 }), messages: Type.Array(ConversationMessageSchema, { maxItems: 1000 }),
});

export const WorkbenchRunStatusSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("running"), Type.Literal("cancelling"),
  Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"),
]);
export const WorkbenchArtifactSchema = object({
  kind: Type.Union([Type.Literal("report.json"), Type.Literal("report.md"), Type.Literal("manifest.json"), Type.Literal("events.jsonl")]),
  sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
});
export const BoundedEvidenceReferenceSchema = object({
  path: Type.String({ minLength: 1, maxLength: 512 }), startLine: Type.Integer({ minimum: 1 }), endLine: Type.Integer({ minimum: 1 }),
});
export const BoundedClaimSchema = object({
  id, kind: Type.Union([Type.Literal("fact"), Type.Literal("inference"), Type.Literal("unknown")]),
  text: Type.String({ minLength: 1, maxLength: 1000 }),
  evidence: Type.Array(BoundedEvidenceReferenceSchema, { maxItems: 8 }),
});
export const CapabilityResultSchema = object({
  capabilityId: Type.Literal("public_repository_analysis"),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  summary: Type.String({ minLength: 1, maxLength: 4096 }),
  claims: Type.Array(BoundedClaimSchema, { minItems: 1, maxItems: 32 }),
});
export const WorkbenchResultSchema = Type.Union([
  object({
    schemaVersion: Type.Literal(1), status: Type.Literal("completed"), runId: id, conversationId: id, endedAt: timestamp,
    reply: Type.String({ maxLength: 16_000 }), artifacts: Type.Optional(Type.Array(WorkbenchArtifactSchema, { maxItems: 16 })),
    capabilityResult: Type.Optional(CapabilityResultSchema),
  }),
  object({
    schemaVersion: Type.Literal(1), status: Type.Literal("failed"), runId: id, conversationId: id, endedAt: timestamp,
    error: object({ code: Type.String({ minLength: 1, maxLength: 64 }), message: Type.String({ minLength: 1, maxLength: 512 }) }),
    artifacts: Type.Optional(Type.Array(WorkbenchArtifactSchema, { maxItems: 16 })),
  }),
  object({
    schemaVersion: Type.Literal(1), status: Type.Literal("cancelled"), runId: id, conversationId: id, endedAt: timestamp,
    reason: Type.Union([Type.Literal("user"), Type.Literal("timeout"), Type.Literal("token_limit"), Type.Literal("call_limit"), Type.Literal("tool_limit"), Type.Literal("cost_limit")]),
    artifacts: Type.Optional(Type.Array(WorkbenchArtifactSchema, { maxItems: 16 })),
  }),
]);
export const WorkbenchRunSchema = object({
  schemaVersion: Type.Literal(1), runId: id, conversationId: id, status: WorkbenchRunStatusSchema,
  createdAt: timestamp, updatedAt: timestamp, input: RunSubmissionSchema, retryOfRunId: Type.Optional(id),
  result: Type.Optional(WorkbenchResultSchema),
});

const eventEnvelope = { schemaVersion: Type.Literal(1), eventId: id, runId: id, conversationId: id, sequence: Type.Integer({ minimum: 1 }), timestamp };
export const WorkbenchEventSchema = Type.Union([
  object({ ...eventEnvelope, type: Type.Literal("run.started"), data: object({ input: RunSubmissionSchema, retryOfRunId: Type.Optional(id) }) }),
  object({ ...eventEnvelope, type: Type.Literal("message.delta"), data: object({ text: Type.String({ minLength: 1, maxLength: 8192 }) }) }),
  object({ ...eventEnvelope, type: Type.Literal("capability.started"), data: object({ capabilityId: Type.Literal("public_repository_analysis"), label: Type.String({ minLength: 1, maxLength: 128 }) }) }),
  object({ ...eventEnvelope, type: Type.Literal("tool.started"), data: object({ toolCallId: id, toolName: id }) }),
  object({ ...eventEnvelope, type: Type.Literal("tool.finished"), data: object({ toolCallId: id, toolName: id, isError: Type.Boolean() }) }),
  object({ ...eventEnvelope, type: Type.Literal("run.cancelling"), data: object({ reason: Type.Union([Type.Literal("user"), Type.Literal("timeout"), Type.Literal("token_limit"), Type.Literal("call_limit"), Type.Literal("tool_limit"), Type.Literal("cost_limit")]) }) }),
  object({ ...eventEnvelope, type: Type.Literal("run.warning"), data: object({ code: Type.Literal("cancellation_pending") }) }),
  object({ ...eventEnvelope, type: Type.Literal("run.finished"), data: WorkbenchResultSchema }),
]);

/** Transport-level recovery control frame. It is not a run event and does not consume a run sequence number. */
export const WorkbenchStreamResetSchema = object({
  schemaVersion: Type.Literal(1), eventId: id, runId: id, type: Type.Literal("stream.reset"),
  data: object({
    reason: Type.Literal("event_history_expired"),
    earliestAvailableSequence: Type.Integer({ minimum: 1 }),
    latestSequence: Type.Integer({ minimum: 0 }),
    latestEventId: Type.Optional(id),
  }),
});

export const WorkbenchApiErrorSchema = object({
  schemaVersion: Type.Literal(1), error: object({
    code: Type.Union([
      Type.Literal("invalid_request"), Type.Literal("not_found"), Type.Literal("busy"),
      Type.Literal("idempotency_conflict"), Type.Literal("unsupported_capability"), Type.Literal("conflict"), Type.Literal("internal_error"),
    ]), message: Type.String({ minLength: 1, maxLength: 512 }),
  }),
});

export const CapabilityInfoSchema = object({
  id: Type.Literal("public_repository_analysis"),
  name: Type.String({ minLength: 1, maxLength: 128 }),
  description: Type.String({ minLength: 1, maxLength: 1024 }),
  inputs: Type.Array(object({
    id, label: Type.String({ minLength: 1, maxLength: 128 }), required: Type.Boolean(),
    description: Type.String({ minLength: 1, maxLength: 512 }),
    control: Type.Union([Type.Literal("text"), Type.Literal("textarea")]),
    maxLength: Type.Integer({ minimum: 1, maximum: 16_000 }),
  }), { maxItems: 16 }),
});

export type RepositoryAnalysisInput = Static<typeof RepositoryAnalysisInputSchema>;
export type CapabilityInvocation = Static<typeof CapabilityInvocationSchema>;
export type PromptSubmission = Static<typeof PromptSubmissionSchema>;
export type RunSubmission = Static<typeof RunSubmissionSchema>;
export type CreateRunRequest = Static<typeof CreateRunRequestSchema>;
export type ConversationMessage = Static<typeof ConversationMessageSchema>;
export type ConversationSummary = Static<typeof ConversationSummarySchema>;
export type Conversation = Static<typeof ConversationSchema>;
export type WorkbenchRunStatus = Static<typeof WorkbenchRunStatusSchema>;
export type WorkbenchArtifact = Static<typeof WorkbenchArtifactSchema>;
export type CapabilityResult = Static<typeof CapabilityResultSchema>;
export type WorkbenchResult = Static<typeof WorkbenchResultSchema>;
export type WorkbenchRun = Static<typeof WorkbenchRunSchema>;
export type WorkbenchEvent = Static<typeof WorkbenchEventSchema>;
export type WorkbenchStreamReset = Static<typeof WorkbenchStreamResetSchema>;
export type WorkbenchApiError = Static<typeof WorkbenchApiErrorSchema>;
export type CapabilityInfo = Static<typeof CapabilityInfoSchema>;
export type BoundedEvidenceReference = Static<typeof BoundedEvidenceReferenceSchema>;
export type BoundedClaim = Static<typeof BoundedClaimSchema>;

export function parseWorkbenchResult(value: unknown): WorkbenchResult {
  if (!Check(WorkbenchResultSchema, value)) throw new Error("Workbench result validation failed");
  const result = value as WorkbenchResult;
  if (!Number.isFinite(Date.parse(result.endedAt)) || new Date(result.endedAt).toISOString() !== result.endedAt) throw new Error("Invalid workbench result timestamp");
  if (result.status === "completed" && result.artifacts && new Set(result.artifacts.map((item) => item.kind)).size !== result.artifacts.length) {
    throw new Error("Duplicate workbench artifact kind");
  }
  return result;
}

export function parseWorkbenchEvent(value: unknown): WorkbenchEvent {
  if (!Check(WorkbenchEventSchema, value)) throw new Error("Workbench event validation failed");
  const event = value as WorkbenchEvent;
  if (!Number.isFinite(Date.parse(event.timestamp)) || new Date(event.timestamp).toISOString() !== event.timestamp) throw new Error("Invalid workbench event timestamp");
  if (event.type === "run.finished") {
    const result = parseWorkbenchResult(event.data);
    if (event.runId !== result.runId || event.conversationId !== result.conversationId) throw new Error("Workbench event result identity mismatch");
  }
  return event;
}
