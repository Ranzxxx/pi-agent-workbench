import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { RepositoryAnalysisInputSchema, RunSubmissionSchema, WorkbenchResultSchema } from "./workbench.js";

const object = <T extends Record<string, import("typebox").TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" });
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const nonnegative = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const sequence = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const relativeFilePath = Type.String({ minLength: 1, maxLength: 1024,
  pattern: "^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*[\\\\:]).+$",
});

/** API, event and persistence payloads have independent versions. This is not a report schema version. */
export const V2RunStatusSchema = Type.Union([
  Type.Literal("accepted"), Type.Literal("running"), Type.Literal("cancelling"),
  Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("interrupted"),
]);
export type V2RunStatus = Static<typeof V2RunStatusSchema>;

export const V2RunIdentitySchema = object({
  schemaVersion: Type.Literal(2), runId: id, conversationId: id,
});
export const V2AttemptIdentitySchema = object({
  schemaVersion: Type.Literal(2), runId: id, attemptId: id, attemptNumber: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
});

export const V2RunSchema = object({
  schemaVersion: Type.Literal(2), runId: id, conversationId: id,
  projectId: Type.Optional(Type.Union([id, Type.Null()])),
  extensionId: Type.Optional(Type.Union([id, Type.Null()])),
  status: V2RunStatusSchema,
  requestHash: sha256,
  input: Type.Optional(RunSubmissionSchema),
  retryOfRunId: Type.Optional(id), currentAttemptId: Type.Optional(id),
  createdAt: timestamp, updatedAt: timestamp, endedAt: Type.Optional(Type.Union([timestamp, Type.Null()])),
  result: Type.Optional(WorkbenchResultSchema),
});

export const V2ConversationMessageSchema = object({
  schemaVersion: Type.Literal(2), messageId: id, conversationId: id,
  sequence: sequence, role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("capability")]),
  content: Type.String({ maxLength: 16_000 }), createdAt: timestamp,
  extensionId: Type.Optional(Type.Union([id, Type.Null()])),
  capabilityInput: Type.Optional(RepositoryAnalysisInputSchema),
});
export const V2ConversationSummarySchema = object({
  schemaVersion: Type.Literal(2), conversationId: id, title: Type.String({ minLength: 1, maxLength: 256 }),
  projectId: Type.Optional(Type.Union([id, Type.Null()])),
  createdAt: timestamp, updatedAt: timestamp, preview: Type.String({ maxLength: 256 }), messageCount: nonnegative,
});
export const V2ConversationSchema = object({
  schemaVersion: Type.Literal(2), conversationId: id, title: Type.String({ minLength: 1, maxLength: 256 }),
  projectId: Type.Optional(Type.Union([id, Type.Null()])),
  createdAt: timestamp, updatedAt: timestamp, preview: Type.String({ maxLength: 256 }), messageCount: nonnegative,
  messages: Type.Array(V2ConversationMessageSchema, { maxItems: 1000 }),
});
export const V2SubmitRunRequestSchema = object({
  schemaVersion: Type.Literal(2), conversationId: id, input: RunSubmissionSchema,
});

export const V2ProjectSchema = object({
  schemaVersion: Type.Literal(2), projectId: id, displayName: Type.String({ minLength: 1, maxLength: 256 }),
  canonicalRoot: Type.String({ minLength: 1, maxLength: 4096 }), validationState: Type.Union([Type.Literal("valid"), Type.Literal("missing"), Type.Literal("needs_review")]),
  createdAt: timestamp, lastAccessedAt: timestamp,
});
export const V2PickerEntrySchema = object({
  name: Type.String({ minLength: 1, maxLength: 255 }), kind: Type.Union([Type.Literal("directory"), Type.Literal("file"), Type.Literal("excluded")]),
  token: Type.Optional(id), byteSize: Type.Optional(nonnegative), reason: Type.Optional(Type.String({ maxLength: 128 })),
});
export const V2PickerDirectorySchema = object({
  schemaVersion: Type.Literal(2), directoryToken: id, parentToken: Type.Optional(id), displayPath: Type.String({ minLength: 1, maxLength: 4096 }),
  canSelectProject: Type.Boolean(), truncated: Type.Boolean(), entries: Type.Array(V2PickerEntrySchema, { maxItems: 500 }),
});
export const V2PickerRootsSchema = object({
  schemaVersion: Type.Literal(2), roots: Type.Array(object({ label: Type.String({ minLength: 1, maxLength: 256 }), token: id }), { maxItems: 32 }),
});
export const V2PickerSessionSchema = object({ schemaVersion: Type.Literal(2), csrfToken: Type.String({ minLength: 32, maxLength: 128 }), expiresAt: timestamp });
export const V2PickerBrowseRequestSchema = object({ schemaVersion: Type.Literal(2), mode: Type.Union([Type.Literal("project"), Type.Literal("attachment")]), directoryToken: id });
export const V2PickerSelectProjectRequestSchema = object({ schemaVersion: Type.Literal(2), directoryToken: id });
export const V2PickerOpenProjectRequestSchema = object({
  schemaVersion: Type.Literal(2), selectionToken: id, displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});
