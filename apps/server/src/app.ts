import Fastify, { type FastifyInstance } from "fastify";
import { isIP } from "node:net";
import {
  parse, V2ErrorSchema, V2EventCursorSchema, V2SubmitRunRequestSchema,
  V2AttachmentImportRequestSchema, V2PickerBrowseRequestSchema, V2PickerOpenProjectRequestSchema,
  V2PickerSelectProjectRequestSchema, V2ProjectRulesAcceptRequestSchema,
  V2ChangesetUndoRequestSchema, V2CleanupRequestSchema,
  UpdateCapabilityStateRequestSchema,
  WorkbenchApiErrorSchema, type V2Error, type V2RunEvent, type V2SubmitRunRequest,
} from "@pi-workbench/protocol";
import { createWorkbenchService, type WorkbenchServiceOptions, type ServiceError } from "./service.js";

const SSE_PENDING_EVENT_LIMIT = 4096;
type SseReset = { schemaVersion: 2; type: "stream.reset"; runId: string; data: { reason: "event_history_expired"; earliestAvailableSequence: number; latestSequence: number; latestEventId?: string } };

/** Bounded queue for one SSE response; on overflow it discards only unsent events and yields a reset cursor. */
export class BoundedSseEventQueue {
  private readonly pending: V2RunEvent[] = [];
  private lastSequence = 0;
  private overflow: SseReset | undefined;
  constructor(private readonly runId: string, private readonly limit = SSE_PENDING_EVENT_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("SSE event queue limit must be a positive safe integer");
  }
  get length(): number { return this.pending.length; }
  get reset(): SseReset | undefined { return this.overflow; }
  enqueue(event: V2RunEvent): boolean {
    if (this.overflow) {
      if (event.sequence > this.overflow.data.latestSequence) {
        this.overflow = { ...this.overflow, data: { ...this.overflow.data, latestSequence: event.sequence, latestEventId: event.eventId } };
        this.lastSequence = event.sequence;
      }
      return false;
    }
    if (event.sequence <= this.lastSequence) return false;
    if (this.pending.length >= this.limit) {
      this.pending.length = 0;
      this.lastSequence = event.sequence;
      this.overflow = {
        schemaVersion: 2, type: "stream.reset", runId: this.runId,
        data: { reason: "event_history_expired", earliestAvailableSequence: Math.max(1, event.sequence - this.limit + 1),
          latestSequence: event.sequence, latestEventId: event.eventId },
      };
      return false;
    }
    this.lastSequence = event.sequence;
    this.pending.push(event);
    return true;
  }
  shift(): V2RunEvent | undefined { return this.pending.shift(); }
  takeReset(): SseReset | undefined {
    const reset = this.overflow;
    this.overflow = undefined;
    return reset;
  }
}
export function canWriteSseHeartbeat(state: {
  closed: boolean; destroyed: boolean; pumping: boolean; backpressured: boolean; pendingEvents: number; resetPending: boolean;
}): boolean {
  return !state.closed && !state.destroyed && !state.pumping && !state.backpressured && state.pendingEvents === 0 && !state.resetPending;
}

