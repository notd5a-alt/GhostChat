import { useRef, type ChangeEvent, type DragEvent } from "react";
import type { IncomingFile, OutgoingFile } from "../types";
import type { SentFile } from "../hooks/useFileTransfer";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function compressionRatio(original: number, compressed: number): string {
  if (original === 0) return "0%";
  const ratio = ((1 - compressed / original) * 100).toFixed(0);
  return `${ratio}% smaller`;
}

function asciiProgressBar(progress: number, width = 20, paused = false): string {
  const filled = Math.round(progress * width);
  const empty = width - filled;
  const fillChar = paused ? "\u2592" : "\u2588";
  return "[" + fillChar.repeat(filled) + "\u2591".repeat(empty) + "] " + Math.round(progress * 100) + "%";
}

interface FileShareProps {
  incoming: IncomingFile[];
  outgoing: OutgoingFile | null;
  sentFiles: SentFile[];
  onSendFile: (file: File) => Promise<void>;
  onCancel?: (id: string) => void;
}

export default function FileShare({ incoming, outgoing, sentFiles, onSendFile, onCancel }: FileShareProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onSendFile(file);
    e.target.value = "";
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) onSendFile(file);
  };

  return (
    <div className="file-share">
      <div
        className="drop-zone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        {"> "}Drop a file here or click to select
        <input
          ref={inputRef}
          type="file"
          hidden
          onChange={handleFile}
        />
      </div>

      {outgoing && (
        <div className="transfer">
          <div className="transfer-header">
            <span className="transfer-name">
              {outgoing.status === "compressing" ? "Compressing" : "Sending"}: {outgoing.name}
            </span>
            {onCancel && (outgoing.status === "sending" || outgoing.status === "paused" || outgoing.status === "compressing") && (
              <button className="btn small danger" onClick={() => onCancel(outgoing.id)}>
                [ X ]
              </button>
            )}
          </div>
          {outgoing.status === "compressing" ? (
            <span className="ascii-progress" style={{ color: "var(--accent)" }}>
              {asciiProgressBar(0)} Compressing...
            </span>
          ) : (
            <>
              <span className={`ascii-progress ${outgoing.status === "paused" ? "paused" : ""}`}>
                {asciiProgressBar(
                  outgoing.compressedSize > 0 ? outgoing.bytesSent / outgoing.compressedSize : 0,
                  20,
                  outgoing.status === "paused"
                )}
                {outgoing.status === "paused" && " PAUSED"}
              </span>
              <span className="transfer-info">
                {formatSize(outgoing.bytesSent)} / {formatSize(outgoing.compressedSize)}
                {outgoing.compressedSize < outgoing.size && (
                  <span className="compression-badge">
                    {" "}({compressionRatio(outgoing.size, outgoing.compressedSize)})
                  </span>
                )}
              </span>
            </>
          )}
        </div>
      )}

      {incoming.map((f) => (
        <div key={f.id} className={`transfer ${f.status === "failed" ? "transfer-failed" : ""}${f.status === "completed" ? " transfer-done" : ""}`}>
          <div className="transfer-header">
            <span className="transfer-name">{f.name}</span>
            {f.warning && <span className="transfer-warning">{f.warning}</span>}
            <span className="transfer-direction">received</span>
            {onCancel && (f.status === "receiving" || f.status === "paused") && (
              <button className="btn small danger" onClick={() => onCancel(f.id)}>
                [ X ]
              </button>
            )}
          </div>
          {f.status === "completed" && f.blobUrl ? (
            <div>
              <a href={f.blobUrl} download={f.name} className="btn small">
                [ DOWNLOAD ({formatSize(f.size)}) ]
              </a>
              {f.compressedSize < f.size && (
                <span className="compression-badge">
                  {" "}Transferred {formatSize(f.compressedSize)} ({compressionRatio(f.size, f.compressedSize)})
                </span>
              )}
            </div>
          ) : f.status === "failed" ? (
            <span className="transfer-error">{f.error || "Transfer failed"}</span>
          ) : (
            <span className={`ascii-progress ${f.status === "paused" ? "paused" : ""}`}>
              {asciiProgressBar(f.progress, 20, f.status === "paused")}
              {f.status === "paused" && " PAUSED - reconnecting..."}
            </span>
          )}
        </div>
      ))}

      {sentFiles.map((f) => (
        <div key={f.id} className="transfer transfer-sent">
          <div className="transfer-header">
            <span className="transfer-name">{f.name}</span>
            <span className="transfer-direction">sent</span>
          </div>
          <span className="transfer-info">
            {formatSize(f.size)}
            {f.compressedSize < f.size && (
              <span className="compression-badge">
                {" "}({compressionRatio(f.size, f.compressedSize)})
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
