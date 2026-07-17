import { List, Play, WarningCircle, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { MessageView } from "./components/MessageView";
import { Sidebar } from "./components/Sidebar";
import { ToolRunView } from "./components/ToolRunView";
import { ToolWorkSummary } from "./components/ToolWorkSummary";
import { messageKey } from "./lib/content";
import { usePiSocket } from "./lib/use-pi-socket";
import type {
  AgentMessage,
  BridgeStatus,
  ExtensionRequest,
  ModelInfo,
  PromptSubmission,
  RpcState,
  SessionSummary,
  ServerEvent,
  SessionStats,
  ThinkingLevel,
  ToolRun,
} from "./types";

interface BridgeState {
  status: BridgeStatus;
  workspace?: string;
  pid?: number;
  message?: string;
}

type TimelineEntry =
  | { kind: "message"; key: string; message: AgentMessage; streaming: boolean }
  | { kind: "tool"; key: string; tool: ToolRun }
  | { kind: "work"; key: string; tools: ToolRun[]; startedAt: number; completedAt: number };

interface Notice {
  tone: "warning" | "error" | "info";
  message: string;
}

const WORKSPACES_STORAGE_KEY = "pi-web-workspaces";

function loadStoredWorkspaces(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(WORKSPACES_STORAGE_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((path): path is string => typeof path === "string" && path.length > 0).slice(0, 12)
      : [];
  } catch {
    return [];
  }
}

function rememberWorkspace(workspaces: string[], workspace: string): string[] {
  if (workspaces.includes(workspace)) return workspaces;
  return [...workspaces.slice(0, 11), workspace];
}

function isAgentMessage(value: unknown): value is AgentMessage {
  return typeof value === "object" && value !== null && "role" in value && typeof value.role === "string";
}

function isModelInfo(value: unknown): value is ModelInfo {
  return typeof value === "object" && value !== null &&
    "id" in value && typeof value.id === "string" &&
    "provider" in value && typeof value.provider === "string";
}

function upsertMessage(entries: TimelineEntry[], message: AgentMessage, streaming: boolean): TimelineEntry[] {
  const key = messageKey(message, crypto.randomUUID());
  const index = entries.findIndex((entry) => entry.kind === "message" && entry.key === key);
  const next: TimelineEntry = { kind: "message", key, message, streaming };
  if (index === -1) return [...entries, next];
  return entries.map((entry, entryIndex) => (entryIndex === index ? next : entry));
}

function upsertTool(entries: TimelineEntry[], tool: ToolRun): TimelineEntry[] {
  const key = `tool-${tool.id}`;
  const index = entries.findIndex((entry) => entry.kind === "tool" && entry.key === key);
  const previous = index === -1 ? null : entries[index];
  const previousTool = previous?.kind === "tool" ? previous.tool : null;
  const next: TimelineEntry = {
    kind: "tool",
    key,
    tool: {
      ...previousTool,
      ...tool,
      args: Object.keys(tool.args).length > 0 ? tool.args : previousTool?.args ?? {},
      startedAt: previousTool?.startedAt ?? tool.startedAt,
    },
  };
  if (index === -1) return [...entries, next];
  return entries.map((entry, entryIndex) => (entryIndex === index ? next : entry));
}

function hasVisibleAssistantText(message: AgentMessage): boolean {
  if (typeof message.content === "string") return message.content.trim().length > 0;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);
}

