"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CapabilityCatalogEntry, Conversation, ConversationSummary, WorkbenchEvent, WorkbenchRun, V2AttachmentResult, V2Changeset, V2ChangesetSummary, V2Conversation, V2ConversationSummary, V2Run, V2RunSubmission, V2CleanupPreview, V2ChangesetUndoResult } from "@pi-workbench/protocol";
import { RunArtifacts } from "./run-artifacts";
import { retryStartupRead } from "./startup";

const API = "/api/v2";
const SUGGESTIONS = ["帮我制定一个清晰的实施计划", "解释一下 Agent 是如何工作的", "把这个想法拆解成可执行的步骤"];
const EVENT_TYPES = ["run.accepted", "run.started", "run.progress", "message.delta", "tool.started", "tool.finished", "checkpoint.saved", "usage.updated", "run.cancelling", "run.completed", "run.failed", "run.cancelled", "run.interrupted", "stream.reset"] as const;
const API_REQUEST_TIMEOUT_MS = 30_000;
const REPOSITORY_URL_PATTERN = /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u;
const FAKE_REPOSITORY_SHA = "7f06c6b2792349e4d9ccbd393008e5bf1f4d419a";
type CapabilityField = { id: string; title: string; description: string; type: "string" | "number" | "integer" | "boolean" | "object" | "array"; required: boolean; maxLength: number; control: "text" | "textarea" | "json"; enum?: unknown[] };
type V2StreamReset = { schemaVersion: 2; type: "stream.reset"; runId: string; data: { reason: "event_history_expired"; earliestAvailableSequence: number; latestSequence: number; latestEventId?: string } };
type UiConversation = Conversation & { projectId?: string | null };
type UiConversationSummary = ConversationSummary & { projectId?: string | null };
type UiRun = Omit<WorkbenchRun, "input"> & { input: V2RunSubmission };
type LocalProject = { schemaVersion: 2; projectId: string; displayName: string; canonicalRoot: string; validationState: "valid" | "missing" | "needs_review"; createdAt: string; lastAccessedAt: string };
type PickerDirectory = { schemaVersion: 2; directoryToken: string; parentToken?: string; displayPath: string; canSelectProject: boolean; truncated: boolean; entries: Array<{ name: string; kind: "directory" | "file" | "excluded"; token?: string; byteSize?: number; reason?: string }> };
type PickerRoot = { label: string; token: string };
type LocalAttachment = { schemaVersion: 2; attachmentId: string; conversationId: string; fileName: string; relativePath: string; byteSize: number; mediaType: string; createdAt: string };
type LocalAttachmentResult = V2AttachmentResult;
type ProjectRuleView = { schemaVersion: 2; projectId: string; sourcePath: string; sourceSha256: string; sourceVersion: string; content: string; acceptedAt: string; revokedAt?: string | null };
let pickerCsrfToken: string | null = null;
let pickerSessionRequest: Promise<string> | null = null;

