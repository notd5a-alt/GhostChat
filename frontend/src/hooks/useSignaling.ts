import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import type { SignalingState, SignalingMessage, SignalingHook } from "../types";

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_DELAY = 1000; // ms, doubles each attempt, max 30s

export default function useSignaling(url: string | null): SignalingHook {
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef<((msg: SignalingMessage) => void) | null>(null);
  const queueRef = useRef<SignalingMessage[]>([]); // buffer messages arriving before handler is set
  const sendQueueRef = useRef<SignalingMessage[]>([]); // buffer outgoing messages during reconnect
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const urlRef = useRef(url);
  const [state, setState] = useState<SignalingState>("closed");
  const [debugLog, setDebugLog] = useState<string[]>([]);

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setDebugLog((prev) => [...prev.slice(-19), `${ts} ${msg}`]);
  }, []);

  urlRef.current = url;

  const wasEverOpenRef = useRef(false);

  const createSocketRef = useRef<(() => void) | null>(null);
  createSocketRef.current = () => {
    const currentUrl = urlRef.current;
    if (!currentUrl) return;
    if (wsRef.current) return;
    setState(reconnectAttemptRef.current > 0 ? "reconnecting" : "connecting");

    addLog(`WS connecting to ${currentUrl}`);
    const ws = new WebSocket(currentUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Connection state logged via addLog to debug panel
      addLog(`WS open`);
      setState("open");
      wasEverOpenRef.current = true;
      reconnectAttemptRef.current = 0;

      // Flush queued outgoing messages (ICE candidates, etc. sent during reconnect)
      const queued = sendQueueRef.current;
      sendQueueRef.current = [];
      for (const msg of queued) {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          addLog(`WS flush: ${msg.type}`);
          wsRef.current.send(JSON.stringify(msg));
        }
      }
    };
    ws.onclose = (event: CloseEvent) => {
      // Connection state logged via addLog to debug panel
      addLog(`WS closed code=${event.code} reason=${event.reason}`);
      wsRef.current = null;

      // Don't reconnect if we intentionally closed or were replaced by a new
      // connection for the same role (backend sends 4001 on replacement)
      if (intentionalCloseRef.current || event.code === 4001) {
        setState("closed");
        sendQueueRef.current = [];
        return;
      }

      // Only auto-reconnect if the connection was previously open
      // (prevents phantom reconnects from failed initial connections)
      if (wasEverOpenRef.current && reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
        const baseDelay = Math.min(
          BASE_DELAY * Math.pow(2, reconnectAttemptRef.current),
          30000
        );
        // Add ±20% jitter to prevent thundering herd on server restart
        const delay = Math.max(500, baseDelay * (0.8 + Math.random() * 0.4));
        setState("reconnecting");
        reconnectTimerRef.current = setTimeout(() => {
          reconnectAttemptRef.current++;
          createSocketRef.current?.();
        }, delay);
      } else if (!wasEverOpenRef.current) {
        setState("closed");
        sendQueueRef.current = [];
      } else {
        // Max reconnect attempts exhausted — clear stale queued messages
        setState("closed");
        sendQueueRef.current = [];
      }
    };
    ws.onerror = () => {
      addLog(`WS error`);
    };
    ws.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data) as SignalingMessage;
        // Auto-reply to server heartbeat pings — prevents 5min timeout teardown
        if (msg.type === "ping") {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "pong" }));
          }
          return;
        }
        addLog(`WS recv: ${msg.type}`);
        if (onMessageRef.current) {
          onMessageRef.current(msg);
        } else {
          queueRef.current.push(msg);
        }
      } catch {
        addLog(`WS recv: invalid JSON`);
      }
    };
  };

  const connect = useCallback(() => {
    intentionalCloseRef.current = false;
    reconnectAttemptRef.current = 0;
    createSocketRef.current?.();
  }, []);

  const send = useCallback((obj: SignalingMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      addLog(`WS send: ${obj.type}`);
      ws.send(JSON.stringify(obj));
    } else {
      // Queue for retry on reconnect instead of dropping
      sendQueueRef.current.push(obj);
      addLog(`WS send QUEUED (not open): ${obj.type}`);
    }
  }, [addLog]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    wasEverOpenRef.current = false;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    reconnectAttemptRef.current = 0;
    wsRef.current?.close();
    wsRef.current = null;
    queueRef.current = [];
    sendQueueRef.current = [];
    setState("closed");
  }, []);

  const onMessage = useCallback((handler: (msg: SignalingMessage) => void) => {
    onMessageRef.current = handler;
    // Flush any buffered messages
    const queued = queueRef.current;
    queueRef.current = [];
    queued.forEach((msg) => handler(msg));
  }, []);

  useEffect(() => {
    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, []);

  return useMemo(
    () => ({ connect, send, disconnect, onMessage, state, debugLog, addLog }),
    [connect, send, disconnect, onMessage, state, debugLog, addLog]
  );
}
