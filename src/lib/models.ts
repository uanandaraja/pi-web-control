import type { ModelInfo, ThinkingLevel } from "../types";

export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function modelKey(model: Pick<ModelInfo, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function modelLabel(model?: ModelInfo | null): string {
  return model?.name?.trim() || model?.id || "Choose model";
}

export function supportedThinkingLevels(model?: ModelInfo | null): ThinkingLevel[] {
  if (!model?.reasoning) return ["off"];

  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}
