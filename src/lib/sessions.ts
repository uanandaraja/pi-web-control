import type { SessionSummary } from "../types";

export function sessionTitle(session: SessionSummary): string {
  return session.name?.trim() || session.firstMessage.trim() || "Empty session";
}

export function relativeSessionTime(value: string): string {
  const timestamp = new Date(value).getTime();
  const elapsed = Date.now() - timestamp;
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
}