function parseRequest(value: unknown): V2SubmitRunRequest {
  try { return parse(V2SubmitRunRequestSchema, value); }
  catch { throw Object.assign(new Error("请求字段或协议版本无效。"), { statusCode: 400, code: "invalid_request" }); }
}
function parsePickerBody<T>(schema: Parameters<typeof parse>[0], value: unknown): T {
  try { return parse(schema, value) as T; }
  catch { throw Object.assign(new Error("请求字段或协议版本无效。"), { statusCode: 400, code: "invalid_request" }); }
}
function header(request: { headers: Record<string, string | string[] | undefined> }, name: string): string | undefined {
  const value = request.headers[name]; return Array.isArray(value) ? value[0] : value;
}
function localHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
function localHostHeader(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(`http://${value}`);
    return localHostname(parsed.hostname) && !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash;
  } catch { return false; }
}
function localSocket(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  if (normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}
function checkedOrigin(request: import("fastify").FastifyRequest, required: boolean): string | undefined {
  const origin = header(request, "origin");
  if (!localSocket(request.raw.socket.remoteAddress) || !localHostHeader(header(request, "host")) || !localHostHeader(header(request, "x-forwarded-host")) && header(request, "x-forwarded-host") !== undefined) {
    throw Object.assign(new Error("仅允许来自本机工作台的请求。"), { statusCode: 403, code: "invalid_request" });
  }
  if (header(request, "sec-fetch-site") === "cross-site") throw Object.assign(new Error("已拒绝跨站本地请求。"), { statusCode: 403, code: "invalid_request" });
  if (!origin && !required) return undefined;
  if (!origin) throw Object.assign(new Error("请求缺少来源。"), { statusCode: 403, code: "invalid_request" });
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw Object.assign(new Error("请求来源无效。"), { statusCode: 403, code: "invalid_request" }); }
  if (!localHostname(parsed.hostname) || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw Object.assign(new Error("仅允许来自本机工作台的请求。"), { statusCode: 403, code: "invalid_request" });
  }
  // Next's loopback rewrite supplies the browser-facing authority here.
  const authority = header(request, "x-forwarded-host") ?? header(request, "host")!;
  if (parsed.host !== new URL(`${parsed.protocol}//${authority}`).host) {
    throw Object.assign(new Error("请求来源与工作台地址不匹配。"), { statusCode: 403, code: "invalid_request" });
  }
  return parsed.origin;
}
function sessionCookie(request: import("fastify").FastifyRequest): string | undefined {
  const cookie = header(request, "cookie");
  for (const pair of cookie?.split(";") ?? []) {
    const [name, ...value] = pair.trim().split("=");
    if (name === "piwb_picker_session") return value.join("=");
  }
  return undefined;
}

