import {
  ArrowRight,
  ArrowsClockwise,
  FolderSimple,
  GearSix,
  Plus,
  X,
} from "@phosphor-icons/react";
import { type FormEvent, useEffect, useState } from "react";
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
  sessions: SessionSummary[];
  onClose: () => void;
  onSelectSession: (session: SessionSummary) => void;
  onNewSession: () => void;
  onRestart: () => void;
  onOpenSettings: () => void;
  onAddWorkspace: (path: string) => void;
  onSelectWorkspace: (path: string) => void;
}

function basename(path?: string): string {
  if (!path) return "No workspace";
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

const COLLAPSED_SESSION_COUNT = 5;

export function Sidebar({
  open,
  bridgeStatus,
  connectionStatus,
  workspace,
  workspaces,
  workspaceSwitching,
  rpcState,
  sessions,
  onClose,
  onSelectSession,
  onNewSession,
  onRestart,
  onOpenSettings,
  onAddWorkspace,
  onSelectWorkspace,
}: SidebarProps) {
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [showAllSessions, setShowAllSessions] = useState(false);
  const workspaceControlsDisabled = connectionStatus !== "open" || workspaceSwitching || rpcState?.isStreaming === true;
  const visibleSessions = showAllSessions ? sessions : sessions.slice(0, COLLAPSED_SESSION_COUNT);

  useEffect(() => {
    setShowAllSessions(false);
  }, [workspace]);

  function submitWorkspace(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const path = workspacePath.trim();
    if (!path || workspaceControlsDisabled) return;
    onAddWorkspace(path);
    setWorkspacePath("");
    setAddingWorkspace(false);
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
              <button type="submit" disabled={!workspacePath.trim()} aria-label="Use workspace">
                <ArrowRight size={13} weight="bold" />
              </button>
            </form>
          ) : null}
          <div className="workspace-list">
            {workspaces.map((path) => {
              const activeWorkspace = path === workspace;
              return (
                <div className={`workspace-group ${activeWorkspace ? "active" : ""}`} key={path}>
                  <button
                    className={`workspace-row ${activeWorkspace ? "active" : ""}`}
                    type="button"
                    disabled={workspaceControlsDisabled}
                    aria-current={activeWorkspace ? "true" : undefined}
                    onClick={() => activeWorkspace ? undefined : onSelectWorkspace(path)}
                    title={path}
                  >
                    <FolderSimple size={15} />
                    <strong>{basename(path)}</strong>
                  </button>
                  {activeWorkspace ? (
                    <div className="sidebar-session-list">
                      {sessions.length > 0 ? visibleSessions.map((session) => {
                        const activeSession = session.path === rpcState?.sessionFile;
                        return (
                          <button
                            className={`sidebar-session-row ${activeSession ? "active" : ""}`}
                            key={session.path}
                            type="button"
                            aria-current={activeSession ? "page" : undefined}
                            onClick={() => activeSession ? undefined : onSelectSession(session)}
                            title={sessionTitle(session)}
                          >
                            <span>{sessionTitle(session)}</span>
                            <time className="tabular" dateTime={session.modified}>{relativeSessionTime(session.modified)}</time>
                          </button>
                        );
                      }) : (
                        <div className="sidebar-empty-sessions">No saved sessions</div>
                      )}
                      {sessions.length > COLLAPSED_SESSION_COUNT ? (
                        <button
                          className="sidebar-show-more"
                          type="button"
                          onClick={() => setShowAllSessions((current) => !current)}
                        >
                          {showAllSessions ? "Show less" : "Show more"}
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
