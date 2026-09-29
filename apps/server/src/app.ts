import Fastify, { type FastifyInstance } from "fastify";
import {
  parse, CreateRunRequestSchema, WorkbenchApiErrorSchema,
  type CreateRunRequest,
} from "@pi-workbench/protocol";
import { createWorkbenchService, type WorkbenchServiceOptions, type ServiceError } from "./service.js";

const serviceErrorCodes = new Set<ServiceError["code"]>([
  "invalid_request", "not_found", "busy", "idempotency_conflict",
  "unsupported_capability", "conflict", "internal_error",
]);

export async function createWorkbenchApp(options: WorkbenchServiceOptions): Promise<FastifyInstance> {
  const service = createWorkbenchService(options);
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  app.addHook("onClose", async () => service.close());
  app.setErrorHandler((error, _request, reply) => {
    const known = error as Partial<ServiceError>;
    const statusCode = Number.isInteger(known.statusCode) ? known.statusCode! : 500;
    const code = serviceErrorCodes.has(known.code as ServiceError["code"])
      ? known.code as ServiceError["code"]
      : statusCode < 500 ? "invalid_request" : "internal_error";
    const message = statusCode >= 500 ? "请求失败；未返回原始异常详情。" : (error instanceof Error ? error.message : "请求无效。");
    const payload = parse(WorkbenchApiErrorSchema, { schemaVersion: 1, error: { code, message: message.slice(0, 512) } });
    void reply.code(statusCode).send(payload);
  });

  app.get("/api/v1/health", async () => ({ schemaVersion: 1, status: "ok", mode: service.mode }));
  app.get("/api/v1/capabilities", async () => ({ schemaVersion: 1, capabilities: service.listCapabilities() }));
  app.post("/api/v1/conversations", async (_request, reply) => reply.code(201).send(service.createConversation()));
  app.get("/api/v1/conversations", async () => ({ schemaVersion: 1, conversations: service.listConversations() }));
  app.get<{ Params: { conversationId: string } }>("/api/v1/conversations/:conversationId", async (request) => service.getConversation(request.params.conversationId));
  app.get<{ Params: { conversationId: string } }>("/api/v1/conversations/:conversationId/runs", async (request) => ({ schemaVersion: 1, runs: service.listConversationRuns(request.params.conversationId) }));

  app.post<{ Params: { conversationId: string }; Headers: { "idempotency-key"?: string } }>("/api/v1/conversations/:conversationId/runs", async (request, reply) => {
    const envelope = parseRequest(request.body);
    const submitted = service.submit(request.params.conversationId, envelope.input, request.headers["idempotency-key"] ?? "");
    return reply.code(submitted.replayed ? 200 : 202).send(submitted.run);
  });
  app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId", async (request) => service.getRun(request.params.runId));
  app.post<{ Params: { runId: string } }>("/api/v1/runs/:runId/cancel", async (request) => service.cancel(request.params.runId));
  app.post<{ Params: { runId: string }; Headers: { "idempotency-key"?: string } }>("/api/v1/runs/:runId/retry", async (request, reply) => {
    const submitted = service.retry(request.params.runId, request.headers["idempotency-key"] ?? "");
    return reply.code(submitted.replayed ? 200 : 202).send(submitted.run);
  });
  app.get<{ Params: { runId: string; kind: string }; Querystring: { after?: string } }>("/api/v1/runs/:runId/events", async (request, reply) => {
    const rawCursor = request.headers["last-event-id"];
    const cursor = (Array.isArray(rawCursor) ? rawCursor[0] : rawCursor) || request.query.after;
    // Validate before taking ownership of the raw response. An unknown run
    // must use the versioned 404 envelope instead of leaving an open 200 SSE.
    service.getRun(request.params.runId);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    raw.flushHeaders();
    const write = (event: unknown & { eventId?: string; type?: string }) => {
      const encoded = JSON.stringify(event);
      raw.write(`${event.eventId ? `id: ${event.eventId}\n` : ""}event: ${event.type ?? "message"}\ndata: ${encoded}\n\n`);
    };
    const subscription = service.subscribeEvents(request.params.runId, cursor, (event) => {
      write(event);
      if (event.type === "run.finished") {
        cleanup();
        raw.end();
      }
    });
    let finished = false;
    const heartbeat = setInterval(() => { if (!raw.destroyed) raw.write(": keep-alive\n\n"); }, 15_000);
    heartbeat.unref();
    function cleanup() {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      subscription.unsubscribe();
      raw.off("close", cleanup);
      raw.off("error", cleanup);
      request.raw.off("aborted", cleanup);
    }
    // Disconnects happen on the response side; the incoming request may close
    // as soon as its body is consumed while this SSE response remains open.
    // Cleanup only unsubscribes transport resources and never cancels the run.
    raw.once("close", cleanup);
    raw.once("error", cleanup);
    request.raw.once("aborted", cleanup);
    if (subscription.reset) {
      const reset = subscription.reset;
      // A recovery control frame has a payload ID for observability, but deliberately
      // has no SSE `id:` field so EventSource keeps its last real run-event cursor.
      raw.write(`event: ${reset.type}\ndata: ${JSON.stringify(reset)}\n\n`);
    }
    for (const event of subscription.replay) write(event);
    if (subscription.finished || subscription.replay.some((event) => event.type === "run.finished")) {
      cleanup();
      raw.end();
    }
    return reply;
  });
  app.get<{ Params: { runId: string; kind: string } }>("/api/v1/runs/:runId/artifacts/:kind", async (request, reply) => {
    const artifact = await service.readArtifact(request.params.runId, request.params.kind);
    return reply.type(artifact.contentType).header("x-content-type-options", "nosniff").send(artifact.bytes);
  });

  return app;
}

function parseRequest(value: unknown): CreateRunRequest {
  if (typeof value === "object" && value !== null && "input" in value) {
    const record = value as { input?: unknown };
    if (typeof record.input === "object" && record.input !== null && "kind" in record.input && "capabilityId" in record.input) {
      const raw = record.input as { capabilityId?: unknown };
      if (typeof raw.capabilityId === "string" && raw.capabilityId !== "public_repository_analysis") {
        const error = new Error("Unsupported capability ID") as ServiceError;
        error.code = "unsupported_capability";
        error.statusCode = 400;
        throw error;
      }
    }
  }
  try { return parse(CreateRunRequestSchema, value); }
  catch { const error = new Error("Request does not match the versioned run contract") as ServiceError; error.code = "invalid_request"; error.statusCode = 400; throw error; }
}
