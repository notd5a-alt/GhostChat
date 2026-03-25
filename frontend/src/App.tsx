import { useState, useCallback, useEffect, useRef } from "react";
import useSignaling from "./hooks/useSignaling";
import useWebRTC from "./hooks/useWebRTC";
import useConnectionMonitor from "./hooks/useConnectionMonitor";
import useDataChannel from "./hooks/useDataChannel";
import useFileTransfer from "./hooks/useFileTransfer";
import useVAD from "./hooks/useVAD";
import useTheme from "./hooks/useTheme";
import Home from "./components/Home";
import Lobby from "./components/Lobby";
import Chat from "./components/Chat";
import VideoCall from "./components/VideoCall";
import FileShare from "./components/FileShare";
import ThemeSelector from "./components/ThemeSelector";
import { playPeerConnected, playPeerDisconnected } from "./utils/sounds";
import type { PresenceStatus } from "./types";
import "./styles/index.css";

type Screen = "home" | "lobby" | "session";
type Mode = "host" | "join" | null;
type Tab = "chat" | "video" | "files";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [mode, setMode] = useState<Mode>(null);
  const [sigUrl, setSigUrl] = useState<string | null>(null);
  const [hostAddr, setHostAddr] = useState("");
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [showThemePanel, setShowThemePanel] = useState(false);
  const sigConnectedRef = useRef(false);

  const signaling = useSignaling(sigUrl);
  const isHost = mode === "host";
  const webrtc = useWebRTC(signaling, isHost);
  const theme = useTheme();
  const monitor = useConnectionMonitor(webrtc.pcRef, signaling.state, webrtc.connectionState);
  const chat = useDataChannel(webrtc.chatChannel, webrtc.hmacKey);
  const files = useFileTransfer(webrtc.fileChannel, webrtc.hmacKey);
  const vad = useVAD(webrtc.localStream, webrtc.remoteStream);

  // Transition to session once WebRTC connects
  useEffect(() => {
    if (webrtc.connectionState === "connected" && screen === "lobby") {
      setScreen("session");
      setFingerprint(webrtc.getFingerprint());
      playPeerConnected();
    }
  }, [webrtc.connectionState, screen, webrtc.getFingerprint]);

  // Handle peer disconnect during session
  useEffect(() => {
    if (screen === "session") {
      if (
        (webrtc.connectionState === "disconnected" && monitor.recoveryFailed) ||
        webrtc.connectionState === "new"
      ) {
        playPeerDisconnected();
        setScreen("home");
        setMode(null);
        setSigUrl(null);
        signaling.disconnect();
      }
    }
  }, [webrtc.connectionState, screen, monitor.recoveryFailed, signaling.disconnect]);

  const wsProto = window.location.protocol === "https:" ? "wss" : "ws";

  const handleHost = useCallback(async () => {
    setMode("host");
    try {
      const res = await fetch("/api/info");
      const data = await res.json();
      setHostAddr(`${data.ip}:${data.port}`);
    } catch {
      setHostAddr(window.location.host);
    }
    const wsUrl = `${wsProto}://${window.location.host}/ws?role=host`;
    // debug: hosting wsUrl is logged to signaling debugLog instead
    setSigUrl(wsUrl);
    setScreen("lobby");
  }, [wsProto]);

  const handleJoin = useCallback((addr: string) => {
    setMode("join");
    // When joining a different address, the WebSocket goes directly to the
    // backend (not through Vite proxy), so always use ws:// (backend is HTTP-only).
    // Only use the page protocol when the address matches the current origin.
    const proto = addr === window.location.host ? wsProto : "ws";
    const wsUrl = `${proto}://${addr}/ws?role=join`;
    // debug: joining wsUrl is logged to signaling debugLog instead
    setSigUrl(wsUrl);
    setScreen("lobby");
  }, [wsProto]);

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
  // reinitCounter bumps on cleanup() so we also re-init after peer-disconnected
  // (connectionState may already be "new" if no answer was received, so it
  // can't be used as the trigger).
  useEffect(() => {
    if (signaling.state === "open") {
      signaling.addLog(`effect: init (reinit=${webrtc.reinitCounter})`);
      fetch("/api/ice-config")
        .then((r) => r.json())
        .then((config) => webrtc.init(config))
        .catch(() => webrtc.init(null));
    }
  }, [signaling.state, webrtc.reinitCounter, webrtc.init, signaling.addLog]);

  // Play ringtone when peer is in a call but local user hasn't joined yet
  const hasRemoteTracks = webrtc.remoteStream
    ?.getTracks()
    .some((t) => t.readyState === "live" && !t.muted);
  const wasInCallRef = useRef(false);
  const [callRejected, setCallRejected] = useState(false);

  useEffect(() => {
    if (webrtc.localStream) {
      wasInCallRef.current = true;
    }
  }, [webrtc.localStream]);

  // Reset when remote tracks disappear (peer ended their call)
  useEffect(() => {
    if (!hasRemoteTracks) {
      wasInCallRef.current = false;
      setCallRejected(false);
    }
  }, [hasRemoteTracks]);

  const incomingCall = hasRemoteTracks && !webrtc.localStream && !wasInCallRef.current && !callRejected;

  useEffect(() => {
    if (incomingCall) {
      const audio = new Audio("/ringtone.wav");
      audio.play().catch(() => {});
      return () => {
        audio.pause();
        audio.currentTime = 0;
        audio.src = "";
      };
    }
  }, [incomingCall]);

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
    webrtc.cleanup();
    signaling.disconnect();
    setScreen("home");
    setMode(null);
    setSigUrl(null);
    setHostAddr("");
    setFingerprint(null);
    chat.clearMessages();
  }, [webrtc.cleanup, signaling.disconnect, chat.clearMessages]);

  const handleRetry = useCallback(() => {
    webrtc.cleanup();
    monitor.setTimeoutExpired(false);
    // Re-init will be triggered by the signaling.state === "open" effect
    fetch("/api/ice-config")
      .then((r) => r.json())
      .then((config) => webrtc.init(config))
      .catch(() => webrtc.init(null));
  }, [webrtc.cleanup, webrtc.init, monitor.setTimeoutExpired]);

  if (screen === "home") {
    return <Home onHost={handleHost} onJoin={handleJoin} themeId={theme.themeId} onThemeChange={theme.setTheme} />;
  }

  if (screen === "lobby") {
    return (
      <Lobby
        isHost={isHost}
        hostAddr={hostAddr}
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
            stats={monitor.stats}
            localSpeaking={vad.localSpeaking}
            remoteSpeaking={vad.remoteSpeaking}
          />
        )}
        {activeTab === "files" && (
          <FileShare
            incoming={files.incoming}
            outgoing={files.outgoing}
            onSendFile={files.sendFile}
            onCancel={files.cancelTransfer}
          />
        )}
      </main>
    </div>
  );
}
