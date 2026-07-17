import { CaretDown } from "@phosphor-icons/react";
import type { ToolRun } from "../types";
import { ToolRunView } from "./ToolRunView";

interface ToolWorkSummaryProps {
  tools: ToolRun[];
  startedAt: number;
  completedAt: number;
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;

  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function ToolWorkSummary({ tools, startedAt, completedAt }: ToolWorkSummaryProps) {
  const elapsed = formatDuration(completedAt - startedAt);
  const toolLabel = `${tools.length} tool ${tools.length === 1 ? "call" : "calls"}`;

  return (
    <section className="work-summary" aria-label={`Worked for ${elapsed}, ${toolLabel}`}>
      <details className="work-summary-disclosure">
        <summary title={toolLabel}>
          <span>Worked for {elapsed}</span>
          <CaretDown className="work-summary-caret" size={13} aria-hidden="true" />
        </summary>
        <div className="work-summary-items">
          {tools.map((tool) => <ToolRunView key={tool.id} tool={tool} />)}
        </div>
      </details>
      <div className="work-summary-divider" aria-hidden="true" />
    </section>
  );
}