export const V2AttachmentSchema = object({
  schemaVersion: Type.Literal(2), attachmentId: id, conversationId: id, fileName: Type.String({ minLength: 1, maxLength: 512 }),
  relativePath: Type.String({ minLength: 1, maxLength: 4096 }), byteSize: nonnegative, mediaType: Type.Literal("text/plain; charset=utf-8"), createdAt: timestamp,
});
export const V2AttachmentImportRequestSchema = object({
  schemaVersion: Type.Literal(2), fileTokens: Type.Array(id, { maxItems: 100 }), directoryToken: Type.Optional(id),
});
export const V2ImportResultSchema = object({
  schemaVersion: Type.Literal(2), attachments: Type.Array(V2AttachmentSchema, { maxItems: 100 }),
  skipped: Type.Array(object({ path: Type.String({ minLength: 1, maxLength: 4096 }), reason: Type.String({ minLength: 1, maxLength: 128 }) }), { maxItems: 500 }),
  totalBytes: nonnegative,
});
export const V2ProjectRulesSchema = object({
  schemaVersion: Type.Literal(2), projectId: id, sourcePath: Type.String({ minLength: 1, maxLength: 4096 }),
  sourceSha256: sha256, sourceVersion: Type.String({ minLength: 1, maxLength: 128 }), content: Type.String({ maxLength: 65536 }),
  acceptedAt: timestamp, revokedAt: Type.Optional(Type.Union([timestamp, Type.Null()])),
});
export const V2ProjectRulesAcceptRequestSchema = object({ schemaVersion: Type.Literal(2), previewToken: id });
export const V2FileOperationSchema = object({
  schemaVersion: Type.Literal(2), operationId: id, changesetId: id, sequence,
  path: relativeFilePath, kind: Type.Union([Type.Literal("create"), Type.Literal("replace"), Type.Literal("restore"), Type.Literal("remove_created")]),
  status: Type.Union([Type.Literal("prepared"), Type.Literal("applied"), Type.Literal("not_applied"), Type.Literal("conflict"), Type.Literal("uncertain"), Type.Literal("undone")]),
  preHash: Type.Optional(Type.Union([sha256, Type.Null()])), postHash: Type.Optional(Type.Union([sha256, Type.Null()])),
  errorCode: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()])),
});
export const V2FileDiffSchema = object({
  path: relativeFilePath, status: Type.String({ minLength: 1, maxLength: 32 }),
  beforeText: Type.Union([Type.String({ maxLength: 65536 }), Type.Null()]),
  afterText: Type.Union([Type.String({ maxLength: 65536 }), Type.Null()]),
  diffText: Type.String({ maxLength: 131072 }), truncated: Type.Boolean(),
});
export const V2ChangesetSchema = object({
  schemaVersion: Type.Literal(2), changesetId: id, conversationId: id, projectId: id,
  runId: Type.Optional(Type.Union([id, Type.Null()])), undoOfChangesetId: Type.Optional(Type.Union([id, Type.Null()])),
  status: Type.Union([Type.Literal("open"), Type.Literal("applied"), Type.Literal("partial"), Type.Literal("conflict"), Type.Literal("undone")]),
  createdAt: timestamp, updatedAt: timestamp,
  operations: Type.Array(V2FileOperationSchema, { maxItems: 1000 }), diffs: Type.Array(V2FileDiffSchema, { maxItems: 200 }),
});
export const V2ChangesetSummarySchema = object({
  schemaVersion: Type.Literal(2), changesetId: id, conversationId: id, projectId: id,
  runId: Type.Optional(Type.Union([id, Type.Null()])), undoOfChangesetId: Type.Optional(Type.Union([id, Type.Null()])),
  status: Type.Union([Type.Literal("open"), Type.Literal("applied"), Type.Literal("partial"), Type.Literal("conflict"), Type.Literal("undone")]),
  operationCount: nonnegative, createdAt: timestamp, updatedAt: timestamp,
});
export const V2ChangesetUndoRequestSchema = object({ schemaVersion: Type.Literal(2), confirm: Type.Literal(true) });
export const V2ChangesetUndoResultSchema = object({
  schemaVersion: Type.Literal(2), changesetId: id, status: Type.Union([Type.Literal("undone"), Type.Literal("partial"), Type.Literal("conflict")]),
  undonePaths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 200 }),
  conflictPaths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 200 }),
});
export const V2CleanupPreviewSchema = object({
  schemaVersion: Type.Literal(2), changesetIds: Type.Array(id, { maxItems: 100 }),
  changesetCount: nonnegative, backupObjectCount: nonnegative, backupBytes: nonnegative,
  losesUndoHistory: Type.Boolean(), note: Type.String({ minLength: 1, maxLength: 512 }),
});
export const V2CleanupRequestSchema = object({
  schemaVersion: Type.Literal(2), confirm: Type.Literal(true), changesetIds: Type.Array(id, { minItems: 1, maxItems: 100 }),
});
export const V2CleanupResultSchema = object({
  schemaVersion: Type.Literal(2), deletedChangesetCount: nonnegative, queuedBackupObjects: nonnegative,
});
export const V2AttachmentResultSchema = object({
  schemaVersion: Type.Literal(2), resultId: id, conversationId: id, sourceAttachmentId: Type.Optional(Type.Union([id, Type.Null()])),
  fileName: Type.String({ minLength: 1, maxLength: 512 }), byteSize: nonnegative, mediaType: Type.Literal("text/plain; charset=utf-8"), createdAt: timestamp,
});

