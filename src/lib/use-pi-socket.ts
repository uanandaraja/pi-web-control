import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionStatus, ServerEvent } from "../types";

interface PiSocketOptions {
  onEvent: (event: ServerEvent) => void;
}

export function usePiSocket({ onEvent }: PiSocketOptions) {
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | null>(null);
  const manuallyClosedRef = useRef(false);
  const eventHandlerRef = useRef(onEvent);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  eventHandlerRef.current = onEvent;

  const send = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const connect = useCallback(() => {
    if (retryRef.current !== null) window.clearTimeout(retryRef.current);
    const existing = socketRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;

    manuallyClosedRef.current = false;
    setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      if (socketRef.current === socket) setStatus("open");
    });
    socket.addEventListener("message", (event) => {
      try {
        const value: unknown = JSON.parse(String(event.data));
        if (typeof value === "object" && value !== null && "type" in value && typeof value.type === "string") {
          eventHandlerRef.current(value as ServerEvent);
        }
      } catch {
        eventHandlerRef.current({ type: "bridge_error", message: "Received invalid JSON from the bridge" });
      }
    });
    socket.addEventListener("error", () => {
      if (socketRef.current === socket) setStatus("error");
    });
    socket.addEventListener("close", () => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      setStatus("closed");
      if (!manuallyClosedRef.current) {
        retryRef.current = window.setTimeout(connect, 1500);
      }
    });
  }, []);

  useEffect(() => {
    connect();
    return () => {
      manuallyClosedRef.current = true;
      if (retryRef.current !== null) window.clearTimeout(retryRef.current);
      socketRef.current?.close();
    };
  }, [connect]);

  return { status, send, reconnect: connect };
}
