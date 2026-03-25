// Shared type definitions for Synced frontend

// --- Signaling ---

export type SignalingState = "closed" | "connecting" | "open" | "reconnecting";

export interface SignalingMessage {
  type: "offer" | "answer" | "ice-candidate" | "peer-joined" | "peer-disconnected";
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

export interface SignalingHook {
  connect: () => void;
  send: (obj: SignalingMessage) => void;
  disconnect: () => void;
  onMessage: (handler: (msg: SignalingMessage) => void) => void;
  state: SignalingState;
  debugLog: string[];
  addLog: (msg: string) => void;
}

// --- Connection monitoring ---

export type ConnectionQuality = "excellent" | "good" | "poor" | "critical";
export type ConnectionType = "direct" | "relay";

export interface ConnectionStats {
  rtt: number | null;
  packetLoss: number | null;
  bitrate: number | null;
  codec: string | null;
  resolution: string | null;
  fps: number | null;
}

// --- Audio processing ---

export interface AudioProcessingState {
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

// --- Chat ---

export interface ChatMessage {
  type: "text";
  id: string;
  content: string;
  timestamp: number;
  from: "you" | "peer";
  reactions: Record<string, string[]>;
}

export type PresenceStatus = "online" | "idle" | "away";

export type DataChannelMessage =
  | { type: "text"; id: string; content: string; timestamp: number }
  | { type: "reaction"; msgId: string; emoji: string }
  | { type: "read"; upTo: string }
  | { type: "typing"; isTyping: boolean }
  | { type: "presence"; status: PresenceStatus };

// --- File transfer ---

export type FileTransferStatus = "compressing" | "sending" | "receiving" | "paused" | "completed" | "failed";

export interface IncomingFile {
  id: string;
  name: string;
  size: number;
  compressedSize: number;
  progress: number;
  blobUrl: string | null;
  status: FileTransferStatus;
  error?: string;
}

export interface OutgoingFile {
  id: string;
  name: string;
  size: number;
  compressedSize: number;
  bytesSent: number;
  status: FileTransferStatus;
}

export type FileControlMessage =
  | { type: "file-meta"; id: string; name: string; size: number; mimeType: string; compressedSize: number; checksum: string }
  | { type: "file-end"; id: string }
  | { type: "file-resume-req"; id: string; receivedBytes: number; chunkIndex: number }
  | { type: "file-resume-ack"; id: string; resumeFromByte: number; resumeFromChunk: number }
  | { type: "file-cancel"; id: string };
