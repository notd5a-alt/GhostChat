import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import useDataChannel from "./useDataChannel";

// Mock dependencies
vi.mock("../utils/channelAuth", () => ({
  signMessage: vi.fn((_key: unknown, raw: string) =>
    Promise.resolve(JSON.stringify({ p: raw, h: "aabbccdd" }))
  ),
  verifyMessage: vi.fn((_key: unknown, envelope: string) => {
    try {
      const { p } = JSON.parse(envelope);
      return Promise.resolve(p ?? null);
    } catch {
      return Promise.resolve(null);
    }
  }),
}));

vi.mock("../utils/sounds", () => ({
  playMessageReceived: vi.fn(),
  playMessageSent: vi.fn(),
}));

import { signMessage, verifyMessage } from "../utils/channelAuth";
import { playMessageReceived, playMessageSent } from "../utils/sounds";

// ---------- helpers ----------

type MessageHandler = (e: MessageEvent) => void;

function createMockChannel(readyState: RTCDataChannelState = "open") {
  const listeners: Record<string, Set<MessageHandler>> = {};
  const channel = {
    readyState,
    send: vi.fn(),
    addEventListener: vi.fn((event: string, handler: MessageHandler) => {
      if (!listeners[event]) listeners[event] = new Set();
      listeners[event].add(handler);
    }),
    removeEventListener: vi.fn((event: string, handler: MessageHandler) => {
      listeners[event]?.delete(handler);
    }),
    /** Simulate an incoming message */
    _receive(data: string) {
      const event = { data } as MessageEvent;
      listeners["message"]?.forEach((h) => h(event));
    },
  };
  return channel as unknown as RTCDataChannel & { _receive: (data: string) => void };
}

/** Build an unsigned JSON string (what channel.send receives when hmacKey is null) */
function plain(obj: unknown): string {
  return JSON.stringify(obj);
}

/** Wrap payload the way signMessage mock does (with hmac key) */
function signed(obj: unknown): string {
  return JSON.stringify({ p: JSON.stringify(obj), h: "aabbccdd" });
}

// ---------- tests ----------