export const V2ErrorSchema = object({
  schemaVersion: Type.Literal(2),
  code: Type.Union([
    Type.Literal("invalid_request"), Type.Literal("not_found"), Type.Literal("active_task"),
    Type.Literal("idempotency_conflict"), Type.Literal("upgrade_required"), Type.Literal("db_busy"),
    Type.Literal("db_readonly"), Type.Literal("unknown_schema"), Type.Literal("conflict"),
    Type.Literal("busy"), Type.Literal("worker_unavailable"), Type.Literal("interrupted"),
    Type.Literal("internal_error"), Type.Literal("migration_failed"),
  ]),
  message: Type.String({ minLength: 1, maxLength: 512 }), retryable: Type.Boolean(),
});

export const V2RunAttemptSchema = object({
  schemaVersion: Type.Literal(2), runId: id, attemptId: id,
  attemptNumber: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  status: Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("interrupted")]),
  usageComplete: Type.Boolean(),
  workerBootId: Type.Optional(id), startedAt: timestamp, endedAt: Type.Optional(Type.Union([timestamp, Type.Null()])),
  error: Type.Optional(Type.Union([Type.Null(), V2ErrorSchema])),
});

const eventEnvelope = {
  schemaVersion: Type.Literal(2), eventId: id, runId: id, attemptId: id,
  sequence, timestamp,
};
const smallText = Type.String({ minLength: 1, maxLength: 1024 });
const usage = object({
  modelCalls: nonnegative, toolCalls: nonnegative, inputTokens: nonnegative, outputTokens: nonnegative,
  cacheReadTokens: nonnegative, cacheWriteTokens: nonnegative,
  totalTokens: nonnegative, costStatus: Type.Union([Type.Literal("unknown"), Type.Literal("estimate"), Type.Literal("known")]),
  estimatedCostUsd: Type.Optional(Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
});

export const V2RunEventSchema = Type.Union([
  object({ ...eventEnvelope, type: Type.Literal("run.accepted"), data: object({ conversationId: id, requestHash: sha256 }) }),
  object({ ...eventEnvelope, type: Type.Literal("run.started"), data: object({ workerBootId: id }) }),
  object({ ...eventEnvelope, type: Type.Literal("run.progress"), data: object({ phase: smallText, message: Type.String({ maxLength: 2048 }) }) }),
  object({ ...eventEnvelope, type: Type.Literal("message.delta"), data: object({ text: Type.String({ minLength: 1, maxLength: 8192 }) }) }),
  object({ ...eventEnvelope, type: Type.Literal("tool.started"), data: object({ toolCallId: id, toolName: id, argumentsSummary: Type.Literal("omitted") }) }),
  object({ ...eventEnvelope, type: Type.Literal("tool.finished"), data: object({ toolCallId: id, toolName: id, isError: Type.Boolean() }) }),
  object({ ...eventEnvelope, type: Type.Literal("checkpoint.saved"), data: object({ checkpointId: id, phase: smallText }) }),
  object({ ...eventEnvelope, type: Type.Literal("file_change_prepared"), data: object({
    changesetId: id, operationId: id, path: relativeFilePath,
    kind: Type.Union([Type.Literal("create"), Type.Literal("replace"), Type.Literal("restore"), Type.Literal("remove_created")]),
    preHash: Type.Union([sha256, Type.Null()]), postHash: Type.Union([sha256, Type.Null()]),
  }) }),
  object({ ...eventEnvelope, type: Type.Literal("file_change_applied"), data: object({
    changesetId: id, operationId: id, path: relativeFilePath, postHash: Type.Union([sha256, Type.Null()]),
  }) }),
  object({ ...eventEnvelope, type: Type.Literal("file_change_conflict"), data: object({
    changesetId: id, operationId: id, path: relativeFilePath, reason: smallText,
  }) }),
  object({ ...eventEnvelope, type: Type.Literal("usage.updated"), data: usage }),
  object({ ...eventEnvelope, type: Type.Literal("run.cancelling"), data: object({ reason: Type.Union([
    Type.Literal("user"), Type.Literal("shutdown"), Type.Literal("timeout"), Type.Literal("token_limit"),
    Type.Literal("call_limit"), Type.Literal("tool_limit"), Type.Literal("cost_limit"),
  ]) }) }),
  object({ ...eventEnvelope, type: Type.Literal("run.completed"), data: object({ resultRef: Type.Optional(id) }) }),
  object({ ...eventEnvelope, type: Type.Literal("run.failed"), data: object({ error: V2ErrorSchema }) }),
  object({ ...eventEnvelope, type: Type.Literal("run.cancelled"), data: object({ reason: Type.Union([
    Type.Literal("user"), Type.Literal("shutdown"), Type.Literal("timeout"), Type.Literal("token_limit"),
    Type.Literal("call_limit"), Type.Literal("tool_limit"), Type.Literal("cost_limit"),
  ]) }) }),
  object({ ...eventEnvelope, type: Type.Literal("run.interrupted"), data: object({ reason: Type.Union([Type.Literal("process_exit"), Type.Literal("state_uncertain")]) }) }),
  object({ ...eventEnvelope, type: Type.Literal("changeset_undone"), data: object({
    changesetId: id, status: Type.Union([Type.Literal("undone"), Type.Literal("partial"), Type.Literal("conflict")]),
  }) }),
]);

export const V2EventCursorSchema = object({
  schemaVersion: Type.Literal(2), runId: id, afterSequence: nonnegative, lastEventId: Type.Optional(id),
});
export const V2RunEventPageSchema = object({
  schemaVersion: Type.Literal(2), runId: id, afterSequence: nonnegative, events: Type.Array(V2RunEventSchema, { maxItems: 1000 }),
  nextCursor: V2EventCursorSchema,
});

export const V2IdempotencyRequestSchema = object({
  schemaVersion: Type.Literal(2), scope: id, endpoint: Type.String({ minLength: 1, maxLength: 128 }),
  key: Type.String({ minLength: 1, maxLength: 255 }), requestHash: sha256,
});
export const V2IdempotencyResultSchema = object({
  schemaVersion: Type.Literal(2), resourceKind: Type.Union([Type.Literal("run"), Type.Literal("conversation")]), resourceId: id,
});

export type V2RunIdentity = Static<typeof V2RunIdentitySchema>;
export type V2AttemptIdentity = Static<typeof V2AttemptIdentitySchema>;
export type V2Run = Static<typeof V2RunSchema>;
export type V2ConversationMessage = Static<typeof V2ConversationMessageSchema>;
export type V2ConversationSummary = Static<typeof V2ConversationSummarySchema>;
export type V2Conversation = Static<typeof V2ConversationSchema>;
export type V2SubmitRunRequest = Static<typeof V2SubmitRunRequestSchema>;
export type V2Project = Static<typeof V2ProjectSchema>;
export type V2PickerEntry = Static<typeof V2PickerEntrySchema>;
export type V2PickerDirectory = Static<typeof V2PickerDirectorySchema>;
export type V2PickerRoots = Static<typeof V2PickerRootsSchema>;
export type V2PickerSession = Static<typeof V2PickerSessionSchema>;
export type V2PickerBrowseRequest = Static<typeof V2PickerBrowseRequestSchema>;
export type V2PickerSelectProjectRequest = Static<typeof V2PickerSelectProjectRequestSchema>;
export type V2PickerOpenProjectRequest = Static<typeof V2PickerOpenProjectRequestSchema>;
export type V2Attachment = Static<typeof V2AttachmentSchema>;
export type V2AttachmentImportRequest = Static<typeof V2AttachmentImportRequestSchema>;
export type V2ImportResult = Static<typeof V2ImportResultSchema>;
export type V2ProjectRules = Static<typeof V2ProjectRulesSchema>;
export type V2ProjectRulesAcceptRequest = Static<typeof V2ProjectRulesAcceptRequestSchema>;
export type V2FileOperation = Static<typeof V2FileOperationSchema>;
export type V2FileDiff = Static<typeof V2FileDiffSchema>;
export type V2Changeset = Static<typeof V2ChangesetSchema>;
export type V2ChangesetSummary = Static<typeof V2ChangesetSummarySchema>;
export type V2ChangesetUndoRequest = Static<typeof V2ChangesetUndoRequestSchema>;
export type V2ChangesetUndoResult = Static<typeof V2ChangesetUndoResultSchema>;
export type V2CleanupPreview = Static<typeof V2CleanupPreviewSchema>;
export type V2CleanupRequest = Static<typeof V2CleanupRequestSchema>;
export type V2CleanupResult = Static<typeof V2CleanupResultSchema>;
export type V2AttachmentResult = Static<typeof V2AttachmentResultSchema>;
export type V2RunAttempt = Static<typeof V2RunAttemptSchema>;
export type V2RunEvent = Static<typeof V2RunEventSchema>;
export type V2EventCursor = Static<typeof V2EventCursorSchema>;
export type V2RunEventPage = Static<typeof V2RunEventPageSchema>;
export type V2Error = Static<typeof V2ErrorSchema>;
export type V2IdempotencyRequest = Static<typeof V2IdempotencyRequestSchema>;
export type V2IdempotencyResult = Static<typeof V2IdempotencyResultSchema>;

function parseVersioned<T>(schema: import("typebox").TSchema, value: unknown, label: string): T {
  if (!Check(schema, value)) throw new Error(`${label} validation failed`);
  return value as T;
}
function validateTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Invalid v2 timestamp");
}

