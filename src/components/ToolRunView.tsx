import {
  BookOpen,
  FilePlus,
  FolderOpen,
  Globe,
  MagnifyingGlass,
  PencilSimpleLine,
  TerminalWindow,
  Wrench,
} from "@phosphor-icons/react";
import type { ToolRun } from "../types";

type ToolKind = "read" | "search" | "list" | "edit" | "write" | "command" | "web" | "other";

interface ToolPresentation {
  kind: ToolKind;
  verb: string;
  detail?: string;
  target?: string;
  context?: string;
}

function stringArg(tool: ToolRun, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = tool.args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function compact(value: string, maximum = 100): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

function compactPath(path: string): string {
  if (path === "." || path === "./") return "workspace";
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  return normalized.split("/").filter(Boolean).at(-1) || path;
}

function presentTool(tool: ToolRun): ToolPresentation {
  const name = tool.name.toLowerCase();
  const path = stringArg(tool, "path", "filePath", "file", "cwd", "directory");

  if (["read", "read_file", "cat"].includes(name)) {
    return { kind: "read", verb: "Read", target: path ? compactPath(path) : "file" };
  }
  if (["find", "grep", "search", "ripgrep", "rg"].includes(name)) {
    const query = stringArg(tool, "pattern", "query", "search", "needle") ?? "matches";
    return {
      kind: "search",
      verb: "Searched for",
      detail: compact(query),
      context: path ? compactPath(path) : "workspace",
    };
  }
  if (["ls", "list", "list_files"].includes(name)) {
    return { kind: "list", verb: "Listed", target: path ? compactPath(path) : "workspace" };
  }
  if (["edit", "apply_patch", "patch", "replace"].includes(name)) {
    return { kind: "edit", verb: "Edited", target: path ? compactPath(path) : "files" };
  }
  if (["write", "write_file", "create_file"].includes(name)) {
    return { kind: "write", verb: "Wrote", target: path ? compactPath(path) : "file" };
  }
  if (["bash", "shell", "exec", "exec_command", "run"].includes(name)) {
    return { kind: "command", verb: "Ran", detail: compact(stringArg(tool, "command", "cmd", "script") ?? "command") };
  }
  if (["open", "fetch", "web", "browse", "navigate"].includes(name)) {
    const url = stringArg(tool, "url", "uri", "href") ?? path ?? "page";
    return { kind: "web", verb: "Opened", target: compact(url) };
  }

  const fallbackTarget = Object.entries(tool.args).find(([key, value]) => key !== "reasoning" && typeof value === "string" && value.trim());
  return {
    kind: "other",
    verb: tool.name.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()),
    ...(fallbackTarget ? { target: compact(String(fallbackTarget[1])) } : {}),
  };
}

function ToolIcon({ kind }: { kind: ToolKind }) {
  if (kind === "read") return <BookOpen size={15} />;
  if (kind === "search") return <MagnifyingGlass size={15} />;
  if (kind === "list") return <FolderOpen size={15} />;
  if (kind === "edit") return <PencilSimpleLine size={15} />;
  if (kind === "write") return <FilePlus size={15} />;
  if (kind === "command") return <TerminalWindow size={15} />;
  if (kind === "web") return <Globe size={15} />;
  return <Wrench size={15} />;
}

export function ToolRunView({ tool }: { tool: ToolRun }) {
  const presentation = presentTool(tool);
  const statusLabel = tool.status === "running" ? "running" : tool.status === "error" ? "failed" : "completed";

  return (
    <div className={`tool-run tool-${tool.status}`} aria-label={`${presentation.verb}, ${statusLabel}`}>
      <span className="tool-icon" aria-hidden="true">
        <ToolIcon kind={presentation.kind} />
      </span>
      <span className="tool-copy">
        <span>{presentation.verb}</span>
        {presentation.detail ? <span className={presentation.kind === "command" ? "tool-command" : "tool-detail"}>{presentation.detail}</span> : null}
        {presentation.target ? <span className="tool-target" title={presentation.target}>{presentation.target}</span> : null}
        {presentation.context ? (
          <>
            <span>in</span>
            <span className="tool-target" title={presentation.context}>{presentation.context}</span>
          </>
        ) : null}
      </span>
    </div>
  );
}
