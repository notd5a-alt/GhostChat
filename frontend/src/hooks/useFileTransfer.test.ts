import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import useFileTransfer from "./useFileTransfer";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../utils/channelAuth", () => ({
  signMessage: vi.fn((_key: unknown, str: string) => Promise.resolve(str)),
  verifyMessage: vi.fn((_key: unknown, str: string) => Promise.resolve(str)),
  signChunk: vi.fn((_key: unknown, chunk: ArrayBuffer) => Promise.resolve(chunk)),
  verifyChunk: vi.fn((_key: unknown, data: ArrayBuffer) => Promise.resolve(data)),
}));

vi.mock("../utils/compression", () => ({
  compressFile: vi.fn((file: File) =>
    Promise.resolve({
      compressed: new Blob(["data"]),
      checksum: "abc123",
      originalSize: file.size,
    })
  ),
  decompressBlob: vi.fn((blob: Blob) => Promise.resolve(blob)),
}));

vi.mock("../utils/sounds", () => ({
  playFileComplete: vi.fn(),
}));

// ---------------------------------------------------------------------------
// URL mocks
// ---------------------------------------------------------------------------

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:test-url");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Mock RTCDataChannel factory
// ---------------------------------------------------------------------------

type EventHandler = (ev: any) => void;

function createMockChannel(readyState: RTCDataChannelState = "open") {
  const listeners: Record<string, EventHandler[]> = {};

  const channel = {
    readyState,
    binaryType: "" as string,
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onbufferedamountlow: null as (() => void) | null,
    send: vi.fn(),
    addEventListener: vi.fn((event: string, handler: EventHandler) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    removeEventListener: vi.fn((event: string, handler: EventHandler) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((h) => h !== handler);
      }
    }),
    // Test helper: dispatch event to listeners
    _dispatch(event: string, data: any) {
      for (const h of listeners[event] || []) {
        h(data);
      }
    },
  } as unknown as RTCDataChannel & { _dispatch: (event: string, data: any) => void };

  return channel;
}

