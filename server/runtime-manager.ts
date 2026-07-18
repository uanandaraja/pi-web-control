import type { AppConfig } from "./config";
import { PiRpcProcess, type JsonObject, type PiBridgeStatus } from "./pi-rpc-process";

export type RuntimeSnapshot = JsonObject & {
  id: string;
  workspace: string;
  status: PiBridgeStatus;
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
  pendingUiRequest?: JsonObject;
  error?: string;
};

type Runtime = {
  id: string;
  pi: PiRpcProcess;
  snapshot: RuntimeSnapshot;
  targetSessionPath?: string;
};

type RuntimeEvent =
  | { type: "runtime_snapshot"; runtime: RuntimeSnapshot }
  | { type: "runtime_removed"; runtimeId: string }
  | { type: "runtime_event"; runtimeId: string; event: JsonObject };

export class RuntimeManager {
  private readonly runtimes = new Map<string, Runtime>();

  constructor(
    private readonly config: AppConfig,
    private readonly emit: (event: RuntimeEvent) => void,
  ) {}

  list(): RuntimeSnapshot[] {
    return [...this.runtimes.values()]
      .map((runtime) => runtime.snapshot)
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt);
  }

  get(runtimeId: string): RuntimeSnapshot | undefined {
    return this.runtimes.get(runtimeId)?.snapshot;
  }

  async create(workspace: string, sessionPath?: string): Promise<RuntimeSnapshot> {
    const existing = sessionPath
      ? [...this.runtimes.values()].find((runtime) =>
          runtime.targetSessionPath === sessionPath || runtime.snapshot.sessionFile === sessionPath)
      : undefined;
    if (existing) return existing.snapshot;

    const id = crypto.randomUUID();
    const runtimeConfig = { ...this.config, workspace };
    const pi = new PiRpcProcess(runtimeConfig);
    const runtime: Runtime = {
      id,
      pi,
      targetSessionPath: sessionPath,
      snapshot: {
        id,
        workspace,
        status: "stopped",
        isStreaming: false,
        lastActiveAt: Date.now(),
        ...(sessionPath ? { sessionFile: sessionPath } : {}),
      },
    };

    this.runtimes.set(id, runtime);
    pi.subscribe((event) => this.handleEvent(runtime, event));
    this.publish(runtime);

    try {
      await pi.start();
      if (sessionPath) {
        const response = await pi.request({ type: "switch_session", sessionPath });
        if (response.success === false) throw new Error(String(response.error ?? "Could not open session"));
        if (typeof response.data === "object" && response.data !== null && "cancelled" in response.data && response.data.cancelled === true) {
          throw new Error("Session switch was cancelled");
        }
      }
      await this.refreshState(runtime);
      return runtime.snapshot;
    } catch (error) {
      await runtime.pi.stop().catch(() => undefined);
      runtime.snapshot = {
        ...runtime.snapshot,
        status: "error",
        isStreaming: false,
        pid: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
      this.publish(runtime);
      throw error;
    }
  }

  send(runtimeId: string, command: JsonObject): void {
    const runtime = this.require(runtimeId);
    runtime.snapshot = {
      ...runtime.snapshot,
      lastActiveAt: Date.now(),
      ...(command.type === "extension_ui_response"
        ? { needsInput: false, pendingUiRequest: undefined, activity: runtime.snapshot.isStreaming ? "Thinking" : undefined }
        : {}),
    };
    runtime.pi.send(command);
    this.publish(runtime);
  }

  async restart(runtimeId: string): Promise<RuntimeSnapshot> {
    const runtime = this.require(runtimeId);
    const sessionPath = runtime.snapshot.sessionFile ?? runtime.targetSessionPath;
    try {
      await runtime.pi.restart();
      if (sessionPath) {
        const response = await runtime.pi.request({ type: "switch_session", sessionPath });
        if (response.success === false) throw new Error(String(response.error ?? "Could not restore session"));
      }
      await this.refreshState(runtime);
      return runtime.snapshot;
    } catch (error) {
      await runtime.pi.stop().catch(() => undefined);
      runtime.snapshot = {
        ...runtime.snapshot,
        status: "error",
        isStreaming: false,
        pid: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
      this.publish(runtime);
      throw error;
    }
  }

  async stop(runtimeId: string): Promise<void> {
    const runtime = this.require(runtimeId);
    await runtime.pi.stop();
  }

  async remove(runtimeId: string): Promise<void> {
    const runtime = this.require(runtimeId);
    await runtime.pi.stop();
    this.runtimes.delete(runtimeId);
    this.emit({ type: "runtime_removed", runtimeId });
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.pi.stop()));
  }

  private require(runtimeId: string): Runtime {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new Error("Session runtime was not found");
    return runtime;
  }

  private handleEvent(runtime: Runtime, event: JsonObject): void {
    let changed = false;

    switch (event.type) {
      case "bridge_status": {
        runtime.snapshot = {
          ...runtime.snapshot,
          status: typeof event.status === "string" ? event.status as PiBridgeStatus : runtime.snapshot.status,
          pid: typeof event.pid === "number" ? event.pid : undefined,
          error: typeof event.message === "string" ? event.message : undefined,
        };
        changed = true;
        break;
      }
      case "agent_start": {
        runtime.snapshot = { ...runtime.snapshot, isStreaming: true, activity: "Thinking", lastActiveAt: Date.now() };
        changed = true;
        break;
      }
      case "agent_settled": {
        runtime.snapshot = {
          ...runtime.snapshot,
          isStreaming: false,
          activity: runtime.snapshot.needsInput ? "Needs input" : undefined,
          lastActiveAt: Date.now(),
        };
        changed = true;
        void this.refreshState(runtime);
        break;
      }
      case "tool_execution_start": {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        runtime.snapshot = { ...runtime.snapshot, activity: `Running ${toolName}`, lastActiveAt: Date.now() };
        changed = true;
        break;
      }
      case "tool_execution_end": {
        runtime.snapshot = { ...runtime.snapshot, activity: runtime.snapshot.isStreaming ? "Thinking" : undefined, lastActiveAt: Date.now() };
        changed = true;
        break;
      }
      case "extension_ui_request": {
        if (["confirm", "select", "input", "editor"].includes(String(event.method))) {
          runtime.snapshot = {
            ...runtime.snapshot,
            needsInput: true,
            pendingUiRequest: event,
            activity: "Needs input",
            lastActiveAt: Date.now(),
          };
          changed = true;
        }
        break;
      }
      case "response": {
        if (event.command === "get_state" && event.success !== false) changed = this.applyState(runtime, event.data) || changed;
        if ((event.command === "new_session" || event.command === "switch_session") && event.success !== false) {
          void this.refreshState(runtime);
        }
        break;
      }
    }

    this.emit({ type: "runtime_event", runtimeId: runtime.id, event });
    if (changed) this.publish(runtime);
  }

  private applyState(runtime: Runtime, value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    const state = value as JsonObject;
    runtime.snapshot = {
      ...runtime.snapshot,
      ...(typeof state.sessionFile === "string" || state.sessionFile === null ? { sessionFile: state.sessionFile } : {}),
      ...(typeof state.sessionId === "string" ? { sessionId: state.sessionId } : {}),
      ...(typeof state.sessionName === "string" ? { sessionName: state.sessionName } : {}),
      ...(typeof state.messageCount === "number" ? { messageCount: state.messageCount } : {}),
      ...(typeof state.pendingMessageCount === "number" ? { pendingMessageCount: state.pendingMessageCount } : {}),
      ...(typeof state.isStreaming === "boolean" ? { isStreaming: state.isStreaming } : {}),
    };
    runtime.targetSessionPath = typeof state.sessionFile === "string" ? state.sessionFile : runtime.targetSessionPath;
    return true;
  }

  private async refreshState(runtime: Runtime): Promise<void> {
    if (runtime.snapshot.status !== "running") return;
    try {
      const response = await runtime.pi.request({ type: "get_state" });
      if (response.success !== false && this.applyState(runtime, response.data)) this.publish(runtime);
    } catch {
      // A concurrent stop or restart will publish the authoritative bridge status.
    }
  }

  private publish(runtime: Runtime): void {
    this.emit({ type: "runtime_snapshot", runtime: runtime.snapshot });
  }
}
