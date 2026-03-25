import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import useSignaling from "./useSignaling";
import type { SignalingMessage } from "../types";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WSCallback = (ev: any) => void;

class MockWebSocket {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSING = 2 as const;
  static CLOSED = 3 as const;

  CONNECTING = 0 as const;
  OPEN = 1 as const;
  CLOSING = 2 as const;
  CLOSED = 3 as const;

  static lastInstance: MockWebSocket | null = null;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: WSCallback | null = null;
  onclose: WSCallback | null = null;
  onerror: WSCallback | null = null;
  onmessage: WSCallback | null = null;
  send = vi.fn();
  close = vi.fn().mockImplementation(function (this: MockWebSocket) {
    this.readyState = MockWebSocket.CLOSED;
    // Simulate async close event
    if (this.onclose) {
      this.onclose({ code: 1000, reason: "" } as CloseEvent);
    }
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.lastInstance = this;
  }

  // --- helpers for tests ---

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  simulateClose(code = 1006, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  simulateRawMessage(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }

  simulateError() {
    this.onerror?.({} as Event);
  }
}

// Install mock before each test, restore after
beforeEach(() => {
  vi.useFakeTimers();
  MockWebSocket.lastInstance = null;
  (globalThis as any).WebSocket = MockWebSocket;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSignaling", () => {
  // 1
  it("initial state is closed with empty debugLog", () => {
    const { result } = renderHook(() => useSignaling("ws://localhost:9876/ws"));
    expect(result.current.state).toBe("closed");
    expect(result.current.debugLog).toEqual([]);
  });

  // 2
  it("connect() creates a WebSocket and transitions to connecting", () => {
    const { result } = renderHook(() => useSignaling("ws://localhost:9876/ws"));

    act(() => {
      result.current.connect();
    });

    expect(MockWebSocket.lastInstance).not.toBeNull();
    expect(MockWebSocket.lastInstance!.url).toBe("ws://localhost:9876/ws");
    expect(result.current.state).toBe("connecting");
  });

  // 3
  it("on WS open, state becomes open", () => {
    const { result } = renderHook(() => useSignaling("ws://localhost:9876/ws"));

    act(() => {
      result.current.connect();
    });

    act(() => {
      MockWebSocket.lastInstance!.simulateOpen();
    });

    expect(result.current.state).toBe("open");
  });

  // 4
  it("send() sends JSON-stringified message when WS is open", () => {
    const { result } = renderHook(() => useSignaling("ws://localhost:9876/ws"));

    act(() => {
      result.current.connect();
    });
    act(() => {
      MockWebSocket.lastInstance!.simulateOpen();
    });

    const msg: SignalingMessage = { type: "offer", sdp: "v=0\r\n" };
    act(() => {
      result.current.send(msg);
    });

    expect(MockWebSocket.lastInstance!.send).toHaveBeenCalledWith(
      JSON.stringify(msg)
    );
  });

  // 5
  it("send() does not send when WS is not open", () => {
    const { result } = renderHook(() => useSignaling("ws://localhost:9876/ws"));

    act(() => {
      result.current.connect();
    });
    // WS is still CONNECTING (readyState 0), not OPEN

    const msg: SignalingMessage = { type: "offer", sdp: "v=0\r\n" };
    act(() => {
      result.current.send(msg);
    });

    expect(MockWebSocket.lastInstance!.send).not.toHaveBeenCalled();
  });

  // 6
  it("messages received before onMessage handler are buffered and flushed when handler registers", () => {
    const { result } = renderHook(() => useSignaling("ws://localhost:9876/ws"));

    act(() => {
      result.current.connect();
    });
    act(() => {
      MockWebSocket.lastInstance!.simulateOpen();
    });

    // Receive messages before registering handler
    const msg1: SignalingMessage = { type: "peer-joined" };
    const msg2: SignalingMessage = { type: "offer", sdp: "v=0\r\n" };
    act(() => {
      MockWebSocket.lastInstance!.simulateMessage(msg1);
      MockWebSocket.lastInstance!.simulateMessage(msg2);
    });

    // Now register handler — it should receive the buffered messages
    const handler = vi.fn();
    act(() => {
      result.current.onMessage(handler);
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(msg1);
    expect(handler).toHaveBeenCalledWith(msg2);
  });

  // 7
  it("messages received after onMessage handler is set are delivered immediately", () => {
    const { result } = renderHook(() => useSignaling("ws://localhost:9876/ws"));

    act(() => {
      result.current.connect();
    });
    act(() => {
      MockWebSocket.lastInstance!.simulateOpen();
    });

    const handler = vi.fn();
    act(() => {
      result.current.onMessage(handler);
    });

    const msg: SignalingMessage = { type: "peer-joined" };
    act(() => {
      MockWebSocket.lastInstance!.simulateMessage(msg);
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(msg);
  });

  // 8
  it("disconnect() closes WS and resets state to closed", () => {
    const { result } = renderHook(() => useSignaling("ws://localhost:9876/ws"));

    act(() => {
      result.current.connect();
    });
    act(() => {
      MockWebSocket.lastInstance!.simulateOpen();
    });

    expect(result.current.state).toBe("open");

    act(() => {
      result.current.disconnect();
    });

    expect(result.current.state).toBe("closed");
  });

  // 9
  it("invalid JSON messages are handled gracefully", () => {
    const { result } = renderHook(() => useSignaling("ws://localhost:9876/ws"));

    act(() => {
      result.current.connect();
    });
    act(() => {
      MockWebSocket.lastInstance!.simulateOpen();
    });

    const handler = vi.fn();
    act(() => {
      result.current.onMessage(handler);
    });

    // Should not throw
    act(() => {
      MockWebSocket.lastInstance!.simulateRawMessage("not valid json {{{");
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.current.debugLog.some((l) => l.includes("invalid JSON"))).toBe(true);
  });

  // 10
  it("auto-reconnects with exponential backoff after unexpected close when wasEverOpen", () => {
    const { result } = renderHook(() => useSignaling("ws://localhost:9876/ws"));

    act(() => {
      result.current.connect();
    });
    const firstWs = MockWebSocket.lastInstance!;
    act(() => {
      firstWs.simulateOpen();
    });
    expect(result.current.state).toBe("open");

    // Unexpected close (not intentional, not 4001)
    act(() => {
      firstWs.simulateClose(1006, "abnormal");
    });

    expect(result.current.state).toBe("reconnecting");

    // First reconnect after BASE_DELAY (1000ms)
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    const secondWs = MockWebSocket.lastInstance!;
    expect(secondWs).not.toBe(firstWs);
    // State should still be reconnecting until the new socket opens
    expect(result.current.state).toBe("reconnecting");

    // Simulate that second connection also fails
    act(() => {
      secondWs.simulateClose(1006, "");
    });

    expect(result.current.state).toBe("reconnecting");

    // Second reconnect after 2000ms (exponential backoff)
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    // Should not have reconnected yet
    const stillSecond = MockWebSocket.lastInstance!;
    expect(stillSecond).toBe(secondWs);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    // Now it should have created a third WS
    expect(MockWebSocket.lastInstance).not.toBe(secondWs);
  });

  // 11
  it("does not reconnect when intentionally closed via disconnect()", () => {
    const { result } = renderHook(() => useSignaling("ws://localhost:9876/ws"));

    act(() => {
      result.current.connect();
    });
    act(() => {
      MockWebSocket.lastInstance!.simulateOpen();
    });

    act(() => {
      result.current.disconnect();
    });

    expect(result.current.state).toBe("closed");

    // Advance timers — no reconnect should happen
    act(() => {
      vi.advanceTimersByTime(60000);
    });

    expect(result.current.state).toBe("closed");
  });

  // 12
  it("does not reconnect when close code is 4001", () => {
    const { result } = renderHook(() => useSignaling("ws://localhost:9876/ws"));

    act(() => {
      result.current.connect();
    });
    act(() => {
      MockWebSocket.lastInstance!.simulateOpen();
    });

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateClose(4001, "room full");
    });

    expect(result.current.state).toBe("closed");

    act(() => {
      vi.advanceTimersByTime(60000);
    });

    expect(result.current.state).toBe("closed");
  });

  // 13
  it("does not reconnect when connection was never opened", () => {
    const { result } = renderHook(() => useSignaling("ws://localhost:9876/ws"));

    act(() => {
      result.current.connect();
    });

    const ws = MockWebSocket.lastInstance!;
    // Close without ever opening
    act(() => {
      ws.simulateClose(1006, "");
    });

    expect(result.current.state).toBe("closed");

    act(() => {
      vi.advanceTimersByTime(60000);
    });

    expect(result.current.state).toBe("closed");
  });

  // 14
  it("connect() with null URL does nothing", () => {
    const { result } = renderHook(() => useSignaling(null));

    act(() => {
      result.current.connect();
    });

    expect(MockWebSocket.lastInstance).toBeNull();
    expect(result.current.state).toBe("closed");
  });
});