// ---------------------------------------------------------------------------
// Helper: wait for microtasks / timers to flush
// ---------------------------------------------------------------------------

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useFileTransfer", () => {
  // ---- 1. Initial state ----
  it("has empty incoming and null outgoing on init", () => {
    const { result } = renderHook(() => useFileTransfer(null, null));
    expect(result.current.incoming).toEqual([]);
    expect(result.current.outgoing).toBeNull();
  });

  // ---- 2. sendFile compresses and sends metadata + chunks + end ----
  it("sendFile compresses and sends metadata, chunks, and file-end", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useFileTransfer(channel, null));

    const file = new File(["hello world"], "test.txt", { type: "text/plain" });

    await act(async () => {
      await result.current.sendFile(file);
    });

    const calls = channel.send as ReturnType<typeof vi.fn>;
    expect(calls.mock.calls.length).toBeGreaterThanOrEqual(2);

    // First call: metadata JSON
    const metaStr = calls.mock.calls[0][0] as string;
    const meta = JSON.parse(metaStr);
    expect(meta.type).toBe("file-meta");
    expect(meta.name).toBe("test.txt");
    expect(meta.checksum).toBe("abc123");

    // Last call: file-end JSON
    const lastCallArg = calls.mock.calls[calls.mock.calls.length - 1][0];
    const endMsg = JSON.parse(lastCallArg as string);
    expect(endMsg.type).toBe("file-end");
  });

  // ---- 3. sendFile rejects files over 500MB ----
  it("rejects files exceeding MAX_FILE_SIZE with failed status", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useFileTransfer(channel, null));

    const bigFile = new File(["x"], "huge.bin", { type: "application/octet-stream" });
    Object.defineProperty(bigFile, "size", { value: 501 * 1024 * 1024 });

    await act(async () => {
      await result.current.sendFile(bigFile);
    });

    expect(result.current.outgoing).not.toBeNull();
    expect(result.current.outgoing!.status).toBe("failed");

    // Channel.send should not have been called
    expect((channel.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  // ---- 4. sendFile does nothing when channel is null or not open ----
  it("does nothing when channel is null", async () => {
    const { result } = renderHook(() => useFileTransfer(null, null));
    const file = new File(["test"], "a.txt", { type: "text/plain" });

    await act(async () => {
      await result.current.sendFile(file);
    });

    expect(result.current.outgoing).toBeNull();
  });

  it("does nothing when channel is not open", async () => {
    const channel = createMockChannel("closing");
    const { result } = renderHook(() => useFileTransfer(channel, null));
    const file = new File(["test"], "a.txt", { type: "text/plain" });

    await act(async () => {
      await result.current.sendFile(file);
    });

    expect(result.current.outgoing).toBeNull();
  });

  // ---- 5. Receiving file-meta creates an incoming entry ----
  it("creates incoming entry on file-meta message", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useFileTransfer(channel, null));

    const metaMsg = JSON.stringify({
      type: "file-meta",
      id: "file-1",
      name: "photo.png",
      size: 1024,
      mimeType: "image/png",
      compressedSize: 800,
      checksum: "abc123",
    });

    await act(async () => {
      channel._dispatch("message", { data: metaMsg } as MessageEvent);
      await flushPromises();
    });

    expect(result.current.incoming.length).toBe(1);
    expect(result.current.incoming[0].id).toBe("file-1");
    expect(result.current.incoming[0].name).toBe("photo.png");
    expect(result.current.incoming[0].size).toBe(1024);
    expect(result.current.incoming[0].status).toBe("receiving");
  });

  // ---- 6. Receiving binary chunks updates progress ----
  it("updates progress when binary chunks are received", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useFileTransfer(channel, null));

    // First send meta
    const metaMsg = JSON.stringify({
      type: "file-meta",
      id: "file-2",
      name: "data.bin",
      size: 200,
      mimeType: "application/octet-stream",
      compressedSize: 200,
      checksum: "abc123",
    });

    await act(async () => {
      channel._dispatch("message", { data: metaMsg } as MessageEvent);
      await flushPromises();
    });

    // Send a binary chunk
    const chunkBuffer = new ArrayBuffer(100);
    await act(async () => {
      channel._dispatch("message", { data: chunkBuffer } as MessageEvent);
      await flushPromises();
    });

    // Progress should be 100/200 = 0.5
    expect(result.current.incoming[0].progress).toBe(0.5);
  });

  // ---- 7. Receiving file-end creates blob URL and marks completed ----
  it("creates blob URL and marks completed on file-end", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useFileTransfer(channel, null));

    // Meta
    const metaMsg = JSON.stringify({
      type: "file-meta",
      id: "file-3",
      name: "doc.pdf",
      size: 50,
      mimeType: "application/pdf",
      compressedSize: 50,
      checksum: "abc123",
    });

    await act(async () => {
      channel._dispatch("message", { data: metaMsg } as MessageEvent);
      await flushPromises();
    });

    // Send all data as one chunk
    const chunkBuffer = new ArrayBuffer(50);
    await act(async () => {
      channel._dispatch("message", { data: chunkBuffer } as MessageEvent);
      await flushPromises();
    });

    // File-end
    const endMsg = JSON.stringify({ type: "file-end", id: "file-3" });
    await act(async () => {
      channel._dispatch("message", { data: endMsg } as MessageEvent);
      await flushPromises();
    });

    expect(result.current.incoming[0].status).toBe("completed");
    expect(result.current.incoming[0].blobUrl).toBe("blob:test-url");
    expect(result.current.incoming[0].progress).toBe(1);
  });

  // ---- 8. Receiving file-cancel marks incoming as failed ----
  it("marks incoming as failed on file-cancel", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useFileTransfer(channel, null));

    // Meta
    const metaMsg = JSON.stringify({
      type: "file-meta",
      id: "file-4",
      name: "video.mp4",
      size: 5000,
      mimeType: "video/mp4",
      compressedSize: 4000,
      checksum: "abc123",
    });

    await act(async () => {
      channel._dispatch("message", { data: metaMsg } as MessageEvent);
      await flushPromises();
    });

    // Cancel
    const cancelMsg = JSON.stringify({ type: "file-cancel", id: "file-4" });
    await act(async () => {
      channel._dispatch("message", { data: cancelMsg } as MessageEvent);
      await flushPromises();
    });

    expect(result.current.incoming[0].status).toBe("failed");
    expect(result.current.incoming[0].error).toBe("Cancelled by peer");
  });

  // ---- 9. cancelTransfer cancels outgoing and notifies peer ----
  it("cancels outgoing transfer and notifies peer", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useFileTransfer(channel, null));

    // Start a send but use a large compressed blob so chunks don't finish instantly
    // We'll just verify cancelTransfer sends file-cancel
    // First, trigger a file-meta as incoming to give us something to cancel
    // Instead, let's test cancelling an arbitrary id — it should still send file-cancel

    act(() => {
      result.current.cancelTransfer("outgoing-id");
    });

    await act(async () => {
      await flushPromises();
    });

    const sendFn = channel.send as ReturnType<typeof vi.fn>;
    const cancelCall = sendFn.mock.calls.find((call: unknown[]) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.type === "file-cancel";
      } catch {
        return false;
      }
    });

    expect(cancelCall).toBeDefined();
    const parsed = JSON.parse(cancelCall![0] as string);
    expect(parsed.type).toBe("file-cancel");
    expect(parsed.id).toBe("outgoing-id");
  });

  // ---- 10. cancelTransfer cancels incoming and revokes blob URL ----
  it("cancels incoming transfer and revokes blob URL", async () => {
    const channel = createMockChannel("open");
    const { result } = renderHook(() => useFileTransfer(channel, null));

    // Create an incoming file that has a blob URL (simulate completed transfer)
    const metaMsg = JSON.stringify({
      type: "file-meta",
      id: "file-5",
      name: "image.jpg",
      size: 20,
      mimeType: "image/jpeg",
      compressedSize: 20,
      checksum: "abc123",
    });

    await act(async () => {
      channel._dispatch("message", { data: metaMsg } as MessageEvent);
      await flushPromises();
    });

    // Send chunk + file-end to get a completed file with blob URL
    const chunk = new ArrayBuffer(20);
    await act(async () => {
      channel._dispatch("message", { data: chunk } as MessageEvent);
      await flushPromises();
    });

    const endMsg = JSON.stringify({ type: "file-end", id: "file-5" });
    await act(async () => {
      channel._dispatch("message", { data: endMsg } as MessageEvent);
      await flushPromises();
    });

    expect(result.current.incoming[0].blobUrl).toBe("blob:test-url");

    // Now cancel it
    act(() => {
      result.current.cancelTransfer("file-5");
    });

    expect(result.current.incoming[0].status).toBe("failed");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-url");
  });

  // ---- 11. Channel drop pauses receiving transfers ----
  it("pauses receiving transfers when channel drops", async () => {
    const channel = createMockChannel("open");
    const { result, rerender } = renderHook(
      ({ ch }: { ch: RTCDataChannel | null }) => useFileTransfer(ch, null),
      { initialProps: { ch: channel as RTCDataChannel | null } }
    );

    // Create a receiving incoming file
    const metaMsg = JSON.stringify({
      type: "file-meta",
      id: "file-6",
      name: "archive.zip",
      size: 10000,
      mimeType: "application/zip",
      compressedSize: 8000,
      checksum: "abc123",
    });

    await act(async () => {
      channel._dispatch("message", { data: metaMsg } as MessageEvent);
      await flushPromises();
    });

    expect(result.current.incoming[0].status).toBe("receiving");

    // Drop channel by re-rendering with null
    await act(async () => {
      rerender({ ch: null });
      await flushPromises();
    });

    expect(result.current.incoming[0].status).toBe("paused");
  });
});
