import { resolve } from "node:path";

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true" || value === "1";
}

function readPort(value: string | undefined): number {
  if (value === undefined) return 8787;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PI_WEB_PORT: ${value}`);
  }
  return port;
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const host = process.env.PI_WEB_HOST ?? "127.0.0.1";
  const token = process.env.PI_WEB_TOKEN?.trim() || undefined;

  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && token === undefined) {
    throw new Error("PI_WEB_TOKEN is required when PI_WEB_HOST is not a loopback address");
  }

  return {
    host,
    port: readPort(process.env.PI_WEB_PORT),
    token,
    allowedOrigin: process.env.PI_WEB_ORIGIN?.trim() || undefined,
    workspace: resolve(process.env.PI_WORKSPACE ?? process.cwd()),
    piCommand: process.env.PI_COMMAND?.trim() || "pi",
    piProvider: process.env.PI_PROVIDER?.trim() || undefined,
    piModel: process.env.PI_MODEL?.trim() || undefined,
    sessionDir: process.env.PI_SESSION_DIR?.trim() || undefined,
    noSession: readBoolean(process.env.PI_NO_SESSION, false),
    autoStart: readBoolean(process.env.PI_AUTO_START, true),
  };
}
