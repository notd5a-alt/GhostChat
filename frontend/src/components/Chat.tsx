import { useState, useRef, useEffect, type FormEvent } from "react";
import type { ChatMessage } from "../types";

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

interface ChatProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onCommand: (cmd: string) => void;
  cmdOutput: string | null;
  onReaction: (msgId: string, emoji: string) => void;
  onMarkRead: (msgId: string) => void;
  onTyping: (isTyping: boolean) => void;
  peerReadUpTo: string | null;
  peerTyping: boolean;
}

export default function Chat({
  messages,
  onSend,
  onCommand,
  cmdOutput,
  onReaction,
  onMarkRead,
  onTyping,
  peerReadUpTo,
  peerTyping,
}: ChatProps) {
  const [text, setText] = useState("");
  const [pickerMsgId, setPickerMsgId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastReadRef = useRef<string | null>(null);
  const seenMsgIds = useRef(new Set<string>());

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Auto-send read receipts for new peer messages
  useEffect(() => {
    const lastPeer = [...messages].reverse().find((m) => m.from === "peer");
    if (lastPeer && lastPeer.id !== lastReadRef.current) {
      lastReadRef.current = lastPeer.id;
      onMarkRead(lastPeer.id);
    }
  }, [messages, onMarkRead]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/")) {
      onCommand(trimmed);
    } else {
      onSend(trimmed);
    }
    setText("");
    onTyping(false);
  };

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.target.value);
    onTyping(true);
  };

  // Find the index of the last "you" message that the peer has read
  const lastReadIdx = peerReadUpTo
    ? messages.findIndex((m) => m.id === peerReadUpTo)
    : -1;

  return (
    <div className="chat">
      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && (
          <p className="empty">No messages yet. Say something!</p>
        )}
        {messages.map((m, i) => {
          const isNew = !seenMsgIds.current.has(m.id);
          if (isNew) seenMsgIds.current.add(m.id);
          return (
          <div
            key={m.id || i}
            className={`msg ${m.from}${isNew ? " msg-animate" : ""}`}
            onClick={() =>
              setPickerMsgId(pickerMsgId === m.id ? null : m.id)
            }
          >
            <span className="msg-sender">
              {m.from === "you" ? "> You" : "< Peer"}
            </span>
            <span className="msg-text">{m.content}</span>
            <span className="msg-time">
              {new Date(m.timestamp).toLocaleTimeString()}
            </span>
            {/* Reactions display */}
            {m.reactions && Object.keys(m.reactions).length > 0 && (
              <div className="msg-reactions">
                {Object.entries(m.reactions).map(([emoji, users]) => (
                  <button
                    key={emoji}
                    className={`reaction-badge ${
                      users.includes("you") ? "mine" : ""
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onReaction(m.id, emoji);
                    }}
                  >
                    {emoji} {users.length}
                  </button>
                ))}
              </div>
            )}
            {/* Reaction picker */}
            {pickerMsgId === m.id && (
              <div className="reaction-picker">
                {REACTION_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    className="reaction-pick"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReaction(m.id, emoji);
                      setPickerMsgId(null);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
            {/* Read receipt — show on the exact message the peer has read up to */}
            {m.from === "you" && i === lastReadIdx && (
              <span className="msg-read">SEEN</span>
            )}
          </div>
          );
        })}
      </div>
      {cmdOutput && (
        <pre className="cmd-output">{cmdOutput}</pre>
      )}
      {peerTyping && (
        <div className="typing-indicator">
          <span>Peer is typing</span>
          <span className="typing-dots">...</span>
        </div>
      )}
      <form className="chat-input" onSubmit={submit}>
        <input
          type="text"
          placeholder="Type a message..."
          value={text}
          onChange={handleInput}
          autoFocus
        />
        <button className="btn" type="submit" disabled={!text.trim()}>
          [ SEND ]
        </button>
      </form>
    </div>
  );
}
