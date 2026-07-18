export type ConnectionStatus = "connecting" | "open" | "closed" | "error";
export type BridgeStatus = "starting" | "running" | "stopped" | "error";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type RuntimeSnapshot = {
  id: string;
  workspace: string;
  status: BridgeStatus;
  isStreaming: boolean;
  lastActiveAt: number;
  pid?: number;
  sessionFile?: string | null;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  pendingMessageCount?: number;
  activity?: string;
  needsInput?: boolean;
  pendingUiRequest?: ExtensionRequest;
  error?: string;
};

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ImageBlock {
  type: "image";
  data?: string;
  mimeType?: string;
}

export interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PromptFile {
  name: string;
  data: string;
  mimeType: string;
}

export interface PromptSubmission {
  message: string;
  images: PromptImage[];
  files: PromptFile[];
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ImageBlock | Record<string, unknown>;

export interface AgentMessage {
  role: "user" | "assistant" | "toolResult" | "bashExecution" | string;
  content?: string | ContentBlock[];
  timestamp?: number;
  stopReason?: string;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
  [key: string]: unknown;
}

export interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  contextWindow?: number;
}

export interface RpcState {
  model: ModelInfo | null;
  thinkingLevel?: ThinkingLevel;
  isStreaming: boolean;
  isCompacting?: boolean;
  sessionFile?: string | null;
  sessionId?: string;
  sessionName?: string;
  messageCount: number;
  pendingMessageCount?: number;
}

export interface SessionStats {
  cost?: number;
  toolCalls?: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

export interface SessionSummary {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

export interface ToolRun {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  startedAt?: number;
  completedAt?: number;
}

export interface ExtensionRequest {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
}

export type ServerEvent = Record<string, unknown> & { type: string };