export function parseV2RunIdentity(value: unknown): V2RunIdentity {
  return parseVersioned<V2RunIdentity>(V2RunIdentitySchema, value, "V2 run identity");
}
export function parseV2AttemptIdentity(value: unknown): V2AttemptIdentity {
  return parseVersioned<V2AttemptIdentity>(V2AttemptIdentitySchema, value, "V2 attempt identity");
}

export function parseV2Run(value: unknown): V2Run {
  const run = parseVersioned<V2Run>(V2RunSchema, value, "V2 run");
  validateTimestamp(run.createdAt); validateTimestamp(run.updatedAt);
  if (run.endedAt) validateTimestamp(run.endedAt);
  if (Date.parse(run.updatedAt) < Date.parse(run.createdAt)) throw new Error("Invalid v2 run update time");
  if (run.endedAt && Date.parse(run.endedAt) < Date.parse(run.createdAt)) throw new Error("Invalid v2 run time range");
  if (run.endedAt && Date.parse(run.endedAt) > Date.parse(run.updatedAt)) throw new Error("Invalid v2 run end time");
  if (["completed", "failed", "cancelled", "interrupted"].includes(run.status) !== Boolean(run.endedAt)) throw new Error("V2 run terminal timestamp mismatch");
  return run;
}

export function parseV2RunAttempt(value: unknown): V2RunAttempt {
  const attempt = parseVersioned<V2RunAttempt>(V2RunAttemptSchema, value, "V2 attempt");
  validateTimestamp(attempt.startedAt);
  if (attempt.endedAt) validateTimestamp(attempt.endedAt);
  if (attempt.endedAt && Date.parse(attempt.endedAt) < Date.parse(attempt.startedAt)) throw new Error("Invalid v2 attempt time range");
  const terminal = attempt.status !== "running";
  if (terminal !== Boolean(attempt.endedAt)) throw new Error("V2 attempt terminal timestamp mismatch");
  if (attempt.status === "failed" && !attempt.error) throw new Error("Failed v2 attempts require an error");
  if (attempt.error && attempt.status !== "failed") throw new Error("V2 attempt error status mismatch");
  if (attempt.error) parseV2Error(attempt.error);
  return attempt;
}

