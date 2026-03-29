import { useState, useCallback, useEffect, useRef } from "react";
import {
  signMessage,
  verifyMessage,
  signChunk,
  verifyChunk,
} from "../utils/channelAuth";
import { compressFile, decompressBlob } from "../utils/compression";
import { playFileComplete } from "../utils/sounds";
import type { IncomingFile, OutgoingFile, FileTransferStatus } from "../types";

const CHUNK_SIZE = 16384; // 16 KB
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB — compressed in memory, so limit to avoid OOM

const MIME_RE = /^[\w.-]+\/[\w.+-]+$/;
const MAX_NAME_LEN = 200;

function sanitizeFileName(raw: unknown): { name: string; wasTruncated: boolean } {
  if (typeof raw !== "string" || !raw.trim()) return { name: "download", wasTruncated: false };
  let name = raw.replace(/[/\\:\0]/g, "_").trim();
  let wasTruncated = false;
  if (name.length > MAX_NAME_LEN) {
    wasTruncated = true;
    const dot = name.lastIndexOf(".");
    if (dot > 0 && name.length - dot <= 10) {
      name = name.slice(0, MAX_NAME_LEN - (name.length - dot)) + name.slice(dot);
    } else {
      name = name.slice(0, MAX_NAME_LEN);
    }
  }
  return { name: name || "download", wasTruncated };
}

function sanitizeMimeType(raw: unknown): string {
  if (typeof raw !== "string") return "application/octet-stream";
  const t = raw.trim().toLowerCase();
  return MIME_RE.test(t) ? t : "application/octet-stream";
}

interface PendingFile {
  name: string;
  size: number;
  compressedSize: number;
  mimeType: string;
  checksum: string;
  chunks: ArrayBuffer[];
  receivedBytes: number;
  chunkIndex: number;
  status: FileTransferStatus;
}

interface ActiveSend {
  id: string;
  name: string;
  originalSize: number;
  compressedBlob: Blob;
  compressedSize: number;
  checksum: string;
  mimeType: string;
  chunkIndex: number;
  byteOffset: number;
  completed: boolean;
}

export interface SentFile {
  id: string;
  name: string;
  size: number;
  compressedSize: number;
  timestamp: number;
}

export interface FileTransferHook {
  incoming: IncomingFile[];
  outgoing: OutgoingFile | null;
  sentFiles: SentFile[];
  sendFile: (file: File) => Promise<void>;
  cancelTransfer: (id: string) => void;
}

