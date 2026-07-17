import type { AgentMessage } from "../types";

export function messageKey(message: AgentMessage, fallback: string): string {
  return `${message.role}-${message.timestamp ?? fallback}`;
}

export function textBlocks(message: AgentMessage): Array<{ type: "text" | "thinking"; text: string }> {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  if (!Array.isArray(message.content)) return [];

  const result: Array<{ type: "text" | "thinking"; text: string }> = [];
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") {
      result.push({ type: "text", text: block.text });
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      result.push({ type: "thinking", text: block.thinking });
    }
  }
  return result;
}