function collapseLatestWork(entries: TimelineEntry[], fallbackCompletedAt = Date.now()): TimelineEntry[] {
  let boundaryIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "message" && entry.message.role === "user") {
      boundaryIndex = index;
      break;
    }
  }

  const tools = entries
    .slice(boundaryIndex + 1)
    .filter((entry): entry is Extract<TimelineEntry, { kind: "tool" }> => entry.kind === "tool")
    .map((entry) => entry.tool);
  if (tools.length === 0) return entries;

  const startedAt = Math.min(...tools.map((tool) => tool.startedAt ?? fallbackCompletedAt));
  const completedAt = Math.max(
    fallbackCompletedAt,
    ...tools.flatMap((tool) => tool.completedAt !== undefined ? [tool.completedAt] : []),
  );
  let finalAssistant: Extract<TimelineEntry, { kind: "message" }> | null = null;
  for (let index = entries.length - 1; index > boundaryIndex; index -= 1) {
    const entry = entries[index];
    if (
      entry?.kind === "message" &&
      entry.message.role === "assistant" &&
      hasVisibleAssistantText(entry.message)
    ) {
      finalAssistant = entry;
      break;
    }
  }

  const workEntry: TimelineEntry = {
    kind: "work",
    key: `work-${tools[0]!.id}`,
    tools,
    startedAt,
    completedAt,
  };
  const toolIds = new Set(tools.map((tool) => tool.id));
  const result: TimelineEntry[] = [];
  let inserted = false;

  for (const entry of entries) {
    if (entry.kind === "tool" && toolIds.has(entry.tool.id)) continue;
    if (!inserted && finalAssistant && entry === finalAssistant) {
      result.push(workEntry);
      inserted = true;
    }
    if (entry.kind === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
      result.push({
        ...entry,
        message: {
          ...entry.message,
          content: entry.message.content.filter((block) => block.type !== "thinking"),
        },
      });
    } else {
      result.push(entry);
    }
  }
  if (!inserted) result.push(workEntry);
  return result;
}

function collapseHistoricalWork(entries: TimelineEntry[]): TimelineEntry[] {
  const result: TimelineEntry[] = [];
  let segment: TimelineEntry[] = [];

  function flushSegment(): void {
    if (segment.length === 0) return;
    const timestamps = segment.flatMap((entry) => {
      if (entry.kind === "message" && entry.message.timestamp !== undefined) return [entry.message.timestamp];
      if (entry.kind === "tool" && entry.tool.completedAt !== undefined) return [entry.tool.completedAt];
      return [];
    });
    const completedAt = timestamps.length > 0 ? Math.max(...timestamps) : Date.now();
    result.push(...collapseLatestWork(segment, completedAt));
    segment = [];
  }

  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      flushSegment();
      result.push(entry);
    } else {
      segment.push(entry);
    }
  }
  flushSegment();
  return result;
}

function historyTimeline(messages: AgentMessage[]): TimelineEntry[] {
  let entries: TimelineEntry[] = [];

  messages.forEach((message, index) => {
    if (message.role === "user" || message.role === "assistant") {
      entries.push({
        kind: "message",
        key: messageKey(message, `history-${index}`),
        message,
        streaming: false,
      });
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
        entries = upsertTool(entries, {
          id: block.id,
          name: block.name,
          args: typeof block.arguments === "object" && block.arguments !== null
            ? block.arguments as Record<string, unknown>
            : {},
          status: "running",
          startedAt: message.timestamp,
        });
      }
    }

    if (message.role === "toolResult") {
      const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const name = typeof message.toolName === "string" ? message.toolName : "Tool";
      if (!id) return;
      entries = upsertTool(entries, {
        id,
        name,
        args: {},
        status: message.isError === true ? "error" : "done",
        completedAt: message.timestamp,
      });
    }
  });

  return collapseHistoricalWork(entries);
}

function eventString(event: ServerEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" ? value : undefined;
}