export default function useFileTransfer(
  channel: RTCDataChannel | null,
  hmacKey: CryptoKey | null
): FileTransferHook {
  const [incoming, setIncoming] = useState<IncomingFile[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingFile | null>(null);
  const [sentFiles, setSentFiles] = useState<SentFile[]>([]);
  const pendingRef = useRef<Record<string, PendingFile>>({});
  const sendLockRef = useRef(false);
  const channelRef = useRef(channel);
  const hmacKeyRef = useRef(hmacKey);
  const blobUrlsRef = useRef<Map<string, string>>(new Map());
  const activeSendRef = useRef<ActiveSend | null>(null);
  const sendResolveRef = useRef<(() => void) | null>(null);
  // Track which file ID is currently being received — deterministic chunk routing
  const activeReceiveIdRef = useRef<string | null>(null);

  useEffect(() => {
    hmacKeyRef.current = hmacKey;
  }, [hmacKey]);

  // Helper: send chunks from a given offset
  const sendChunks = useCallback(async (
    ch: RTCDataChannel,
    send: ActiveSend,
    key: CryptoKey | null,
  ) => {
    let { byteOffset, chunkIndex } = send;

    while (byteOffset < send.compressedSize) {
      // Check channel is still open
      if (ch.readyState !== "open") {
        // Pause — save progress
        send.byteOffset = byteOffset;
        send.chunkIndex = chunkIndex;
        setOutgoing((prev) =>
          prev ? { ...prev, bytesSent: byteOffset, status: "paused" } : null
        );
        return; // Will resume via file-resume-req
      }

      // Flow control — set threshold BEFORE registering handler to prevent race
      // where bufferedAmount drops below threshold before handler is attached
      if (ch.bufferedAmount > 65536) {
        ch.bufferedAmountLowThreshold = 16384;
        await new Promise<void>((resolve) => {
          const cleanup = () => {
            ch.onbufferedamountlow = null;
            ch.removeEventListener("close", onClose);
            resolve();
          };
          // C2: Resolve if channel closes while waiting for buffer drain
          const onClose = () => cleanup();
          ch.addEventListener("close", onClose, { once: true });
          ch.onbufferedamountlow = () => cleanup();
          // Check immediately in case buffer already drained or channel closed
          if (ch.bufferedAmount <= 16384 || ch.readyState !== "open") {
            cleanup();
          }
        });
      }

      const end = Math.min(byteOffset + CHUNK_SIZE, send.compressedSize);
      const chunk = await send.compressedBlob.slice(byteOffset, end).arrayBuffer();
      const toSend = key ? await signChunk(key, chunk, send.id, chunkIndex) : chunk;
      ch.send(toSend);
      byteOffset = end;
      chunkIndex++;

      // Throttle progress updates
      if (chunkIndex % 10 === 0 || byteOffset === send.compressedSize) {
        send.byteOffset = byteOffset;
        send.chunkIndex = chunkIndex;
        setOutgoing((prev) =>
          prev ? { ...prev, bytesSent: byteOffset } : null
        );
      }
    }

    // Complete
    const endMsg = JSON.stringify({ type: "file-end", id: send.id });
    ch.send(key ? await signMessage(key, endMsg) : endMsg);
    send.completed = true;
    send.byteOffset = byteOffset;
    send.chunkIndex = chunkIndex;
  }, []);

  useEffect(() => {
    channelRef.current = channel;
    if (!channel) {
      // Channel dropped — mark pending transfers as paused
      // H2: Clear active receive ID so new transfers can be accepted after reconnect
      activeReceiveIdRef.current = null;
      for (const entry of Object.values(pendingRef.current)) {
        if (entry.status === "receiving") {
          entry.status = "paused";
        }
      }
      setIncoming((prev) =>
        prev.map((f) =>
          f.status === "receiving" ? { ...f, status: "paused" as FileTransferStatus } : f
        )
      );
      return;
    }

    channel.binaryType = "arraybuffer";

    // On channel reconnect, request resume for any paused incoming transfers
    const pausedIds = Object.entries(pendingRef.current)
      .filter(([, e]) => e.status === "paused")
      .map(([id, e]) => ({ id, receivedBytes: e.receivedBytes, chunkIndex: e.chunkIndex }));

    if (pausedIds.length > 0) {
      const key = hmacKeyRef.current;
      const sendResumes = async () => {
        for (const { id, receivedBytes, chunkIndex } of pausedIds) {
          if (channel.readyState !== "open") break;
          const msg = JSON.stringify({ type: "file-resume-req", id, receivedBytes, chunkIndex });
          try {
            const signed = key ? await signMessage(key, msg) : msg;
            channel.send(signed);
          } catch (err) {
            console.warn("Failed to send resume request for", id, err);
          }
        }
      };
      sendResumes();
    }

    const handler = async (e: MessageEvent) => {
      const key = hmacKeyRef.current;

      if (typeof e.data === "string") {
        try {
          let parsed: Record<string, unknown>;
          if (key) {
            const payload = await verifyMessage(key, e.data);
            if (!payload) {
              console.warn("HMAC verification failed on file control message");
              return;
            }
            parsed = JSON.parse(payload);
          } else {
            try {
              const outer = JSON.parse(e.data);
              parsed = outer.p ? JSON.parse(outer.p) : outer;
            } catch {
              parsed = JSON.parse(e.data);
            }
          }

          const msgType = parsed.type as string;

          if (msgType === "file-meta") {
            const id = parsed.id as string;
            const size = parsed.size as number;
            const compressedSize = (parsed.compressedSize as number) || size;

            // Validate metadata sizes (H12)
            if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_SIZE ||
                !Number.isFinite(compressedSize) || compressedSize < 0 || compressedSize > MAX_FILE_SIZE ||
                typeof id !== "string" || !id) {
              console.warn("Invalid file metadata, rejecting transfer");
              return;
            }

            // Enforce sequential receives — reject if another file is actively receiving (C6)
            if (activeReceiveIdRef.current && pendingRef.current[activeReceiveIdRef.current]?.status === "receiving") {
              console.warn("Already receiving a file, rejecting concurrent transfer:", id);
              return;
            }

            activeReceiveIdRef.current = id;
            const checksum = (parsed.checksum as string) || "";
            const { name: safeName, wasTruncated } = sanitizeFileName(parsed.name);
            const safeMime = sanitizeMimeType(parsed.mimeType);
            pendingRef.current[id] = {
              name: safeName,
              size,
              compressedSize,
              mimeType: safeMime,
              checksum,
              chunks: [],
              receivedBytes: 0,
              chunkIndex: 0,
              status: "receiving",
            };
            setIncoming((prev) => [
              ...prev,
              {
                id,
                name: safeName,
                size,
                compressedSize,
                progress: 0,
                blobUrl: null,
                status: "receiving",
                ...(wasTruncated ? { warning: `Filename truncated to ${MAX_NAME_LEN} chars` } : {}),
              },
            ]);
          } else if (msgType === "file-end") {
            const id = parsed.id as string;
            if (activeReceiveIdRef.current === id) activeReceiveIdRef.current = null;
            const entry = pendingRef.current[id];
            if (!entry) return;

            // Decompress and verify checksum (fall back to raw if not compressed)
            try {
              const rawBlob = new Blob(entry.chunks, { type: entry.mimeType });
              let finalBlob: Blob;

              if (entry.checksum) {
                // Data was compressed — decompress and verify
                try {
                  finalBlob = await decompressBlob(rawBlob, entry.checksum);
                } catch (decompErr) {
                  console.warn("Decompression failed, using raw data:", decompErr);
                  finalBlob = rawBlob;
                }
              } else {
                // No checksum means uncompressed transfer (legacy or fallback)
                finalBlob = rawBlob;
              }

              const blobUrl = URL.createObjectURL(
                new Blob([finalBlob], { type: entry.mimeType })
              );
              blobUrlsRef.current.set(id, blobUrl);
              delete pendingRef.current[id];
              setIncoming((prev) =>
                prev.map((f) =>
                  f.id === id
                    ? { ...f, progress: 1, blobUrl, status: "completed" as FileTransferStatus, timestamp: Date.now() }
                    : f
                )
              );
              playFileComplete();
            } catch (err) {
              const leakedUrl = blobUrlsRef.current.get(id);
              if (leakedUrl) {
                URL.revokeObjectURL(leakedUrl);
                blobUrlsRef.current.delete(id);
              }
              delete pendingRef.current[id];
              setIncoming((prev) =>
                prev.map((f) =>
                  f.id === id
                    ? { ...f, status: "failed" as FileTransferStatus, error: (err as Error).message }
                    : f
                )
              );
            }
          } else if (msgType === "file-resume-req") {
            // Peer wants us to resume sending from a specific point
            const id = parsed.id as string;
            const send = activeSendRef.current;
            if (!send || send.id !== id || send.completed) return;

            const resumeFromByte = parsed.receivedBytes as number;
            const resumeFromChunk = parsed.chunkIndex as number;
            const maxChunks = Math.ceil(send.compressedSize / CHUNK_SIZE);
            // Validate resume position is within bounds (H13: chunkIndex upper bound)
            if (resumeFromByte < 0 || resumeFromByte > send.compressedSize ||
                resumeFromChunk < 0 || resumeFromChunk > maxChunks) return;
            send.byteOffset = resumeFromByte;
            send.chunkIndex = resumeFromChunk;

            // Send ack
            const ackMsg = JSON.stringify({
              type: "file-resume-ack",
              id,
              resumeFromByte,
              resumeFromChunk,
            });
            channel.send(key ? await signMessage(key, ackMsg) : ackMsg);

            // Resume sending
            setOutgoing((prev) =>
              prev ? { ...prev, bytesSent: resumeFromByte, status: "sending" } : null
            );
            sendChunks(channel, send, key).then(() => {
              if (send.completed) {
                activeSendRef.current = null;
                sendLockRef.current = false;
                setSentFiles((prev) => [...prev, {
                  id: send.id,
                  name: send.name,
                  size: send.originalSize,
                  compressedSize: send.compressedSize,
                  timestamp: Date.now(),
                }]);
                setOutgoing(null);
                playFileComplete();
                sendResolveRef.current?.();
                sendResolveRef.current = null;
              } else {
                // C2: Paused again during resume — release lock after timeout
                // to prevent permanent lock if peer never sends another resume-req
                setTimeout(() => {
                  if (sendLockRef.current && activeSendRef.current?.id === send.id && !send.completed) {
                    activeSendRef.current = null;
                    sendLockRef.current = false;
                    setOutgoing(null);
                    sendResolveRef.current?.();
                    sendResolveRef.current = null;
                  }
                }, 60_000);
              }
            }).catch((err) => {
              // H10: prevent permanent send lock on resume failure
              console.warn("Resume send failed:", err);
              activeSendRef.current = null;
              sendLockRef.current = false;
              setOutgoing((prev) => prev ? { ...prev, status: "failed" as FileTransferStatus } : null);
              sendResolveRef.current?.();
              sendResolveRef.current = null;
            });
          } else if (msgType === "file-resume-ack") {
            // Server acknowledged our resume request — update status
            const id = parsed.id as string;
            const entry = pendingRef.current[id];
            if (entry) {
              entry.status = "receiving";
              entry.chunkIndex = parsed.resumeFromChunk as number;
              entry.receivedBytes = parsed.resumeFromByte as number;
              // Trim chunks to match the acknowledged byte offset
              let bytes = 0;
              let keepChunks = 0;
              for (const chunk of entry.chunks) {
                if (bytes + chunk.byteLength <= entry.receivedBytes) {
                  bytes += chunk.byteLength;
                  keepChunks++;
                } else break;
              }
              entry.chunks = entry.chunks.slice(0, keepChunks);
              entry.receivedBytes = bytes;
            }
            setIncoming((prev) =>
              prev.map((f) =>
                f.id === id ? { ...f, status: "receiving" as FileTransferStatus } : f
              )
            );
          } else if (msgType === "file-cancel") {
            const id = parsed.id as string;
            if (activeReceiveIdRef.current === id) activeReceiveIdRef.current = null;
            delete pendingRef.current[id];
            setIncoming((prev) =>
              prev.map((f) =>
                f.id === id
                  ? { ...f, status: "failed" as FileTransferStatus, error: "Cancelled by peer" }
                  : f
              )
            );
          }
        } catch {
          /* parse error */
        }
      } else {
        // Binary chunk — route to the actively receiving file (set on file-meta)
        const id = activeReceiveIdRef.current;
        if (!id) return;
        const entry = pendingRef.current[id];
        if (!entry || entry.status !== "receiving") return;

        let chunkData: ArrayBuffer;
        if (key) {
          const verified = await verifyChunk(key, e.data as ArrayBuffer, id, entry.chunkIndex);
          if (!verified) {
            console.warn("HMAC verification failed for chunk", entry.chunkIndex, "of file", id);
            return;
          }
          chunkData = verified;
        } else {
          chunkData = e.data as ArrayBuffer;
        }

        entry.chunks.push(chunkData);
        entry.receivedBytes += chunkData.byteLength;
        entry.chunkIndex++;

        // Throttle progress updates
        const now = Date.now();
        if (now - ((entry as unknown as { lastUpdate: number }).lastUpdate || 0) > 100 || entry.receivedBytes >= entry.compressedSize) {
          (entry as unknown as { lastUpdate: number }).lastUpdate = now;
          const progress = Math.min(entry.receivedBytes / entry.compressedSize, 1);
          setIncoming((prev) =>
            prev.map((f) => (f.id === id ? { ...f, progress } : f))
          );
        }
      }
    };

    channel.addEventListener("message", handler);
    return () => {
      channel.removeEventListener("message", handler);
      // Don't clear pendingRef — paused transfers need to survive channel reconnect
    };
  }, [channel, sendChunks]);

  // Revoke blob URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current = new Map();
    };
  }, []);

  // M4: Auto-revoke blob URLs after 5 minutes to prevent memory accumulation
  // during long sessions with many file transfers
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setIncoming((prev) =>
        prev.map((f) => {
          if (f.status === "completed" && f.blobUrl && f.timestamp && now - f.timestamp > 5 * 60 * 1000) {
            URL.revokeObjectURL(f.blobUrl);
            blobUrlsRef.current.delete(f.id);
            return { ...f, blobUrl: null };
          }
          return f;
        })
      );
    }, 60_000); // Check every minute
    return () => clearInterval(interval);
  }, []);

  const sendFile = useCallback(async (file: File) => {
    // M5: Show feedback instead of silently dropping concurrent sends
    if (sendLockRef.current) {
      setOutgoing((prev) => prev ? { ...prev } : {
        id: "busy",
        name: file.name,
        size: file.size,
        compressedSize: 0,
        bytesSent: 0,
        status: "failed" as FileTransferStatus,
      });
      return;
    }
    const ch = channelRef.current;
    if (!ch || ch.readyState !== "open") return;
    const key = hmacKeyRef.current;

    if (file.size > MAX_FILE_SIZE) {
      setOutgoing({
        id: "error",
        name: file.name,
        size: file.size,
        compressedSize: 0,
        bytesSent: 0,
        status: "failed" as FileTransferStatus,
      });
      setTimeout(() => setOutgoing(null), 5000);
      return;
    }

    sendLockRef.current = true;
    const id = crypto.randomUUID();

    try {
      // Phase 1: Compress
      setOutgoing({
        id,
        name: file.name,
        size: file.size,
        compressedSize: 0,
        bytesSent: 0,
        status: "compressing",
      });

      const { compressed, checksum, originalSize } = await compressFile(file);
      const compressedSize = compressed.size;

      // Store active send for potential resume
      const send: ActiveSend = {
        id,
        name: file.name,
        originalSize,
        compressedBlob: compressed,
        compressedSize,
        checksum,
        mimeType: file.type || "application/octet-stream",
        chunkIndex: 0,
        byteOffset: 0,
        completed: false,
      };
      activeSendRef.current = send;

      setOutgoing({
        id,
        name: file.name,
        size: originalSize,
        compressedSize,
        bytesSent: 0,
        status: "sending",
      });

      // Phase 2: Send metadata
      const metaMsg = JSON.stringify({
        type: "file-meta",
        id,
        name: file.name,
        size: originalSize,
        mimeType: file.type || "application/octet-stream",
        compressedSize,
        checksum,
      });
      ch.send(key ? await signMessage(key, metaMsg) : metaMsg);

      // Phase 3: Send chunks
      await sendChunks(ch, send, key);

      if (send.completed) {
        activeSendRef.current = null;
        sendLockRef.current = false;
        setSentFiles((prev) => [...prev, {
          id: send.id,
          name: send.name,
          size: send.originalSize,
          compressedSize: send.compressedSize,
          timestamp: Date.now(),
        }]);
        setOutgoing(null);
        playFileComplete();
      } else {
        // Paused — wait for resume, but timeout after 60s to release the lock
        await new Promise<void>((resolve) => {
          sendResolveRef.current = resolve;
          const timeout = setTimeout(() => {
            sendResolveRef.current = null;
            activeSendRef.current = null;
            sendLockRef.current = false;
            setOutgoing(null);
            resolve();
          }, 60_000);
          // Clear timeout if resolved normally via resume
          const origResolve = resolve;
          sendResolveRef.current = () => { clearTimeout(timeout); origResolve(); };
        });
      }
    } catch {
      activeSendRef.current = null;
      sendLockRef.current = false;
      setOutgoing(null);
    }
  }, [sendChunks]);

  const cancelTransfer = useCallback((id: string) => {
    const ch = channelRef.current;
    const key = hmacKeyRef.current;

    // Cancel outgoing
    if (activeSendRef.current?.id === id) {
      activeSendRef.current = null;
      sendLockRef.current = false;
      setOutgoing(null);
      sendResolveRef.current?.();
      sendResolveRef.current = null;
    }

    // Cancel incoming — revoke any blob URL to prevent memory leaks
    delete pendingRef.current[id];
    setIncoming((prev) =>
      prev.map((f) => {
        if (f.id === id) {
          if (f.blobUrl) {
            URL.revokeObjectURL(f.blobUrl);
            blobUrlsRef.current.delete(id);
          }
          return { ...f, status: "failed" as FileTransferStatus, error: "Cancelled" };
        }
        return f;
      })
    );

    // Notify peer
    if (ch && ch.readyState === "open") {
      const msg = JSON.stringify({ type: "file-cancel", id });
      const send = async () => {
        ch.send(key ? await signMessage(key, msg) : msg);
      };
      send().catch(() => {});
    }
  }, []);

  return { incoming, outgoing, sentFiles, sendFile, cancelTransfer };
}
