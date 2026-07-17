import type { AppConfig } from "./config";

export type JsonObject = Record<string, unknown>;
export type PiBridgeStatus = "starting" | "running" | "stopped" | "error";

type PiChild = ReturnType<typeof spawnPi>;

function spawnPi(config: AppConfig) {
  const args = ["--mode", "rpc"];

  if (config.piProvider) args.push("--provider", config.piProvider);
  if (config.piModel) args.push("--model", config.piModel);
  if (config.sessionDir) args.push("--session-dir", config.sessionDir);
  if (config.noSession) args.push("--no-session");

  return Bun.spawn({
    cmd: [config.piCommand, ...args],
    cwd: config.workspace,
    env: process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

export interface BridgeSnapshot extends JsonObject {
  type: "bridge_status";
  status: PiBridgeStatus;
  workspace: string;
  pid?: number;
  message?: string;
}

export class PiRpcProcess {
  private child: PiChild | null = null;
  private status: PiBridgeStatus = "stopped";
  private statusMessage: string | undefined;
  private readonly listeners = new Set<(message: JsonObject) => void>();

  constructor(private readonly config: AppConfig) {}

  subscribe(listener: (message: JsonObject) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): BridgeSnapshot {
    return {
      type: "bridge_status",
      status: this.status,
      workspace: this.config.workspace,
      ...(this.child ? { pid: this.child.pid } : {}),
      ...(this.statusMessage ? { message: this.statusMessage } : {}),
    };
  }

  async start(): Promise<void> {
    if (this.child) return;

    this.setStatus("starting");
    try {
      const child = spawnPi(this.config);
      this.child = child;
      this.setStatus("running");

      void this.readJsonLines(child.stdout);
      void this.readStderr(child.stderr);
      void this.watchExit(child);
    } catch (error) {
      this.child = null;
      this.setStatus("error", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.setStatus("stopped");
      return;
    }

    this.status = "stopped";
    this.statusMessage = undefined;
    this.child = null;
    child.stdin.end();
    child.kill("SIGTERM");
    await child.exited;
    this.emit(this.snapshot());
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  send(command: JsonObject): void {
    if (!this.child || this.status !== "running") {
      throw new Error("Pi is not running");
    }

    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    this.child.stdin.flush();
  }

  private setStatus(status: PiBridgeStatus, message?: string): void {
    this.status = status;
    this.statusMessage = message;
    this.emit(this.snapshot());
  }

  private emit(message: JsonObject): void {
    for (const listener of this.listeners) listener(message);
  }

  private async watchExit(child: PiChild): Promise<void> {
    const exitCode = await child.exited;
    if (this.child !== child) return;

    this.child = null;
    const expected = this.status === "stopped";
    this.setStatus(expected ? "stopped" : "error", expected ? undefined : `Pi exited with code ${exitCode}`);
  }

  private async readJsonLines(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;

        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > 0) this.parseLine(line);
      }
    }

    buffer += decoder.decode();
    if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
    if (buffer.length > 0) this.parseLine(buffer);
  }

  private parseLine(line: string): void {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        this.emit(value as JsonObject);
      }
    } catch {
      this.emit({
        type: "bridge_log",
        level: "warning",
        message: "Pi emitted a non-JSON stdout record",
        detail: line.slice(0, 500),
      });
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) this.emit({ type: "bridge_log", level: "error", message: line });
      }
    }

    const finalLine = `${buffer}${decoder.decode()}`.trim();
    if (finalLine) this.emit({ type: "bridge_log", level: "error", message: finalLine });
  }
}
