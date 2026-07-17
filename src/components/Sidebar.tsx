import {
  ArrowRight,
  ArrowsClockwise,
  CaretRight,
  CircleNotch,
  FolderSimple,
  GearSix,
  Plus,
  X,
} from "@phosphor-icons/react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { relativeSessionTime, sessionTitle } from "../lib/sessions";
import type { BridgeStatus, ConnectionStatus, RpcState, SessionSummary } from "../types";

interface SidebarProps {
  open: boolean;
  bridgeStatus: BridgeStatus;
  connectionStatus: ConnectionStatus;
  workspace?: string;
  workspaces: string[];
  workspaceSwitching: boolean;
  rpcState: RpcState | null;
  sessionsByWorkspace: Record<string, SessionSummary[]>;
  sessionListsLoading: string[];
  openingSessionPath?: string;
  onClose: () => void;
  onSelectSession: (workspace: string, session: SessionSummary) => void;
  onNewSession: () => void;
  onRestart: () => void;
  onOpenSettings: () => void;
  onAddWorkspace: (path: string) => void;
  onToggleWorkspace: (path: string) => void;
}

function basename(path?: string): string {
  if (!path) return "No workspace";
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

const COLLAPSED_SESSION_COUNT = 5;
const workspaceCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function Sidebar({
  open,
  bridgeStatus,
  connectionStatus,
  workspace,
  workspaces,
  workspaceSwitching,
  rpcState,
  sessionsByWorkspace,
  sessionListsLoading,
  openingSessionPath,
  onClose,
  onSelectSession,
  onNewSession,
  onRestart,
  onOpenSettings,
  onAddWorkspace,
  onToggleWorkspace,
}: SidebarProps) {
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set());
  const [showAllSessions, setShowAllSessions] = useState<Set<string>>(() => new Set());
  const workspaceControlsDisabled = connectionStatus !== "open" || workspaceSwitching;
  const sortedWorkspaces = useMemo(() => [...workspaces].sort((left, right) =>
    workspaceCollator.compare(basename(left), basename(right)) || workspaceCollator.compare(left, right)
  ), [workspaces]);

  useEffect(() => {
    if (!workspace) return;
    setExpandedWorkspaces((current) => {
      if (current.has(workspace)) return current;
      const next = new Set(current);
      next.add(workspace);
      return next;
    });
    onToggleWorkspace(workspace);
  }, [onToggleWorkspace, workspace]);

  function submitWorkspace(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const path = workspacePath.trim();
    if (!path || workspaceControlsDisabled) return;
    onAddWorkspace(path);
    setWorkspacePath("");
    setAddingWorkspace(false);
  }

  function toggleWorkspace(path: string): void {
    const expanding = !expandedWorkspaces.has(path);
    setExpandedWorkspaces((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (expanding) onToggleWorkspace(path);
  }

  function toggleAllSessions(path: string): void {
    setShowAllSessions((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <>
      <button className={`sidebar-backdrop ${open ? "visible" : ""}`} type="button" onClick={onClose} aria-label="Close sidebar" />
      <aside id="app-sidebar" className={`sidebar ${open ? "open" : ""}`}>
        <div className="sidebar-close-row">
          <strong className="sidebar-title">Pi Control</strong>
          <button className="icon-button sidebar-close" type="button" onClick={onClose} aria-label="Close sidebar">
            <X size={18} />
          </button>
        </div>

        <nav className="sidebar-actions" aria-label="App actions">
          <button type="button" onClick={onNewSession} disabled={bridgeStatus !== "running"}>
            <Plus size={16} />
            New session
          </button>
          <button type="button" onClick={onRestart} disabled={connectionStatus !== "open"}>
            <ArrowsClockwise size={16} />
            Restart Pi
          </button>
          <button type="button" onClick={onOpenSettings}>
            <GearSix size={16} />
            Settings
          </button>
        </nav>

        <section className="sidebar-tree" aria-labelledby="workspace-heading">
          <div className="sidebar-section-heading">
            <h2 id="workspace-heading">Workspaces</h2>
            <div className="sidebar-section-actions">
              <span className="tabular">{workspaces.length}</span>
              <button
                type="button"
                disabled={workspaceControlsDisabled}
                aria-label="Add workspace"
                aria-expanded={addingWorkspace}
                onClick={() => setAddingWorkspace((current) => !current)}
              >
                <Plus size={13} />
              </button>
            </div>
          </div>
          {addingWorkspace ? (
            <form className="workspace-add-form" onSubmit={submitWorkspace}>
              <FolderSimple size={14} aria-hidden="true" />
              <label className="sr-only" htmlFor="workspace-path">Workspace path</label>
              <input
                id="workspace-path"
                type="text"
                value={workspacePath}
                placeholder="~/Dev/project"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                onChange={(event) => setWorkspacePath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  setWorkspacePath("");
                  setAddingWorkspace(false);
                }}
              />
              <button type="submit" disabled={!workspacePath.trim()} aria-label="Add workspace">
                <ArrowRight size={13} weight="bold" />
              </button>
            </form>
          ) : null}
          <div className="workspace-list">
            {sortedWorkspaces.map((path) => {
              const activeWorkspace = path === workspace;
              const expanded = expandedWorkspaces.has(path);
              const sessions = sessionsByWorkspace[path];
              const loading = sessionListsLoading.includes(path);
              const showAll = showAllSessions.has(path);
              const visibleSessions = showAll ? sessions : sessions?.slice(0, COLLAPSED_SESSION_COUNT);

              return (
                <div className={`workspace-group ${activeWorkspace ? "active" : ""}`} key={path}>
                  <button
                    className={`workspace-row ${activeWorkspace ? "active" : ""}`}
                    type="button"
                    aria-current={activeWorkspace ? "true" : undefined}
                    aria-expanded={expanded}
                    onClick={() => toggleWorkspace(path)}
                    title={path}
                  >
                    <CaretRight className={`workspace-chevron ${expanded ? "expanded" : ""}`} size={11} weight="bold" />
                    <FolderSimple size={15} />
                    <strong>{basename(path)}</strong>
                    {loading ? <CircleNotch className="spin workspace-loading-icon" size={13} aria-label="Loading sessions" /> : null}
                  </button>
                  {expanded ? (
                    <div className="sidebar-session-list">
                      {sessions === undefined ? (
                        <div className="sidebar-loading-sessions" role="status">
                          <CircleNotch className="spin" size={12} />
                          Loading sessions…
                        </div>
                      ) : sessions.length > 0 ? visibleSessions?.map((session) => {
                        const activeSession = activeWorkspace && session.path === rpcState?.sessionFile;
                        const opening = session.path === openingSessionPath;
                        return (
                          <button
                            className={`sidebar-session-row ${activeSession ? "active" : ""} ${opening ? "loading" : ""}`}
                            key={session.path}
                            type="button"
                            aria-current={activeSession ? "page" : undefined}
                            aria-busy={opening || undefined}
                            disabled={Boolean(openingSessionPath) && !opening}
                            onClick={() => activeSession || opening ? undefined : onSelectSession(path, session)}
                            title={sessionTitle(session)}
                          >
                            <span>{sessionTitle(session)}</span>
                            {opening ? (
                              <CircleNotch className="spin session-loading-icon" size={12} aria-label="Opening session" />
                            ) : (
                              <time className="tabular" dateTime={session.modified}>{relativeSessionTime(session.modified)}</time>
                            )}
                          </button>
                        );
                      }) : (
                        <div className="sidebar-empty-sessions">No saved sessions</div>
                      )}
                      {sessions && sessions.length > COLLAPSED_SESSION_COUNT ? (
                        <button
                          className="sidebar-show-more"
                          type="button"
                          onClick={() => toggleAllSessions(path)}
                        >
                          {showAll ? "Show less" : "Show more"}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      </aside>
    </>
  );
}