describe("useDataChannel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Initial state
  it("has correct initial state", () => {
    const { result } = renderHook(() => useDataChannel(null, null));
    expect(result.current.messages).toEqual([]);
    expect(result.current.peerMsgSeq).toBe(0);
    expect(result.current.peerTyping).toBe(false);
    expect(result.current.peerPresence).toBeNull();
    expect(result.current.peerReadUpTo).toBeNull();
  });

  // 2. sendMessage sends text via channel and adds to messages with from="you"
  it("sendMessage sends text and adds local message", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useDataChannel(channel, null));

    await act(async () => {
      result.current.sendMessage("hello");
    });

    expect(channel.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(channel.send.mock.calls[0][0]);
    expect(sent.type).toBe("text");
    expect(sent.content).toBe("hello");

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].from).toBe("you");
    expect(result.current.messages[0].content).toBe("hello");
    expect(result.current.messages[0].reactions).toEqual({});
    expect(playMessageSent).toHaveBeenCalled();
  });

  // 3. sendMessage does nothing when channel is null or not open
  it("sendMessage does nothing when channel is null", async () => {
    const { result } = renderHook(() => useDataChannel(null, null));
    await act(async () => {
      result.current.sendMessage("ignored");
    });
    expect(result.current.messages).toHaveLength(0);
  });

  it("sendMessage does nothing when channel is not open", async () => {
    const channel = createMockChannel("connecting");
    const { result } = renderHook(() => useDataChannel(channel, null));
    await act(async () => {
      result.current.sendMessage("ignored");
    });
    expect(channel.send).not.toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(0);
  });

  // 4. Receiving a text message
  it("receiving text message adds to messages with from='peer' and increments peerMsgSeq", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useDataChannel(channel, null));

    const incoming = { type: "text", id: "msg-1", content: "hi", timestamp: 1000 };

    await act(async () => {
      channel._receive(plain(incoming));
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].from).toBe("peer");
    expect(result.current.messages[0].content).toBe("hi");
    expect(result.current.messages[0].id).toBe("msg-1");
    expect(result.current.messages[0].reactions).toEqual({});
    expect(result.current.peerMsgSeq).toBe(1);
    expect(playMessageReceived).toHaveBeenCalled();
  });

  // 5. Receiving a reaction toggles the emoji
  it("receiving a reaction toggles emoji on the correct message", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useDataChannel(channel, null));

    // First add a message
    await act(async () => {
      result.current.sendMessage("hello");
    });
    const msgId = result.current.messages[0].id;

    // Receive a reaction from peer
    await act(async () => {
      channel._receive(plain({ type: "reaction", msgId, emoji: "thumbsup" }));
    });
    expect(result.current.messages[0].reactions).toEqual({ thumbsup: ["peer"] });

    // Receive the same reaction again (toggle off)
    await act(async () => {
      channel._receive(plain({ type: "reaction", msgId, emoji: "thumbsup" }));
    });
    expect(result.current.messages[0].reactions).toEqual({});
  });

  // 6. Receiving a read receipt
  it("receiving a read receipt updates peerReadUpTo", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useDataChannel(channel, null));

    await act(async () => {
      channel._receive(plain({ type: "read", upTo: "msg-42" }));
    });

    expect(result.current.peerReadUpTo).toBe("msg-42");
  });

  // 7. Receiving a typing indicator
  it("receiving typing indicator updates peerTyping", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useDataChannel(channel, null));

    await act(async () => {
      channel._receive(plain({ type: "typing", isTyping: true }));
    });
    expect(result.current.peerTyping).toBe(true);

    await act(async () => {
      channel._receive(plain({ type: "typing", isTyping: false }));
    });
    expect(result.current.peerTyping).toBe(false);
  });

  it("peer typing auto-clears after 4s timeout", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useDataChannel(channel, null));

    await act(async () => {
      channel._receive(plain({ type: "typing", isTyping: true }));
    });
    expect(result.current.peerTyping).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.peerTyping).toBe(false);
  });

  // 8. Receiving presence
  it("receiving presence updates peerPresence", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useDataChannel(channel, null));

    await act(async () => {
      channel._receive(plain({ type: "presence", status: "away" }));
    });
    expect(result.current.peerPresence).toBe("away");
  });

  // 9. sendReaction toggles emoji locally
  it("sendReaction toggles emoji locally (add then remove)", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useDataChannel(channel, null));

    await act(async () => {
      result.current.sendMessage("test");
    });
    const msgId = result.current.messages[0].id;

    // Add reaction
    await act(async () => {
      result.current.sendReaction(msgId, "heart");
    });
    expect(result.current.messages[0].reactions).toEqual({ heart: ["you"] });
    expect(channel.send).toHaveBeenCalled();

    // Remove reaction (toggle)
    await act(async () => {
      result.current.sendReaction(msgId, "heart");
    });
    expect(result.current.messages[0].reactions).toEqual({});
  });

  // 10. sendReadReceipt sends read message
  it("sendReadReceipt sends read message", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useDataChannel(channel, null));

    await act(async () => {
      result.current.sendReadReceipt("msg-99");
    });

    expect(channel.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(channel.send.mock.calls[0][0]);
    expect(sent.type).toBe("read");
    expect(sent.upTo).toBe("msg-99");
  });

  // 11. sendTyping sends typing indicator (only sends once until reset)
  it("sendTyping sends true once, then false after stop", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useDataChannel(channel, null));

    // First call sends typing=true
    await act(async () => {
      result.current.sendTyping(true);
    });
    expect(channel.send).toHaveBeenCalledTimes(1);
    let sent = JSON.parse(channel.send.mock.calls[0][0]);
    expect(sent.type).toBe("typing");
    expect(sent.isTyping).toBe(true);

    // Second call with true should not send again (debounced)
    await act(async () => {
      result.current.sendTyping(true);
    });
    expect(channel.send).toHaveBeenCalledTimes(1);

    // Explicit stop sends false
    await act(async () => {
      result.current.sendTyping(false);
    });
    expect(channel.send).toHaveBeenCalledTimes(2);
    sent = JSON.parse(channel.send.mock.calls[1][0]);
    expect(sent.type).toBe("typing");
    expect(sent.isTyping).toBe(false);
  });

  it("sendTyping auto-sends false after 3s timeout", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useDataChannel(channel, null));

    await act(async () => {
      result.current.sendTyping(true);
    });
    expect(channel.send).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    // Should have auto-sent typing=false
    expect(channel.send).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(channel.send.mock.calls[1][0]);
    expect(sent.type).toBe("typing");
    expect(sent.isTyping).toBe(false);
  });

  // 12. sendPresence sends presence message
  it("sendPresence sends presence message", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useDataChannel(channel, null));

    await act(async () => {
      result.current.sendPresence("idle");
    });

    expect(channel.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(channel.send.mock.calls[0][0]);
    expect(sent.type).toBe("presence");
    expect(sent.status).toBe("idle");
  });

  // 13. clearMessages resets all state
  it("clearMessages resets all state", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useDataChannel(channel, null));

    // Build up some state
    await act(async () => {
      result.current.sendMessage("msg");
    });
    await act(async () => {
      channel._receive(plain({ type: "text", id: "p1", content: "peer msg", timestamp: 1 }));
    });
    await act(async () => {
      channel._receive(plain({ type: "read", upTo: "p1" }));
    });
    await act(async () => {
      channel._receive(plain({ type: "typing", isTyping: true }));
    });
    await act(async () => {
      channel._receive(plain({ type: "presence", status: "online" }));
    });

    expect(result.current.messages.length).toBeGreaterThan(0);
    expect(result.current.peerMsgSeq).toBe(1);
    expect(result.current.peerReadUpTo).toBe("p1");
    expect(result.current.peerTyping).toBe(true);
    expect(result.current.peerPresence).toBe("online");

    await act(async () => {
      result.current.clearMessages();
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.peerMsgSeq).toBe(0);
    expect(result.current.peerReadUpTo).toBeNull();
    expect(result.current.peerTyping).toBe(false);
    expect(result.current.peerPresence).toBeNull();
  });

  // 14. Invalid messages are handled gracefully
  it("handles invalid JSON gracefully", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useDataChannel(channel, null));

    await act(async () => {
      channel._receive("not valid json {{{");
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.peerMsgSeq).toBe(0);
  });

  it("handles unknown message types gracefully", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useDataChannel(channel, null));

    await act(async () => {
      channel._receive(plain({ type: "unknown", data: "stuff" }));
    });

    expect(result.current.messages).toEqual([]);
  });

  // HMAC key path: sendMessage uses signMessage when key is present
  it("sendMessage uses signMessage when hmacKey is provided", async () => {
    const channel = createMockChannel("open");
    const fakeKey = { type: "secret" } as unknown as CryptoKey;
    const { result } = renderHook(() => useDataChannel(channel, fakeKey));

    await act(async () => {
      result.current.sendMessage("secure hello");
    });

    expect(signMessage).toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledTimes(1);
    // signMessage mock returns JSON with { p, h } envelope
    const envelope = JSON.parse(channel.send.mock.calls[0][0]);
    expect(envelope.p).toBeDefined();
    expect(envelope.h).toBeDefined();
    const inner = JSON.parse(envelope.p);
    expect(inner.content).toBe("secure hello");
  });

  // HMAC key path: receiving uses verifyMessage when key is present
  it("receiving a message uses verifyMessage when hmacKey is provided", async () => {
    const channel = createMockChannel("open");
    const fakeKey = { type: "secret" } as unknown as CryptoKey;
    const { result } = renderHook(() => useDataChannel(channel, fakeKey));

    const incoming = { type: "text", id: "s1", content: "verified", timestamp: 2000 };

    await act(async () => {
      channel._receive(signed(incoming));
    });

    expect(verifyMessage).toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe("verified");
  });

  it("drops message when HMAC verification fails", async () => {
    const channel = createMockChannel("open");
    const fakeKey = { type: "secret" } as unknown as CryptoKey;

    // Make verifyMessage return null (failed verification)
    vi.mocked(verifyMessage).mockResolvedValueOnce(null);

    const { result } = renderHook(() => useDataChannel(channel, fakeKey));

    await act(async () => {
      channel._receive(signed({ type: "text", id: "bad", content: "tampered", timestamp: 3000 }));
    });

    expect(result.current.messages).toHaveLength(0);
  });

  // sendReadReceipt does nothing when channel not open
  it("sendReadReceipt does nothing when channel is not open", async () => {
    const channel = createMockChannel("closing");
    const { result } = renderHook(() => useDataChannel(channel, null));

    await act(async () => {
      result.current.sendReadReceipt("msg-1");
    });
    expect(channel.send).not.toHaveBeenCalled();
  });

  // sendReaction does nothing when channel not open
  it("sendReaction does nothing when channel is not open", async () => {
    const channel = createMockChannel("closing");
    const { result } = renderHook(() => useDataChannel(channel, null));

    await act(async () => {
      result.current.sendReaction("msg-1", "thumbsup");
    });
    expect(channel.send).not.toHaveBeenCalled();
  });

  // sendPresence does nothing when channel not open
  it("sendPresence does nothing when channel is not open", async () => {
    const channel = createMockChannel("closing");
    const { result } = renderHook(() => useDataChannel(channel, null));

    await act(async () => {
      result.current.sendPresence("online");
    });
    expect(channel.send).not.toHaveBeenCalled();
  });
});