export function parseV2Error(value: unknown): V2Error {
  return parseVersioned<V2Error>(V2ErrorSchema, value, "V2 error");
}

export function parseV2RunEvent(value: unknown): V2RunEvent {
  const event = parseVersioned<V2RunEvent>(V2RunEventSchema, value, "V2 event");
  validateTimestamp(event.timestamp);
  if ((event.type === "run.failed") && event.data.error.schemaVersion !== 2) throw new Error("Invalid v2 event error");
  if (event.type === "usage.updated" && event.data.totalTokens !== event.data.inputTokens + event.data.outputTokens + event.data.cacheReadTokens + event.data.cacheWriteTokens) {
    throw new Error("Invalid v2 usage total");
  }
  if (event.type === "usage.updated" && ((event.data.costStatus === "unknown") === (event.data.estimatedCostUsd !== undefined))) {
    throw new Error("Invalid v2 usage cost status");
  }
  return event;
}

export function parseV2EventCursor(value: unknown): V2EventCursor {
  return parseVersioned<V2EventCursor>(V2EventCursorSchema, value, "V2 event cursor");
}

export function parseV2RunEventPage(value: unknown): V2RunEventPage {
  const page = parseVersioned<V2RunEventPage>(V2RunEventPageSchema, value, "V2 event page");
  let expected = page.afterSequence + 1;
  for (const raw of page.events) {
    const event = parseV2RunEvent(raw);
    if (event.runId !== page.runId || event.sequence !== expected) throw new Error("Invalid v2 event sequence");
    expected = event.sequence + 1;
  }
  const last = page.events.at(-1);
  if (page.nextCursor.runId !== page.runId || page.nextCursor.afterSequence !== (last?.sequence ?? page.afterSequence)) throw new Error("Invalid v2 event page cursor");
  if (last && page.nextCursor.lastEventId !== last.eventId) throw new Error("Invalid v2 event page event ID cursor");
  return page;
}

export function parseV2IdempotencyRequest(value: unknown): V2IdempotencyRequest {
  return parseVersioned<V2IdempotencyRequest>(V2IdempotencyRequestSchema, value, "V2 idempotency request");
}
export function parseV2IdempotencyResult(value: unknown): V2IdempotencyResult {
  return parseVersioned<V2IdempotencyResult>(V2IdempotencyResultSchema, value, "V2 idempotency result");
}