export async function createWorkbenchApp(options: WorkbenchServiceOptions): Promise<FastifyInstance> {
  const service = await createWorkbenchService(options);
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  app.addHook("onClose", async () => service.close());
  app.addHook("onRequest", async (request) => {
    const route = request.routeOptions.url;
    if (!route?.startsWith("/api/")) return;
    const unsafe = request.method !== "GET" && request.method !== "HEAD";
    const origin = checkedOrigin(request, unsafe);
    if (route === "/api/v1/health" || route === "/api/v2/health" || route === "/api/v2/picker/session") return;
    try {
      // EventSource and artifact links carry cookies, but cannot set a CSRF header.
      service.validatePickerSession(sessionCookie(request), header(request, "x-csrf-token"), origin, unsafe);
    } catch (error) {
      if ((error as Partial<ServiceError>).code === "not_found") Object.assign(error as object, { statusCode: 401 });
      throw error;
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const known = error as Partial<ServiceError>;
    const statusCode = Number.isInteger(known.statusCode) ? known.statusCode! : 500;
    const code = typeof known.code === "string" ? known.code : statusCode < 500 ? "invalid_request" : "internal_error";
    const message = statusCode >= 500 ? "请求失败；未返回原始异常详情。" : (error instanceof Error ? error.message : "请求无效。");
    if (request.url.startsWith("/api/v2/")) {
      const allowed = new Set<V2Error["code"]>([
        "invalid_request", "not_found", "active_task", "idempotency_conflict", "upgrade_required", "db_busy", "db_readonly",
        "unknown_schema", "conflict", "busy", "worker_unavailable", "interrupted", "internal_error", "migration_failed",
        "unknown_extension", "extension_disabled", "extension_unconfigured", "extension_incompatible",
        "extension_permission_denied", "extension_invalid_input", "extension_invalid_config",
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
  app.get("/api/v1/capabilities", async () => ({ schemaVersion: 1, capabilities: service.listLegacyCapabilities() }));
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
  app.post("/api/v2/picker/session", async (request, reply) => {
    const origin = checkedOrigin(request, true)!;
    const session = service.createPickerSession(origin);
    const secure = origin.startsWith("https:") ? "; Secure" : "";
    reply.header("set-cookie", [
      `piwb_picker_session=${session.sessionId}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=14400${secure}`,
      `piwb_picker_session=; HttpOnly; SameSite=Strict; Path=/api/v2; Max-Age=0${secure}`,
    ]);
    reply.header("cache-control", "no-store");
    return { schemaVersion: 2, csrfToken: session.csrfToken, expiresAt: session.expiresAt };
  });
  function requirePickerSession(request: import("fastify").FastifyRequest, unsafe = false): string {
    const origin = checkedOrigin(request, unsafe);
    const sessionId = sessionCookie(request);
    service.validatePickerSession(sessionId, header(request, "x-csrf-token"), origin);
    return sessionId!;
  }
  app.get<{ Querystring: { mode?: "project" | "attachment" } }>("/api/v2/picker/roots", async (request) => {
    const mode = request.query.mode;
    if (mode !== "project" && mode !== "attachment") throw Object.assign(new Error("选择器模式无效。"), { statusCode: 400, code: "invalid_request" });
    return service.pickerRoots(requirePickerSession(request), mode);
  });
  app.post("/api/v2/picker/browse", async (request) => {
    const sessionId = requirePickerSession(request, true);
    const body = parsePickerBody<{ schemaVersion: 2; mode: "project" | "attachment"; directoryToken: string }>(V2PickerBrowseRequestSchema, request.body);
    return service.browsePickerDirectory(sessionId, body.directoryToken, body.mode);
  });
  app.post("/api/v2/picker/project-selection", async (request) => {
    const sessionId = requirePickerSession(request, true);
    const body = parsePickerBody<{ schemaVersion: 2; directoryToken: string }>(V2PickerSelectProjectRequestSchema, request.body);
    return { schemaVersion: 2, ...service.prepareProjectSelection(sessionId, body.directoryToken) };
  });
  app.post("/api/v2/picker/open-project", async (request, reply) => {
    const sessionId = requirePickerSession(request, true);
    const body = parsePickerBody<{ schemaVersion: 2; selectionToken: string; displayName?: string }>(V2PickerOpenProjectRequestSchema, request.body);
    return reply.code(201).send(await service.openProject(sessionId, body.selectionToken, body.displayName));
  });
  app.get("/api/v2/projects", async (request) => {
    requirePickerSession(request);
    return { schemaVersion: 2, projects: await service.listProjects() };
  });
  app.post<{ Params: { projectId: string } }>("/api/v2/projects/:projectId/conversations", async (request, reply) => {
    requirePickerSession(request, true);
    return reply.code(201).send(await service.createProjectConversation(request.params.projectId));
  });
  app.get<{ Params: { projectId: string } }>("/api/v2/projects/:projectId/rules", async (request) => {
    requirePickerSession(request);
    return { schemaVersion: 2, rules: service.projectRules(request.params.projectId) };
  });
  app.post<{ Params: { projectId: string } }>("/api/v2/projects/:projectId/rules/preview", async (request) => {
    const sessionId = requirePickerSession(request, true);
    return { schemaVersion: 2, ...await service.previewProjectRules(sessionId, request.params.projectId) };
  });
  app.post<{ Params: { projectId: string } }>("/api/v2/projects/:projectId/rules/accept", async (request) => {
    const sessionId = requirePickerSession(request, true);
    const body = parsePickerBody<{ schemaVersion: 2; previewToken: string }>(V2ProjectRulesAcceptRequestSchema, request.body);
    const accepted = await service.acceptProjectRules(sessionId, body.previewToken, request.params.projectId);
    return { schemaVersion: 2, rules: service.projectRules(accepted.projectId) };
  });
  app.delete<{ Params: { projectId: string } }>("/api/v2/projects/:projectId/rules", async (request) => {
    requirePickerSession(request, true);
    service.revokeProjectRules(request.params.projectId);
    return { schemaVersion: 2, revoked: true, projectId: request.params.projectId };
  });
  app.get("/api/v2/capabilities", async () => ({ schemaVersion: 2, capabilities: service.listCapabilities() }));
  app.patch<{ Params: { capabilityId: string } }>("/api/v2/capabilities/:capabilityId/state", async (request) => {
    requirePickerSession(request, true);
    const body = parsePickerBody<{ schemaVersion: 2; enabled?: boolean; config?: Record<string, unknown> }>(UpdateCapabilityStateRequestSchema, request.body);
    if (body.enabled === undefined && body.config === undefined) throw Object.assign(new Error("至少需要更新启用状态或配置。"), { statusCode: 400, code: "invalid_request" });
    return { schemaVersion: 2, capability: service.updateCapabilityState(request.params.capabilityId, body) };
  });
  app.get("/api/v2/conversations", async () => ({ schemaVersion: 2, conversations: service.listConversationV2() }));
  app.post("/api/v2/conversations", async (_request, reply) => reply.code(201).send(service.createConversationV2()));
  app.get<{ Params: { conversationId: string } }>("/api/v2/conversations/:conversationId", async (request) => service.getConversationV2(request.params.conversationId));
  app.delete<{ Params: { conversationId: string } }>("/api/v2/conversations/:conversationId", async (request) => {
    requirePickerSession(request, true);
    const cleanup = service.deleteConversationV2(request.params.conversationId);
    return { schemaVersion: 2, deleted: true, conversationId: request.params.conversationId, cleanup };
  });
  app.get("/api/v2/deletions", async (request) => {
    requirePickerSession(request);
    return { schemaVersion: 2, deletions: service.listDeletionCleanup() };
  });
  app.post<{ Params: { conversationId: string } }>("/api/v2/deletions/:conversationId/retry", async (request) => {
    requirePickerSession(request, true);
    return { schemaVersion: 2, cleanup: await service.retryDeletionCleanup(request.params.conversationId) };
  });
  app.get<{ Params: { conversationId: string } }>("/api/v2/conversations/:conversationId/changesets", async (request) => {
    requirePickerSession(request);
    return { schemaVersion: 2, changesets: service.listConversationChangesets(request.params.conversationId) };
  });
  app.get<{ Params: { conversationId: string; changesetId: string } }>("/api/v2/conversations/:conversationId/changesets/:changesetId", async (request) => {
    requirePickerSession(request);
    return service.getConversationChangeset(request.params.conversationId, request.params.changesetId);
  });
  app.post<{ Params: { conversationId: string; changesetId: string } }>("/api/v2/conversations/:conversationId/changesets/:changesetId/undo", async (request) => {
    requirePickerSession(request, true);
    parsePickerBody(V2ChangesetUndoRequestSchema, request.body);
    return service.undoFileChangeset(request.params.conversationId, request.params.changesetId);
  });
  app.get<{ Params: { conversationId: string } }>("/api/v2/conversations/:conversationId/attachment-results", async (request) => {
    requirePickerSession(request);
    return { schemaVersion: 2, results: await service.listConversationAttachmentResults(request.params.conversationId) };
  });
  app.get<{ Params: { conversationId: string; resultId: string } }>("/api/v2/conversations/:conversationId/attachment-results/:resultId", async (request, reply) => {
    requirePickerSession(request);
    const item = await service.readConversationAttachmentResult(request.params.conversationId, request.params.resultId);
    const fileName = encodeURIComponent(item.result.fileName).replaceAll("'", "%27");
    return reply.type(item.result.mediaType).header("content-disposition", `attachment; filename*=UTF-8''${fileName}`)
      .header("x-content-type-options", "nosniff").header("cache-control", "no-store").send(item.bytes);
  });
  app.get<{ Params: { conversationId: string } }>("/api/v2/conversations/:conversationId/file-cleanup-preview", async (request) => {
    requirePickerSession(request);
    return service.previewFileCleanup(request.params.conversationId);
  });
  app.post<{ Params: { conversationId: string } }>("/api/v2/conversations/:conversationId/file-cleanup", async (request) => {
    requirePickerSession(request, true);
    const body = parsePickerBody<{ schemaVersion: 2; confirm: true; changesetIds: string[] }>(V2CleanupRequestSchema, request.body);
    return service.cleanupFileChangesets(request.params.conversationId, body.changesetIds);
  });
  app.get<{ Params: { conversationId: string } }>("/api/v2/conversations/:conversationId/runs", async (request) => ({ schemaVersion: 2, runs: service.listRunsV2(request.params.conversationId) }));
  app.get<{ Params: { conversationId: string } }>("/api/v2/conversations/:conversationId/attachments", async (request) => {
    requirePickerSession(request);
    return { schemaVersion: 2, attachments: service.listConversationAttachments(request.params.conversationId) };
  });
  app.post<{ Params: { conversationId: string } }>("/api/v2/conversations/:conversationId/attachments/import", async (request) => {
    const sessionId = requirePickerSession(request, true);
    const body = parsePickerBody<{ schemaVersion: 2; fileTokens: string[]; directoryToken?: string }>(V2AttachmentImportRequestSchema, request.body);
    return service.importAttachments(sessionId, request.params.conversationId, body.fileTokens, body.directoryToken);
  });
  app.get<{ Params: { conversationId: string; attachmentId: string } }>("/api/v2/conversations/:conversationId/attachments/:attachmentId", async (request, reply) => {
    requirePickerSession(request);
    const item = await service.readConversationAttachment(request.params.conversationId, request.params.attachmentId);
    const fileName = encodeURIComponent(item.attachment.fileName).replaceAll("'", "%27");
    return reply.type(item.attachment.mediaType).header("content-disposition", `attachment; filename*=UTF-8''${fileName}`)
      .header("x-content-type-options", "nosniff").header("cache-control", "no-store").send(item.bytes);
  });
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
    const queue = new BoundedSseEventQueue(request.params.runId);
    let closed = false;
    let pumping = false;
    let initializing = true;
    let terminalQueued = false;
    let backpressured = false;
    function enqueue(event: typeof subscription.replay[number]): void {
      if (closed) return;
      const accepted = queue.enqueue(event);
      if (!accepted && queue.reset) {
        terminalQueued = false;
        if (!initializing) void pump();
        return;
      }
      if (!accepted) return;
      if (["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(event.type)) terminalQueued = true;
      if (!initializing) void pump();
    }
    function writeControl(reset: NonNullable<typeof subscription.reset>): void {
      raw.write(`event: stream.reset\ndata: ${JSON.stringify(reset)}\n\n`);
    }
    function waitForDrain(): Promise<void> {
      return new Promise<void>((resolve) => {
        const resume = () => { backpressured = false; raw.off("close", resume); raw.off("error", resume); raw.off("drain", resume); resolve(); };
        raw.once("drain", resume); raw.once("close", resume); raw.once("error", resume);
      });
    }
    async function pump(): Promise<void> {
      if (pumping || closed) return;
      pumping = true;
      try {
        while ((queue.length || queue.reset) && !closed && !raw.destroyed) {
          if (queue.reset) {
            writeControl(queue.takeReset()!);
            subscription.unsubscribe();
            raw.end();
            return;
          }
          const event = queue.shift()!;
          const ok = raw.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          if (!ok) { backpressured = true; await waitForDrain(); }
        }
        if (!closed && !raw.destroyed && queue.reset) {
          writeControl(queue.takeReset()!);
          subscription.unsubscribe();
          raw.end();
          return;
        }
        if (!closed && terminalQueued && queue.length === 0) raw.end();
      } finally { pumping = false; }
    }
    const heartbeat = setInterval(() => {
      if (!canWriteSseHeartbeat({ closed, destroyed: raw.destroyed, pumping, backpressured, pendingEvents: queue.length, resetPending: Boolean(queue.reset) })) return;
      if (!raw.write(": keep-alive\n\n")) { backpressured = true; void waitForDrain(); }
    }, 15_000);
    heartbeat.unref();
    function cleanup() {
      if (closed) return;
      closed = true; clearInterval(heartbeat); subscription.unsubscribe();
      raw.off("close", cleanup); raw.off("error", cleanup); request.raw.off("aborted", cleanup);
    }
    raw.once("close", cleanup); raw.once("error", cleanup); request.raw.once("aborted", cleanup);
    if (subscription.reset) writeControl(subscription.reset);
    for (const event of subscription.replay) enqueue(event);
    if (subscription.finished) terminalQueued = true;
    initializing = false;
    void pump();
    return reply;
  });
  app.get<{ Params: { runId: string; kind: string } }>("/api/v2/runs/:runId/artifacts/:kind", async (request, reply) => {
    const artifact = await service.readArtifact(request.params.runId, request.params.kind);
    return reply.type(artifact.contentType).header("x-content-type-options", "nosniff").send(artifact.bytes);
  });

  return app;
}