function formatCost(cost?: number): string {
  if (cost === undefined) return "$0.00";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

export function App() {
  const [bridge, setBridge] = useState<BridgeState>({ status: "stopped" });
  const [rpcState, setRpcState] = useState<RpcState | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>(loadStoredWorkspaces);
  const [workspaceSwitching, setWorkspaceSwitching] = useState(false);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [extensionRequest, setExtensionRequest] = useState<ExtensionRequest | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [token, setToken] = useState("");
  const [authError, setAuthError] = useState("");
  const [syncRevision, setSyncRevision] = useState(0);
  const [fullSyncRevision, setFullSyncRevision] = useState(0);
  const feedRef = useRef<HTMLDivElement>(null);

  const onEvent = useCallback((event: ServerEvent) => {
    if (event.type === "bridge_auth_required") {
      setAuthRequired(true);
      return;
    }
    if (event.type === "bridge_auth_ok") {
      setAuthRequired(false);
      setAuthenticated(true);
      setAuthError("");
      return;
    }
    if (event.type === "bridge_auth_error") {
      sessionStorage.removeItem("pi-web-token");
      setAuthenticated(false);
      setAuthRequired(true);
      setAuthError(eventString(event, "message") ?? "Authentication failed");
      return;
    }
    if (event.type === "bridge_status") {
      setAuthenticated(true);
      const workspace = eventString(event, "workspace");
      setBridge({
        status: (event.status as BridgeStatus) ?? "stopped",
        workspace,
        pid: typeof event.pid === "number" ? event.pid : undefined,
        message: eventString(event, "message"),
      });
      if (workspace) setWorkspaces((current) => rememberWorkspace(current, workspace));
      if (event.status === "error") {
        setNotice({ tone: "error", message: eventString(event, "message") ?? "Pi failed to start" });
      }
      return;
    }
    if (event.type === "bridge_log" || event.type === "bridge_error") {
      setNotice({ tone: event.level === "warning" ? "warning" : "error", message: eventString(event, "message") ?? "Bridge error" });
      return;
    }
    if (event.type === "bridge_response") {
      if (event.command === "set_workspace") {
        setWorkspaceSwitching(false);
        if (event.success === false) {
          setNotice({ tone: "error", message: eventString(event, "error") ?? "Could not change workspace" });
          return;
        }
        const data = event.data;
        const workspace = typeof data === "object" && data !== null && "workspace" in data && typeof data.workspace === "string"
          ? data.workspace
          : undefined;
        if (workspace) setWorkspaces((current) => rememberWorkspace(current, workspace));
        setTimeline([]);
        setRpcState(null);
        setStats(null);
        setSessions([]);
        setFullSyncRevision((value) => value + 1);
        return;
      }
      if (event.command === "list_sessions") {
        if (event.success === false) {
          setNotice({ tone: "warning", message: eventString(event, "error") ?? "Could not load previous sessions" });
          return;
        }
        const data = event.data;
        if (typeof data === "object" && data !== null && "sessions" in data && Array.isArray(data.sessions)) {
          setSessions(data.sessions.filter((session): session is SessionSummary =>
            typeof session === "object" && session !== null && "path" in session && typeof session.path === "string",
          ));
        }
        return;
      }
      if (event.success === false) {
        setNotice({ tone: "error", message: eventString(event, "error") ?? "Bridge command failed" });
        return;
      }
    }
    if (event.type === "response") {
      if (event.success === false) {
        if (event.command === "set_model" || event.command === "set_thinking_level") {
          setSyncRevision((value) => value + 1);
        }
        setNotice({ tone: "error", message: eventString(event, "error") ?? `${event.command ?? "Command"} failed` });
        return;
      }

      const data = event.data;
      if (event.command === "get_state" && typeof data === "object" && data !== null) {
        setRpcState(data as RpcState);
      }
      if (event.command === "get_session_stats" && typeof data === "object" && data !== null) {
        setStats(data as SessionStats);
      }
      if (event.command === "get_available_models" && typeof data === "object" && data !== null && "models" in data && Array.isArray(data.models)) {
        setAvailableModels(data.models.filter(isModelInfo));
      }
      if (event.command === "set_model" && isModelInfo(data)) {
        setRpcState((state) => state ? { ...state, model: data } : state);
        setSyncRevision((value) => value + 1);
      }
      if (event.command === "set_thinking_level") {
        setSyncRevision((value) => value + 1);
      }
      if (event.command === "get_messages" && typeof data === "object" && data !== null && "messages" in data && Array.isArray(data.messages)) {
        setTimeline(historyTimeline(data.messages.filter(isAgentMessage)));
      }
      if (event.command === "new_session") {
        setTimeline([]);
        setStats(null);
        setFullSyncRevision((value) => value + 1);
      }
      if (event.command === "switch_session") {
        const cancelled = typeof data === "object" && data !== null && "cancelled" in data && data.cancelled === true;
        if (cancelled) {
          setNotice({ tone: "info", message: "Session switch was cancelled" });
        } else {
          setTimeline([]);
          setStats(null);
          setFullSyncRevision((value) => value + 1);
        }
      }
      return;
    }
    if (event.type === "agent_start") {
      setRpcState((state) => state ? { ...state, isStreaming: true } : state);
      return;
    }
    if (event.type === "agent_settled") {
      setRpcState((state) => state ? { ...state, isStreaming: false } : state);
      setTimeline((entries) => collapseLatestWork(entries));
      setSyncRevision((value) => value + 1);
      return;
    }
    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
      const agentMessage = event.message;
      if (isAgentMessage(agentMessage) && (agentMessage.role === "user" || agentMessage.role === "assistant")) {
        setTimeline((entries) => upsertMessage(entries, agentMessage, event.type !== "message_end" && agentMessage.role === "assistant"));
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      const id = eventString(event, "toolCallId");
      const name = eventString(event, "toolName");
      if (id && name) {
        setTimeline((entries) => upsertTool(entries, {
          id,
          name,
          args: typeof event.args === "object" && event.args !== null ? event.args as Record<string, unknown> : {},
          status: "running",
          startedAt: Date.now(),
        }));
      }
      return;
    }
    if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const id = eventString(event, "toolCallId");
      const name = eventString(event, "toolName");
      if (id && name) {
        setTimeline((entries) => upsertTool(entries, {
          id,
          name,
          args: typeof event.args === "object" && event.args !== null ? event.args as Record<string, unknown> : {},
          status: event.type === "tool_execution_update" ? "running" : event.isError ? "error" : "done",
          ...(event.type === "tool_execution_end" ? { completedAt: Date.now() } : {}),
        }));
      }
      return;
    }
    if (event.type === "extension_ui_request") {
      const request = event as unknown as ExtensionRequest;
      if (request.method === "notify") {
        setNotice({ tone: request.notifyType ?? "info", message: request.message ?? "Pi notification" });
      } else if (["confirm", "select", "input", "editor"].includes(request.method)) {
        setExtensionRequest(request);
      }
    }
  }, []);

  const { status: connectionStatus, send, reconnect } = usePiSocket({ onEvent });

  useEffect(() => {
    if (!authRequired || connectionStatus !== "open" || authenticated) return;
    const storedToken = sessionStorage.getItem("pi-web-token");
    if (storedToken) send({ type: "bridge.auth", token: storedToken });
  }, [authRequired, authenticated, connectionStatus, send]);

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(workspaces));
    } catch {
      // The current workspace still works when browser storage is unavailable.
    }
  }, [workspaces]);

  useEffect(() => {
    if (connectionStatus === "open") return;
    setWorkspaceSwitching(false);
  }, [connectionStatus]);

  useEffect(() => {
    if (connectionStatus !== "open" || !authenticated) return;
    send({ id: `sessions-${crypto.randomUUID()}`, type: "bridge.list_sessions" });
  }, [authenticated, connectionStatus, send]);

  useEffect(() => {
    if (connectionStatus !== "open" || !authenticated || bridge.status !== "running") return;
    send({ id: `state-${crypto.randomUUID()}`, type: "get_state" });
    send({ id: `messages-${crypto.randomUUID()}`, type: "get_messages" });
    send({ id: `stats-${crypto.randomUUID()}`, type: "get_session_stats" });
    send({ id: `models-${crypto.randomUUID()}`, type: "get_available_models" });
    send({ id: `sessions-${crypto.randomUUID()}`, type: "bridge.list_sessions" });
  }, [authenticated, bridge.pid, bridge.status, connectionStatus, send]);

  useEffect(() => {
    if (syncRevision === 0 || connectionStatus !== "open" || bridge.status !== "running") return;
    send({ id: `state-${crypto.randomUUID()}`, type: "get_state" });
    send({ id: `stats-${crypto.randomUUID()}`, type: "get_session_stats" });
  }, [bridge.status, connectionStatus, send, syncRevision]);

  useEffect(() => {
    if (fullSyncRevision === 0 || connectionStatus !== "open" || bridge.status !== "running") return;
    send({ id: `state-${crypto.randomUUID()}`, type: "get_state" });
    send({ id: `messages-${crypto.randomUUID()}`, type: "get_messages" });
    send({ id: `stats-${crypto.randomUUID()}`, type: "get_session_stats" });
    send({ id: `sessions-${crypto.randomUUID()}`, type: "bridge.list_sessions" });
  }, [bridge.status, connectionStatus, fullSyncRevision, send]);

  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 180;
    if (nearBottom) feed.scrollTo({ top: feed.scrollHeight, behavior: rpcState?.isStreaming ? "instant" : "smooth" });
  }, [rpcState?.isStreaming, timeline]);

  function authenticate(event: React.FormEvent): void {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    sessionStorage.setItem("pi-web-token", trimmed);
    setAuthError("");
    send({ type: "bridge.auth", token: trimmed });
  }

  function selectWorkspace(path: string): void {
    if (path === bridge.workspace || workspaceSwitching) return;
    if (rpcState?.isStreaming) {
      setNotice({ tone: "info", message: "Wait for the current run to finish before changing workspace" });
      return;
    }
    setWorkspaceSwitching(true);
    const sent = send({ id: crypto.randomUUID(), type: "bridge.set_workspace", workspace: path });
    if (!sent) {
      setWorkspaceSwitching(false);
      setNotice({ tone: "error", message: "Bridge disconnected before the workspace could change" });
    }
  }

  const canSend = connectionStatus === "open" && authenticated && bridge.status === "running";
  const contextPercent = stats?.contextUsage?.percent;
  const contextLabel = contextPercent === null || contextPercent === undefined
    ? "Pending"
    : `${contextPercent.toFixed(1)}%`;

  return (
    <div className="app-shell">
      <Sidebar
        open={sidebarOpen}
        bridgeStatus={bridge.status}
        connectionStatus={connectionStatus}
        workspace={bridge.workspace}
        workspaces={workspaces}
        workspaceSwitching={workspaceSwitching}
        rpcState={rpcState}
        sessions={sessions}
        onClose={() => setSidebarOpen(false)}
        onSelectSession={(session) => {
          setSidebarOpen(false);
          send({ id: crypto.randomUUID(), type: "switch_session", sessionPath: session.path });
        }}
        onNewSession={() => send({ id: crypto.randomUUID(), type: "new_session" })}
        onRestart={() => send({ id: crypto.randomUUID(), type: "bridge.restart" })}
        onAddWorkspace={selectWorkspace}
        onSelectWorkspace={selectWorkspace}
      />

      <main className="main-panel">
        <header className="topbar">
          <button className="icon-button menu-button" type="button" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
            <List size={20} />
          </button>
          <div className="topbar-usage" aria-label="Session usage">
            <div className="topbar-context">
              <span>Context</span>
              <strong className="tabular">{contextLabel}</strong>
              <span className="topbar-context-track" aria-hidden="true">
                <span style={{ width: `${Math.min(100, contextPercent ?? 0)}%` }} />
              </span>
            </div>
            <div className="topbar-cost">
              <span>Cost</span>
              <strong className="tabular">{formatCost(stats?.cost)}</strong>
            </div>
          </div>
        </header>

        {notice ? (
          <div className={`notice notice-${notice.tone}`} role="status">
            <WarningCircle size={17} />
            <span>{notice.message}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notice">
              <X size={16} />
            </button>
          </div>
        ) : null}

        <div className="feed" ref={feedRef}>
          <div className="feed-inner">
            {timeline.length === 0 ? (
              <section className="empty-state">
                <h1>Let&apos;s lock in.</h1>
                <p>What are we doing here?</p>
                {bridge.status !== "running" ? (
                  <button className="primary-button" type="button" onClick={() => send({ id: crypto.randomUUID(), type: "bridge.start" })}>
                    <Play size={16} weight="fill" />
                    Start Pi
                  </button>
                ) : null}
              </section>
            ) : (
              timeline.map((entry) =>
                entry.kind === "message" ? (
                  <MessageView key={entry.key} message={entry.message} streaming={entry.streaming} />
                ) : entry.kind === "tool" ? (
                  <ToolRunView key={entry.key} tool={entry.tool} />
                ) : (
                  <ToolWorkSummary
                    key={entry.key}
                    tools={entry.tools}
                    startedAt={entry.startedAt}
                    completedAt={entry.completedAt}
                  />
                ),
              )
            )}
          </div>
        </div>

        <Composer
          disabled={!canSend}
          streaming={Boolean(rpcState?.isStreaming)}
          models={availableModels}
          model={rpcState?.model ?? null}
          thinkingLevel={rpcState?.thinkingLevel ?? "off"}
          onSend={({ message, images, files }: PromptSubmission) => send({
            id: crypto.randomUUID(),
            type: "prompt",
            message,
            ...(images.length > 0 ? { images } : {}),
            ...(files.length > 0 ? { files } : {}),
            ...(rpcState?.isStreaming ? { streamingBehavior: "steer" } : {}),
          })}
          onAbort={() => send({ id: crypto.randomUUID(), type: "abort" })}
          onModelChange={(model) => {
            setRpcState((state) => state ? { ...state, model } : state);
            send({ id: crypto.randomUUID(), type: "set_model", provider: model.provider, modelId: model.id });
          }}
          onThinkingLevelChange={(level: ThinkingLevel) => {
            setRpcState((state) => state ? { ...state, thinkingLevel: level } : state);
            send({ id: crypto.randomUUID(), type: "set_thinking_level", level });
          }}
        />
      </main>

      {connectionStatus !== "open" ? (
        <div className="connection-overlay" role="status">
          <div className="connection-card">
            <div className="connection-pulse" aria-hidden="true" />
            <h2>{connectionStatus === "connecting" ? "Connecting to the bridge" : "Bridge disconnected"}</h2>
            <p>The UI will reconnect automatically. You can also retry now.</p>
            <button className="secondary-button" type="button" onClick={reconnect}>Reconnect</button>
          </div>
        </div>
      ) : null}

      {authRequired && !authenticated ? (
        <div className="auth-overlay">
          <form className="auth-card" onSubmit={authenticate}>
            <div className="auth-mark">π</div>
            <h1>Unlock Pi Control</h1>
            <p>Enter the access token configured on this machine.</p>
            <label htmlFor="access-token">Access token</label>
            <input
              id="access-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="current-password"
              autoFocus
            />
            {authError ? <div className="field-error">{authError}</div> : null}
            <button className="primary-button" type="submit" disabled={!token.trim()}>
              Continue
            </button>
          </form>
        </div>
      ) : null}

      {extensionRequest ? (
        <ExtensionDialog
          request={extensionRequest}
          onRespond={(response) => {
            send(response);
            setExtensionRequest(null);
          }}
        />
      ) : null}

    </div>
  );
}
