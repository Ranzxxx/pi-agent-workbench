"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CapabilityInfo, Conversation, ConversationSummary, WorkbenchEvent, WorkbenchRun, WorkbenchStreamReset } from "@pi-workbench/protocol";

const API = "/api/v1";
const SUGGESTIONS = ["帮我制定一个清晰的实施计划", "解释一下 Agent 是如何工作的", "把这个想法拆解成可执行的步骤"];
const EVENT_TYPES = ["run.started", "message.delta", "capability.started", "tool.started", "tool.finished", "run.cancelling", "run.warning", "stream.reset", "run.finished"] as const;
const REPOSITORY_URL_PATTERN = /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u;
const FAKE_REPOSITORY_SHA = "7f06c6b2792349e4d9ccbd393008e5bf1f4d419a";
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
  const response = await fetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
  if (!response.ok) throw new Error(body?.error?.message ?? `请求失败 (${response.status})`);
  return body as T;
}
function key(): string { return crypto.randomUUID(); }
function Icon({ name }: { name: "plus" | "chat" | "grid" | "settings" | "send" | "stop" | "paperclip" | "spark" | "close" }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const };
  const paths: Record<typeof name, React.ReactNode> = {
    plus: <><path d="M12 5v14M5 12h14" /></>, chat: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5 8 8 0 0 1-3.5-.8L4 20l1.8-4A7.5 7.5 0 1 1 20 11.5Z" /></>,
    grid: <><rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><rect x="14" y="14" width="6" height="6" rx="1.5" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.6.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.6-.9l-1.7.6-1.4-2.4L8 15a8 8 0 0 1 0-1.9l-1.4-1.2L8 9.5l1.7.6a8 8 0 0 1 1.6-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.6.9l1.7-.6 1.4 2.4-1.4 1.2a8 8 0 0 1 0 1.9Z" transform="translate(-1 -1) scale(1.08)" /></>,
    send: <><path d="m5 12 14-7-4 14-3.2-5.5L5 12Z" /><path d="m11.8 13.5 3.5-3.5" /></>, stop: <><rect x="6" y="6" width="12" height="12" rx="2" /></>,
    paperclip: <><path d="m8.5 12.5 6-6a3 3 0 0 1 4.2 4.2l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.1-8.1" /></>, spark: <><path d="m12 3 1.6 6.4L20 11l-6.4 1.6L12 19l-1.6-6.4L4 11l6.4-1.6L12 3Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" /></>, close: <><path d="m6 6 12 12M18 6 6 18" /></>,
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
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityInfo[]>([]);
  const [text, setText] = useState("");
  const [selectedCapability, setSelectedCapability] = useState<CapabilityInfo | null>(null);
  const [capabilityValues, setCapabilityValues] = useState<Record<string, string>>({});
  const [showPicker, setShowPicker] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [activeRun, setActiveRun] = useState<WorkbenchRun | null>(null);
  const [events, setEvents] = useState<WorkbenchEvent[]>([]);
  const [draftReply, setDraftReply] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const busy = activeRun !== null && ["queued", "running", "cancelling"].includes(activeRun.status);

  const refreshSidebar = useCallback(async () => {
    const result = await api<{ conversations: ConversationSummary[] }>("/conversations");
    setConversations(result.conversations);
  }, []);
  const loadConversation = useCallback(async (id: string) => {
    const [loaded, runResult] = await Promise.all([
      api<Conversation>(`/conversations/${encodeURIComponent(id)}`),
      api<{ runs: WorkbenchRun[] }>(`/conversations/${encodeURIComponent(id)}/runs`),
    ]);
    localStorage.setItem("pi-workbench-conversation", id);
    setConversation(loaded);
    const latestRun = runResult.runs[0];
    if (latestRun) { setActiveRun(latestRun); setEvents([]); setDraftReply(""); connectEvents(latestRun.runId); }
    else { setActiveRun(null); setEvents([]); setDraftReply(""); }
  }, []);
  const connectEvents = useCallback((runId: string, afterEventId?: string) => {
    eventSourceRef.current?.close();
    const cursor = afterEventId ? `?after=${encodeURIComponent(afterEventId)}` : "";
    const source = new EventSource(`${API}/runs/${encodeURIComponent(runId)}/events${cursor}`);
    eventSourceRef.current = source;
    source.onerror = () => setNotice("事件连接暂时中断，浏览器正在自动重连；运行仍在服务端继续。可点击“重新连接”立即恢复。" );
    for (const type of EVENT_TYPES) source.addEventListener(type, (message) => {
      try {
        const payload = JSON.parse((message as MessageEvent<string>).data) as WorkbenchEvent | WorkbenchStreamReset;
        if ("type" in payload && payload.type === "stream.reset") {
          source.close();
          void api<WorkbenchRun>(`/runs/${encodeURIComponent(runId)}`).then((snapshot) => {
            setActiveRun(snapshot);
            if (["queued", "running", "cancelling"].includes(snapshot.status)) connectEvents(runId, payload.data.latestEventId);
          });
          return;
        }
        const event = payload as WorkbenchEvent;
        setEvents((current) => current.some((item) => item.eventId === event.eventId) ? current : [...current, event].slice(-256));
        if (event.type === "message.delta") setDraftReply((current) => current + event.data.text);
        if (event.type === "run.finished") {
          setActiveRun((current) => current?.runId === runId ? { ...current, status: event.data.status, result: event.data } : current);
          source.close();
          void refreshSidebar();
          void api<Conversation>(`/conversations/${encodeURIComponent(event.conversationId)}`).then(setConversation);
        }
        setNotice("");
      } catch { setNotice("收到无法识别的事件；正在保留当前对话状态。"); }
    });
  }, [refreshSidebar]);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      try {
        const health = await api<{ mode: "fake" | "online" }>("/health");
        const caps = await api<{ capabilities: CapabilityInfo[] }>("/capabilities");
        const listed = await api<{ conversations: ConversationSummary[] }>("/conversations");
        if (ignore) return;
        setMode(health.mode); setCapabilities(caps.capabilities); setConversations(listed.conversations);
        const saved = localStorage.getItem("pi-workbench-conversation");
        if (saved && listed.conversations.some((item) => item.conversationId === saved)) await loadConversation(saved);
        else await createConversation();
      } catch (error) { if (!ignore) setNotice(error instanceof Error ? error.message : "无法连接本地工作台服务。"); }
      finally { if (!ignore) setLoading(false); }
    })();
    return () => { ignore = true; eventSourceRef.current?.close(); };
  }, [loadConversation]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [conversation?.messages.length, events.length, draftReply]);

  async function createConversation() {
    eventSourceRef.current?.close();
    const created = await api<Conversation>("/conversations", { method: "POST", body: "{}" });
    setConversation(created); setActiveRun(null); setEvents([]); setDraftReply("");
    localStorage.setItem("pi-workbench-conversation", created.conversationId);
    await refreshSidebar();
    textareaRef.current?.focus();
  }
  function onComposerChange(value: string) {
    setText(value);
    const at = value.lastIndexOf("@");
    if (at >= 0 && (at === 0 || /\s/u.test(value[at - 1] ?? "")) && value.slice(at + 1).split(/\s/u).length <= 1) {
      setPickerQuery(value.slice(at + 1)); setShowPicker(true);
    } else setShowPicker(false);
  }
  function chooseCapability(capability: CapabilityInfo) {
    setSelectedCapability(capability); setCapabilityValues({}); setText(""); setPickerQuery(""); setShowPicker(false);
  }
  function clearCapability() { setSelectedCapability(null); setCapabilityValues({}); }
  async function submit() {
    if (!conversation || busy) return;
    const trimmed = text.trim();
    let capabilityInput: Record<string, string> | undefined;
    if (selectedCapability) {
      capabilityInput = {};
      for (const field of selectedCapability.inputs) {
        const value = capabilityValues[field.id]?.trim() ?? "";
        if (field.required && !value) { setNotice(`请填写“${field.label}”。`); return; }
        if (value.length > field.maxLength) { setNotice(`“${field.label}”最多 ${field.maxLength} 个字符。`); return; }
        if (value) capabilityInput[field.id] = value;
      }
      if (selectedCapability.id === "public_repository_analysis") {
        const repository = capabilityInput.repositoryUrl ?? "";
        const ref = capabilityInput.ref ?? "";
        if (!REPOSITORY_URL_PATTERN.test(repository)) {
          setNotice("仓库地址格式无效，请填写完整的公开 GitHub 地址，例如 https://github.com/用户名/仓库名。"); return;
        }
        if (mode === "fake" && (!isFakeDemoRepository(repository) || (ref && ref !== "main" && ref !== FAKE_REPOSITORY_SHA))) {
          setNotice("离线演示仅支持合成仓库 https://github.com/demo/harborlight（main 或固定演示 SHA）。如需分析其他仓库，请配置 API Key 并切换到在线模式。"); return;
        }
      }
    } else if (!trimmed) return;
    setNotice(""); setDraftReply(""); setEvents([]);
    const input = selectedCapability ? {
      kind: "capability", capabilityId: selectedCapability.id,
      input: capabilityInput,
    } : { kind: "message", text: trimmed };
    try {
      const created = await api<WorkbenchRun>(`/conversations/${encodeURIComponent(conversation.conversationId)}/runs`, {
        method: "POST", headers: { "Idempotency-Key": key() }, body: JSON.stringify({ schemaVersion: 1, input }),
      });
      setActiveRun(created);
      setText("");
      clearCapability();
      await refreshSidebar();
      connectEvents(created.runId);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法提交运行。"); }
  }
  async function cancel() {
    if (!activeRun || !busy) return;
    const runId = activeRun.runId;
    try {
      const snapshot = await api<WorkbenchRun>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: "{}" });
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
  async function retry() {
    if (!activeRun || busy) return;
    try {
      const next = await api<WorkbenchRun>(`/runs/${encodeURIComponent(activeRun.runId)}/retry`, { method: "POST", headers: { "Idempotency-Key": key() }, body: "{}" });
      setActiveRun(next); setEvents([]); setDraftReply(""); connectEvents(next.runId);
    } catch (error) { setNotice(error instanceof Error ? error.message : "重试失败。"); }
  }
  const filteredCapabilities = capabilities.filter((capability) => `${capability.name} ${capability.id}`.toLowerCase().includes(pickerQuery.toLowerCase()));
  const isWelcome = !conversation?.messages.length;
  const result = activeRun?.result;

  return <div className={`workbench-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
    <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
      <div className="brand-row"><a className="brand" href="#home" aria-label="PI Workbench">PI <span>Workbench</span></a><button className="collapse" aria-label="收起导航" onClick={() => setMobileOpen(false)}>‹</button></div>
      <nav className="primary-nav" aria-label="主导航">
        <button className="nav-item selected" onClick={() => void createConversation()}><Icon name="plus" /><span>新对话</span></button>
        <div className="nav-caption">工作区</div>
        <button className="nav-item" onClick={() => textareaRef.current?.focus()}><Icon name="chat" /><span>对话</span></button>
        <button className="nav-item" onClick={() => { setPickerQuery(""); setShowPicker((current) => !current); textareaRef.current?.focus(); }}><Icon name="grid" /><span>能力中心</span></button>
      </nav>
      <div className="section-heading"><span>最近对话</span><button className="icon-button" aria-label="新建对话" onClick={() => void createConversation()}><Icon name="plus" /></button></div>
      <div className="conversation-list">
        {conversations.map((item) => <button key={item.conversationId} className={`conversation-item ${item.conversationId === conversation?.conversationId ? "current" : ""}`} title={item.title} onClick={() => void loadConversation(item.conversationId)}><Icon name="chat" /><span>{item.title}</span></button>)}
        {!conversations.length && <p className="empty-sidebar">对话会暂存在当前服务进程中</p>}
      </div>
      <div className="sidebar-footer"><button className="nav-item" onClick={() => setShowSettings(true)}><Icon name="settings" /><span>设置和更多</span></button></div>
    </aside>
    {mobileOpen && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />}
    <main className="main-area">
      <header className="topbar"><button className="mobile-menu" aria-label="打开导航" onClick={() => setMobileOpen(true)}><Icon name="chat" /></button><div className="mobile-brand">PI Workbench</div><div className={`mode-pill ${mode === "fake" ? "offline" : "online"}`}><span className="status-dot" />{mode === "fake" ? "离线演示" : "DeepSeek Flash"}</div></header>
      <div className={`content-shell ${isWelcome ? "welcome-view" : "conversation-view"}`}>
        {loading ? <div className="loading-state"><span className="loader" /> 正在打开工作台</div> : <>
          {isWelcome ? <section className="welcome-block"><div className="welcome-mark"><Icon name="spark" /></div><h1>你好，今天想解决什么问题？</h1><p>直接描述你的目标，PI Workbench 会通过对话协助你。<br className="wide-break" />需要读取公开仓库时，可以在输入框中用 <kbd>@</kbd> 显式选择“仓库分析”。</p></section> : <section className="transcript" aria-label="对话记录">
            {conversation?.messages.map((message) => <article key={message.id} className={`message-row ${message.role === "assistant" ? "assistant" : "user"}`}><div className="message-avatar">{message.role === "assistant" ? <span>PI</span> : "你"}</div><div className="message-body"><div className="message-role">{message.role === "assistant" ? "PI Workbench" : message.role === "capability" ? "能力调用" : "你"}</div><div className="message-text">{message.text}</div>{message.role === "capability" && <div className="capability-chip">@{capabilities.find((cap) => cap.id === message.capabilityId)?.name ?? "能力"}</div>}</div></article>)}
            {busy && <article className="message-row assistant"><div className="message-avatar"><span>PI</span></div><div className="message-body"><div className="message-role">PI Workbench</div>{draftReply ? <div className="message-text">{draftReply}</div> : <div className="thinking"><span /><span /><span /> 正在处理你的请求</div>}</div></article>}
            {activeRun && <div className="run-card"><div className="run-card-head"><div><span className={`run-state ${activeRun.status}`}>{activeRun.status === "running" ? "运行中" : activeRun.status === "cancelling" ? "正在取消" : activeRun.status === "completed" ? "已完成" : activeRun.status === "failed" ? "失败" : activeRun.status === "cancelled" ? "已取消" : "等待中"}</span><span className="run-id">运行 {activeRun.runId.slice(0, 8)}</span></div><div className="run-actions">{busy && <button className="quiet-button" onClick={() => void cancel()}>取消</button>}{!busy && activeRun.status !== "completed" && <button className="quiet-button" onClick={() => void retry()}>重试</button>}<button className="quiet-button" onClick={() => activeRun && connectEvents(activeRun.runId)}>重新连接</button></div></div>
              <div className="event-list">{events.filter((event) => event.type !== "message.delta").slice(-10).map((event) => <div className="event-item" key={event.eventId}><span className={`event-dot ${event.type}`} /><span>{eventLabel(event)}</span></div>)}</div>
              {!busy && result?.status === "failed" && <p className="result-error">{result.error.message}</p>}
              {!busy && result?.status === "cancelled" && <p className="result-note">运行已取消。未把部分执行结果加入 Agent 上下文。</p>}
              {result?.status === "completed" && result.capabilityResult && <section className="report-card"><div className="report-heading"><div><span className="eyebrow">能力结果</span><h3>{result.capabilityResult.title}</h3></div></div><p>{result.capabilityResult.summary}</p><div className="claim-list">{result.capabilityResult.claims.map((claim) => <article className="claim" key={claim.id}><span className={`claim-kind ${claim.kind}`}>{claim.kind === "fact" ? "事实" : claim.kind === "inference" ? "推断" : "未知"}</span><p>{claim.text}</p>{claim.evidence.map((evidence, index) => <div className="evidence-ref" key={`${evidence.path}-${index}`}>{evidence.path}:{evidence.startLine}-{evidence.endLine}</div>)}</article>)}</div>
                  <div className="artifact-list">{result.artifacts?.map((artifact) => <a className="artifact-link" key={artifact.kind} href={`${API}/runs/${encodeURIComponent(activeRun.runId)}/artifacts/${encodeURIComponent(artifact.kind)}`} target="_blank" rel="noreferrer">查看产物 · {artifact.kind}</a>)}</div></section>}
            </div>}
            <div ref={messagesEndRef} />
          </section>}
          <section className="composer-zone">
            {selectedCapability && <div className="capability-fields"><div className="capability-form-head"><div><span className="capability-kicker">已选择能力</span><strong>@{selectedCapability.name}</strong></div><button className="icon-button" aria-label="移除能力" onClick={clearCapability}><Icon name="close" /></button></div><div className="field-grid">{selectedCapability.inputs.map((field) => <label className="capability-input-field" key={field.id}><span>{field.label}{field.required ? "（必填）" : "（可选）"}</span>{field.control === "textarea" ? <textarea value={capabilityValues[field.id] ?? ""} maxLength={field.maxLength} onChange={(event) => setCapabilityValues((values) => ({ ...values, [field.id]: event.target.value }))} placeholder={field.description} rows={3} /> : <input value={capabilityValues[field.id] ?? ""} maxLength={field.maxLength} onChange={(event) => setCapabilityValues((values) => ({ ...values, [field.id]: event.target.value }))} placeholder={field.description} />}</label>)}</div>{selectedCapability.id === "public_repository_analysis" && mode === "fake" && <p className="offline-capability-note">离线演示只使用合成的 Harborlight 仓库，不会分析真实仓库；其他地址会被拒绝。真实分析需切换在线模式。</p>}</div>}
            <div className="composer-wrap">
              {showPicker && <div className="capability-picker"><div className="picker-title">选择已注册能力</div>{filteredCapabilities.length ? filteredCapabilities.map((capability) => <button key={capability.id} className="picker-option" onMouseDown={(event) => event.preventDefault()} onClick={() => chooseCapability(capability)}><span className="picker-icon"><Icon name="spark" /></span><span><strong>@{capability.name}</strong><small>{capability.description}</small></span><kbd>↵</kbd></button>) : <div className="picker-empty">没有匹配的已注册能力</div>}</div>}
              <textarea ref={textareaRef} value={text} onChange={(event) => onComposerChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !showPicker) { event.preventDefault(); void submit(); } if (event.key === "Escape" && showPicker) setShowPicker(false); }} placeholder={selectedCapability ? "能力参数请填写在上方；普通提示可移除能力后单独发送" : "给 PI Workbench 一个任务；输入 @ 可显式调用已注册能力"} rows={2} aria-label="输入你的任务" disabled={selectedCapability !== null} />
              <div className="composer-toolbar"><div className="composer-tools"><button className="tool-button" title="附件入口将在后续版本提供" aria-label="附件"><Icon name="paperclip" /></button><span className="tool-separator" /><span className="composer-hint">Enter 发送 · Shift + Enter 换行</span></div><button className={`send-button ${busy ? "cancel" : ""}`} onClick={() => busy ? void cancel() : void submit()} aria-label={busy ? "取消运行" : "发送"}>{busy ? <Icon name="stop" /> : <Icon name="send" />}</button></div>
              </div>
            {isWelcome && <div className="suggestions">{SUGGESTIONS.map((suggestion, index) => <button key={suggestion} className="suggestion" onClick={() => setText(suggestion)}>{index === 0 && <Icon name="spark" />}{suggestion}</button>)}</div>}
            {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="关闭提示"><Icon name="close" /></button></div>}
            <div className="disclaimer">普通提示使用默认空工具集 · 对话仅保存在当前进程 · AI 生成内容请自行核验</div>
          </section>
        </>}
      </div>
    </main>
    {showSettings && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="dialog-head"><h2 id="settings-title">设置和更多</h2><button className="icon-button" onClick={() => setShowSettings(false)} aria-label="关闭"><Icon name="close" /></button></div><div className="settings-row"><div><strong>模型模式</strong><p>{mode === "fake" ? "离线模拟，无真实模型调用" : "DeepSeek Flash；密钥仅由服务端读取"}</p></div><span className={`mode-pill ${mode === "fake" ? "offline" : "online"}`}>{mode === "fake" ? "离线演示" : "在线"}</span></div><div className="settings-row"><div><strong>对话存储</strong><p>保存在服务进程内；重启后清空</p></div></div><p className="settings-footnote">本地 API 默认绑定 127.0.0.1。此页面不会读取或保存 API Key。</p></section></div>}
  </div>;
}
