import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" });
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const money = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const sha = Type.String({ pattern: "^[a-f0-9]{40}$" });
const relativePath = Type.String({ minLength: 1, maxLength: 512, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\\\\\u0000-\\u001f:]+$" });

export const RepositorySchema = object({
  url: Type.String({ pattern: "^https://github\\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$", maxLength: 512 }),
  sha,
});
export const RunInputSchema = object({ repository: RepositorySchema, goal: Type.String({ minLength: 1, maxLength: 8000 }) });
export const BudgetSchema = object({
  timeoutMs: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
  maxModelCalls: Type.Integer({ minimum: 1, maximum: 1000 }),
  maxToolCalls: Type.Integer({ minimum: 0, maximum: 10000 }),
  maxTokens: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
  maxOutputTokens: Type.Integer({ minimum: 1, maximum: 100_000 }),
  maxCostUsd: money,
});
export const PricingSchema = object({
  version: Type.String({ minLength: 1, maxLength: 128 }),
  input: money, output: money, cacheRead: money, cacheWrite: money,
});
export const UsageSchema = object({
  modelCalls: count, toolCalls: count,
  inputTokens: count, outputTokens: count, cacheReadTokens: count, cacheWriteTokens: count,
  totalTokens: count, estimatedCostUsd: money,
  pricingVersion: Type.String({ minLength: 1, maxLength: 128 }),
});
export const CancelReasonSchema = Type.Union([
  Type.Literal("user"), Type.Literal("timeout"), Type.Literal("token_limit"),
  Type.Literal("call_limit"), Type.Literal("tool_limit"), Type.Literal("cost_limit"),
]);
export const ArtifactSchema = object({
  kind: Type.Union([Type.Literal("report.json"), Type.Literal("report.md")]),
  path: relativePath,
  sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
});
export const ArtifactsSchema = Type.Array(ArtifactSchema, { minItems: 1, maxItems: 16 });
export const EvidenceSchema = object({
  id, path: relativePath, sha,
  startLine: Type.Integer({ minimum: 1 }), endLine: Type.Integer({ minimum: 1 }),
  excerpt: Type.String({ minLength: 1, maxLength: 16384 }),
});
const resultBase = { schemaVersion: Type.Literal(1), runId: id, attemptId: id, usage: UsageSchema, endedAt: timestamp };
export const RunResultSchema = Type.Union([
  object({ ...resultBase, status: Type.Literal("completed"), artifacts: ArtifactsSchema }),
  object({ ...resultBase, status: Type.Literal("failed"), error: object({
    code: Type.Union([Type.Literal("model_error"), Type.Literal("invalid_result"), Type.Literal("runtime_error")]),
    message: Type.String({ minLength: 1, maxLength: 512 }),
  }) }),
  object({ ...resultBase, status: Type.Literal("cancelled"), reason: CancelReasonSchema }),
]);
const envelope = { schemaVersion: Type.Literal(1), eventId: id, runId: id, attemptId: id, sequence: Type.Integer({ minimum: 1 }), timestamp };
export const RunEventSchema = Type.Union([
  object({ ...envelope, type: Type.Literal("run.started"), data: RunInputSchema }),
  object({ ...envelope, type: Type.Literal("text.delta"), data: object({ text: Type.String({ maxLength: 8192 }) }) }),
  object({ ...envelope, type: Type.Literal("tool.started"), data: object({ toolCallId: id, toolName: id, argumentsSummary: Type.Literal("omitted") }) }),
  object({ ...envelope, type: Type.Literal("tool.finished"), data: object({
    toolCallId: id, toolName: id, isError: Type.Boolean(),
    summary: Type.Union([Type.Literal("ok"), Type.Literal("tool_error"), Type.Literal("cancelled")]),
  }) }),
  object({ ...envelope, type: Type.Literal("run.cancelling"), data: object({ reason: CancelReasonSchema }) }),
  object({ ...envelope, type: Type.Literal("run.warning"), data: object({ code: Type.Literal("cancellation_pending") }) }),
  object({ ...envelope, type: Type.Literal("run.finished"), data: RunResultSchema }),
]);

export type RunInput = Static<typeof RunInputSchema>;
export type Budget = Static<typeof BudgetSchema>;
export type Pricing = Static<typeof PricingSchema>;
export type Usage = Static<typeof UsageSchema>;
export type Artifact = Static<typeof ArtifactSchema>;
export type Evidence = Static<typeof EvidenceSchema>;
export type CancelReason = Static<typeof CancelReasonSchema>;
export type RunResult = Static<typeof RunResultSchema>;
export type RunEvent = Static<typeof RunEventSchema>;
export type RunState = "queued" | "running" | "cancelling" | RunResult["status"];

// Reject at trust boundaries. Never coerce input or include rejected values in errors.
export function parse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Check(schema, value)) throw new Error("Protocol validation failed");
  return value;
}
export function parseArtifacts(value: unknown): Artifact[] {
  const artifacts = parse(ArtifactsSchema, value);
  if (new Set(artifacts.map((a) => a.path)).size !== artifacts.length) throw new Error("Duplicate artifact path");
  return artifacts;
}
export function parseEvidence(value: unknown): Evidence {
  const evidence = parse(EvidenceSchema, value);
  if (evidence.endLine < evidence.startLine) throw new Error("Invalid evidence line range");
  return evidence;
}
export function parseResult(value: unknown): RunResult {
  const result = parse(RunResultSchema, value);
  if (!Number.isFinite(Date.parse(result.endedAt)) || new Date(result.endedAt).toISOString() !== result.endedAt) throw new Error("Invalid timestamp");
  const u = result.usage;
  if (u.totalTokens !== u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens) throw new Error("Invalid token total");
  if (result.status === "completed") parseArtifacts(result.artifacts);
  return result;
}
export function parseEvent(value: unknown): RunEvent {
  const event = parse(RunEventSchema, value);
  if (!Number.isFinite(Date.parse(event.timestamp)) || new Date(event.timestamp).toISOString() !== event.timestamp) throw new Error("Invalid timestamp");
  if (event.type === "run.finished") {
    const result = parseResult(event.data);
    if (event.runId !== result.runId || event.attemptId !== result.attemptId) throw new Error("Result identity mismatch");
  }
  return event;
}
