import { createHash, timingSafeEqual } from "node:crypto";
import { extname, resolve, sep } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ServerWebSocket } from "bun";
import { loadConfig } from "./config";
import { PiRpcProcess, type JsonObject } from "./pi-rpc-process";

interface SocketData {
  id: string;
  authenticated: boolean;
  address: string;
}

const config = loadConfig();
const pi = new PiRpcProcess(config);
const appRoot = resolve(import.meta.dir, "..");
const distRoot = resolve(appRoot, "dist");
const clients = new Set<ServerWebSocket<SocketData>>();

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

function sanitizePiMessage(message: JsonObject): JsonObject {
  if (message.type !== "response") return message;
  const data = message.data;
  if (message.command === "get_available_models" && typeof data === "object" && data !== null && "models" in data && Array.isArray(data.models)) {
    return { ...message, data: { models: data.models.flatMap((value) => sanitizeModel(value) ?? []) } };
  }
  if (message.command === "get_state" && typeof data === "object" && data !== null && "model" in data) {
    return { ...message, data: { ...data, model: sanitizeModel(data.model) } };
  }
  if (message.command === "set_model") {
    return { ...message, data: sanitizeModel(data) };
  }
  if (message.command === "cycle_model" && typeof data === "object" && data !== null && "model" in data) {
    return { ...message, data: { ...data, model: sanitizeModel(data.model) } };
  }
  return message;
}

pi.subscribe(broadcast);

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

async function listWorkspaceSessions(): Promise<JsonObject[]> {
  const sessions = await SessionManager.list(config.workspace, config.sessionDir);
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
      return json({ ok: true, bridge: pi.snapshot(), authenticationRequired: Boolean(config.token) });
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
        send(socket, pi.snapshot());
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
          send(socket, pi.snapshot());
        } else {
          send(socket, { type: "bridge_auth_error", message: "Invalid access token" });
          socket.close(4003, "Authentication failed");
        }
        return;
      }

      const requestId = typeof message.id === "string" ? message.id : undefined;
      try {
        if (message.type === "bridge.start") {
          await pi.start();
          send(socket, { type: "bridge_response", command: "start", requestId, success: true });
          return;
        }
        if (message.type === "bridge.stop") {
          await pi.stop();
          send(socket, { type: "bridge_response", command: "stop", requestId, success: true });
          return;
        }
        if (message.type === "bridge.restart") {
          await pi.restart();
          send(socket, { type: "bridge_response", command: "restart", requestId, success: true });
          return;
        }
        if (message.type === "bridge.ping") {
          send(socket, { type: "bridge_pong", requestId, timestamp: Date.now() });
          return;
        }
        if (message.type === "bridge.list_sessions") {
          const sessions = await listWorkspaceSessions();
          send(socket, {
            type: "bridge_response",
            command: "list_sessions",
            requestId,
            success: true,
            data: { sessions },
          });
          return;
        }

        pi.send(message);
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
  void pi.start().catch((error) => {
    console.error("Could not start Pi:", error);
  });
}

async function shutdown(): Promise<void> {
  await pi.stop();
  server.stop(true);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
