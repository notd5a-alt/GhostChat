import { useState, useCallback, useEffect, useRef } from "react";
import useSignaling from "./hooks/useSignaling";
import useWebRTC from "./hooks/useWebRTC";
import useConnectionMonitor from "./hooks/useConnectionMonitor";
import useDataChannel from "./hooks/useDataChannel";
import useFileTransfer from "./hooks/useFileTransfer";
import useNoiseSuppression, { preloadRnnoise } from "./hooks/useNoiseSuppression";
import useVAD from "./hooks/useVAD";
import useTheme from "./hooks/useTheme";
import useAudioDevices from "./hooks/useAudioDevices";
import useMicLevel from "./hooks/useMicLevel";
import Home from "./components/Home";
import Lobby from "./components/Lobby";
import Chat from "./components/Chat";
import VideoCall from "./components/VideoCall";
import FileShare from "./components/FileShare";
import ThemeSelector from "./components/ThemeSelector";
import { playPeerConnected, playPeerDisconnected, warmUpAudio, preloadRingtone, startRingtone, stopRingtone } from "./utils/sounds";
import { getApiBaseUrl, getWsBaseUrl } from "./config";
import type { PresenceStatus } from "./types";
import "./styles/index.css";

type Screen = "home" | "lobby" | "session";
type Mode = "host" | "join" | null;
type Tab = "chat" | "video" | "files";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [mode, setMode] = useState<Mode>(null);
  const [sigUrl, setSigUrl] = useState<string | null>(null);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [showThemePanel, setShowThemePanel] = useState(false);
  const sigConnectedRef = useRef(false);
  const nsAutoEnabledRef = useRef(false);

  const signaling = useSignaling(sigUrl);
  const isHost = mode === "host";
  const webrtc = useWebRTC(signaling, isHost);
  const theme = useTheme();
  const monitor = useConnectionMonitor(webrtc.pcRef, signaling.state, webrtc.connectionState);
  const chat = useDataChannel(webrtc.chatChannel, webrtc.hmacKey);
  const files = useFileTransfer(webrtc.fileChannel, webrtc.hmacKey);
  const vad = useVAD(webrtc.localStream, webrtc.remoteStream);
  const remoteAudioRef = useRef<HTMLVideoElement | null>(null);
  const audioDevices = useAudioDevices(
    webrtc.localStreamRef,
    webrtc.pcRef,
    remoteAudioRef,
    webrtc.setLocalStream,
    webrtc.localStream,
  );
  const micLevel = useMicLevel(webrtc.localStream);
  const noiseSuppression = useNoiseSuppression();

  // Transition to session once WebRTC connects
  useEffect(() => {
    if (webrtc.connectionState === "connected" && screen === "lobby") {
      setScreen("session");
      setFingerprint(webrtc.getFingerprint());
      playPeerConnected();
    }
  }, [webrtc.connectionState, screen, webrtc.getFingerprint]);

  // Full state reset — shared by handleDisconnect and peer-disconnect effect.
  // Idempotent: webrtc.cleanup() no-ops if PC is already null.
  const fullReset = useCallback(() => {
    nsAutoEnabledRef.current = false;
    noiseSuppression.teardown();
    webrtc.cleanup();
    signaling.disconnect();
    setScreen("home");
    setMode(null);
    setSigUrl(null);
    setRoomCode(null);
    setRoomError(null);
    setFingerprint(null);
    chat.clearMessages();
    setActiveTab("chat");
    setLastSeenSeq(0);
    setUnreadDismissed(false);
  }, [webrtc.cleanup, signaling.disconnect, chat.clearMessages, noiseSuppression.teardown]);

  // Handle peer disconnect during session
  useEffect(() => {
    if (screen === "session") {
      if (
        (webrtc.connectionState === "disconnected" && monitor.recoveryFailed) ||
        webrtc.connectionState === "new"
      ) {
        playPeerDisconnected();
        fullReset();
      }
    }
  }, [webrtc.connectionState, screen, monitor.recoveryFailed, fullReset]);

  const wsProto = window.location.protocol === "https:" ? "wss" : "ws";

  // Pre-load ringtone audio and RNNoise WASM on mount
  useEffect(() => {
    preloadRingtone();
    preloadRnnoise();
  }, []);

  // Auto-enable AI noise suppression once when a call starts
  useEffect(() => {
    if (nsAutoEnabledRef.current || noiseSuppression.enabled || !webrtc.localStream) return;
    nsAutoEnabledRef.current = true;
    const track = webrtc.localStreamRef.current?.getAudioTracks()[0];
    if (track) {
      noiseSuppression.toggle(track, webrtc.pcRef, webrtc.localStreamRef).then((newTrack) => {
        if (newTrack) {
          webrtc.setLocalStream((s) => s ? new MediaStream(s.getTracks()) : s);
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webrtc.localStream]);

  const handleCreateRoom = useCallback(async () => {
    // Defensive: tear down any leftover state from a previous session
    fullReset();
    warmUpAudio();
    setMode("host");
    setRoomError(null);
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/rooms`, { method: "POST" });
      if (!res.ok) throw new Error("Server at capacity");
      const { room_code, token } = await res.json();
      setRoomCode(room_code);
      const wsUrl = `${getWsBaseUrl()}/ws/${room_code}?role=host&token=${encodeURIComponent(token)}`;
      setSigUrl(wsUrl);
      setScreen("lobby");
    } catch (err) {
      setRoomError(err instanceof Error ? err.message : "Failed to create room");
      setMode(null);
    }
  }, [fullReset]);

  const handleJoinRoom = useCallback(async (code: string) => {
    // Defensive: tear down any leftover state from a previous session
    fullReset();
    warmUpAudio();
    setMode("join");
    setRoomError(null);
    const upper = code.toUpperCase().trim();

    // Backward compat: if contains ":", treat as IP:port (old direct-connect flow)
    if (upper.includes(":")) {
      const proto = upper === window.location.host ? wsProto : "ws";
      setSigUrl(`${proto}://${upper}/ws?role=join`);
      setScreen("lobby");
      return;
    }

    // Validate room code format before any network calls (URL safety + enumeration defense)
    if (!/^[A-HJKL-NP-Z2-9]{6}$/.test(upper)) {
      setRoomError("Invalid room code. Codes are 6 characters (letters and numbers).");
      setMode(null);
      return;
    }

    let roomToken = "";
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/rooms/${upper}`);
      const data = await res.json();
      if (!data.exists) {
        setRoomError("Room not found. Check the code and try again.");
        setMode(null);
        return;
      }
      if (!data.joinable) {
        setRoomError("Room is full.");
        setMode(null);
        return;
      }
      roomToken = data.token || "";
    } catch {
      setRoomError("Could not reach signaling server.");
      setMode(null);
      return;
    }

    setRoomCode(upper);
    setSigUrl(`${getWsBaseUrl()}/ws/${upper}?role=join&token=${encodeURIComponent(roomToken)}`);
    setScreen("lobby");
  }, [fullReset, wsProto]);

  // Connect signaling once URL is set (only once per sigUrl to avoid infinite reconnect loop)
  useEffect(() => {
    if (sigUrl && signaling.state === "closed" && !sigConnectedRef.current) {
      sigConnectedRef.current = true;
      signaling.connect();
    }
    if (!sigUrl) {
      sigConnectedRef.current = false;
    }
  }, [sigUrl, signaling.state, signaling.connect]);

  // Init WebRTC once signaling is open — fetch ICE config from backend first.
  // Only fires when signaling.state transitions to "open" (initial connect or
  // reconnect after disconnect). handleRetry() calls init() directly for retries.
  useEffect(() => {
    if (signaling.state === "open") {
      let cancelled = false;
      signaling.addLog("effect: init");
      fetch(`${getApiBaseUrl()}/api/ice-config`)
        .then((r) => r.json())
        .then((config) => { if (!cancelled) webrtc.init(config); })
        .catch(() => { if (!cancelled) webrtc.init(null); });
      return () => { cancelled = true; };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signaling.state, webrtc.init, signaling.addLog]);

  // Ringtone logic — plays for both caller (ringback) and receiver (incoming)
  const hasRemoteTracks = webrtc.remoteStream
    .getTracks()
    .some((t) => t.readyState === "live" && !t.muted);
  const wasInCallRef = useRef(false);
  const [callRejected, setCallRejected] = useState(false);
  const peerEverJoinedCallRef = useRef(false);

  useEffect(() => {
    if (webrtc.localStream) {
      wasInCallRef.current = true;
    }
  }, [webrtc.localStream]);

  // Track whether the remote peer ever answered (prevents ringtone after mid-call hangup)
  useEffect(() => {
    if (hasRemoteTracks && webrtc.localStream) {
      peerEverJoinedCallRef.current = true;
    }
    if (!webrtc.localStream) {
      peerEverJoinedCallRef.current = false;
    }
  }, [hasRemoteTracks, webrtc.localStream]);

  // Reset when remote tracks disappear (peer ended their call)
  useEffect(() => {
    if (!hasRemoteTracks) {
      wasInCallRef.current = false;
      setCallRejected(false);
    }
  }, [hasRemoteTracks]);

  const incomingCall = hasRemoteTracks && !webrtc.localStream && !wasInCallRef.current && !callRejected;
  const outgoingRinging = screen === "session"
    && !!webrtc.localStream
    && !hasRemoteTracks
    && !peerEverJoinedCallRef.current;
  const ringing = incomingCall || outgoingRinging;

  useEffect(() => {
    if (ringing) {
      startRingtone();
      return () => stopRingtone();
    }
  }, [ringing]);

  // Unread message notification when not on chat tab
  const [lastSeenSeq, setLastSeenSeq] = useState(0);
  const [unreadDismissed, setUnreadDismissed] = useState(false);

  const unreadCount = chat.peerMsgSeq - lastSeenSeq;

  // Mark all as read when switching to chat tab
  useEffect(() => {
    if (activeTab === "chat") {
      setLastSeenSeq(chat.peerMsgSeq);
      setUnreadDismissed(false);
    }
  }, [activeTab, chat.peerMsgSeq]);

  // Reset dismissed flag when new messages arrive after dismiss
  useEffect(() => {
    if (unreadCount > 0 && unreadDismissed) {
      setUnreadDismissed(false);
    }
  }, [chat.peerMsgSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasUnread = unreadCount > 0 && activeTab !== "chat" && !unreadDismissed;

  // Presence detection: online / idle / away
  const presenceRef = useRef<PresenceStatus>("online");
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (screen !== "session") return;

    const sendIfChanged = (status: PresenceStatus) => {
      if (presenceRef.current !== status) {
        presenceRef.current = status;
        chat.sendPresence(status);
      }
    };

    const resetIdle = () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (document.visibilityState === "visible") {
        sendIfChanged("online");
        idleTimerRef.current = setTimeout(() => sendIfChanged("idle"), 60000);
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
        sendIfChanged("away");
      } else {
        resetIdle();
      }
    };

    const handleActivity = () => resetIdle();

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleActivity);
    window.addEventListener("mousemove", handleActivity);
    window.addEventListener("keydown", handleActivity);

    // Send initial online status
    chat.sendPresence("online");
    resetIdle();

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleActivity);
      window.removeEventListener("mousemove", handleActivity);
      window.removeEventListener("keydown", handleActivity);
    };
  }, [screen, chat.sendPresence, webrtc.chatChannel]);

  // Command palette — handles /slash commands from chat input
  const [cmdOutput, setCmdOutput] = useState<string | null>(null);
  const cmdOutputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCommand = useCallback((cmd: string) => {
    const parts = cmd.trim().split(/\s+/);
    const name = parts[0].toLowerCase();
    let output: string | null = null;

    switch (name) {
      case "/clear":
        chat.clearMessages();
        output = "Messages cleared.";
        break;
      case "/fingerprint":
        output = fingerprint
          ? `DTLS Fingerprint:\n${fingerprint}`
          : "No fingerprint available (not connected).";
        break;
      case "/diag":
        setActiveTab("video");
        output = "Switched to Call tab. Click [ DIAG ] to view diagnostics.";
        break;
      case "/stats": {
        const s = monitor.stats;
        output = s
          ? `RTT: ${s.rtt != null ? Math.round(s.rtt) + "ms" : "--"}\nLoss: ${s.packetLoss != null ? s.packetLoss.toFixed(1) + "%" : "--"}\nBitrate: ${s.bitrate != null ? Math.round(s.bitrate / 1000) + " kbps" : "--"}\nQuality: ${monitor.connectionQuality || "--"}\nType: ${monitor.connectionType || "--"}`
          : "No stats available (not in a call).";
        break;
      }
      case "/whoami":
        output = `Role: ${isHost ? "HOST" : "JOINER"}\nPeer presence: ${chat.peerPresence || "unknown"}`;
        break;
      case "/theme": {
        const themeName = parts[1]?.toLowerCase();
        if (themeName) {
          const found = theme.themes.find((t) => t.id === themeName || t.name.toLowerCase() === themeName);
          if (found) {
            theme.setTheme(found.id);
            output = `Theme set to: ${found.name}`;
          } else {
            output = `Unknown theme: ${themeName}\nAvailable: ${theme.themes.map((t) => t.id).join(", ")}`;
          }
        } else {
          output = `Current theme: ${theme.themeId}\nAvailable: ${theme.themes.map((t) => t.id).join(", ")}\nUsage: /theme <name>`;
        }
        break;
      }
      case "/help":
        output = [
          "Available commands:",
          "  /clear        — Clear chat messages",
          "  /fingerprint  — Show DTLS fingerprint",
          "  /diag         — Open diagnostics panel",
          "  /stats        — Show connection stats",
          "  /whoami       — Show your role and peer status",
          "  /theme [name] — Change color theme",
          "  /help         — Show this help",
        ].join("\n");
        break;
      default:
        output = `Unknown command: ${name}\nType /help for available commands.`;
    }

    if (output) {
      setCmdOutput(output);
      if (cmdOutputTimerRef.current) clearTimeout(cmdOutputTimerRef.current);
      cmdOutputTimerRef.current = setTimeout(() => setCmdOutput(null), 8000);
    }
  }, [fingerprint, monitor.stats, monitor.connectionQuality, monitor.connectionType, isHost, chat.peerPresence, chat.clearMessages, theme]);

  const handleDisconnect = useCallback(() => {
    fullReset();
  }, [fullReset]);

  const handleRetry = useCallback(() => {
    webrtc.cleanup();
    monitor.setTimeoutExpired(false);
    // Re-init will be triggered by the signaling.state === "open" effect
    fetch(`${getApiBaseUrl()}/api/ice-config`)
      .then((r) => r.json())
      .then((config) => webrtc.init(config))
      .catch(() => webrtc.init(null));
  }, [webrtc.cleanup, webrtc.init, monitor.setTimeoutExpired]);

  if (screen === "home") {
    return <Home onCreateRoom={handleCreateRoom} onJoinRoom={handleJoinRoom} roomError={roomError} themeId={theme.themeId} onThemeChange={theme.setTheme} />;
  }

  if (screen === "lobby") {
    return (
      <Lobby
        isHost={isHost}
        roomCode={roomCode}
        connectionState={webrtc.connectionState}
        signalingState={signaling.state}
        signalingUrl={sigUrl}
        debugLog={signaling.debugLog}
        timeoutExpired={monitor.timeoutExpired}
        onRetry={handleRetry}
        onCancel={handleDisconnect}
      />
    );
  }

  return (
    <div className="session">
      <header className="session-header">
        <img src="/logo.png" alt="" className="header-logo" />
        <span className="brand">{"> "}SYNCED</span>
        {chat.peerPresence && (
          <span className={`presence-indicator ${chat.peerPresence}`}>
            <span className="presence-dot" />
            {chat.peerPresence !== "online" && chat.peerPresence.toUpperCase()}
          </span>
        )}
        {fingerprint && (
          <span className="fingerprint" title="DTLS fingerprint — verify with your peer">
            {fingerprint.slice(0, 20)}...
          </span>
        )}
        <nav className="tabs">
          <button
            className={activeTab === "chat" ? "active" : ""}
            onClick={() => setActiveTab("chat")}
          >
            Chat{unreadCount > 0 && activeTab !== "chat" && (
              <span className="tab-badge">{unreadCount}</span>
            )}
          </button>
          <button
            className={activeTab === "video" ? "active" : ""}
            onClick={() => setActiveTab("video")}
          >
            Call
          </button>
          <button
            className={activeTab === "files" ? "active" : ""}
            onClick={() => setActiveTab("files")}
          >
            Files
          </button>
        </nav>
        <button
          className={`btn small ${showThemePanel ? "active" : ""}`}
          onClick={() => setShowThemePanel((s) => !s)}
        >
          [ THEME ]
        </button>
        <button className="btn small danger" onClick={handleDisconnect}>
          [ DISCONNECT ]
        </button>
      </header>

      {showThemePanel && (
        <div className="theme-panel">
          <ThemeSelector currentTheme={theme.themeId} onSelect={theme.setTheme} />
        </div>
      )}

      {incomingCall && (
        <div className="incoming-call-pill">
          <span className="pill-pulse" />
          <span className="pill-text">INCOMING CALL</span>
          <button
            className="btn small primary"
            onClick={() => {
              setActiveTab("video");
              webrtc.startCall(false);
            }}
          >
            [ JOIN ]
          </button>
          <button
            className="btn small pill-reject"
            onClick={() => setCallRejected(true)}
          >
            [ REJECT ]
          </button>
        </div>
      )}

      {hasUnread && (
        <div className="incoming-call-pill message-pill">
          <span className="pill-pulse message-pulse" />
          <span className="pill-text">NEW MESSAGE{unreadCount > 1 ? `S (${unreadCount})` : ""}</span>
          <button
            className="btn small primary"
            onClick={() => setActiveTab("chat")}
          >
            [ VIEW ]
          </button>
          <button
            className="btn small pill-dismiss"
            onClick={() => { setUnreadDismissed(true); setLastSeenSeq(chat.peerMsgSeq); }}
          >
            [ DISMISS ]
          </button>
        </div>
      )}

      <main className="session-content">
        {activeTab === "chat" && (
          <Chat
            messages={chat.messages}
            onSend={chat.sendMessage}
            onCommand={handleCommand}
            cmdOutput={cmdOutput}
            onReaction={chat.sendReaction}
            onMarkRead={chat.sendReadReceipt}
            onTyping={chat.sendTyping}
            peerReadUpTo={chat.peerReadUpTo}
            peerTyping={chat.peerTyping}
          />
        )}
        {activeTab === "video" && (
          <VideoCall
            localStream={webrtc.localStream}
            remoteStream={webrtc.remoteStream}
            remoteScreenStream={webrtc.remoteScreenStream}
            streamRevision={webrtc.streamRevision}
            screenStream={webrtc.screenStream}
            onStartCall={webrtc.startCall}
            onEndCall={webrtc.endCall}
            onToggleAudio={webrtc.toggleAudio}
            onToggleVideo={webrtc.toggleVideo}
            onShareScreen={webrtc.shareScreen}
            onStopScreenShare={webrtc.stopScreenShare}
            callError={webrtc.callError}
            connectionQuality={monitor.connectionQuality}
            connectionType={monitor.connectionType}
            isRecovering={monitor.isRecovering}
            recoveryFailed={monitor.recoveryFailed}
            signalingState={signaling.state}
            audioProcessing={webrtc.audioProcessing}
            onToggleAudioProcessing={webrtc.toggleAudioProcessing}
            aiNsEnabled={noiseSuppression.enabled}
            onToggleAiNs={async () => {
              const track = webrtc.localStreamRef.current?.getAudioTracks()[0];
              if (!track) return;
              const newTrack = await noiseSuppression.toggle(track, webrtc.pcRef, webrtc.localStreamRef);
              if (newTrack) {
                webrtc.setLocalStream((s) =>
                  s ? new MediaStream(s.getTracks()) : s,
                );
              }
            }}
            stats={monitor.stats}
            localSpeaking={vad.localSpeaking}
            remoteSpeaking={vad.remoteSpeaking}
            audioDevices={audioDevices}
            micLevel={micLevel}
            remoteAudioRef={remoteAudioRef}
          />
        )}
        {activeTab === "files" && (
          <FileShare
            incoming={files.incoming}
            outgoing={files.outgoing}
            sentFiles={files.sentFiles}
            onSendFile={files.sendFile}
            onCancel={files.cancelTransfer}
          />
        )}
      </main>
    </div>
  );
}
