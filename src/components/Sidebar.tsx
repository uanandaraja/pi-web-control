import {
  ArrowsClockwise,
  FolderSimple,
  Plus,
  X,
} from "@phosphor-icons/react";
import { relativeSessionTime, sessionTitle } from "../lib/sessions";
import type { BridgeStatus, ConnectionStatus, RpcState, SessionSummary } from "../types";

interface SidebarProps {
  open: boolean;
  bridgeStatus: BridgeStatus;
  connectionStatus: ConnectionStatus;
  workspace?: string;
  rpcState: RpcState | null;
  sessions: SessionSummary[];
  onClose: () => void;
  onSelectSession: (session: SessionSummary) => void;
  onNewSession: () => void;
  onRestart: () => void;
}

function basename(path?: string): string {
  if (!path) return "No workspace";
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function Sidebar({
  open,
  bridgeStatus,
  connectionStatus,
  workspace,
  rpcState,
  sessions,
  onClose,
  onSelectSession,
  onNewSession,
  onRestart,
}: SidebarProps) {
  return (
    <>
      <button className={`sidebar-backdrop ${open ? "visible" : ""}`} type="button" onClick={onClose} aria-label="Close sidebar" />
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="sidebar-close-row">
          <button className="icon-button sidebar-close" type="button" onClick={onClose} aria-label="Close sidebar">
            <X size={18} />
          </button>
        </div>

        <nav className="sidebar-actions" aria-label="Session actions">
          <button type="button" onClick={onNewSession} disabled={bridgeStatus !== "running"}>
            <Plus size={16} />
            New session
          </button>
          <button type="button" onClick={onRestart} disabled={connectionStatus !== "open"}>
            <ArrowsClockwise size={16} />
            Restart Pi
          </button>
        </nav>

        <section className="sidebar-tree" aria-labelledby="workspace-heading">
          <div className="sidebar-section-heading">
            <h2 id="workspace-heading">Workspace</h2>
            <span className="tabular">{sessions.length}</span>
          </div>
          <div className="workspace-row">
            <FolderSimple size={15} />
            <strong title={workspace}>{basename(workspace)}</strong>
          </div>
          <div className="sidebar-session-list">
            {sessions.length > 0 ? sessions.map((session) => {
              const active = session.path === rpcState?.sessionFile;
              return (
                <button
                  className={`sidebar-session-row ${active ? "active" : ""}`}
                  key={session.path}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => active ? undefined : onSelectSession(session)}
                  title={sessionTitle(session)}
                >
                  <span>{sessionTitle(session)}</span>
                  <time className="tabular" dateTime={session.modified}>{relativeSessionTime(session.modified)}</time>
                </button>
              );
            }) : (
              <div className="sidebar-empty-sessions">No saved sessions</div>
            )}
          </div>
        </section>
      </aside>
    </>
  );
}
