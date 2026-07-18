import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ServerWebSocket } from "bun";
import { loadConfig } from "./config";
import type { JsonObject } from "./pi-rpc-process";
import { RuntimeManager } from "./runtime-manager";

type SocketData = {
  id: string;
  authenticated: boolean;
  address: string;
};

const config = loadConfig();
const appRoot = resolve(import.meta.dir, "..");
const distRoot = resolve(appRoot, "dist");
const attachmentRoot = resolve(tmpdir(), "pi-web-control", String(process.pid));
const clients = new Set<ServerWebSocket<SocketData>>();
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ATTACHMENT_CONTEXT_START = "<pi_web_control_attachment_context>";
const ATTACHMENT_CONTEXT_END = "</pi_web_control_attachment_context>";

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...init?.headers,
    },
  });
}

function send(socket: ServerWebSocket<SocketData>, message: JsonObject): void {
  socket.send(JSON.stringify(message));
}

function broadcast(message: JsonObject): void {
  const serialized = JSON.stringify(sanitizePiMessage(message));
  for (const client of clients) {
    if (client.data.authenticated) client.send(serialized);
  }
}

function sanitizeModel(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null) return null;
  const model = value as JsonObject;
  if (typeof model.id !== "string" || typeof model.provider !== "string") return null;

  const rawThinkingMap = model.thinkingLevelMap;
  const thinkingLevelMap: JsonObject = {};
  if (typeof rawThinkingMap === "object" && rawThinkingMap !== null) {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const mapped = (rawThinkingMap as JsonObject)[level];
      if (typeof mapped === "string" || mapped === null) thinkingLevelMap[level] = mapped;
    }
  }

  return {
    id: model.id,
    provider: model.provider,
    ...(typeof model.name === "string" ? { name: model.name } : {}),
    reasoning: model.reasoning === true,
    ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
    ...(Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
  };
}

function stripAttachmentContext(value: string): string {
  const startIndex = value.indexOf(`\n\n${ATTACHMENT_CONTEXT_START}`);
  if (startIndex === -1) return value;
  const endIndex = value.indexOf(ATTACHMENT_CONTEXT_END, startIndex);
  if (endIndex === -1) return value.slice(0, startIndex);
  return `${value.slice(0, startIndex)}${value.slice(endIndex + ATTACHMENT_CONTEXT_END.length)}`;
}

function sanitizeAgentMessage(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const agentMessage = value as JsonObject;
  if (agentMessage.role !== "user") return value;

  if (typeof agentMessage.content === "string") {
    return { ...agentMessage, content: stripAttachmentContext(agentMessage.content) };
  }
  if (!Array.isArray(agentMessage.content)) return value;

  return {
    ...agentMessage,
    content: agentMessage.content.map((block) => {
      if (typeof block !== "object" || block === null || Array.isArray(block)) return block;
      const contentBlock = block as JsonObject;
      return contentBlock.type === "text" && typeof contentBlock.text === "string"
        ? { ...contentBlock, text: stripAttachmentContext(contentBlock.text) }
        : block;
    }),
  };
}

function sanitizePiMessage(message: JsonObject): JsonObject {
  let sanitized = message;

  if ("message" in sanitized) {
    const agentMessage = sanitizeAgentMessage(sanitized.message);
    if (agentMessage !== sanitized.message) sanitized = { ...sanitized, message: agentMessage };
  }

  if (sanitized.type !== "response") return sanitized;
  const data = sanitized.data;
  if (sanitized.command === "get_messages" && typeof data === "object" && data !== null && "messages" in data && Array.isArray(data.messages)) {
    sanitized = { ...sanitized, data: { ...data, messages: data.messages.map(sanitizeAgentMessage) } };
  }
  if (sanitized.command === "get_available_models" && typeof data === "object" && data !== null && "models" in data && Array.isArray(data.models)) {
    return { ...sanitized, data: { models: data.models.flatMap((value) => sanitizeModel(value) ?? []) } };
  }
  if (sanitized.command === "get_state" && typeof data === "object" && data !== null && "model" in data) {
    return { ...sanitized, data: { ...data, model: sanitizeModel(data.model) } };
  }
  if (sanitized.command === "set_model") {
    return { ...sanitized, data: sanitizeModel(data) };
  }
  if (sanitized.command === "cycle_model" && typeof data === "object" && data !== null && "model" in data) {
    return { ...sanitized, data: { ...data, model: sanitizeModel(data.model) } };
  }
  return sanitized;
}

function decodeAttachment(value: unknown, label: string): Buffer {
  if (typeof value !== "string") throw new Error(`${label} is missing attachment data`);
  const unpadded = value.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(unpadded)) throw new Error(`${label} has invalid attachment data`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== unpadded) {
    throw new Error(`${label} has invalid attachment data`);
  }
  if (decoded.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`${label} is larger than 5 MB`);
  return decoded;
}

function safeAttachmentName(value: unknown): string {
  const original = typeof value === "string" && value.trim() ? value.trim() : "attachment";
  const safe = basename(original).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return safe || "attachment";
}

