import Fastify, { type FastifyInstance } from "fastify";
import {
  parse, V2ErrorSchema, V2EventCursorSchema, V2SubmitRunRequestSchema,
  WorkbenchApiErrorSchema, type V2Error, type V2SubmitRunRequest,
} from "@pi-workbench/protocol";
import { createWorkbenchService, type WorkbenchServiceOptions, type ServiceError } from "./service.js";

function parseRequest(value: unknown): V2SubmitRunRequest {
  try { return parse(V2SubmitRunRequestSchema, value); }
  catch { throw Object.assign(new Error("请求字段或协议版本无效。"), { statusCode: 400, code: "invalid_request" }); }
}

export async function createWorkbenchApp(options: WorkbenchServiceOptions): Promise<FastifyInstance> {
  const service = await createWorkbenchService(options);
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  app.addHook("onClose", async () => service.close());
  app.setErrorHandler((error, request, reply) => {
    const known = error as Partial<ServiceError>;
    const statusCode = Number.isInteger(known.statusCode) ? known.statusCode! : 500;
    const code = typeof known.code === "string" ? known.code : statusCode < 500 ? "invalid_request" : "internal_error";
    const message = statusCode >= 500 ? "请求失败；未返回原始异常详情。" : (error instanceof Error ? error.message : "请求无效。");
    if (request.url.startsWith("/api/v2/")) {
      const allowed = new Set<V2Error["code"]>([
        "invalid_request", "not_found", "active_task", "idempotency_conflict", "upgrade_required", "db_busy", "db_readonly",
        "unknown_schema", "conflict", "busy", "worker_unavailable", "interrupted", "internal_error", "migration_failed",
      ]);
      const payload = parse(V2ErrorSchema, {
        schemaVersion: 2, code: allowed.has(code as V2Error["code"]) ? code : "internal_error",
        message: message.slice(0, 512), retryable: Boolean(known.retryable),
      });
      void reply.code(statusCode).send(payload);
      return;
    }
    if (statusCode === 426 || code === "upgrade_required") {
      void reply.code(426).send({ schemaVersion: 2, code: "upgrade_required", message: "此写入端点已升级，请使用 /api/v2。", retryable: false });
      return;
    }
    const accepted = new Set(["invalid_request", "not_found", "busy", "idempotency_conflict", "unsupported_capability", "conflict", "internal_error"]);
    const payload = parse(WorkbenchApiErrorSchema, {
      schemaVersion: 1, error: { code: accepted.has(code) ? code : statusCode < 500 ? "invalid_request" : "internal_error", message: message.slice(0, 512) },
    });
    void reply.code(statusCode).send(payload);
  });

  app.get("/api/v1/health", async () => ({ schemaVersion: 1, status: "ok", mode: service.mode }));
  app.get("/api/v1/capabilities", async () => ({ schemaVersion: 1, capabilities: service.listCapabilities() }));
  app.get("/api/v1/conversations", async () => ({ schemaVersion: 1, conversations: service.listConversations() }));
  app.get<{ Params: { conversationId: string } }>("/api/v1/conversations/:conversationId", async (request) => service.getConversation(request.params.conversationId));
  app.get<{ Params: { conversationId: string } }>("/api/v1/conversations/:conversationId/runs", async (request) => ({ schemaVersion: 1, runs: service.listConversationRuns(request.params.conversationId) }));
  app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId", async (request) => service.getRun(request.params.runId));
  app.get<{ Params: { runId: string; kind: string } }>("/api/v1/runs/:runId/artifacts/:kind", async (request, reply) => {
    const artifact = await service.readArtifact(request.params.runId, request.params.kind);
    return reply.type(artifact.contentType).header("x-content-type-options", "nosniff").send(artifact.bytes);
  });
  // The v1 API remains readable for stored history; writes fail explicitly instead of returning misleading v1 state.
  for (const route of [
    "/api/v1/conversations", "/api/v1/conversations/:conversationId/runs", "/api/v1/runs/:runId/cancel", "/api/v1/runs/:runId/retry",
  ]) {
    app.route({ method: ["POST", "DELETE"], url: route, handler: async (_request, reply) => reply.code(426).send({
      schemaVersion: 2, code: "upgrade_required", message: "此写入端点已升级，请使用 /api/v2。", retryable: false,
    }) });
  }

  app.get("/api/v2/health", async () => ({ schemaVersion: 2, status: "ok", mode: service.mode, workerReady: service.workerReady }));
  app.get("/api/v2/capabilities", async () => ({ schemaVersion: 2, capabilities: service.listCapabilities() }));
  app.get("/api/v2/conversations", async () => ({ schemaVersion: 2, conversations: service.listConversationV2() }));
  app.post("/api/v2/conversations", async (_request, reply) => reply.code(201).send(service.createConversationV2()));
  app.get<{ Params: { conversationId: string } }>("/api/v2/conversations/:conversationId", async (request) => service.getConversationV2(request.params.conversationId));
  app.delete<{ Params: { conversationId: string } }>("/api/v2/conversations/:conversationId", async (request) => {
    service.deleteConversationV2(request.params.conversationId);
    return { schemaVersion: 2, deleted: true, conversationId: request.params.conversationId };
  });
  app.get<{ Params: { conversationId: string } }>("/api/v2/conversations/:conversationId/runs", async (request) => ({ schemaVersion: 2, runs: service.listRunsV2(request.params.conversationId) }));
  app.post<{ Headers: { "idempotency-key"?: string } }>("/api/v2/runs", async (request, reply) => {
    const body = parseRequest(request.body);
    const submitted = service.submitV2(body.conversationId, body.input, request.headers["idempotency-key"] ?? "");
    return reply.code(submitted.replayed ? 200 : 202).send(submitted.run);
  });
  app.get<{ Params: { runId: string } }>("/api/v2/runs/:runId", async (request) => service.getRunV2(request.params.runId));
  app.post<{ Params: { runId: string } }>("/api/v2/runs/:runId/cancel", async (request) => service.cancelV2(request.params.runId));
  app.post<{ Params: { runId: string }; Headers: { "idempotency-key"?: string } }>("/api/v2/runs/:runId/retry", async (request, reply) => {
    const submitted = service.retryV2(request.params.runId, request.headers["idempotency-key"] ?? "");
    return reply.code(submitted.replayed ? 200 : 202).send(submitted.run);
  });
  app.post<{ Params: { runId: string }; Headers: { "idempotency-key"?: string } }>("/api/v2/runs/:runId/continue", async (request, reply) => {
    const continued = service.continueV2(request.params.runId, request.headers["idempotency-key"] ?? "");
    return reply.code(continued.replayed ? 200 : 202).send(continued.run);
  });
  app.get<{ Params: { runId: string }; Querystring: { after?: string } }>("/api/v2/runs/:runId/events", async (request, reply) => {
    service.getRunV2(request.params.runId);
    const header = request.headers["last-event-id"];
    const cursor = (Array.isArray(header) ? header[0] : header) || request.query.after;
    const subscription = service.subscribeEventsV2(request.params.runId, cursor, (event) => enqueue(event));
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    raw.flushHeaders();
    const queue = [] as typeof subscription.replay;
    const seen = new Set<string>();
    let closed = false;
    let pumping = false;
    let initializing = true;
    let terminalQueued = subscription.finished;
    function enqueue(event: typeof subscription.replay[number]): void {
      if (closed || seen.has(event.eventId)) return;
      seen.add(event.eventId); queue.push(event);
      if (["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(event.type)) terminalQueued = true;
      if (!initializing) void pump();
    }
    function writeControl(reset: NonNullable<typeof subscription.reset>): void {
      raw.write(`event: stream.reset\ndata: ${JSON.stringify(reset)}\n\n`);
    }
    async function pump(): Promise<void> {
      if (pumping || closed) return;
      pumping = true;
      try {
        while (queue.length && !closed && !raw.destroyed) {
          const event = queue.shift()!;
          const ok = raw.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          if (!ok) await new Promise<void>((resolve) => raw.once("drain", resolve));
        }
        if (!closed && terminalQueued && queue.length === 0) raw.end();
      } finally { pumping = false; }
    }
    const heartbeat = setInterval(() => { if (!closed && !raw.destroyed) raw.write(": keep-alive\n\n"); }, 15_000);
    heartbeat.unref();
    function cleanup() {
      if (closed) return;
      closed = true; clearInterval(heartbeat); subscription.unsubscribe();
      raw.off("close", cleanup); raw.off("error", cleanup); request.raw.off("aborted", cleanup);
    }
    raw.once("close", cleanup); raw.once("error", cleanup); request.raw.once("aborted", cleanup);
    if (subscription.reset) writeControl(subscription.reset);
    for (const event of subscription.replay) enqueue(event);
    initializing = false;
    void pump();
    if (subscription.finished && !subscription.replay.length) raw.end();
    return reply;
  });
  app.get<{ Params: { runId: string; kind: string } }>("/api/v2/runs/:runId/artifacts/:kind", async (request, reply) => {
    const artifact = await service.readArtifact(request.params.runId, request.params.kind);
    return reply.type(artifact.contentType).header("x-content-type-options", "nosniff").send(artifact.bytes);
  });

  return app;
}