function normalizeConversation(value: V2Conversation): UiConversation {
  return {
    schemaVersion: 1, conversationId: value.conversationId, title: value.title.slice(0, 128),
    projectId: value.projectId ?? null,
    createdAt: value.createdAt, updatedAt: value.updatedAt, preview: value.preview, messageCount: value.messageCount,
    messages: value.messages.map((message) => message.role === "capability" && message.capabilityInput
      ? { schemaVersion: 1, id: message.messageId, role: "capability", text: message.content, createdAt: message.createdAt, capabilityId: message.extensionId ?? "extension", input: message.capabilityInput } as unknown as Conversation["messages"][number]
      : { schemaVersion: 1, id: message.messageId, role: message.role === "capability" ? "assistant" : message.role, text: message.content, createdAt: message.createdAt }),
  };
}
function schemaFields(schema: Record<string, unknown>, includePrompt = false): CapabilityField[] {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(properties as Record<string, unknown>).flatMap(([id, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    if (item.type !== "string" && item.type !== "number" && item.type !== "integer" && item.type !== "boolean" && item.type !== "object" && item.type !== "array") return [];
    if (!includePrompt && item["x-ui"] === "prompt") return [];
    return [{
      id, title: typeof item.title === "string" ? item.title : id,
      description: typeof item.description === "string" ? item.description : "",
      type: item.type as CapabilityField["type"], required: required.includes(id),
      maxLength: typeof item.maxLength === "number" ? item.maxLength : 1024,
      control: item.type === "object" || item.type === "array" ? "json" as const : item["x-ui"] === "textarea" ? "textarea" as const : "text" as const,
      ...(Array.isArray(item.enum) ? { enum: item.enum } : {}),
    }];
  });
}
function normalizeSummary(value: V2ConversationSummary): UiConversationSummary {
  return { schemaVersion: 1, conversationId: value.conversationId, title: value.title.slice(0, 128), projectId: value.projectId ?? null, createdAt: value.createdAt, updatedAt: value.updatedAt, preview: value.preview, messageCount: value.messageCount };
}
function normalizeRun(value: V2Run): UiRun {
  if (!value.input) throw new Error("服务器返回的运行缺少输入记录");
  const status = value.status === "accepted" ? "queued" : value.status;
  return {
    schemaVersion: 1, runId: value.runId, conversationId: value.conversationId, status,
    createdAt: value.createdAt, updatedAt: value.updatedAt, input: value.input,
    ...(value.retryOfRunId ? { retryOfRunId: value.retryOfRunId } : {}), ...(value.result ? { result: value.result } : {}),
  };
}
function normalizeApiValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeApiValue);
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  if (item.schemaVersion === 2 && typeof item.runId === "string" && typeof item.requestHash === "string") return normalizeRun(item as unknown as V2Run);
  if (item.schemaVersion === 2 && typeof item.conversationId === "string" && Array.isArray(item.messages)) return normalizeConversation(item as unknown as V2Conversation);
  if (item.schemaVersion === 2 && typeof item.conversationId === "string" && typeof item.title === "string" && typeof item.preview === "string") return normalizeSummary(item as unknown as V2ConversationSummary);
  return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, normalizeApiValue(nested)]));
}
function isFakeDemoRepository(value: string): boolean {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const repo = segments[1]?.replace(/\.git$/iu, "");
    return url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password && !url.search && !url.hash
      && segments.length === 2 && segments[0]?.toLowerCase() === "demo" && repo?.toLowerCase() === "harborlight";
  } catch { return false; }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const timeoutSignal = AbortSignal.timeout(API_REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`${API}${path}`, { ...init, headers, signal });
  const body = await response.json().catch((error: unknown) => {
    if (signal.aborted) throw signal.reason;
    if (response.ok) throw error;
    return undefined;
  }) as { message?: string; error?: { message?: string } } | undefined;
  if (!response.ok) throw Object.assign(new Error(body?.message ?? body?.error?.message ?? `请求失败 (${response.status})`), { status: response.status });
  return normalizeApiValue(body) as T;
}
async function openPickerSession(): Promise<string> {
  if (pickerCsrfToken) return pickerCsrfToken;
  if (!pickerSessionRequest) {
    pickerSessionRequest = api<{ csrfToken: string }>("/picker/session", { method: "POST", body: "{}" })
      .then((session) => { pickerCsrfToken = session.csrfToken; return session.csrfToken; });
  }
  const pending = pickerSessionRequest;
  try { return await pending; }
  finally { if (pickerSessionRequest === pending) pickerSessionRequest = null; }
}
async function pickerApi<T>(path: string, init?: RequestInit, retry = true): Promise<T> {
  const csrfToken = await openPickerSession();
  const headers = new Headers(init?.headers);
  headers.set("x-csrf-token", csrfToken);
  try { return await api<T>(path, { ...init, headers }); }
  catch (error) {
    if (retry && error && typeof error === "object" && "status" in error && error.status === 404) {
      if (pickerCsrfToken === csrfToken) pickerCsrfToken = null;
      await openPickerSession();
      return pickerApi<T>(path, init, false);
    }
    throw error;
  }
}
function key(): string { return crypto.randomUUID(); }
function formatBytes(bytes: number): string { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`; }
function Icon({ name }: { name: "plus" | "chat" | "grid" | "settings" | "send" | "stop" | "paperclip" | "spark" | "close" | "trash" | "folder" }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const };
  const paths: Record<typeof name, React.ReactNode> = {
    plus: <><path d="M12 5v14M5 12h14" /></>, chat: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5 8 8 0 0 1-3.5-.8L4 20l1.8-4A7.5 7.5 0 1 1 20 11.5Z" /></>,
    grid: <><rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><rect x="14" y="14" width="6" height="6" rx="1.5" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.6.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.6-.9l-1.7.6-1.4-2.4L8 15a8 8 0 0 1 0-1.9l-1.4-1.2L8 9.5l1.7.6a8 8 0 0 1 1.6-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.6.9l1.7-.6 1.4 2.4-1.4 1.2a8 8 0 0 1 0 1.9Z" transform="translate(-1 -1) scale(1.08)" /></>,
    send: <><path d="m5 12 14-7-4 14-3.2-5.5L5 12Z" /><path d="m11.8 13.5 3.5-3.5" /></>, stop: <><rect x="6" y="6" width="12" height="12" rx="2" /></>,
    paperclip: <><path d="m8.5 12.5 6-6a3 3 0 0 1 4.2 4.2l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.1-8.1" /></>, spark: <><path d="m12 3 1.6 6.4L20 11l-6.4 1.6L12 19l-1.6-6.4L4 11l6.4-1.6L12 3Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" /></>, close: <><path d="m6 6 12 12M18 6 6 18" /></>, trash: <><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6" /></>,
    folder: <><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z" /><path d="M3.5 9h17" /></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}
function eventLabel(event: WorkbenchEvent): string {
  switch (event.type) {
    case "run.started": return "开始执行";
    case "message.delta": return "正在生成回复";
    case "capability.started": return `调用能力：${event.data.label}`;
    case "tool.started": return `开始工具：${event.data.toolName}`;
    case "tool.finished": return `完成工具：${event.data.toolName}`;
    case "run.cancelling": return "正在取消";
    case "run.warning": return "取消处理中，等待 Agent 安全结束";
    case "run.finished": return event.data.status === "completed" ? "运行完成" : event.data.status === "cancelled" ? "运行已取消" : "运行失败";
  }
}

export default function HomePage() {
  const [mode, setMode] = useState<"fake" | "online">("fake");
  const [conversations, setConversations] = useState<UiConversationSummary[]>([]);
  const [conversation, setConversation] = useState<UiConversation | null>(null);
  const [isNewConversationDraft, setIsNewConversationDraft] = useState(true);
  const [capabilities, setCapabilities] = useState<CapabilityCatalogEntry[]>([]);
  const [text, setText] = useState("");
  const [selectedCapability, setSelectedCapability] = useState<CapabilityCatalogEntry | null>(null);
  const [capabilityValues, setCapabilityValues] = useState<Record<string, string>>({});
  const [showPicker, setShowPicker] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerIndex, setPickerIndex] = useState(0);
  const [activeView, setActiveView] = useState<"conversation" | "capabilities">("conversation");
  const [capabilitySearch, setCapabilitySearch] = useState("");
  const [configDrafts, setConfigDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [capabilityNotice, setCapabilityNotice] = useState("");
  const [activeRun, setActiveRun] = useState<UiRun | null>(null);
  const [runs, setRuns] = useState<UiRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<WorkbenchEvent[]>([]);
  const [draftReply, setDraftReply] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState(false);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [currentProject, setCurrentProject] = useState<LocalProject | null>(null);
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [attachmentResults, setAttachmentResults] = useState<LocalAttachmentResult[]>([]);
  const [fileChangesets, setFileChangesets] = useState<V2ChangesetSummary[]>([]);
  const [changesetDetail, setChangesetDetail] = useState<V2Changeset | null>(null);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState<"project" | "attachment" | "rules">("project");
  const [pickerRoots, setPickerRoots] = useState<PickerRoot[]>([]);
  const [pickerDirectory, setPickerDirectory] = useState<PickerDirectory | null>(null);
  const [selectedFileTokens, setSelectedFileTokens] = useState<string[]>([]);
  const [selectedFileBytes, setSelectedFileBytes] = useState(0);
  const [pickerNotice, setPickerNotice] = useState("");
  const [pickerSkipped, setPickerSkipped] = useState<Array<{ path: string; reason: string }>>([]);
  const [projectName, setProjectName] = useState("");
  const [rulesPreviewToken, setRulesPreviewToken] = useState<string | null>(null);
  const [projectRules, setProjectRules] = useState<ProjectRuleView | null>(null);
  const [rulesAccepted, setRulesAccepted] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastEventIdByRunRef = useRef<Record<string, string>>({});
  const selectedConversationIdRef = useRef<string | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const submissionInFlightRef = useRef(false);
  const navigationTokenRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const busy = activeRun !== null && ["queued", "running", "cancelling"].includes(activeRun.status);

  const refreshSidebar = useCallback(async () => {
    const result = await api<{ conversations: UiConversationSummary[] }>("/conversations");
    setConversations(result.conversations);
  }, []);
  const refreshConversationFiles = useCallback(async (id: string, token: number) => {
    const [attachmentData, resultData, changesetData] = await Promise.all([
      pickerApi<{ attachments: LocalAttachment[] }>(`/conversations/${encodeURIComponent(id)}/attachments`),
      pickerApi<{ results: LocalAttachmentResult[] }>(`/conversations/${encodeURIComponent(id)}/attachment-results`),
      pickerApi<{ changesets: V2ChangesetSummary[] }>(`/conversations/${encodeURIComponent(id)}/changesets`),
    ]);
    if (token !== navigationTokenRef.current || selectedConversationIdRef.current !== id) return;
    setAttachments(attachmentData.attachments);
    setAttachmentResults(resultData.results);
    setFileChangesets(changesetData.changesets);
  }, []);
  const loadConversation = useCallback(async (id: string, signal?: AbortSignal) => {
    const token = ++navigationTokenRef.current;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    activeRunIdRef.current = null;
    selectedConversationIdRef.current = id;
    setIsNewConversationDraft(false);
    setConversation(null); setActiveRun(null); setRuns([]); setSelectedRunId(null); setEvents([]); setDraftReply("");
    setAttachments([]); setAttachmentResults([]); setFileChangesets([]); setChangesetDetail(null);
    const [loaded, runResult] = await Promise.all([
      api<UiConversation>(`/conversations/${encodeURIComponent(id)}`, { signal }),
      api<{ runs: UiRun[] }>(`/conversations/${encodeURIComponent(id)}/runs`, { signal }),
    ]);
    if (token !== navigationTokenRef.current || selectedConversationIdRef.current !== id) return;
    localStorage.setItem("pi-workbench-conversation", id);
    setConversation(loaded);
    setAttachments([]);
    setAttachmentResults([]); setFileChangesets([]); setChangesetDetail(null);
    setCurrentProject(null);
    setRuns(runResult.runs);
    const latestRun = runResult.runs[0];
    setSelectedRunId(latestRun?.runId ?? null);
    setActiveRun(latestRun ?? null); setEvents([]); setDraftReply("");
    if (latestRun && ["queued", "running", "cancelling"].includes(latestRun.status)) {
      delete lastEventIdByRunRef.current[latestRun.runId];
      connectEvents(latestRun.runId);
    }
    void refreshConversationFiles(id, token).catch(() => {
      if (token === navigationTokenRef.current && selectedConversationIdRef.current === id) setNotice("附件或项目修改记录暂时无法读取。");
    });
    void pickerApi<{ projects: LocalProject[] }>("/projects")
      .then((result) => {
        if (token !== navigationTokenRef.current || selectedConversationIdRef.current !== id) return;
        setProjects(result.projects);
        setCurrentProject(result.projects.find((project) => project.projectId === loaded.projectId) ?? null);
      })
      .catch(() => { if (token === navigationTokenRef.current && selectedConversationIdRef.current === id) setNotice("项目状态暂时无法读取；对话本身仍可使用。"); });
  }, [refreshConversationFiles]);
  const connectEvents = useCallback((runId: string, afterEventId?: string) => {
    eventSourceRef.current?.close();
    activeRunIdRef.current = runId;
    const conversationId = selectedConversationIdRef.current;
    const token = navigationTokenRef.current;
    const cursorId = afterEventId ?? lastEventIdByRunRef.current[runId];
    const cursor = cursorId ? `?after=${encodeURIComponent(cursorId)}` : "";
    const source = new EventSource(`${API}/runs/${encodeURIComponent(runId)}/events${cursor}`);
    eventSourceRef.current = source;
    const isCurrent = () => eventSourceRef.current === source && activeRunIdRef.current === runId &&
      selectedConversationIdRef.current === conversationId && navigationTokenRef.current === token;
    source.onerror = () => { if (isCurrent()) setNotice("事件连接暂时中断，浏览器正在自动重连；运行仍在服务端继续。可点击“重新连接”立即恢复。"); };
    for (const type of EVENT_TYPES) source.addEventListener(type, (message) => {
      if (!isCurrent()) return;
      try {
        const payload = JSON.parse((message as MessageEvent<string>).data) as Record<string, unknown>;
        if (payload.type === "stream.reset") {
          const reset = payload as unknown as V2StreamReset;
          source.close();
          void api<UiRun>(`/runs/${encodeURIComponent(runId)}`).then((snapshot) => {
            if (!isCurrent()) return;
            setActiveRun(snapshot);
            setRuns((current) => current.map((item) => item.runId === runId ? snapshot : item));
            if (["queued", "running", "cancelling"].includes(snapshot.status)) {
              if (reset.data.latestEventId) lastEventIdByRunRef.current[runId] = reset.data.latestEventId;
              connectEvents(runId, reset.data.latestEventId);
            }
            else {
              eventSourceRef.current = null;
              void refreshSidebar();
              if (conversationId) void refreshConversationFiles(conversationId, token).catch(() => undefined);
              if (conversationId) void api<UiConversation>(`/conversations/${encodeURIComponent(conversationId)}`).then((loaded) => {
                if (selectedConversationIdRef.current === conversationId && navigationTokenRef.current === token) setConversation(loaded);
              }).catch(() => setNotice("对话刷新失败，请重新选择该对话。"));
            }
          }).catch(() => { if (isCurrent()) setNotice("运行状态恢复失败，请重新连接。"); });
          return;
        }
        if (payload.runId !== runId) return;
        if (typeof payload.eventId === "string") lastEventIdByRunRef.current[runId] = payload.eventId;
        const eventType = payload.type;
        if (eventType === "run.accepted" || eventType === "run.started") {
          const status = eventType === "run.started" ? "running" : "queued";
          setActiveRun((current) => current?.runId === runId ? { ...current, status } : current);
          setRuns((current) => current.map((item) => item.runId === runId ? { ...item, status } : item));
          setNotice("");
          return;
        }
        if (eventType === "run.progress") {
          const progress = payload.data as { message: string };
          setNotice(progress.message);
          return;
        }
        if (eventType === "checkpoint.saved" || eventType === "usage.updated") return;
        if (["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(String(eventType))) {
          source.close();
          void api<UiRun>(`/runs/${encodeURIComponent(runId)}`).then((snapshot) => {
            if (!isCurrent()) return;
            setActiveRun((current) => current?.runId === runId ? snapshot : current);
            setRuns((current) => current.map((item) => item.runId === runId ? snapshot : item));
            eventSourceRef.current = null;
            void refreshSidebar();
            if (conversationId) void refreshConversationFiles(conversationId, token).catch(() => undefined);
            if (conversationId) void api<UiConversation>(`/conversations/${encodeURIComponent(conversationId)}`).then((loaded) => {
              if (selectedConversationIdRef.current === conversationId && navigationTokenRef.current === token && activeRunIdRef.current === runId) setConversation(loaded);
            }).catch(() => { if (selectedConversationIdRef.current === conversationId) setNotice("对话刷新失败，请重新选择该对话。"); });
          }).catch(() => { if (isCurrent()) setNotice("运行状态刷新失败，请重新连接。"); });
          return;
        }
        let event: WorkbenchEvent | undefined;
        if (eventType === "message.delta") event = { schemaVersion: 1, eventId: String(payload.eventId), runId, conversationId: conversationId ?? "", sequence: Number(payload.sequence), timestamp: String(payload.timestamp), type: "message.delta", data: payload.data as { text: string } };
        if (eventType === "tool.started") {
          const data = payload.data as { toolCallId: string; toolName: string };
          event = { schemaVersion: 1, eventId: String(payload.eventId), runId, conversationId: conversationId ?? "", sequence: Number(payload.sequence), timestamp: String(payload.timestamp), type: "tool.started", data };
        }
        if (eventType === "tool.finished") {
          const data = payload.data as { toolCallId: string; toolName: string; isError: boolean };
          event = { schemaVersion: 1, eventId: String(payload.eventId), runId, conversationId: conversationId ?? "", sequence: Number(payload.sequence), timestamp: String(payload.timestamp), type: "tool.finished", data };
        }
        if (eventType === "run.cancelling") {
          const raw = payload.data as { reason: "user" | "shutdown" | "timeout" };
          const data = { reason: raw.reason === "shutdown" ? "timeout" as const : raw.reason };
          event = { schemaVersion: 1, eventId: String(payload.eventId), runId, conversationId: conversationId ?? "", sequence: Number(payload.sequence), timestamp: String(payload.timestamp), type: "run.cancelling", data };
        }
        if (!event || !conversationId) return;
        setEvents((current) => current.some((item) => item.eventId === event.eventId) ? current : [...current, event].slice(-256));
        if (event.type === "message.delta") setDraftReply((current) => current + event.data.text);
        setNotice("");
      } catch { setNotice("收到无法识别的事件；正在保留当前对话状态。"); }
    });
  }, [refreshSidebar, refreshConversationFiles]);

  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();
    setLoading(true);
    setStartupError(false);
    void (async () => {
      try {
        const [health, caps, listed] = await retryStartupRead(async (signal) => {
          const health = await api<{ mode: "fake" | "online" }>("/health", { signal });
          const [caps, listed] = await Promise.all([
            api<{ capabilities: CapabilityCatalogEntry[] }>("/capabilities", { signal }),
            api<{ conversations: UiConversationSummary[] }>("/conversations", { signal }),
          ]);
          return [health, caps, listed] as const;
        }, controller.signal);
        if (ignore) return;
        setMode(health.mode); setCapabilities(caps.capabilities); setConversations(listed.conversations);
        const saved = localStorage.getItem("pi-workbench-conversation");
        if (saved && listed.conversations.some((item) => item.conversationId === saved)) await loadConversation(saved, controller.signal);
        else if (listed.conversations[0]) await loadConversation(listed.conversations[0].conversationId, controller.signal);
        else {
          localStorage.removeItem("pi-workbench-conversation");
          setIsNewConversationDraft(true);
        }
      } catch { if (!ignore) setStartupError(true); }
      finally { if (!ignore) setLoading(false); }
    })();
    return () => { ignore = true; controller.abort(); navigationTokenRef.current++; eventSourceRef.current?.close(); eventSourceRef.current = null; };
  }, [loadConversation, startupAttempt]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [conversation?.messages.length, events.length, draftReply]);
  useEffect(() => { if (isNewConversationDraft && !loading) textareaRef.current?.focus(); }, [isNewConversationDraft, loading]);

  function beginNewConversation() {
    setActiveView("conversation");
    setMobileOpen(false);
    navigationTokenRef.current++;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    activeRunIdRef.current = null;
    selectedConversationIdRef.current = null;
    setConversation(null); setActiveRun(null); setRuns([]); setSelectedRunId(null); setEvents([]); setDraftReply("");
    setAttachments([]); setAttachmentResults([]); setFileChangesets([]); setChangesetDetail(null); setCurrentProject(null);
    setIsNewConversationDraft(true);
    setText(""); setSelectedCapability(null); setCapabilityValues({}); setPickerQuery(""); setShowPicker(false); setNotice("");
    localStorage.removeItem("pi-workbench-conversation");
    textareaRef.current?.focus();
  }
  async function deleteConversation(id: string) {
    let changesets: V2ChangesetSummary[] = [];
    try {
      changesets = id === selectedConversationIdRef.current ? fileChangesets
        : (await pickerApi<{ changesets: V2ChangesetSummary[] }>(`/conversations/${encodeURIComponent(id)}/changesets`)).changesets;
    } catch { setNotice("无法读取该对话的文件修改记录，因此没有删除。"); return; }
    const applied = changesets.filter((item) => item.status === "applied" || item.status === "partial" || item.status === "conflict");
    let changedPaths: string[] = [];
    if (applied.length) {
      try {
        const details = await Promise.all(applied.map((item) => pickerApi<V2Changeset>(`/conversations/${encodeURIComponent(id)}/changesets/${encodeURIComponent(item.changesetId)}`)));
        changedPaths = [...new Set(details.flatMap((detail) => detail.diffs.map((diff) => diff.path)))].sort();
      } catch { setNotice("无法读取将失去撤销能力的文件列表，因此没有删除。"); return; }
    }
    const historyText = applied.length
      ? `\n该对话有 ${applied.length} 组项目文件修改记录，涉及：${changedPaths.slice(0, 20).join("、") || "文件差异记录"}${changedPaths.length > 20 ? ` 等 ${changedPaths.length} 个文件` : ""}。删除后不会回滚项目文件，但会永久失去工作台内对应的撤销记录。`
      : "";
    const accepted = window.confirm(`永久删除这条对话及其消息、会话快照、运行记录、事件、附件和用量？此操作无法撤销。${historyText}\n项目目录中的当前文件不会被删除或自动回滚。若对话仍有活动任务，服务端会拒绝删除。\n\n确定永久删除？`);
    if (!accepted) return;
    const wasSelected = selectedConversationIdRef.current === id;
    try {
      await pickerApi<{ deleted: boolean }>(`/conversations/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });
      const remaining = conversations.filter((item) => item.conversationId !== id);
      setConversations(remaining);
      if (wasSelected) {
        if (remaining[0]) {
          await loadConversation(remaining[0].conversationId);
        } else {
          navigationTokenRef.current++;
          eventSourceRef.current?.close(); eventSourceRef.current = null;
          activeRunIdRef.current = null; selectedConversationIdRef.current = null;
          localStorage.removeItem("pi-workbench-conversation");
          setConversation(null); setActiveRun(null); setRuns([]); setSelectedRunId(null); setEvents([]); setDraftReply(""); setAttachments([]); setAttachmentResults([]); setFileChangesets([]); setChangesetDetail(null); setCurrentProject(null);
          setText(""); clearCapability();
          setIsNewConversationDraft(true);
        }
      } else await refreshSidebar();
      setNotice("对话及其本地运行记录已永久删除。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法删除对话；活动运行可能仍在执行。");
    }
  }
  async function openChangeset(changesetId: string) {
    const conversationId = selectedConversationIdRef.current;
    const token = navigationTokenRef.current;
    if (!conversationId) return;
    try {
      const detail = await pickerApi<V2Changeset>(`/conversations/${encodeURIComponent(conversationId)}/changesets/${encodeURIComponent(changesetId)}`);
      if (token === navigationTokenRef.current && selectedConversationIdRef.current === conversationId) setChangesetDetail(detail);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法读取文件差异。"); }
  }
  async function undoChangeset(changeset: V2ChangesetSummary) {
    if (busy || !conversation) return;
    const accepted = window.confirm(`确认撤销此请求对项目文件的修改？\n工作台会先核对文件版本；文件已被外部修改时会保留现状并报告冲突。\n\n${changeset.operationCount} 条操作记录`);
    if (!accepted) return;
    const conversationId = conversation.conversationId;
    const token = navigationTokenRef.current;
    try {
      const result = await pickerApi<V2ChangesetUndoResult>(`/conversations/${encodeURIComponent(conversationId)}/changesets/${encodeURIComponent(changeset.changesetId)}/undo`, {
        method: "POST", body: JSON.stringify({ schemaVersion: 2, confirm: true }),
      });
      setNotice(!result.undonePaths.length && !result.conflictPaths.length
        ? "没有需要撤销的文件修改，项目文件未更改。"
        : result.conflictPaths.length ? `已撤销 ${result.undonePaths.length} 个文件；${result.conflictPaths.length} 个文件因版本变化保留现状。`
          : `已撤销 ${result.undonePaths.length} 个文件修改。`);
      await refreshConversationFiles(conversationId, token);
      if (changesetDetail?.changesetId === changeset.changesetId) await openChangeset(changeset.changesetId);
    } catch (error) { setNotice(error instanceof Error ? error.message : "撤销文件修改失败。"); }
  }
  async function cleanupFileHistory() {
    const conversationId = conversation?.conversationId;
    if (!conversationId || busy) return;
    try {
      const preview = await pickerApi<V2CleanupPreview>(`/conversations/${encodeURIComponent(conversationId)}/file-cleanup-preview`);
      if (!preview.changesetIds.length) { setNotice("当前对话没有可清理的文件修改记录。"); return; }
      const accepted = window.confirm(`将清除 ${preview.changesetCount} 组文件差异和撤销记录，预计涉及 ${preview.backupObjectCount} 个备份对象（${formatBytes(preview.backupBytes)}）。\n\n${preview.note}\n\n确认清理？`);
      if (!accepted) return;
      const result = await pickerApi<{ deletedChangesetCount: number; queuedBackupObjects: number }>(`/conversations/${encodeURIComponent(conversationId)}/file-cleanup`, {
        method: "POST", body: JSON.stringify({ schemaVersion: 2, confirm: true, changesetIds: preview.changesetIds }),
      });
      setChangesetDetail(null);
      setNotice(`已清理 ${result.deletedChangesetCount} 组文件修改历史。`);
      await refreshConversationFiles(conversationId, navigationTokenRef.current);
    } catch (error) { setNotice(error instanceof Error ? error.message : "清理文件修改历史失败。"); }
  }
  function onComposerChange(value: string) {
    setText(value);
    const at = value.lastIndexOf("@");
    if (at >= 0 && (at === 0 || /\s/u.test(value[at - 1] ?? "")) && value.slice(at + 1).split(/\s/u).length <= 1) {
      setPickerQuery(value.slice(at + 1)); setPickerIndex(0); setShowPicker(true);
    } else setShowPicker(false);
  }
  function chooseCapability(capability: CapabilityCatalogEntry) {
    if (!capability.enabled || !capability.configured || !capability.compatible) return;
    const at = text.lastIndexOf("@");
    const suffix = at >= 0 ? text.slice(at + 1).replace(/^\S*/u, "") : "";
    setText(at >= 0 ? `${text.slice(0, at)}${suffix}` : text);
    setSelectedCapability(capability); setCapabilityValues({}); setPickerQuery(""); setShowPicker(false);
    textareaRef.current?.focus();
  }
  function clearCapability() { setSelectedCapability(null); setCapabilityValues({}); }
  async function submit() {
    if ((!conversation && !isNewConversationDraft) || busy || submissionInFlightRef.current) return;
    let conversationId = conversation?.conversationId;
    const token = navigationTokenRef.current;
    const trimmed = text.trim();
    let capabilityInput: Record<string, unknown> | undefined;
    if (selectedCapability) {
      if (!trimmed) { setNotice("请在输入框中填写本次能力请求的提示。"); return; }
      capabilityInput = {};
      const fields = schemaFields(selectedCapability.manifest.inputSchema);
      for (const field of fields) {
        const rawValue = capabilityValues[field.id] ?? "";
        let value: unknown = field.type === "string" ? rawValue.trim() : rawValue;
        if (field.control === "json" && rawValue.trim()) {
          try { value = JSON.parse(rawValue) as unknown; }
          catch { setNotice(`“${field.title}”必须是有效 JSON。`); return; }
          if (field.type === "array" ? !Array.isArray(value) : !value || typeof value !== "object" || Array.isArray(value)) {
            setNotice(`“${field.title}”必须是 JSON${field.type === "array" ? " 数组" : " 对象"}。`); return;
          }
        }
        const missing = value === "" || value === undefined || value === null;
        if (field.required && missing) { setNotice(`请填写“${field.title}”。`); return; }
        if (field.type === "string" && typeof value === "string" && value.length > field.maxLength) { setNotice(`“${field.title}”最多 ${field.maxLength} 个字符。`); return; }
        if (!missing) {
          if (field.type === "integer" || field.type === "number") {
            const numberValue = Number(String(value));
            if (!Number.isFinite(numberValue) || (field.type === "integer" && !Number.isInteger(numberValue))) { setNotice(`“${field.title}”必须填写有效数字。`); return; }
            capabilityInput[field.id] = numberValue;
          } else if (field.type === "boolean") capabilityInput[field.id] = value === "true";
          else capabilityInput[field.id] = value;
        }
      }
      if (selectedCapability.manifest.id === "public_repository_analysis") {
        const repository = typeof capabilityInput.repositoryUrl === "string" ? capabilityInput.repositoryUrl : "";
        const ref = typeof capabilityInput.ref === "string" ? capabilityInput.ref : "";
        if (!REPOSITORY_URL_PATTERN.test(repository)) {
          setNotice("仓库地址格式无效，请填写完整的公开 GitHub 地址，例如 https://github.com/用户名/仓库名。"); return;
        }
        if (mode === "fake" && (!isFakeDemoRepository(repository) || (ref && ref !== "main" && ref !== FAKE_REPOSITORY_SHA))) {
          setNotice("离线演示仅支持合成仓库 https://github.com/demo/harborlight（main 或固定演示 SHA）。如需分析其他仓库，请配置 API Key 并切换到在线模式。"); return;
        }
      }
    } else if (!trimmed) return;
    submissionInFlightRef.current = true;
    setNotice(""); setDraftReply(""); setEvents([]);
    const input = selectedCapability ? {
      kind: "capability", capabilityId: selectedCapability.manifest.id,
      input: capabilityInput ?? {}, prompt: trimmed,
    } : { kind: "message", text: trimmed };
    let newlyCreatedConversation: UiConversation | undefined;
    let runAccepted = false;
    try {
      if (!conversationId) {
        newlyCreatedConversation = await api<UiConversation>("/conversations", { method: "POST", body: "{}" });
        if (token !== navigationTokenRef.current || selectedConversationIdRef.current !== null) {
          await pickerApi(`/conversations/${encodeURIComponent(newlyCreatedConversation.conversationId)}`, { method: "DELETE", body: "{}" }).catch(() => undefined);
          return;
        }
        conversationId = newlyCreatedConversation.conversationId;
        selectedConversationIdRef.current = conversationId;
        setConversation(newlyCreatedConversation);
        setIsNewConversationDraft(false);
        localStorage.setItem("pi-workbench-conversation", conversationId);
      }
      const created = await api<UiRun>("/runs", {
        method: "POST", headers: { "Idempotency-Key": key() }, body: JSON.stringify({ schemaVersion: 2, conversationId, input }),
      });
      runAccepted = true;
      if (token !== navigationTokenRef.current || selectedConversationIdRef.current !== conversationId) return;
      setActiveRun(created);
      setRuns((current) => [created, ...current].slice(0, 32));
      setSelectedRunId(created.runId);
      if (newlyCreatedConversation && input.kind === "message") {
        const messageAt = new Date().toISOString();
        const optimisticMessage: Conversation["messages"][number] = {
          schemaVersion: 1, id: key(), role: "user", text: trimmed, createdAt: messageAt,
        };
        setConversation((current) => {
          if (!current || current.conversationId !== conversationId) return current;
          return {
            ...current, updatedAt: messageAt, preview: trimmed.replace(/\s+/gu, " ").slice(0, 256),
            messageCount: current.messageCount + 1, messages: [...current.messages, optimisticMessage],
          };
        });
      }
      setText("");
      clearCapability();
      await refreshSidebar();
      connectEvents(created.runId);
    } catch (error) {
      if (newlyCreatedConversation && !runAccepted) {
        let rolledBack = false;
        try {
          await pickerApi(`/conversations/${encodeURIComponent(newlyCreatedConversation.conversationId)}`, { method: "DELETE", body: "{}" });
          rolledBack = true;
        } catch { /* Keep the conversation if the server may already have accepted the run. */ }
        if (rolledBack) {
          if (token === navigationTokenRef.current && selectedConversationIdRef.current === newlyCreatedConversation.conversationId) {
            selectedConversationIdRef.current = null;
            localStorage.removeItem("pi-workbench-conversation");
            setConversation(null); setActiveRun(null); setRuns([]); setSelectedRunId(null); setEvents([]); setDraftReply(""); setAttachments([]); setCurrentProject(null);
            setIsNewConversationDraft(true);
          }
          void refreshSidebar().catch(() => undefined);
        }
      }
      if (token === navigationTokenRef.current) setNotice(error instanceof Error ? error.message : "无法提交运行。");
    } finally { submissionInFlightRef.current = false; }
  }
  async function cancel() {
    if (!activeRun || !busy) return;
    const runId = activeRun.runId;
    try {
      const snapshot = await api<UiRun>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: "{}" });
      setActiveRun((current) => {
        if (current?.runId !== runId) return current;
        // The SSE terminal event can arrive before this HTTP response. Keep that
        // completed state instead of letting an older `cancelling` snapshot win.
        if (["completed", "failed", "cancelled"].includes(current.status)) return current;
        return snapshot;
      });
    }
    catch (error) { setNotice(error instanceof Error ? error.message : "取消请求失败。"); }
  }
  async function retry(runId: string) {
    if (busy) return;
    const conversationId = selectedConversationIdRef.current;
    const token = navigationTokenRef.current;
    try {
      const next = await api<UiRun>(`/runs/${encodeURIComponent(runId)}/retry`, { method: "POST", headers: { "Idempotency-Key": key() }, body: "{}" });
      if (token !== navigationTokenRef.current || selectedConversationIdRef.current !== conversationId) return;
      setActiveRun(next); setRuns((current) => [next, ...current].slice(0, 32)); setSelectedRunId(next.runId);
      setEvents([]); setDraftReply(""); connectEvents(next.runId);
    } catch (error) { setNotice(error instanceof Error ? error.message : "重试失败。"); }
  }
  async function continueRun(runId: string) {
    if (busy) return;
    const conversationId = selectedConversationIdRef.current;
    const token = navigationTokenRef.current;
    try {
      const next = await api<UiRun>(`/runs/${encodeURIComponent(runId)}/continue`, { method: "POST", headers: { "Idempotency-Key": key() }, body: "{}" });
      if (token !== navigationTokenRef.current || selectedConversationIdRef.current !== conversationId) return;
      setActiveRun(next); setRuns((current) => [next, ...current.filter((run) => run.runId !== next.runId)].slice(0, 32)); setSelectedRunId(next.runId);
      setEvents([]); setDraftReply(""); connectEvents(next.runId);
    } catch (error) { setNotice(error instanceof Error ? error.message : "继续运行失败。"); }
  }
  async function openPicker(mode: "project" | "attachment") {
    setPickerMode(mode); setPickerDirectory(null); setSelectedFileTokens([]); setSelectedFileBytes(0); setPickerNotice(""); setPickerSkipped([]); setProjectName("");
    setShowProjectPicker(true);
    try {
      const [rootResult, projectResult] = await Promise.all([
        pickerApi<{ roots: PickerRoot[] }>(`/picker/roots?mode=${mode}`), pickerApi<{ projects: LocalProject[] }>("/projects"),
      ]);
      setPickerRoots(rootResult.roots); setProjects(projectResult.projects);
    } catch (error) { setPickerNotice(error instanceof Error ? error.message : "无法打开本地目录选择器。"); }
  }
  async function browsePicker(token: string) {
    try {
      const result = await pickerApi<PickerDirectory>("/picker/browse", { method: "POST", body: JSON.stringify({ schemaVersion: 2, mode: pickerMode, directoryToken: token }) });
      setPickerDirectory(result); setPickerNotice("");
    } catch (error) { setPickerNotice(error instanceof Error ? error.message : "无法浏览该目录。"); }
  }
  async function openSelectedProject() {
    if (!pickerDirectory?.canSelectProject) return;
    try {
      const selection = await pickerApi<{ selectionToken: string }>("/picker/project-selection", {
        method: "POST", body: JSON.stringify({ schemaVersion: 2, directoryToken: pickerDirectory.directoryToken }),
      });
      const opened = await pickerApi<{ project: LocalProject; conversation: UiConversation }>("/picker/open-project", {
        method: "POST", body: JSON.stringify({ schemaVersion: 2, selectionToken: selection.selectionToken, ...(projectName.trim() ? { displayName: projectName.trim() } : {}) }),
      });
      setProjects((items) => [opened.project, ...items.filter((item) => item.projectId !== opened.project.projectId)]);
      setShowProjectPicker(false); setPickerDirectory(null); setPickerNotice("");
      await refreshSidebar(); await loadConversation(opened.conversation.conversationId);
      setNotice(`已打开项目：${opened.project.displayName}`);
    } catch (error) { setPickerNotice(error instanceof Error ? error.message : "无法打开项目。"); }
  }
  async function startProjectConversation(projectId: string) {
    try {
      const created = await pickerApi<UiConversation>(`/projects/${encodeURIComponent(projectId)}/conversations`, { method: "POST", body: "{}" });
      setShowProjectPicker(false); await refreshSidebar(); await loadConversation(created.conversationId);
    } catch (error) { setPickerNotice(error instanceof Error ? error.message : "无法重新打开项目。"); }
  }
  function toggleFileToken(token: string, byteSize: number) {
    if (selectedFileTokens.includes(token)) {
      setSelectedFileTokens((items) => items.filter((item) => item !== token)); setSelectedFileBytes((bytes) => Math.max(0, bytes - byteSize));
    } else if (selectedFileTokens.length >= 100) setPickerNotice("一次最多选择 100 个文件。");
    else { setSelectedFileTokens((items) => [...items, token]); setSelectedFileBytes((bytes) => bytes + byteSize); }
  }
  async function importSelectedFiles(directoryToken?: string) {
    if (!selectedFileTokens.length && !directoryToken) return;
    let conversationId = conversation?.conversationId;
    let createdConversation: UiConversation | undefined;
    try {
      if (!conversationId) {
        createdConversation = await api<UiConversation>("/conversations", { method: "POST", body: "{}" });
        conversationId = createdConversation.conversationId;
      }
      const result = await pickerApi<{ attachments: LocalAttachment[]; skipped: Array<{ path: string; reason: string }>; totalBytes: number }>(
        `/conversations/${encodeURIComponent(conversationId)}/attachments/import`, {
          method: "POST", body: JSON.stringify({ schemaVersion: 2, fileTokens: directoryToken ? [] : selectedFileTokens, ...(directoryToken ? { directoryToken } : {}) }),
        });
      setPickerSkipped(result.skipped);
      const reasonLabel: Record<string, string> = {
        symbolic_link: "符号链接已跳过", excluded_directory: "受限目录已跳过", sensitive_file: "敏感文件已跳过",
        unsupported_file_type: "非支持的文本类型已跳过", not_utf8_text: "非 UTF-8 文本已跳过", binary_content: "二进制文件已跳过",
        total_size_limit: "超过 20 MiB 总量限制", file_count_limit: "超过 100 个文件限制", scan_limit: "目录项目过多，扫描已停止",
      };
      if (createdConversation && result.attachments.length === 0) {
        await pickerApi(`/conversations/${encodeURIComponent(createdConversation.conversationId)}`, { method: "DELETE", body: "{}" });
      } else if (createdConversation) {
        setShowProjectPicker(false); await refreshSidebar(); await loadConversation(createdConversation.conversationId);
      } else {
        const updated = await pickerApi<{ attachments: LocalAttachment[] }>(`/conversations/${encodeURIComponent(conversationId)}/attachments`);
        setAttachments(updated.attachments);
      }
      setSelectedFileTokens([]); setSelectedFileBytes(0);
      setPickerNotice(result.attachments.length ? `已导入 ${result.attachments.length} 个文本附件（${formatBytes(result.totalBytes)}）。${result.skipped.length ? `跳过 ${result.skipped.length} 项。` : ""}`
        : result.skipped.length ? "没有导入附件；请查看跳过原因。" : "没有可导入的文件。");
      if (result.skipped.length) setPickerSkipped(result.skipped.map((item) => ({ ...item, reason: reasonLabel[item.reason] ?? item.reason })));
    } catch (error) {
      if (createdConversation) await pickerApi(`/conversations/${encodeURIComponent(createdConversation.conversationId)}`, { method: "DELETE", body: "{}" }).catch(() => undefined);
      setPickerNotice(error instanceof Error ? error.message : "附件导入失败，没有完成保存。");
    }
  }
  async function openProjectRules() {
    if (!currentProject) return;
    setPickerMode("rules"); setShowProjectPicker(true); setRulesPreviewToken(null); setProjectRules(null); setRulesAccepted(false); setPickerNotice("");
    try {
      const saved = await pickerApi<{ rules: ProjectRuleView | null }>(`/projects/${encodeURIComponent(currentProject.projectId)}/rules`);
      if (saved.rules) { setProjectRules(saved.rules); setRulesAccepted(true); return; }
      const preview = await pickerApi<{ previewToken: string; sourcePath: string; content: string; sourceSha256: string; sourceVersion: string }>(
        `/projects/${encodeURIComponent(currentProject.projectId)}/rules/preview`, { method: "POST", body: "{}" });
      setRulesPreviewToken(preview.previewToken);
      setProjectRules({ schemaVersion: 2, projectId: currentProject.projectId, sourcePath: preview.sourcePath, sourceSha256: preview.sourceSha256,
        sourceVersion: preview.sourceVersion, content: preview.content, acceptedAt: "", revokedAt: null });
    } catch (error) { setPickerNotice(error instanceof Error ? error.message : "无法预览项目规则。"); }
  }
  async function acceptProjectRules() {
    if (!currentProject || !rulesPreviewToken) return;
    try {
      const result = await pickerApi<{ rules: ProjectRuleView }>(`/projects/${encodeURIComponent(currentProject.projectId)}/rules/accept`, {
        method: "POST", body: JSON.stringify({ schemaVersion: 2, previewToken: rulesPreviewToken }),
      });
      setProjectRules(result.rules); setRulesAccepted(true); setRulesPreviewToken(null); setPickerNotice("规则已保存为用户确认的本地记录；当前运行不会自动加载它。");
    } catch (error) { setPickerNotice(error instanceof Error ? error.message : "规则确认失败。"); }
  }
  async function revokeProjectRules() {
    if (!currentProject) return;
    try {
      await pickerApi(`/projects/${encodeURIComponent(currentProject.projectId)}/rules`, { method: "DELETE" });
      setProjectRules(null); setRulesAccepted(false); setRulesPreviewToken(null); setPickerNotice("项目规则确认已撤回。");
    } catch (error) { setPickerNotice(error instanceof Error ? error.message : "撤回项目规则失败。"); }
  }
  async function downloadAttachment(item: LocalAttachment) {
    try {
      if (!pickerCsrfToken) await openPickerSession();
      const response = await fetch(`${API}/conversations/${encodeURIComponent(item.conversationId)}/attachments/${encodeURIComponent(item.attachmentId)}`, { headers: { "x-csrf-token": pickerCsrfToken! } });
      if (!response.ok) throw new Error("附件不可用或本地会话已过期。");
      const file = await response.blob();
      const url = URL.createObjectURL(file); const anchor = document.createElement("a"); anchor.href = url; anchor.download = item.fileName; anchor.click(); URL.revokeObjectURL(url);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法读取附件。"); }
  }
  async function downloadAttachmentResult(item: LocalAttachmentResult) {
    try {
      if (!pickerCsrfToken) await openPickerSession();
      const response = await fetch(`${API}/conversations/${encodeURIComponent(item.conversationId)}/attachment-results/${encodeURIComponent(item.resultId)}`, { headers: { "x-csrf-token": pickerCsrfToken! } });
      if (!response.ok) throw new Error("结果文件不可用或本地会话已过期。");
      const file = await response.blob();
      const url = URL.createObjectURL(file); const anchor = document.createElement("a"); anchor.href = url; anchor.download = item.fileName; anchor.click(); URL.revokeObjectURL(url);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法下载结果文件。"); }
  }
  const filteredCapabilities = capabilities.filter((capability) => capability.enabled && capability.configured && capability.compatible &&
    `${capability.manifest.name} ${capability.manifest.id} ${capability.manifest.description}`.toLowerCase().includes(pickerQuery.toLowerCase()));
  const capabilityGroups = [
    { kind: "workflow", label: "工作流", entries: filteredCapabilities.filter((entry) => entry.manifest.kind === "workflow") },
    { kind: "tools", label: "工具扩展", entries: filteredCapabilities.filter((entry) => entry.manifest.kind === "tools") },
  ].filter((group) => group.entries.length > 0);
  const visibleCapabilities = capabilities.filter((capability) =>
    `${capability.manifest.name} ${capability.manifest.id} ${capability.manifest.description}`.toLowerCase().includes(capabilitySearch.toLowerCase()));
  async function saveCapabilityState(capabilityId: string, patch: { enabled?: boolean; config?: Record<string, unknown> }) {
    try {
      const response = await pickerApi<{ capability: CapabilityCatalogEntry }>(`/capabilities/${encodeURIComponent(capabilityId)}/state`, {
        method: "PATCH", body: JSON.stringify({ schemaVersion: 2, ...patch }),
      });
      setCapabilities((current) => current.map((entry) => entry.manifest.id === capabilityId ? response.capability : entry));
      if (patch.enabled === false && selectedCapability?.manifest.id === capabilityId) clearCapability();
      if (patch.config) setConfigDrafts((current) => ({ ...current, [capabilityId]: response.capability.config }));
      setCapabilityNotice("能力设置已保存。");
    } catch (error) { setCapabilityNotice(error instanceof Error ? error.message : "无法保存能力设置。"); }
  }
  async function saveCapabilityConfig(capabilityId: string, draft: Record<string, unknown>, fields: CapabilityField[]) {
    const config = { ...draft };
    for (const field of fields) {
      const value = config[field.id];
      if (!field.required && field.enum && value === "") { delete config[field.id]; continue; }
      if (field.required && (value === undefined || value === null || value === "")) {
        setCapabilityNotice(`请填写“${field.title}”。`); return;
      }
      if (field.control === "json" && typeof value === "string") {
        if (!value.trim()) { delete config[field.id]; continue; }
        try { config[field.id] = JSON.parse(value) as unknown; }
        catch { setCapabilityNotice(`“${field.title}”必须是有效 JSON。`); return; }
        const parsed = config[field.id];
        if (field.type === "array" ? !Array.isArray(parsed) : !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setCapabilityNotice(`“${field.title}”必须是 JSON${field.type === "array" ? " 数组" : " 对象"}。`); return;
        }
      }
      if (value === undefined) delete config[field.id];
    }
    await saveCapabilityState(capabilityId, { config });
  }
  const isWelcome = !conversation?.messages.length && !activeRun;
  const canCompose = conversation !== null || isNewConversationDraft;
  const selectedRun = selectedRunId === activeRun?.runId ? activeRun : runs.find((run) => run.runId === selectedRunId) ?? activeRun;
  const selectedIsActive = selectedRun?.runId === activeRun?.runId;
  const result = selectedRun?.result;

  return <div className={`workbench-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
    <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
      <div className="brand-row"><a className="brand" href="#home" aria-label="PI Workbench">PI <span>Workbench</span></a><button className="collapse" aria-label="收起导航" onClick={() => setMobileOpen(false)}>‹</button></div>
      <nav className="primary-nav" aria-label="主导航">
        <button className={`nav-item ${activeView === "conversation" && isNewConversationDraft ? "selected" : ""}`} onClick={beginNewConversation}><Icon name="plus" /><span>新对话</span></button>
        <div className="nav-caption">工作区</div>
        <button className={`nav-item ${activeView === "conversation" ? "selected" : ""}`} onClick={() => { setMobileOpen(false); setActiveView("conversation"); window.setTimeout(() => textareaRef.current?.focus(), 0); }}><Icon name="chat" /><span>对话</span></button>
        <button className={`nav-item ${activeView === "capabilities" ? "selected" : ""}`} onClick={() => { setMobileOpen(false); setShowPicker(false); setCapabilityNotice(""); setActiveView("capabilities"); }}><Icon name="grid" /><span>能力中心</span></button>
        <button className="nav-item" onClick={() => void openPicker("project")}><Icon name="folder" /><span>打开项目</span></button>
      </nav>
      {currentProject && <div className="project-sidebar-card"><div className="project-sidebar-label">当前项目</div><strong title={currentProject.canonicalRoot}>{currentProject.displayName}</strong><button onClick={() => void startProjectConversation(currentProject.projectId)}><Icon name="plus" />新建项目对话</button></div>}
      <div className="section-heading"><span>最近对话</span><button className="icon-button" aria-label="新建对话" onClick={beginNewConversation}><Icon name="plus" /></button></div>
      <div className="conversation-list">
        {conversations.map((item) => <div className={`conversation-row ${item.conversationId === conversation?.conversationId ? "current" : ""}`} key={item.conversationId}>
          <button className="conversation-item" title={item.title} onClick={() => void loadConversation(item.conversationId)}><Icon name="chat" /><span>{item.title}</span></button>
          <button className="delete-conversation" title={`永久删除：${item.title}`} aria-label={`永久删除对话：${item.title}`} onClick={() => void deleteConversation(item.conversationId)}><Icon name="trash" /></button>
        </div>)}
        {!conversations.length && <p className="empty-sidebar">对话保存在本地 SQLite 数据库中</p>}
      </div>
      <div className="sidebar-footer"><button className="nav-item" onClick={() => setShowSettings(true)}><Icon name="settings" /><span>设置和更多</span></button></div>
    </aside>
    {mobileOpen && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />}
    <main className="main-area">
      <header className="topbar"><button className="mobile-menu" aria-label="打开导航" onClick={() => setMobileOpen(true)}><Icon name="chat" /></button><div className="mobile-brand">PI Workbench</div>{currentProject && <div className="project-location" title={currentProject.canonicalRoot}><Icon name="folder" /><span>{currentProject.canonicalRoot}</span><button onClick={() => void openProjectRules()}>项目规则</button></div>}<div className={`mode-pill ${mode === "fake" ? "offline" : "online"}`}><span className="status-dot" />{mode === "fake" ? "离线演示" : "DeepSeek Flash"}</div></header>
      <div className={`content-shell ${activeView === "capabilities" ? "capability-center-shell" : isWelcome ? "welcome-view" : "conversation-view"}`}>
        {loading ? <div className="loading-state" role="status"><span className="loader" /> 正在连接本地工作台…</div> : startupError ? <section className="welcome-block" role="alert"><h1>暂时无法连接工作台</h1><p>本地服务尚未就绪或连接已中断。请检查启动终端后重试。</p><button className="quiet-button" onClick={() => setStartupAttempt((current) => current + 1)}>重新连接</button></section> : activeView === "capabilities" ? <section className="capability-center" aria-labelledby="capability-center-title">
          <header className="capability-center-heading"><div><span className="eyebrow">已注册能力</span><h1 id="capability-center-title">能力中心</h1><p>管理本机工作台中明确注册的扩展。只有启用且完成配置的能力会出现在对话的 @ 菜单中。</p></div><button className="quiet-button" onClick={() => { setMobileOpen(false); setActiveView("conversation"); window.setTimeout(() => textareaRef.current?.focus(), 0); }}>返回对话</button></header>
          <label className="capability-search"><span className="sr-only">搜索能力</span><input value={capabilitySearch} onChange={(event) => setCapabilitySearch(event.target.value)} placeholder="搜索名称、ID 或说明" /></label>
          {capabilityNotice && <div className="capability-center-notice" role="status">{capabilityNotice}</div>}
          <div className="capability-center-list">{visibleCapabilities.map((entry) => {
            const id = entry.manifest.id;
            const draft = configDrafts[id] ?? entry.config as Record<string, unknown>;
            const fields = schemaFields(entry.manifest.configSchema, true);
            const status = !entry.compatible ? "版本不兼容" : !entry.enabled ? "已停用" : !entry.configured ? "需要配置" : "已启用";
            return <article className="capability-center-card" key={id}>
              <div className="capability-center-card-head"><div className="capability-center-icon"><Icon name={entry.manifest.icon === "grid" ? "grid" : "spark"} /></div><div className="capability-center-title"><div><h2>{entry.manifest.name}</h2><span className={`capability-status ${entry.status}`}>{status}</span></div><code>{id} · API {entry.manifest.apiVersion}</code></div><label className="capability-switch"><span>{entry.enabled ? "启用" : "停用"}</span><input type="checkbox" checked={entry.enabled} disabled={!entry.compatible} onChange={(event) => void saveCapabilityState(id, { enabled: event.target.checked })} aria-label={`${entry.enabled ? "停用" : "启用"}${entry.manifest.name}`} /></label></div>
              <p className="capability-center-description">{entry.manifest.description}</p>
              <div className="capability-center-meta"><span>{entry.manifest.kind === "workflow" ? "工作流" : "工具扩展"}</span>{entry.manifest.requiredPermissions.map((permission) => <code key={permission}>{permission}</code>)}{entry.manifest.requiredPermissions.length === 0 && <span>不需要额外权限</span>}</div>
              {fields.length ? <div className="capability-config-fields">{fields.map((field) => {
                const value = draft[field.id];
                return <label className="capability-input-field" key={field.id}><span>{field.title}{field.required ? "（必填）" : "（可选）"}</span>
                  {field.control === "json" ? <textarea value={typeof value === "string" ? value : JSON.stringify(value ?? (field.type === "array" ? [] : {}), null, 2)} onChange={(event) => setConfigDrafts((current) => ({ ...current, [id]: { ...draft, [field.id]: event.target.value } }))} placeholder={field.description} rows={4} />
                    : field.type === "boolean" ? <input type="checkbox" checked={Boolean(value)} onChange={(event) => setConfigDrafts((current) => ({ ...current, [id]: { ...draft, [field.id]: event.target.checked } }))} />
                    : field.enum ? <select value={String(value ?? "")} onChange={(event) => setConfigDrafts((current) => ({ ...current, [id]: { ...draft, [field.id]: field.enum?.find((item) => String(item) === event.target.value) ?? event.target.value } }))}><option value="">选择…</option>{field.enum.map((item) => <option key={String(item)} value={String(item)}>{String(item)}</option>)}</select>
                      : field.control === "textarea" ? <textarea value={value === undefined ? "" : String(value)} maxLength={field.type === "string" ? field.maxLength : undefined} placeholder={field.description} rows={3} onChange={(event) => setConfigDrafts((current) => ({ ...current, [id]: { ...draft, [field.id]: event.target.value } }))} />
                        : <input type={field.type === "number" || field.type === "integer" ? "number" : "text"} value={value === undefined ? "" : String(value)} maxLength={field.type === "string" ? field.maxLength : undefined} placeholder={field.description} onChange={(event) => setConfigDrafts((current) => ({ ...current, [id]: { ...draft, [field.id]: field.type === "number" || field.type === "integer" ? (event.target.value === "" ? undefined : Number(event.target.value)) : event.target.value } }))} />}
                </label>;
              })}<button className="quiet-button" onClick={() => void saveCapabilityConfig(id, draft, fields)}>保存配置</button></div> : <p className="capability-no-config">此能力无需额外配置。</p>}
              <details className="capability-contract"><summary>查看配置、输入与输出契约</summary><pre>{JSON.stringify({ config: entry.manifest.configSchema, input: entry.manifest.inputSchema, output: entry.manifest.outputSchema }, null, 2)}</pre></details>
            </article>;
          })}{visibleCapabilities.length === 0 && <p className="empty-sidebar">没有匹配的已注册能力。</p>}</div>
        </section> : <>
          {isWelcome ? <section className="welcome-block"><div className="welcome-mark"><Icon name="spark" /></div><h1>你好，今天想解决什么问题？</h1><p>直接描述你的目标，PI Workbench 会通过对话协助你。<br className="wide-break" />需要读取公开仓库时，可以在输入框中用 <kbd>@</kbd> 显式选择“仓库分析”。</p></section> : <section className="transcript" aria-label="对话记录">
            {conversation?.messages.map((message) => <article key={message.id} className={`message-row ${message.role === "assistant" ? "assistant" : "user"}`}><div className="message-avatar">{message.role === "assistant" ? <span>PI</span> : "你"}</div><div className="message-body"><div className="message-role">{message.role === "assistant" ? "PI Workbench" : message.role === "capability" ? "能力调用" : "你"}</div><div className="message-text">{message.text}</div>{message.role === "capability" && <div className="capability-chip">@{capabilities.find((entry) => entry.manifest.id === message.capabilityId)?.manifest.name ?? "能力"}</div>}</div></article>)}
            {busy && selectedIsActive && <article className="message-row assistant"><div className="message-avatar"><span>PI</span></div><div className="message-body"><div className="message-role">PI Workbench</div>{draftReply ? <div className="message-text">{draftReply}</div> : <div className="thinking"><span /><span /><span /> 正在处理你的请求</div>}</div></article>}
            {runs.length > 0 && <div className="run-history" aria-label="运行记录"><span>运行记录</span>{runs.map((run) => <button key={run.runId} className={`run-history-item ${selectedRun?.runId === run.runId ? "current" : ""}`} onClick={() => setSelectedRunId(run.runId)} aria-pressed={selectedRun?.runId === run.runId}>{run.input.kind === "capability" ? "能力" : "对话"} · {run.runId.slice(0, 8)} · {run.status === "completed" ? "完成" : run.status === "cancelled" ? "取消" : run.status === "failed" ? "失败" : run.status === "interrupted" ? "中断" : "执行中"}</button>)}</div>}
            {selectedRun && <div className="run-card"><div className="run-card-head"><div><span className={`run-state ${selectedRun.status}`}>{selectedRun.status === "running" ? "运行中" : selectedRun.status === "cancelling" ? "正在取消" : selectedRun.status === "completed" ? "已完成" : selectedRun.status === "failed" ? "失败" : selectedRun.status === "cancelled" ? "已取消" : selectedRun.status === "interrupted" ? "已中断" : "等待中"}</span><span className="run-id">运行 {selectedRun.runId.slice(0, 8)}</span></div><div className="run-actions">{selectedIsActive && busy && <button className="quiet-button" onClick={() => void cancel()}>取消</button>}{!busy && selectedRun.status === "interrupted" && <button className="quiet-button" onClick={() => void continueRun(selectedRun.runId)}>继续</button>}{!busy && ["failed", "cancelled"].includes(selectedRun.status) && <button className="quiet-button" onClick={() => void retry(selectedRun.runId)}>重试</button>}{selectedIsActive && <button className="quiet-button" onClick={() => connectEvents(selectedRun.runId)}>重新连接</button>}</div></div>
              {selectedIsActive && <div className="event-list">{events.filter((event) => event.type !== "message.delta").slice(-10).map((event) => <div className="event-item" key={event.eventId}><span className={`event-dot ${event.type}`} /><span>{eventLabel(event)}</span></div>)}</div>}
              {!busy && result?.status === "failed" && <p className="result-error">{result.error.message}</p>}
              {!busy && result?.status === "cancelled" && <p className="result-note">运行已取消。未把部分执行结果加入 Agent 上下文。</p>}
              {result?.status === "completed" && result.capabilityResult && <section className="report-card"><div className="report-heading"><div><span className="eyebrow">仓库分析结果</span><h3>{result.capabilityResult.title}</h3></div></div><p>{result.capabilityResult.summary}</p><div className="claim-list">{result.capabilityResult.claims.map((claim) => <article className="claim" key={claim.id}><span className={`claim-kind ${claim.kind}`}>{claim.kind === "fact" ? "事实" : claim.kind === "inference" ? "推断" : "未知"}</span><p>{claim.text}</p>{claim.evidence.map((evidence, index) => <div className="evidence-ref" key={`${evidence.path}-${index}`}>{evidence.path}:{evidence.startLine}-{evidence.endLine}</div>)}</article>)}</div></section>}
              {result?.status === "completed" && result.extensionResult && <section className="report-card"><div className="report-heading"><div><span className="eyebrow">@{capabilities.find((entry) => entry.manifest.id === result.extensionResult?.extensionId)?.manifest.name ?? "扩展结果"}</span><h3>{result.extensionResult.title}</h3></div></div><p>{result.extensionResult.summary}</p><details className="extension-output"><summary>查看结构化结果</summary><pre>{JSON.stringify(result.extensionResult.output, null, 2)}</pre></details></section>}
              <RunArtifacts run={selectedRun} />
            </div>}
            {fileChangesets.length > 0 && <section className="file-history" aria-label="项目文件修改记录">
              <div className="file-history-head"><div><span className="eyebrow">项目文件</span><h3>修改记录与差异</h3></div><button className="quiet-button" onClick={() => void cleanupFileHistory()} disabled={busy}>清理历史</button></div>
              <div className="file-history-list">{fileChangesets.map((item) => <article className="file-history-item" key={item.changesetId}>
                <button className="file-history-open" onClick={() => void openChangeset(item.changesetId)} aria-expanded={changesetDetail?.changesetId === item.changesetId}>
                  <strong>{item.status === "applied" ? "已应用" : item.status === "partial" ? "部分完成" : item.status === "conflict" ? "有冲突" : item.status === "undone" ? "已撤销" : item.status === "open" ? "记录未完成" : "状态待核对"}</strong>
                  <span>{item.operationCount} 条操作 · {new Date(item.updatedAt).toLocaleString()}</span>
                </button>
                {item.status !== "undone" && item.status !== "open" && <button className="quiet-button" onClick={() => void undoChangeset(item)} disabled={busy}>撤销此请求</button>}
              </article>)}</div>
              {changesetDetail && <div className="file-diff-view">
                <div className="file-diff-head"><strong>请求差异</strong><button className="icon-button" onClick={() => setChangesetDetail(null)} aria-label="关闭差异">×</button></div>
                {changesetDetail.diffs.map((diff) => <article className="file-diff" key={diff.path}>
                  <div className="file-diff-path">{diff.path} <span>{diff.status === "applied" ? "已应用" : diff.status === "undone" ? "已撤销" : diff.status === "conflict" ? "冲突" : diff.status === "uncertain" ? "待核对" : diff.status}</span></div>
                  <pre>{diff.diffText}{diff.truncated ? "\n… 差异显示已截断" : ""}</pre>
                </article>)}
                {!changesetDetail.diffs.length && <p className="empty-sidebar">没有可显示的文件差异。</p>}
              </div>}
            </section>}
            <div ref={messagesEndRef} />
          </section>}
          <section className="composer-zone">
            {selectedCapability && <div className="capability-fields">
              <div className="capability-form-head"><div><span className="capability-kicker">本次请求使用</span><strong>@{selectedCapability.manifest.name}</strong></div><button className="icon-button" aria-label="移除能力" onClick={clearCapability}><Icon name="close" /></button></div>
              <div className="field-grid">{schemaFields(selectedCapability.manifest.inputSchema).map((field) => <label className="capability-input-field" key={field.id}>
                <span>{field.title}{field.required ? "（必填）" : "（可选）"}</span>
                {field.control === "json" ? <textarea value={capabilityValues[field.id] ?? ""} onChange={(event) => setCapabilityValues((values) => ({ ...values, [field.id]: event.target.value }))} placeholder={field.description || (field.type === "array" ? "[]" : "{}")} rows={4} />
                  : field.enum ? <select value={capabilityValues[field.id] ?? ""} onChange={(event) => setCapabilityValues((values) => ({ ...values, [field.id]: event.target.value }))}><option value="">选择…</option>{field.enum.map((item) => <option key={String(item)} value={String(item)}>{String(item)}</option>)}</select>
                  : field.type === "boolean" ? <select value={capabilityValues[field.id] ?? ""} onChange={(event) => setCapabilityValues((values) => ({ ...values, [field.id]: event.target.value }))}><option value="">选择…</option><option value="true">是</option><option value="false">否</option></select>
                  : field.control === "textarea" ? <textarea value={capabilityValues[field.id] ?? ""} maxLength={field.maxLength} onChange={(event) => setCapabilityValues((values) => ({ ...values, [field.id]: event.target.value }))} placeholder={field.description} rows={3} />
                    : <input type={field.type === "number" || field.type === "integer" ? "number" : "text"} value={capabilityValues[field.id] ?? ""} maxLength={field.type === "string" ? field.maxLength : undefined} onChange={(event) => setCapabilityValues((values) => ({ ...values, [field.id]: event.target.value }))} placeholder={field.description} />}
              </label>)}</div>
              {schemaFields(selectedCapability.manifest.inputSchema).length === 0 && <p className="capability-no-config">此能力不需要额外字段；请在提示中说明本次目标。</p>}
              {selectedCapability.manifest.id === "public_repository_analysis" && mode === "fake" && <p className="offline-capability-note">离线演示只使用合成的 Harborlight 仓库，不会分析真实仓库；其他地址会被拒绝。真实分析需切换在线模式。</p>}
            </div>}
            {attachments.length > 0 && <div className="attachment-chips" aria-label="当前对话附件">{attachments.map((item) => <button key={item.attachmentId} title={`${item.relativePath} · ${item.byteSize} bytes`} onClick={() => void downloadAttachment(item)}><Icon name="paperclip" /><span>{item.fileName}</span><small>{formatBytes(item.byteSize)}</small></button>)}</div>}
            {attachmentResults.length > 0 && <div className="attachment-chips result-chips" aria-label="可下载的结果文件">{attachmentResults.map((item) => <button key={item.resultId} title={`下载结果 · ${item.byteSize} bytes`} onClick={() => void downloadAttachmentResult(item)}><Icon name="paperclip" /><span>{item.fileName}</span><small>结果 · {formatBytes(item.byteSize)}</small></button>)}</div>}
            <div className="composer-wrap">
              {showPicker && <div className="capability-picker" role="listbox" aria-label="选择已注册能力"><div className="picker-title">可用能力 · ↑↓ 选择 · Enter 确认</div>{filteredCapabilities.length ? capabilityGroups.map((group) => <div className="picker-group" role="group" aria-label={group.label} key={group.kind}><div className="picker-group-title">{group.label}</div>{group.entries.map((capability) => { const index = filteredCapabilities.indexOf(capability); return <button key={capability.manifest.id} id={`capability-option-${index}`} role="option" aria-selected={index === pickerIndex} className={`picker-option ${index === pickerIndex ? "active" : ""}`} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setPickerIndex(index)} onClick={() => chooseCapability(capability)}><span className="picker-icon"><Icon name={capability.manifest.icon === "grid" ? "grid" : "spark"} /></span><span><strong>@{capability.manifest.name}</strong><small>{capability.manifest.description}</small></span><kbd>↵</kbd></button>; })}</div>) : <div className="picker-empty">没有匹配的已启用能力</div>}</div>}
              <textarea ref={textareaRef} value={text} onChange={(event) => onComposerChange(event.target.value)} onKeyDown={(event) => {
                if (showPicker && filteredCapabilities.length && event.key === "ArrowDown") { event.preventDefault(); setPickerIndex((index) => (index + 1) % filteredCapabilities.length); return; }
                if (showPicker && filteredCapabilities.length && event.key === "ArrowUp") { event.preventDefault(); setPickerIndex((index) => (index - 1 + filteredCapabilities.length) % filteredCapabilities.length); return; }
                if (showPicker && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); const choice = filteredCapabilities[pickerIndex]; if (choice) chooseCapability(choice); return; }
                if (event.key === "Enter" && !event.shiftKey && !showPicker) { event.preventDefault(); void submit(); }
                if (event.key === "Escape" && showPicker) setShowPicker(false);
              }} placeholder={!canCompose ? "请先新建对话" : selectedCapability ? "输入本次能力请求的目标；Shift + Enter 换行" : "给 PI Workbench 一个任务；输入 @ 可显式调用已注册能力"} rows={2} aria-label="输入你的任务" aria-activedescendant={showPicker && filteredCapabilities[pickerIndex] ? `capability-option-${pickerIndex}` : undefined} disabled={!canCompose} />
              <div className="composer-toolbar"><div className="composer-tools"><button className="tool-button" title="导入本地文本附件" aria-label="附件" onClick={() => void openPicker("attachment")} disabled={!canCompose}><Icon name="paperclip" /></button><span className="tool-separator" /><span className="composer-hint">Enter 发送 · Shift + Enter 换行</span></div><button className={`send-button ${busy ? "cancel" : ""}`} onClick={() => busy ? void cancel() : void submit()} aria-label={busy ? "取消运行" : "发送"} disabled={!canCompose && !busy}>{busy ? <Icon name="stop" /> : <Icon name="send" />}</button></div>
              </div>
            {isWelcome && canCompose && <div className="suggestions">{SUGGESTIONS.map((suggestion, index) => <button key={suggestion} className="suggestion" onClick={() => setText(suggestion)}>{index === 0 && <Icon name="spark" />}{suggestion}</button>)}</div>}
            {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="关闭提示"><Icon name="close" /></button></div>}
            <div className="disclaimer">普通提示使用默认空工具集 · 对话保存于本地 SQLite · AI 生成内容请自行核验</div>
          </section>
        </>}
      </div>
    </main>
    {showProjectPicker && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowProjectPicker(false); }}><section className="project-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="project-picker-title">
      <div className="dialog-head"><div><h2 id="project-picker-title">{pickerMode === "project" ? "打开项目" : pickerMode === "attachment" ? "导入附件" : "项目规则"}</h2><p>{pickerMode === "project" ? "选择本机目录并确认授权。取消不会创建项目或对话。" : pickerMode === "attachment" ? "附件会复制到本地对象库；来源文件不会被修改。" : "只有你明确确认的规则会保存为本地记录；不会自动加载到 Agent。"}</p></div><button className="icon-button" onClick={() => setShowProjectPicker(false)} aria-label="关闭"><Icon name="close" /></button></div>
      {pickerMode === "rules" ? <div className="rules-preview-panel">
        {projectRules ? <><div className="rules-source">来源：{projectRules.sourcePath} · {projectRules.sourceVersion}</div><pre>{projectRules.content}</pre><div className="dialog-actions">{rulesAccepted ? <button className="quiet-button" onClick={() => void revokeProjectRules()}>撤回确认</button> : <button className="primary-action" onClick={() => void acceptProjectRules()} disabled={!rulesPreviewToken}>确认并保存规则</button>}<button className="quiet-button" onClick={() => setShowProjectPicker(false)}>关闭</button></div></> : <p className="picker-empty">{pickerNotice || "正在读取项目规则…"}</p>}
      </div> : <>
        {pickerMode === "project" && !pickerDirectory && <div className="recent-projects"><h3>最近项目</h3>{projects.length ? projects.map((project) => <button key={project.projectId} disabled={project.validationState !== "valid"} onClick={() => void startProjectConversation(project.projectId)}><Icon name="folder" /><span><strong>{project.displayName}</strong><small title={project.canonicalRoot}>{project.canonicalRoot}</small></span><em>{project.validationState === "valid" ? "打开新对话" : project.validationState === "missing" ? "目录不存在" : "需要重新确认"}</em></button>) : <p>还没有已打开的项目。</p>}</div>}
        {!pickerDirectory ? <div className="picker-root-list"><h3>{pickerMode === "project" ? "选择允许目录" : "选择文件或文件夹"}</h3>{pickerRoots.map((root) => <button key={root.token} onClick={() => void browsePicker(root.token)}><Icon name="folder" /><span>{root.label}</span><small>浏览</small></button>)}{pickerRoots.length === 0 && <p>没有可用的允许目录。可通过 PI_WORKBENCH_PICKER_ROOTS 配置本地目录后重启服务。</p>}</div> : <div className="picker-browser">
          <div className="picker-path-row">{pickerDirectory.parentToken && <button onClick={() => void browsePicker(pickerDirectory.parentToken!)}>‹ 上级</button>}<code title={pickerDirectory.displayPath}>{pickerDirectory.displayPath}</code></div>
          <div className="picker-entry-list">{pickerDirectory.entries.map((entry) => <div className={`picker-entry ${entry.kind}`} key={`${entry.name}-${entry.token ?? entry.reason}`}>
            {pickerMode === "attachment" && entry.kind === "file" && entry.token ? <input type="checkbox" checked={selectedFileTokens.includes(entry.token)} onChange={() => toggleFileToken(entry.token!, entry.byteSize ?? 0)} aria-label={`选择 ${entry.name}`} /> : <span className="picker-entry-icon"><Icon name={entry.kind === "directory" ? "folder" : entry.kind === "file" ? "paperclip" : "close"} /></span>}
            {entry.kind === "directory" && entry.token ? <button className="picker-entry-name" onClick={() => void browsePicker(entry.token!)}>{entry.name}<small>文件夹</small></button> : <span className="picker-entry-name static">{entry.name}<small>{entry.kind === "file" ? formatBytes(entry.byteSize ?? 0) : entry.reason ?? "已跳过"}</small></span>}
          </div>)}{pickerDirectory.entries.length === 0 && <p className="picker-empty">此目录为空。</p>}</div>
          {pickerDirectory.truncated && <p className="picker-limit-note">目录项目超过 500 项，仅显示前 500 项。导入文件夹时仍会按服务器扫描上限处理。</p>}
          {pickerMode === "attachment" && <p className="picker-limit-note">已选择 {selectedFileTokens.length}/100 个文件 · {formatBytes(selectedFileBytes)} / 20 MiB。仅导入文本文件；敏感、二进制和超限项目会显示跳过原因。</p>}
          {pickerMode === "project" && pickerDirectory.canSelectProject && <label className="project-name-field"><span>项目名称</span><input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder={pickerDirectory.displayPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? "项目"} maxLength={256} /></label>}
        </div>}
        {pickerNotice && <div className="picker-feedback" role="status">{pickerNotice}</div>}
        {pickerSkipped.length > 0 && <div className="picker-skipped"><strong>跳过项目</strong>{pickerSkipped.slice(0, 12).map((item, index) => <div key={`${item.path}-${index}`}><span>{item.path}</span><small>{item.reason}</small></div>)}</div>}
        <div className="dialog-actions"><button className="quiet-button" onClick={() => setShowProjectPicker(false)}>取消</button>{pickerMode === "project" ? <button className="primary-action" onClick={() => void openSelectedProject()} disabled={!pickerDirectory?.canSelectProject}>打开此项目</button> : <><button className="quiet-button" onClick={() => void importSelectedFiles(pickerDirectory?.parentToken ? pickerDirectory.directoryToken : undefined)} disabled={!pickerDirectory?.parentToken}>导入此文件夹</button><button className="primary-action" onClick={() => void importSelectedFiles()} disabled={!selectedFileTokens.length}>导入所选文件（{selectedFileTokens.length}）</button></>}</div>
      </>}
    </section></div>}
    {showSettings && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="dialog-head"><h2 id="settings-title">设置和更多</h2><button className="icon-button" onClick={() => setShowSettings(false)} aria-label="关闭"><Icon name="close" /></button></div><div className="settings-row"><div><strong>模型模式</strong><p>{mode === "fake" ? "离线模拟，无真实模型调用" : "DeepSeek Flash；密钥仅由服务端读取"}</p></div><span className={`mode-pill ${mode === "fake" ? "offline" : "online"}`}>{mode === "fake" ? "离线演示" : "在线"}</span></div><div className="settings-row"><div><strong>对话存储</strong><p>保存在本机数据目录的 SQLite 数据库中；服务重启后保留</p></div></div><p className="settings-footnote">本地 API 默认绑定 127.0.0.1。此页面不会读取或保存 API Key。</p></section></div>}
  </div>;
}
