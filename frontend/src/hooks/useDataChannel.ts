import { useState, useCallback, useEffect, useRef } from "react";
import { signMessage, verifyMessage } from "../utils/channelAuth";
import { playMessageReceived, playMessageSent } from "../utils/sounds";
import type { ChatMessage, PresenceStatus, DataChannelMessage } from "../types";

async function signAndSend(
  ch: RTCDataChannel,
  key: CryptoKey | null,
  obj: DataChannelMessage
): Promise<void> {
  const raw = JSON.stringify(obj);
  if (key) {
    ch.send(await signMessage(key, raw));
  } else {
    ch.send(raw);
  }
}

export interface DataChannelHook {
  messages: ChatMessage[];
  peerMsgSeq: number;
  sendMessage: (text: string) => void;
  clearMessages: () => void;
  sendReaction: (msgId: string, emoji: string) => void;
  sendReadReceipt: (msgId: string) => void;
  peerReadUpTo: string | null;
  peerTyping: boolean;
  sendTyping: (isTyping: boolean) => void;
  peerPresence: PresenceStatus | null;
  sendPresence: (status: PresenceStatus) => void;
}

export default function useDataChannel(
  channel: RTCDataChannel | null,
  hmacKey: CryptoKey | null
): DataChannelHook {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [peerMsgSeq, setPeerMsgSeq] = useState(0);
  const [peerReadUpTo, setPeerReadUpTo] = useState<string | null>(null);
  const [peerTyping, setPeerTyping] = useState(false);
  const [peerPresence, setPeerPresence] = useState<PresenceStatus | null>(null);
  const channelRef = useRef(channel);
  const hmacKeyRef = useRef(hmacKey);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peerTypingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSentRef = useRef(false);

  useEffect(() => {
    hmacKeyRef.current = hmacKey;
  }, [hmacKey]);

  useEffect(() => {
    channelRef.current = channel;
    if (!channel) {
      // Reset typing indicator when channel closes to prevent stuck state
      setPeerTyping(false);
      if (peerTypingTimeoutRef.current) clearTimeout(peerTypingTimeoutRef.current);
      return;
    }

    const handler = async (e: MessageEvent) => {
      try {
        let parsed: DataChannelMessage;
        const key = hmacKeyRef.current;
        if (key) {
          const payload = await verifyMessage(key, e.data);
          if (!payload) {
            console.warn("HMAC verification failed, dropping message");
            return;
          }
          parsed = JSON.parse(payload);
        } else {
          // No key yet — try to unwrap envelope or parse raw
          try {
            const outer = JSON.parse(e.data);
            parsed = outer.p ? JSON.parse(outer.p) : outer;
          } catch {
            parsed = JSON.parse(e.data);
          }
        }

        if (parsed.type === "text") {
          setMessages((prev) => [
            ...prev,
            { ...parsed, from: "peer", reactions: {} },
          ]);
          setPeerMsgSeq((s) => s + 1);
          playMessageReceived();
        } else if (parsed.type === "reaction") {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== parsed.msgId) return m;
              const reactions = { ...m.reactions };
              if (reactions[parsed.emoji]?.includes("peer")) {
                reactions[parsed.emoji] = reactions[parsed.emoji].filter(
                  (f) => f !== "peer"
                );
                if (reactions[parsed.emoji].length === 0)
                  delete reactions[parsed.emoji];
              } else {
                reactions[parsed.emoji] = [
                  ...(reactions[parsed.emoji] || []),
                  "peer",
                ];
              }
              return { ...m, reactions };
            })
          );
        } else if (parsed.type === "read") {
          setPeerReadUpTo(parsed.upTo);
        } else if (parsed.type === "typing") {
          setPeerTyping(parsed.isTyping);
          if (peerTypingTimeoutRef.current) clearTimeout(peerTypingTimeoutRef.current);
          if (parsed.isTyping) {
            peerTypingTimeoutRef.current = setTimeout(
              () => setPeerTyping(false),
              4000
            );
          }
        } else if (parsed.type === "presence") {
          setPeerPresence(parsed.status);
        }
      } catch { /* parse error */ }
    };
    channel.addEventListener("message", handler);
    return () => {
      channel.removeEventListener("message", handler);
      if (peerTypingTimeoutRef.current) clearTimeout(peerTypingTimeoutRef.current);
    };
  }, [channel]);

  const sendMessage = useCallback((text: string) => {
    const ch = channelRef.current;
    if (!ch || ch.readyState !== "open") return;
    const msg: DataChannelMessage = {
      type: "text",
      id: crypto.randomUUID(),
      content: text,
      timestamp: Date.now(),
    };
    signAndSend(ch, hmacKeyRef.current, msg).catch((err) =>
      console.warn("Failed to send message:", err)
    );
    setMessages((prev) => [...prev, { ...msg, from: "you", reactions: {} }]);
    playMessageSent();
  }, []);

  const sendReaction = useCallback((msgId: string, emoji: string) => {
    const ch = channelRef.current;
    if (!ch || ch.readyState !== "open") return;
    signAndSend(ch, hmacKeyRef.current, { type: "reaction", msgId, emoji }).catch(() => {});
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== msgId) return m;
        const reactions = { ...m.reactions };
        if (reactions[emoji]?.includes("you")) {
          reactions[emoji] = reactions[emoji].filter((f) => f !== "you");
          if (reactions[emoji].length === 0) delete reactions[emoji];
        } else {
          reactions[emoji] = [...(reactions[emoji] || []), "you"];
        }
        return { ...m, reactions };
      })
    );
  }, []);

  const sendReadReceipt = useCallback((msgId: string) => {
    const ch = channelRef.current;
    if (!ch || ch.readyState !== "open") return;
    signAndSend(ch, hmacKeyRef.current, { type: "read", upTo: msgId }).catch(() => {});
  }, []);

  const sendTyping = useCallback((isTyping: boolean) => {
    const ch = channelRef.current;
    if (!ch || ch.readyState !== "open") return;

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

    if (isTyping) {
      if (!lastTypingSentRef.current) {
        signAndSend(ch, hmacKeyRef.current, { type: "typing", isTyping: true }).catch(() => {});
        lastTypingSentRef.current = true;
      }
      typingTimeoutRef.current = setTimeout(() => {
        signAndSend(ch, hmacKeyRef.current, { type: "typing", isTyping: false }).catch(() => {});
        lastTypingSentRef.current = false;
      }, 3000);
    } else {
      if (lastTypingSentRef.current) {
        signAndSend(ch, hmacKeyRef.current, { type: "typing", isTyping: false }).catch(() => {});
        lastTypingSentRef.current = false;
      }
    }
  }, []);

  const sendPresence = useCallback((status: PresenceStatus) => {
    const ch = channelRef.current;
    if (!ch || ch.readyState !== "open") return;
    signAndSend(ch, hmacKeyRef.current, { type: "presence", status }).catch(() => {});
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setPeerMsgSeq(0);
    setPeerReadUpTo(null);
    setPeerTyping(false);
    setPeerPresence(null);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    if (peerTypingTimeoutRef.current) clearTimeout(peerTypingTimeoutRef.current);
    lastTypingSentRef.current = false;
  }, []);

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (peerTypingTimeoutRef.current) clearTimeout(peerTypingTimeoutRef.current);
    };
  }, []);

  return {
    messages,
    peerMsgSeq,
    sendMessage,
    clearMessages,
    sendReaction,
    sendReadReceipt,
    peerReadUpTo,
    peerTyping,
    sendTyping,
    peerPresence,
    sendPresence,
  };
}
