import { ArrowDown, CircleNotch, List, Play, WarningCircle, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { MessageView } from "./components/MessageView";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { ToolRunView } from "./components/ToolRunView";
import { ToolWorkSummary } from "./components/ToolWorkSummary";
import { messageKey } from "./lib/content";
import {
  applyTheme,
  getInitialAppearance,
  getInitialTheme,
  saveAppearance,
  saveTheme,
  type Appearance,
  type ThemeId,
} from "./lib/appearance";
import { usePiSocket } from "./lib/use-pi-socket";
import type {
  AgentMessage,
  BridgeStatus,
  ExtensionRequest,
  ModelInfo,
  PromptSubmission,
  RpcState,
  RuntimeSnapshot,
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

interface PendingSessionOpen {
  workspace: string;
  session: SessionSummary;
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

function isSessionSummary(value: unknown): value is SessionSummary {
  return typeof value === "object" && value !== null &&
    "path" in value && typeof value.path === "string";
}

function isRuntimeSnapshot(value: unknown): value is RuntimeSnapshot {
  return typeof value === "object" && value !== null &&
    "id" in value && typeof value.id === "string" &&
    "workspace" in value && typeof value.workspace === "string" &&
    "status" in value && typeof value.status === "string";
}

function isExtensionRequest(value: unknown): value is ExtensionRequest {
  return typeof value === "object" && value !== null &&
    "type" in value && value.type === "extension_ui_request" &&
    "id" in value && typeof value.id === "string" &&
    "method" in value && typeof value.method === "string";
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

function hasVisibleAssistantOutput(message: AgentMessage): boolean {
  if (hasVisibleAssistantText(message)) return true;
  return Array.isArray(message.content) && message.content.some((block) => block.type === "toolCall");
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
  const [runtimes, setRuntimes] = useState<Record<string, RuntimeSnapshot>>({});
  const [activeRuntimeId, setActiveRuntimeId] = useState<string>();
  const [rpcState, setRpcState] = useState<RpcState | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [sessionsByWorkspace, setSessionsByWorkspace] = useState<Record<string, SessionSummary[]>>({});
  const [sessionListsLoading, setSessionListsLoading] = useState<string[]>([]);
  const [pendingSession, setPendingSession] = useState<PendingSessionOpen | null>(null);
  const [workspaces, setWorkspaces] = useState<string[]>(loadStoredWorkspaces);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [awaitingAssistant, setAwaitingAssistant] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [extensionRequest, setExtensionRequest] = useState<ExtensionRequest | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [desktopSidebarHidden, setDesktopSidebarHidden] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appearance, setAppearance] = useState<Appearance>(getInitialAppearance);
  const [themeId, setThemeId] = useState<ThemeId>(getInitialTheme);
  const [authRequired, setAuthRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [token, setToken] = useState("");
  const [authError, setAuthError] = useState("");
  const [syncRevision, setSyncRevision] = useState(0);
  const [fullSyncRevision, setFullSyncRevision] = useState(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const activeRuntimeIdRef = useRef<string | undefined>(undefined);
  const runtimesRef = useRef<Record<string, RuntimeSnapshot>>({});
  const sessionCacheRef = useRef<Record<string, SessionSummary[]>>({});
  const sessionLoadingRef = useRef(new Set<string>());
  const sessionRequestWorkspacesRef = useRef(new Map<string, string>());
  const awaitingSessionMessagesRef = useRef(false);
  const scrollToBottomRef = useRef(false);

  sessionCacheRef.current = sessionsByWorkspace;
  runtimesRef.current = runtimes;
  activeRuntimeIdRef.current = activeRuntimeId;

  useEffect(() => {
    applyTheme(themeId, appearance);
    saveAppearance(appearance);
    saveTheme(themeId);
  }, [appearance, themeId]);

  const onEvent = useCallback((incomingEvent: ServerEvent) => {
    let event = incomingEvent;

    if (incomingEvent.type === "bridge_snapshot") {
      setAuthenticated(true);
      const runtimeList = Array.isArray(incomingEvent.runtimes)
        ? incomingEvent.runtimes.filter(isRuntimeSnapshot)
        : [];
      const nextRuntimes = Object.fromEntries(runtimeList.map((runtime) => [runtime.id, runtime]));
      setRuntimes(nextRuntimes);
      runtimesRef.current = nextRuntimes;
      for (const runtime of runtimeList) {
        setWorkspaces((current) => rememberWorkspace(current, runtime.workspace));
      }
      const active = activeRuntimeIdRef.current && nextRuntimes[activeRuntimeIdRef.current]
        ? nextRuntimes[activeRuntimeIdRef.current]
        : runtimeList[0];
      if (active) {
        activeRuntimeIdRef.current = active.id;
        setActiveRuntimeId(active.id);
        setBridge(active);
        setExtensionRequest(isExtensionRequest(active.pendingUiRequest) ? active.pendingUiRequest : null);
        setFullSyncRevision((value) => value + 1);
      }
      return;
    }
    if (incomingEvent.type === "runtime_snapshot" && isRuntimeSnapshot(incomingEvent.runtime)) {
      const runtime = incomingEvent.runtime;
      setRuntimes((current) => {
        const next = { ...current, [runtime.id]: runtime };
        runtimesRef.current = next;
        return next;
      });
      setWorkspaces((current) => rememberWorkspace(current, runtime.workspace));
      if (!activeRuntimeIdRef.current) {
        activeRuntimeIdRef.current = runtime.id;
        setActiveRuntimeId(runtime.id);
        setBridge(runtime);
        setFullSyncRevision((value) => value + 1);
      } else if (activeRuntimeIdRef.current === runtime.id) {
        setBridge(runtime);
        setExtensionRequest(isExtensionRequest(runtime.pendingUiRequest) ? runtime.pendingUiRequest : null);
      }
      return;
    }
    if (incomingEvent.type === "runtime_removed" && typeof incomingEvent.runtimeId === "string") {
      setRuntimes((current) => {
        const next = { ...current };
        delete next[incomingEvent.runtimeId as string];
        runtimesRef.current = next;
        return next;
      });
      return;
    }
    if (incomingEvent.type === "runtime_event") {
      if (incomingEvent.runtimeId !== activeRuntimeIdRef.current) return;
      if (typeof incomingEvent.event !== "object" || incomingEvent.event === null || Array.isArray(incomingEvent.event)) return;
      event = incomingEvent.event as ServerEvent;
    }

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
        setAwaitingAssistant(false);
        setNotice({ tone: "error", message: eventString(event, "message") ?? "Pi failed to start" });
      } else if (event.status === "stopped") {
        setAwaitingAssistant(false);
      }
      return;
    }
    if (event.type === "bridge_log" || event.type === "bridge_error") {
      setNotice({ tone: event.level === "warning" ? "warning" : "error", message: eventString(event, "message") ?? "Bridge error" });
      return;
    }
    if (event.type === "bridge_response") {
      if (event.command === "create_runtime" || event.command === "open_session") {
        if (event.success === false) {
          setPendingSession(null);
          setNotice({ tone: "error", message: eventString(event, "error") ?? "Could not open session" });
          return;
        }
        const data = event.data;
        const runtime = typeof data === "object" && data !== null && "runtime" in data && isRuntimeSnapshot(data.runtime)
          ? data.runtime
          : undefined;
        if (!runtime) return;
        setRuntimes((current) => ({ ...current, [runtime.id]: runtime }));
        activeRuntimeIdRef.current = runtime.id;
        setActiveRuntimeId(runtime.id);
        setBridge(runtime);
        setWorkspaces((current) => rememberWorkspace(current, runtime.workspace));
        setTimeline([]);
        setAwaitingAssistant(false);
        setRpcState(null);
        setStats(null);
        setPendingSession(null);
        setFullSyncRevision((value) => value + 1);
        return;
      }
      if (event.command === "list_sessions") {
        const requestId = eventString(event, "requestId");
        const requestedWorkspace = requestId ? sessionRequestWorkspacesRef.current.get(requestId) : undefined;
        if (requestId) sessionRequestWorkspacesRef.current.delete(requestId);

        const data = event.data;
        const resolvedWorkspace = typeof data === "object" && data !== null && "workspace" in data && typeof data.workspace === "string"
          ? data.workspace
          : undefined;
        if (requestedWorkspace) sessionLoadingRef.current.delete(requestedWorkspace);
        if (resolvedWorkspace) sessionLoadingRef.current.delete(resolvedWorkspace);
        setSessionListsLoading([...sessionLoadingRef.current]);

        if (event.success === false) {
          setNotice({ tone: "warning", message: eventString(event, "error") ?? "Could not load previous sessions" });
          return;
        }
        if (typeof data === "object" && data !== null && "sessions" in data && Array.isArray(data.sessions)) {
          const cacheWorkspace = resolvedWorkspace ?? requestedWorkspace;
          if (cacheWorkspace) {
            const sessions = data.sessions.filter(isSessionSummary);
            setSessionsByWorkspace((current) => {
              const next = { ...current, [cacheWorkspace]: sessions };
              sessionCacheRef.current = next;
              return next;
            });
            setWorkspaces((current) => rememberWorkspace(current, cacheWorkspace));
          }
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
        if (event.command === "switch_session" || (event.command === "get_messages" && awaitingSessionMessagesRef.current)) {
          awaitingSessionMessagesRef.current = false;
          setPendingSession(null);
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
        if (awaitingSessionMessagesRef.current) scrollToBottomRef.current = true;
        const messages = data.messages.filter(isAgentMessage);
        let latestUserIndex = -1;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index]?.role !== "user") continue;
          latestUserIndex = index;
          break;
        }
        const hasOutputAfterLatestPrompt = messages.slice(latestUserIndex + 1).some((message) =>
          message.role === "toolResult" || (message.role === "assistant" && hasVisibleAssistantOutput(message)));
        const activeRuntime = activeRuntimeIdRef.current
          ? runtimesRef.current[activeRuntimeIdRef.current]
          : undefined;
        setAwaitingAssistant(Boolean(activeRuntime?.isStreaming) && !hasOutputAfterLatestPrompt);
        setTimeline(historyTimeline(messages));
        if (awaitingSessionMessagesRef.current) {
          awaitingSessionMessagesRef.current = false;
          setPendingSession(null);
        }
      }
      if (event.command === "new_session") {
        setTimeline([]);
        setAwaitingAssistant(false);
        setStats(null);
        setFullSyncRevision((value) => value + 1);
      }
      if (event.command === "switch_session") {
        const cancelled = typeof data === "object" && data !== null && "cancelled" in data && data.cancelled === true;
        if (cancelled) {
          awaitingSessionMessagesRef.current = false;
          setPendingSession(null);
          setNotice({ tone: "info", message: "Session switch was cancelled" });
        } else {
          awaitingSessionMessagesRef.current = true;
          setTimeline([]);
          setAwaitingAssistant(false);
          setStats(null);
          setFullSyncRevision((value) => value + 1);
        }
      }
      return;
    }
    if (event.type === "agent_start") {
      setAwaitingAssistant(true);
      setRpcState((state) => state ? { ...state, isStreaming: true } : state);
      return;
    }
    if (event.type === "agent_settled") {
      setAwaitingAssistant(false);
      setRpcState((state) => state ? { ...state, isStreaming: false } : state);
      setTimeline((entries) => collapseLatestWork(entries));
      setSyncRevision((value) => value + 1);
      return;
    }
    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
      const agentMessage = event.message;
      if (isAgentMessage(agentMessage) && (agentMessage.role === "user" || agentMessage.role === "assistant")) {
        if (agentMessage.role === "assistant" && hasVisibleAssistantText(agentMessage)) setAwaitingAssistant(false);
        setTimeline((entries) => upsertMessage(entries, agentMessage, event.type !== "message_end" && agentMessage.role === "assistant"));
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      const id = eventString(event, "toolCallId");
      const name = eventString(event, "toolName");
      if (id && name) {
        setAwaitingAssistant(false);
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

  const sendRuntime = useCallback((command: Record<string, unknown>): boolean => {
    const runtimeId = activeRuntimeIdRef.current;
    if (!runtimeId) return false;
    return send({ type: "runtime.send", runtimeId, command });
  }, [send]);

  const requestWorkspaceSessions = useCallback((workspace: string, force = false): void => {
    const path = workspace.trim();
    if (!path || (!force && Object.hasOwn(sessionCacheRef.current, path)) || sessionLoadingRef.current.has(path)) return;

    const requestId = `sessions-${crypto.randomUUID()}`;
    sessionLoadingRef.current.add(path);
    sessionRequestWorkspacesRef.current.set(requestId, path);
    setSessionListsLoading([...sessionLoadingRef.current]);

    if (!send({ id: requestId, type: "bridge.list_sessions", workspace: path })) {
      sessionRequestWorkspacesRef.current.delete(requestId);
      sessionLoadingRef.current.delete(path);
      setSessionListsLoading([...sessionLoadingRef.current]);
    }
  }, [send]);

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
    setPendingSession(null);
    awaitingSessionMessagesRef.current = false;
    sessionLoadingRef.current.clear();
    sessionRequestWorkspacesRef.current.clear();
    setSessionListsLoading([]);
  }, [connectionStatus]);

  useEffect(() => {
    if (connectionStatus !== "open" || !authenticated || bridge.status !== "running" || !bridge.workspace || !activeRuntimeId) return;
    sendRuntime({ id: `state-${crypto.randomUUID()}`, type: "get_state" });
    sendRuntime({ id: `messages-${crypto.randomUUID()}`, type: "get_messages" });
    sendRuntime({ id: `stats-${crypto.randomUUID()}`, type: "get_session_stats" });
    sendRuntime({ id: `models-${crypto.randomUUID()}`, type: "get_available_models" });
    requestWorkspaceSessions(bridge.workspace, true);
  }, [activeRuntimeId, authenticated, bridge.pid, bridge.status, bridge.workspace, connectionStatus, requestWorkspaceSessions, sendRuntime]);

  useEffect(() => {
    if (syncRevision === 0 || connectionStatus !== "open" || bridge.status !== "running") return;
    sendRuntime({ id: `state-${crypto.randomUUID()}`, type: "get_state" });
    sendRuntime({ id: `stats-${crypto.randomUUID()}`, type: "get_session_stats" });
    if (bridge.workspace) requestWorkspaceSessions(bridge.workspace, true);
  }, [bridge.status, bridge.workspace, connectionStatus, requestWorkspaceSessions, sendRuntime, syncRevision]);

  useEffect(() => {
    if (fullSyncRevision === 0 || connectionStatus !== "open" || bridge.status !== "running") return;
    sendRuntime({ id: `state-${crypto.randomUUID()}`, type: "get_state" });
    sendRuntime({ id: `messages-${crypto.randomUUID()}`, type: "get_messages" });
    sendRuntime({ id: `stats-${crypto.randomUUID()}`, type: "get_session_stats" });
    if (bridge.workspace) requestWorkspaceSessions(bridge.workspace, true);
  }, [bridge.status, bridge.workspace, connectionStatus, fullSyncRevision, requestWorkspaceSessions, sendRuntime]);

  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    const forceBottom = scrollToBottomRef.current;
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 180;
    if (forceBottom || nearBottom) {
      feed.scrollTo({ top: feed.scrollHeight, behavior: forceBottom || rpcState?.isStreaming ? "instant" : "smooth" });
      scrollToBottomRef.current = false;
      setShowScrollToBottom(false);
    } else {
      setShowScrollToBottom(true);
    }
  }, [awaitingAssistant, rpcState?.isStreaming, timeline]);

  function updateScrollToBottom(): void {
    const feed = feedRef.current;
    if (!feed) return;
    setShowScrollToBottom(feed.scrollHeight - feed.scrollTop - feed.clientHeight >= 120);
  }

  function scrollToBottom(): void {
    const feed = feedRef.current;
    if (!feed) return;
    feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
  }

  function authenticate(event: React.FormEvent): void {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    sessionStorage.setItem("pi-web-token", trimmed);
    setAuthError("");
    send({ type: "bridge.auth", token: trimmed });
  }

  function activateRuntime(runtimeId: string): void {
    if (runtimeId === activeRuntimeIdRef.current) return;
    const runtime = runtimesRef.current[runtimeId];
    if (!runtime) return;
    activeRuntimeIdRef.current = runtimeId;
    setActiveRuntimeId(runtimeId);
    setBridge(runtime);
    setTimeline([]);
    setAwaitingAssistant(runtime.isStreaming);
    setRpcState(null);
    setStats(null);
    setExtensionRequest(isExtensionRequest(runtime.pendingUiRequest) ? runtime.pendingUiRequest : null);
    setFullSyncRevision((value) => value + 1);
  }

  function selectSession(workspace: string, session: SessionSummary): void {
    if (pendingSession) return;
    const existing = Object.values(runtimesRef.current).find((runtime) => runtime.sessionFile === session.path);
    if (existing) {
      activateRuntime(existing.id);
      return;
    }
    setPendingSession({ workspace, session });
    if (!send({
      id: crypto.randomUUID(),
      type: "bridge.open_session",
      workspace,
      sessionPath: session.path,
    })) {
      setPendingSession(null);
      setNotice({ tone: "error", message: "Bridge disconnected before the session could open" });
    }
  }

  function createSession(workspaceOverride?: string): void {
    const workspace = workspaceOverride ?? bridge.workspace ?? workspaces[0];
    if (!workspace) {
      setNotice({ tone: "info", message: "Add a workspace before creating a session" });
      return;
    }
    send({ id: crypto.randomUUID(), type: "bridge.create_runtime", workspace });
  }

  const canSend = connectionStatus === "open" && authenticated && bridge.status === "running";
  const contextPercent = stats?.contextUsage?.percent;
  const contextLabel = contextPercent === null || contextPercent === undefined
    ? "Pending"
    : `${contextPercent.toFixed(1)}%`;

  function closeSidebar(): void {
    setSidebarOpen(false);
    if (!window.matchMedia("(max-width: 860px)").matches) setDesktopSidebarHidden(true);
  }

  function openSidebar(): void {
    setDesktopSidebarHidden(false);
    setSidebarOpen(true);
  }

  return (
    <div className={`app-shell ${desktopSidebarHidden ? "sidebar-hidden" : ""}`}>
      <Sidebar
        open={sidebarOpen}
        connectionStatus={connectionStatus}
        workspace={bridge.workspace}
        workspaces={workspaces}
        runtimes={Object.values(runtimes)}
        activeRuntimeId={activeRuntimeId}
        rpcState={rpcState}
        sessionsByWorkspace={sessionsByWorkspace}
        sessionListsLoading={sessionListsLoading}
        openingSessionPath={pendingSession?.session.path}
        onClose={closeSidebar}
        onSelectSession={(workspace, session) => {
          setSidebarOpen(false);
          selectSession(workspace, session);
        }}
        onSelectRuntime={(runtimeId) => {
          setSidebarOpen(false);
          activateRuntime(runtimeId);
        }}
        onNewSession={createSession}
        onRestart={() => activeRuntimeId && send({ id: crypto.randomUUID(), type: "bridge.restart_runtime", runtimeId: activeRuntimeId })}
        onOpenSettings={() => {
          setSidebarOpen(false);
          setSettingsOpen(true);
        }}
        onAddWorkspace={requestWorkspaceSessions}
        onToggleWorkspace={requestWorkspaceSessions}
      />

      <main className="main-panel">
        <header className="topbar">
          <button
            className="icon-button menu-button"
            type="button"
            onClick={openSidebar}
            aria-label="Open sidebar"
            aria-controls="app-sidebar"
            aria-expanded={!desktopSidebarHidden && sidebarOpen}
          >
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

        <div className="feed-shell">
          <div className="feed" ref={feedRef} onScroll={updateScrollToBottom}>
          {pendingSession ? (
            <div className="session-opening-status" role="status">
              <CircleNotch className="spin" size={15} />
              Opening session…
            </div>
          ) : null}
          <div className="feed-inner">
            {timeline.length === 0 && !awaitingAssistant ? (
              <section className="empty-state">
                <h1>Let&apos;s lock in.</h1>
                <p>What are we doing here?</p>
                {bridge.status !== "running" ? (
                  <button className="primary-button" type="button" onClick={() => activeRuntimeId && send({ id: crypto.randomUUID(), type: "bridge.restart_runtime", runtimeId: activeRuntimeId })}>
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
            {awaitingAssistant ? (
              <div className="working-status" role="status" aria-live="polite">
                <CircleNotch className="spin" size={14} />
                <span>Working…</span>
              </div>
            ) : null}
            </div>
          </div>

          {showScrollToBottom ? (
            <button className="scroll-to-bottom" type="button" onClick={scrollToBottom} aria-label="Scroll to latest message">
              <ArrowDown size={15} weight="bold" />
            </button>
          ) : null}
        </div>

        <Composer
          disabled={!canSend}
          streaming={Boolean(rpcState?.isStreaming)}
          models={availableModels}
          model={rpcState?.model ?? null}
          thinkingLevel={rpcState?.thinkingLevel ?? "off"}
          onSend={({ message, images, files }: PromptSubmission) => {
            const sent = sendRuntime({
              id: crypto.randomUUID(),
              type: "prompt",
              message,
              ...(images.length > 0 ? { images } : {}),
              ...(files.length > 0 ? { files } : {}),
              ...(rpcState?.isStreaming ? { streamingBehavior: "steer" } : {}),
            });
            if (sent) setAwaitingAssistant(true);
            return sent;
          }}
          onAbort={() => {
            setAwaitingAssistant(false);
            return sendRuntime({ id: crypto.randomUUID(), type: "abort" });
          }}
          onModelChange={(model) => {
            setRpcState((state) => state ? { ...state, model } : state);
            sendRuntime({ id: crypto.randomUUID(), type: "set_model", provider: model.provider, modelId: model.id });
          }}
          onThinkingLevelChange={(level: ThinkingLevel) => {
            setRpcState((state) => state ? { ...state, thinkingLevel: level } : state);
            sendRuntime({ id: crypto.randomUUID(), type: "set_thinking_level", level });
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
            sendRuntime({ ...response });
            setExtensionRequest(null);
          }}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          appearance={appearance}
          themeId={themeId}
          onAppearanceChange={setAppearance}
          onThemeChange={setThemeId}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

    </div>
  );
}