async function preparePrompt(message: JsonObject): Promise<JsonObject> {
  if (message.type !== "prompt") return message;

  const images = message.images === undefined ? [] : message.images;
  const files = message.files === undefined ? [] : message.files;
  if (!Array.isArray(images)) throw new Error("Prompt images must be an array");
  if (!Array.isArray(files)) throw new Error("Prompt files must be an array");
  if (images.length + files.length > MAX_ATTACHMENTS) {
    throw new Error(`You can attach up to ${MAX_ATTACHMENTS} files`);
  }

  let totalBytes = 0;
  const validatedImages = images.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Image ${index + 1} is invalid`);
    }
    const image = value as JsonObject;
    if (image.type !== "image" || typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) {
      throw new Error(`Image ${index + 1} has an invalid type`);
    }
    const data = decodeAttachment(image.data, `Image ${index + 1}`);
    totalBytes += data.byteLength;
    return { type: "image", data: data.toString("base64"), mimeType: image.mimeType };
  });

  const stagedFiles: Array<{ name: string; path: string; mimeType: string }> = [];
  if (files.length > 0) await mkdir(attachmentRoot, { recursive: true, mode: 0o700 });

  for (let index = 0; index < files.length; index += 1) {
    const value = files[index];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`File ${index + 1} is invalid`);
    }
    const file = value as JsonObject;
    const name = safeAttachmentName(file.name);
    const data = decodeAttachment(file.data, name);
    totalBytes += data.byteLength;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("Attachments can total up to 8 MB");

    const mimeType = typeof file.mimeType === "string" && file.mimeType.trim()
      ? file.mimeType.trim().slice(0, 160)
      : "application/octet-stream";
    const path = resolve(attachmentRoot, `${crypto.randomUUID()}-${name}`);
    if (!path.startsWith(`${attachmentRoot}${sep}`)) throw new Error("Could not create a safe attachment path");
    await writeFile(path, data, { mode: 0o600 });
    stagedFiles.push({ name, path, mimeType });
  }

  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("Attachments can total up to 8 MB");

  const { files: _files, ...rpcMessage } = message;
  if (validatedImages.length > 0) rpcMessage.images = validatedImages;
  if (stagedFiles.length === 0) return rpcMessage;

  const originalMessage = typeof message.message === "string" && message.message.trim()
    ? message.message
    : "Please inspect the attached files.";
  const attachmentContext = [
    ATTACHMENT_CONTEXT_START,
    "The user attached files that were uploaded to the local host. Use the appropriate tools to inspect them:",
    ...stagedFiles.map((file) => `- ${JSON.stringify(file.name)} (${JSON.stringify(file.mimeType)}): ${JSON.stringify(file.path)}`),
    ATTACHMENT_CONTEXT_END,
  ].join("\n");

  return { ...rpcMessage, message: `${originalMessage}\n\n${attachmentContext}` };
}

async function resolveWorkspacePath(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim()) throw new Error("Enter a workspace path");

  const input = value.trim();
  const expanded = input === "~"
    ? homedir()
    : input.startsWith("~/")
      ? resolve(homedir(), input.slice(2))
      : input;
  const candidate = isAbsolute(expanded) ? resolve(expanded) : resolve(config.workspace, expanded);

  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw new Error(`Workspace does not exist: ${candidate}`);
  }

  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) throw new Error(`Workspace is not a directory: ${canonical}`);
  return canonical;
}

const runtimes = new RuntimeManager(config, (message) => {
  if (message.type === "runtime_event") {
    broadcast({ ...message, event: sanitizePiMessage(message.event) });
    return;
  }
  broadcast(message as unknown as JsonObject);
});

function matchesToken(candidate: unknown): boolean {
  if (!config.token || typeof candidate !== "string") return config.token === undefined;
  const expected = createHash("sha256").update(config.token).digest();
  const received = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(expected, received);
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (config.allowedOrigin) return origin === config.allowedOrigin;

  try {
    const hostname = new URL(origin).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

async function serveStatic(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const relativePath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = resolve(distRoot, relativePath);
  const insideDist = filePath === distRoot || filePath.startsWith(`${distRoot}${sep}`);

  if (!insideDist) return new Response("Forbidden", { status: 403 });

  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file, {
      headers: {
        "Cache-Control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    });
  }

  if (request.headers.get("accept")?.includes("text/html")) {
    const index = Bun.file(resolve(distRoot, "index.html"));
    if (await index.exists()) return new Response(index, { headers: { "Cache-Control": "no-cache" } });
  }

  return new Response("Not found", { status: 404 });
}

function parseSocketMessage(message: string | BufferSource): JsonObject | null {
  const text = typeof message === "string" ? message : new TextDecoder().decode(message);
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

async function listWorkspaceSessions(workspace: string): Promise<JsonObject[]> {
  const sessions = await SessionManager.list(workspace, config.sessionDir);
  return sessions.slice(0, 100).map((session) => ({
    path: session.path,
    id: session.id,
    cwd: session.cwd,
    name: session.name,
    created: session.created.toISOString(),
    modified: session.modified.toISOString(),
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
  }));
}

const server = Bun.serve<SocketData>({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: 16 * 1024 * 1024,
  async fetch(request, bunServer) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, runtimes: runtimes.list(), authenticationRequired: Boolean(config.token) });
    }

    if (url.pathname === "/ws") {
      if (!originAllowed(request)) return new Response("Origin not allowed", { status: 403 });
      const address = bunServer.requestIP(request)?.address ?? "unknown";
      const upgraded = bunServer.upgrade(request, {
        data: { id: crypto.randomUUID(), authenticated: !config.token, address },
      });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }

    return serveStatic(request);
  },
  websocket: {
    maxPayloadLength: 16 * 1024 * 1024,
    idleTimeout: 120,
    open(socket) {
      clients.add(socket);
      if (socket.data.authenticated) {
        send(socket, { type: "bridge_snapshot", runtimes: runtimes.list() });
      } else {
        send(socket, { type: "bridge_auth_required" });
      }
    },
    async message(socket, rawMessage) {
      let message: JsonObject | null;
      try {
        message = parseSocketMessage(rawMessage);
      } catch {
        send(socket, { type: "bridge_error", message: "Invalid JSON message" });
        return;
      }

      if (!message || typeof message.type !== "string") {
        send(socket, { type: "bridge_error", message: "Messages must be JSON objects with a type" });
        return;
      }

      if (!socket.data.authenticated) {
        if (message.type === "bridge.auth" && matchesToken(message.token)) {
          socket.data.authenticated = true;
          send(socket, { type: "bridge_auth_ok" });
          send(socket, { type: "bridge_snapshot", runtimes: runtimes.list() });
        } else {
          send(socket, { type: "bridge_auth_error", message: "Invalid access token" });
          socket.close(4003, "Authentication failed");
        }
        return;
      }

      const requestId = typeof message.id === "string" ? message.id : undefined;
      try {
        if (message.type === "bridge.ping") {
          send(socket, { type: "bridge_pong", requestId, timestamp: Date.now() });
          return;
        }
        if (message.type === "bridge.list_runtimes") {
          send(socket, { type: "bridge_response", command: "list_runtimes", requestId, success: true, data: { runtimes: runtimes.list() } });
          return;
        }
        if (message.type === "bridge.list_sessions") {
          const workspace = message.workspace === undefined
            ? config.workspace
            : await resolveWorkspacePath(message.workspace);
          const sessions = await listWorkspaceSessions(workspace);
          send(socket, {
            type: "bridge_response",
            command: "list_sessions",
            requestId,
            success: true,
            data: { workspace, sessions },
          });
          return;
        }
        if (message.type === "bridge.create_runtime") {
          const workspace = await resolveWorkspacePath(message.workspace ?? config.workspace);
          const runtime = await runtimes.create(workspace);
          send(socket, { type: "bridge_response", command: "create_runtime", requestId, success: true, data: { runtime } });
          return;
        }
        if (message.type === "bridge.open_session") {
          const workspace = await resolveWorkspacePath(message.workspace);
          if (typeof message.sessionPath !== "string") throw new Error("A session path is required");
          const runtime = await runtimes.create(workspace, message.sessionPath);
          send(socket, { type: "bridge_response", command: "open_session", requestId, success: true, data: { runtime } });
          return;
        }
        if (message.type === "bridge.restart_runtime") {
          if (typeof message.runtimeId !== "string") throw new Error("A runtime ID is required");
          const runtime = await runtimes.restart(message.runtimeId);
          send(socket, { type: "bridge_response", command: "restart_runtime", requestId, success: true, data: { runtime } });
          return;
        }
        if (message.type === "bridge.remove_runtime") {
          if (typeof message.runtimeId !== "string") throw new Error("A runtime ID is required");
          await runtimes.remove(message.runtimeId);
          send(socket, { type: "bridge_response", command: "remove_runtime", requestId, success: true });
          return;
        }
        if (message.type === "runtime.send") {
          if (typeof message.runtimeId !== "string") throw new Error("A runtime ID is required");
          if (typeof message.command !== "object" || message.command === null || Array.isArray(message.command)) {
            throw new Error("A runtime command is required");
          }
          runtimes.send(message.runtimeId, await preparePrompt(message.command as JsonObject));
          return;
        }

        throw new Error(`Unknown command: ${message.type}`);
      } catch (error) {
        send(socket, {
          type: "bridge_response",
          command: message.type.startsWith("bridge.") ? message.type.slice("bridge.".length) : message.type,
          requestId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    close(socket) {
      clients.delete(socket);
    },
  },
});

console.log(`Pi Control server listening on http://${config.host}:${server.port}`);
console.log(`Workspace: ${config.workspace}`);

if (config.autoStart) {
  void runtimes.create(config.workspace).catch((error) => {
    console.error("Could not start Pi:", error);
  });
}

async function shutdown(): Promise<void> {
  await runtimes.stopAll();
  await rm(attachmentRoot, { recursive: true, force: true });
  server.stop(true);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
