import { useState, useCallback, useEffect, useRef } from "react";
import useSignaling from "./hooks/useSignaling";
import useWebRTC from "./hooks/useWebRTC";
import useConnectionMonitor from "./hooks/useConnectionMonitor";
import useDataChannel from "./hooks/useDataChannel";
import useFileTransfer from "./hooks/useFileTransfer";
import Home from "./components/Home";
import Lobby from "./components/Lobby";
import Chat from "./components/Chat";
import VideoCall from "./components/VideoCall";
import FileShare from "./components/FileShare";
import "./styles/index.css";

export default function App() {
  const [screen, setScreen] = useState("home"); // home | lobby | session
  const [mode, setMode] = useState(null); // host | join
  const [sigUrl, setSigUrl] = useState(null);
  const [hostAddr, setHostAddr] = useState("");
  const [activeTab, setActiveTab] = useState("chat"); // chat | video | files
  const [fingerprint, setFingerprint] = useState(null);
  const sigConnectedRef = useRef(false);

  const signaling = useSignaling(sigUrl);
  const isHost = mode === "host";
  const webrtc = useWebRTC(signaling, isHost);
  const monitor = useConnectionMonitor(webrtc.pcRef, signaling.state, webrtc.connectionState);
  const chat = useDataChannel(webrtc.chatChannel);
  const files = useFileTransfer(webrtc.fileChannel);

  // Transition to session once WebRTC connects
  useEffect(() => {
    if (webrtc.connectionState === "connected" && screen === "lobby") {
      setScreen("session");
      setFingerprint(webrtc.getFingerprint());
    }
  }, [webrtc.connectionState, screen, webrtc.getFingerprint]);

  // Handle peer disconnect during session
  useEffect(() => {
    if (screen === "session") {
      if (
        (webrtc.connectionState === "disconnected" && monitor.recoveryFailed) ||
        webrtc.connectionState === "new"
      ) {
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
      setHostAddr(`${data.ip}:${window.location.port || (window.location.protocol === "https:" ? "443" : "80")}`);
    } catch {
      setHostAddr(window.location.host);
    }
    const wsUrl = `${wsProto}://${window.location.host}/ws`;
    setSigUrl(wsUrl);
    setScreen("lobby");
  }, [wsProto]);

  const handleJoin = useCallback((addr) => {
    setMode("join");
    const wsUrl = `${wsProto}://${addr}/ws`;
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

  // Init WebRTC once signaling is open — fetch ICE config from backend first
  useEffect(() => {
    if (signaling.state === "open") {
      fetch("/api/ice-config")
        .then((r) => r.json())
        .then((config) => webrtc.init(config))
        .catch(() => webrtc.init(null)); // fallback to default STUN
    }
  }, [signaling.state, webrtc.init]);

  // Play ringtone when peer is in a call but local user hasn't joined yet
  const hasRemoteTracks = webrtc.remoteStream
    ?.getTracks()
    .some((t) => t.readyState === "live" && !t.muted);
  const wasInCallRef = useRef(false);

  useEffect(() => {
    if (webrtc.localStream) {
      wasInCallRef.current = true;
    }
  }, [webrtc.localStream]);

  // Reset when remote tracks disappear (peer ended their call)
  useEffect(() => {
    if (!hasRemoteTracks) {
      wasInCallRef.current = false;
    }
  }, [hasRemoteTracks]);

  useEffect(() => {
    if (hasRemoteTracks && !webrtc.localStream && !wasInCallRef.current) {
      const audio = new Audio("/ringtone.wav");
      audio.play().catch(() => {});
      return () => {
        audio.pause();
        audio.currentTime = 0;
        audio.src = "";
      };
    }
  }, [hasRemoteTracks, webrtc.localStream]);

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
    return <Home onHost={handleHost} onJoin={handleJoin} />;
  }

  if (screen === "lobby") {
    return (
      <Lobby
        isHost={isHost}
        hostAddr={hostAddr}
        connectionState={webrtc.connectionState}
        signalingState={signaling.state}
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
        <span className="brand">{"> "}GHOSTCHAT</span>
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
            Chat
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
        <button className="btn small danger" onClick={handleDisconnect}>
          [ DISCONNECT ]
        </button>
      </header>

      <main className="session-content">
        {activeTab === "chat" && (
          <Chat messages={chat.messages} onSend={chat.sendMessage} />
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
            isRecovering={monitor.isRecovering}
            recoveryFailed={monitor.recoveryFailed}
            signalingState={signaling.state}
          />
        )}
        {activeTab === "files" && (
          <FileShare
            incoming={files.incoming}
            outgoing={files.outgoing}
            onSendFile={files.sendFile}
          />
        )}
      </main>
    </div>
  );
}
