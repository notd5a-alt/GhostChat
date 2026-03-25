import { useState, useRef, useEffect } from "react";
import type { SignalingState } from "../types";

const SPINNER_CHARS = ["|", "/", "-", "\\"];

interface LobbyProps {
  isHost: boolean;
  hostAddr: string;
  connectionState: string;
  signalingState: SignalingState;
  signalingUrl: string | null;
  debugLog: string[];
  timeoutExpired: boolean;
  onRetry: () => void;
  onCancel: () => void;
}

export default function Lobby({
  isHost,
  hostAddr,
  connectionState,
  signalingState,
  signalingUrl,
  debugLog,
  timeoutExpired,
  onRetry,
  onCancel,
}: LobbyProps) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [spinIdx, setSpinIdx] = useState(0);

  useEffect(() => {
    return () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); };
  }, []);

  useEffect(() => {
    if (timeoutExpired) return;
    const id = setInterval(() => setSpinIdx((i) => (i + 1) % 4), 150);
    return () => clearInterval(id);
  }, [timeoutExpired]);

  const copyAddr = () => {
    navigator.clipboard.writeText(hostAddr).then(() => {
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    });
  };

  const status = timeoutExpired
    ? "Connection timed out."
    : connectionState === "connected"
    ? "Connected!"
    : connectionState === "connecting"
    ? "Connecting..."
    : signalingState === "reconnecting"
    ? "Reconnecting to server..."
    : signalingState === "open"
    ? "Waiting for peer..."
    : signalingState === "connecting"
    ? "Connecting to host..."
    : "Initializing...";

  return (
    <div className="lobby">
      <h2>{"> "}{isHost ? "HOSTING SESSION" : "JOINING SESSION"}</h2>

      {isHost && hostAddr && (
        <div className="addr-box">
          <span className="addr">{hostAddr}</span>
          <button className="btn small" onClick={copyAddr}>
            {copied ? "[ COPIED ]" : "[ COPY ]"}
          </button>
        </div>
      )}

      <p className="status-text">{status}</p>

      {timeoutExpired ? (
        <div className="lobby-actions">
          <button className="btn primary" onClick={onRetry}>
            Retry
          </button>
          <button className="btn" onClick={onCancel}>
            [ CANCEL ]
          </button>
        </div>
      ) : (
        <div className="lobby-actions">
          <span className="ascii-spinner">{SPINNER_CHARS[spinIdx]}</span>
          <button className="btn" onClick={onCancel}>
            [ CANCEL ]
          </button>
        </div>
      )}

      <div style={{
        marginTop: "2rem",
        padding: "0.75rem",
        background: "#111",
        border: "1px solid #333",
        borderRadius: "4px",
        fontSize: "0.7rem",
        fontFamily: "monospace",
        textAlign: "left",
        maxWidth: "500px",
        width: "100%",
        color: "#0f0",
      }}>
        <div style={{ marginBottom: "0.5rem", color: "#888" }}>
          // DIAG: role={isHost ? "host" : "join"} sig={signalingState} rtc={connectionState}
        </div>
        <div style={{ marginBottom: "0.5rem", color: "#888", wordBreak: "break-all" }}>
          // URL: {signalingUrl || "none"}
        </div>
        <div style={{ maxHeight: "120px", overflowY: "auto" }}>
          {debugLog.map((line, i) => {
            const lower = line.toLowerCase();
            const isError = lower.includes("error") || lower.includes("fail") || lower.includes("closed") || lower.includes("disconnected") || lower.includes("ignored");
            const isSuccess = lower.includes("connected") || lower.includes("open") || lower.includes("created") || lower.includes("sending") || lower.includes("init");
            const color = isError ? "#f55" : isSuccess ? "#6f6" : "#0f0";
            return <div key={i} style={{ color }}>{line}</div>;
          })}
        </div>
      </div>
    </div>
  );
}
