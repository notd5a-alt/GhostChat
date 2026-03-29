import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import AudioVisualizer from "./AudioVisualizer";
import GhostAsciiArt from "./GhostAsciiArt";
import DiagnosticsPanel from "./DiagnosticsPanel";
import type { ConnectionStats, ConnectionQuality, ConnectionType, AudioProcessingState } from "../types";
import type { AudioDevicesHook } from "../hooks/useAudioDevices";

interface VideoCallProps {
  localStream: MediaStream | null;
  remoteStream: MediaStream;
  remoteScreenStream: MediaStream;
  streamRevision: number;
  screenStream: MediaStream | null;
  onStartCall: (withVideo?: boolean) => Promise<void>;
  onEndCall: () => void;
  onToggleAudio: () => void;
  onToggleVideo: () => Promise<void>;
  onShareScreen: () => Promise<void>;
  onStopScreenShare: () => Promise<void>;
  callError: string | null;
  connectionQuality: ConnectionQuality | null;
  connectionType: ConnectionType | null;
  isRecovering: boolean;
  recoveryFailed: boolean;
  signalingState: string;
  audioProcessing: AudioProcessingState;
  onToggleAudioProcessing: (key: keyof AudioProcessingState) => Promise<void>;
  aiNsEnabled: boolean;
  onToggleAiNs: () => Promise<void>;
  stats: ConnectionStats | null;
  localSpeaking: boolean;
  remoteSpeaking: boolean;
  audioDevices: AudioDevicesHook;
  micLevel: number;
  remoteAudioRef: React.RefObject<HTMLVideoElement | null>;
  deafened: boolean;
  onToggleDeafen: () => void;
}

export default function VideoCall({
  localStream,
  remoteStream,
  remoteScreenStream,
  streamRevision,
  screenStream,
  onStartCall,
  onEndCall,
  onToggleAudio,
  onToggleVideo,
  onShareScreen,
  onStopScreenShare,
  callError,
  connectionQuality,
  connectionType,
  isRecovering,
  recoveryFailed,
  signalingState,
  audioProcessing,
  onToggleAudioProcessing,
  aiNsEnabled,
  onToggleAiNs,
  stats,
  localSpeaking,
  remoteSpeaking,
  audioDevices,
  micLevel,
  remoteAudioRef,
  deafened,
  onToggleDeafen,
}: VideoCallProps) {
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const remoteScreenRef = useRef<HTMLVideoElement>(null);
  const dualCameraRef = useRef<HTMLVideoElement>(null);
  const dualScreenRef = useRef<HTMLVideoElement>(null);
  const screenRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPip, setIsPip] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showDiag, setShowDiag] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  const [expandedView, setExpandedView] = useState<"camera" | "screen" | null>(null);

  // Share remoteRef with parent so useAudioDevices can call setSinkId on it
  useEffect(() => {
    if (remoteAudioRef) (remoteAudioRef as React.MutableRefObject<HTMLVideoElement | null>).current = remoteRef.current;
  }, [remoteAudioRef]);

  useEffect(() => {
    if (!localRef.current) return;
    // Clear srcObject when no video tracks to remove stale last frame
    const hasVideoTrack = localStream?.getVideoTracks().some((t) => t.readyState === "live");
    localRef.current.srcObject = hasVideoTrack ? localStream : null;
  }, [localStream]);

  // Assign srcObject only when the stream object changes (stable refs from useWebRTC).
  // streamRevision triggers re-evaluation of derived values but does NOT reassign srcObject
  // unless the underlying MediaStream reference actually changed.
  const prevRemoteRef = useRef<MediaStream | null>(null);
  useEffect(() => {
    if (remoteRef.current && remoteStream !== prevRemoteRef.current) {
      remoteRef.current.srcObject = remoteStream;
      prevRemoteRef.current = remoteStream;
    }
  }, [remoteStream, streamRevision]);

  const prevRemoteScreenRef = useRef<MediaStream | null>(null);
  useEffect(() => {
    if (remoteScreenRef.current && remoteScreenStream !== prevRemoteScreenRef.current) {
      remoteScreenRef.current.srcObject = remoteScreenStream;
      prevRemoteScreenRef.current = remoteScreenStream;
    }
  }, [remoteScreenStream, streamRevision]);

  // Dual-video srcObject assignment (stable — only on stream reference change)
  useEffect(() => {
    if (dualCameraRef.current) {
      dualCameraRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (dualScreenRef.current) {
      dualScreenRef.current.srcObject = remoteScreenStream;
    }
  }, [remoteScreenStream]);

  // Derive track state using streamRevision as a re-evaluation signal
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hasRemoteVideo = useMemo(() =>
    remoteStream.getVideoTracks().some((t) => t.readyState === "live" && !t.muted),
    [remoteStream, streamRevision]
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hasRemoteScreen = useMemo(() =>
    remoteScreenStream.getVideoTracks().some((t) => t.readyState === "live" && !t.muted),
    [remoteScreenStream, streamRevision]
  );
  const hasDualVideo = hasRemoteVideo && hasRemoteScreen;

  // Reset expanded view when dual video mode ends
  useEffect(() => {
    if (!hasDualVideo) setExpandedView(null);
  }, [hasDualVideo]);

  useEffect(() => {
    if (screenRef.current) screenRef.current.srcObject = screenStream || null;
  }, [screenStream]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hasRemoteTracks = useMemo(() =>
    remoteStream.getTracks().some((t) => t.readyState === "live" && !t.muted)
    || hasRemoteScreen,
    [remoteStream, streamRevision, hasRemoteScreen]
  );

  const audioEnabled = localStream?.getAudioTracks()[0]?.enabled;
  const hasVideo = localStream?.getVideoTracks().some((t) => t.readyState === "live" && !t.muted);
  const inCall = !!localStream;
  const isSharing = !!screenStream;

  // PiP support
  const pipSupported = typeof document !== "undefined" && "pictureInPictureEnabled" in document;

  const togglePip = useCallback(async () => {
    const video = remoteRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch (err) {
      console.error("PiP error:", err);
    }
  }, []);

  // Track PiP state changes
  useEffect(() => {
    const video = remoteRef.current;
    if (!video) return;
    const onEnter = () => setIsPip(true);
    const onLeave = () => setIsPip(false);
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, []);

  // Exit PiP when call ends
  useEffect(() => {
    if (!inCall && document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    }
  }, [inCall]);

  // Fullscreen support
  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch (err) {
      console.error("Fullscreen error:", err);
    }
  }, []);

  // Track fullscreen state
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  return (
    <div className="video-call" ref={containerRef}>
      <div className="video-container">
        {/* Always-mounted remote camera video (also carries audio) */}
        <video
          ref={remoteRef}
          className={`remote-video ${remoteSpeaking ? "speaking" : ""}`}
          autoPlay
          playsInline
          muted
          style={{
            display: inCall && hasRemoteVideo && !hasDualVideo ? "block"
              : inCall && hasDualVideo && expandedView === "camera" ? "block"
              : "none",
            cursor: inCall && ((hasRemoteVideo && !hasDualVideo) || expandedView === "camera") ? "pointer" : "default",
          }}
          role={inCall && ((hasRemoteVideo && !hasDualVideo) || expandedView === "camera") ? "button" : undefined}
          tabIndex={inCall && ((hasRemoteVideo && !hasDualVideo) || expandedView === "camera") ? 0 : undefined}
          aria-label={inCall && hasRemoteVideo && !hasDualVideo ? "Toggle fullscreen" : inCall && expandedView === "camera" ? "Return to split view" : undefined}
          onClick={inCall && hasRemoteVideo && !hasDualVideo ? toggleFullscreen : inCall && expandedView === "camera" ? () => setExpandedView(null) : undefined}
          onKeyDown={inCall && ((hasRemoteVideo && !hasDualVideo) || expandedView === "camera") ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); hasRemoteVideo && !hasDualVideo ? toggleFullscreen() : setExpandedView(null); } } : undefined}
        />
        {/* Always-mounted remote screen share video */}
        <video
          ref={remoteScreenRef}
          className="remote-video"
          autoPlay
          playsInline
          style={{
            display: inCall && !hasDualVideo && hasRemoteScreen && !hasRemoteVideo ? "block"
              : inCall && hasDualVideo && expandedView === "screen" ? "block"
              : "none",
            cursor: inCall && ((!hasDualVideo && hasRemoteScreen && !hasRemoteVideo) || expandedView === "screen") ? "pointer" : "default",
          }}
          role={inCall && ((!hasDualVideo && hasRemoteScreen && !hasRemoteVideo) || expandedView === "screen") ? "button" : undefined}
          tabIndex={inCall && ((!hasDualVideo && hasRemoteScreen && !hasRemoteVideo) || expandedView === "screen") ? 0 : undefined}
          aria-label={inCall && !hasDualVideo && hasRemoteScreen && !hasRemoteVideo ? "Toggle fullscreen" : inCall && expandedView === "screen" ? "Return to split view" : undefined}
          onClick={inCall && !hasDualVideo && hasRemoteScreen && !hasRemoteVideo ? toggleFullscreen : inCall && expandedView === "screen" ? () => setExpandedView(null) : undefined}
          onKeyDown={inCall && ((!hasDualVideo && hasRemoteScreen && !hasRemoteVideo) || expandedView === "screen") ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); !hasDualVideo && hasRemoteScreen && !hasRemoteVideo ? toggleFullscreen() : setExpandedView(null); } } : undefined}
        />
        {/* Dual video side-by-side layout — always mounted to avoid DOM churn */}
        <div className="dual-video-container"
             style={{ display: inCall && hasDualVideo && expandedView === null ? "flex" : "none" }}>
          <div
            className="dual-video-item"
            role="button"
            tabIndex={0}
            aria-label="Expand camera view"
            onClick={() => setExpandedView("camera")}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedView("camera"); } }}
          >
            <video
              ref={dualCameraRef}
              autoPlay
              playsInline
              muted
            />
            <span className="dual-video-label">CAMERA</span>
          </div>
          <div
            className="dual-video-item"
            role="button"
            tabIndex={0}
            aria-label="Expand screen share view"
            onClick={() => setExpandedView("screen")}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedView("screen"); } }}
          >
            <video
              ref={dualScreenRef}
              autoPlay
              playsInline
              muted
            />
            <span className="dual-video-label">SCREEN</span>
          </div>
        </div>
        {/* Expanded view hint */}
        {hasDualVideo && expandedView !== null && (
          <span className="expanded-video-hint">Click to return to split view</span>
        )}
        {inCall && !hasRemoteVideo && !hasRemoteScreen && (
          <AudioVisualizer stream={remoteStream} />
        )}
        {connectionType && inCall && (
          <span className={`connection-type ${connectionType === "relay" ? "relay" : ""}`}>
            {connectionType === "relay" ? "RELAY" : "DIRECT"}
          </span>
        )}
        {connectionQuality && inCall && (
          <span className={`quality-badge quality-${connectionQuality}`}>
            {connectionQuality === "excellent"
              ? "HD"
              : connectionQuality === "good"
              ? "Good"
              : connectionQuality === "poor"
              ? "Poor"
              : "Bad"}
          </span>
        )}
        {hasRemoteTracks && !hasRemoteVideo && !hasRemoteScreen && inCall && (
          <div className={`call-status-badge ${remoteSpeaking ? "speaking" : ""}`}>
            {remoteSpeaking ? "Peer Speaking" : "Voice Call Active"}
          </div>
        )}
        {!hasRemoteTracks && !inCall && <GhostAsciiArt />}
        {!hasRemoteTracks && inCall && (
          <p className="video-placeholder">Waiting for peer to join the call...</p>
        )}
        <video
          ref={localRef}
          className={`local-video ${localSpeaking ? "speaking" : ""}`}
          autoPlay
          playsInline
          muted
          style={{ display: inCall && hasVideo ? "block" : "none" }}
        />
        {isSharing && (
          <video
            ref={screenRef}
            className="screen-preview"
            autoPlay
            playsInline
            muted
          />
        )}
        {showDiag && inCall && (
          <DiagnosticsPanel
            stats={stats}
            connectionQuality={connectionQuality}
            connectionType={connectionType}
          />
        )}
      </div>
      {isRecovering && <p className="call-warning" role="status" aria-live="polite">Reconnecting...</p>}
      {recoveryFailed && (
        <p className="call-error" role="status" aria-live="polite">Connection lost. Please end and restart the call.</p>
      )}
      {signalingState === "reconnecting" && (
        <p className="call-warning" role="status" aria-live="polite">Signaling reconnecting...</p>
      )}
      {callError && <p className="call-error" role="status" aria-live="polite">{callError}</p>}
      {showDevices && inCall && (
        <div className="device-selector-panel">
          <div className="device-selector-row">
            <label className="device-label">MIC:</label>
            <select
              className="device-select"
              value={audioDevices.selectedInput}
              onChange={(e) => audioDevices.setInputDevice(e.target.value)}
            >
              {audioDevices.inputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
            <div className="mic-level-bar">
              <div
                className="mic-level-fill"
                style={{ width: `${micLevel}%` }}
              />
            </div>
          </div>
          <div className="device-selector-row">
            <label className="device-label">OUT:</label>
            <select
              className="device-select"
              value={audioDevices.selectedOutput}
              onChange={(e) => audioDevices.setOutputDevice(e.target.value)}
            >
              {audioDevices.outputDevices.length === 0 ? (
                <option value="">Default</option>
              ) : (
                audioDevices.outputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))
              )}
            </select>
          </div>
        </div>
      )}
      <div className="call-controls">
        {!inCall ? (
          <div className="controls-center">
            <button
              className="btn primary"
              onClick={() => onStartCall(false)}
              aria-label={hasRemoteTracks ? "Join call" : "Start call"}
            >
              {hasRemoteTracks ? "[ JOIN CALL ]" : "[ CALL ]"}
            </button>
          </div>
        ) : (
          <>
            <div className="controls-left">
              <button
                className={`btn ${audioEnabled ? "" : "muted"}`}
                onClick={onToggleAudio}
                aria-label={audioEnabled ? "Mute microphone" : "Unmute microphone"}
              >
                {audioEnabled ? "[ MIC ON ]" : "[ MIC OFF ]"}
              </button>
              <button
                className={`btn ${deafened ? "muted" : ""}`}
                onClick={onToggleDeafen}
                aria-label={deafened ? "Undeafen" : "Deafen"}
              >
                {deafened ? "[ UNDEAFEN ]" : "[ DEAFEN ]"}
              </button>
              <button
                className={`btn ${audioProcessing?.echoCancellation ? "" : "muted"}`}
                onClick={() => onToggleAudioProcessing("echoCancellation")}
                aria-label={audioProcessing?.echoCancellation ? "Disable echo cancellation" : "Enable echo cancellation"}
              >
                {audioProcessing?.echoCancellation ? "[ EC ON ]" : "[ EC OFF ]"}
              </button>
              <button
                className={`btn ${aiNsEnabled ? "active" : "muted"}`}
                onClick={onToggleAiNs}
                title="AI Noise Suppression (RNNoise neural network)"
                aria-label={aiNsEnabled ? "Disable AI noise suppression" : "Enable AI noise suppression"}
              >
                {aiNsEnabled ? "[ AI NS ON ]" : "[ AI NS ]"}
              </button>
              <button
                className={`btn ${showDevices ? "active" : ""}`}
                onClick={() => setShowDevices((d) => !d)}
                aria-label="Toggle audio device settings"
              >
                [ DEVICES ]
              </button>
            </div>
            <div className="controls-center">
              <button
                className={`btn ${hasVideo ? "active" : "muted"}`}
                onClick={onToggleVideo}
                aria-label={hasVideo ? "Turn off camera" : "Turn on camera"}
              >
                {hasVideo ? "[ CAM ON ]" : "[ CAM OFF ]"}
              </button>
              {!isSharing ? (
                <button className="btn" onClick={onShareScreen} aria-label="Share screen">
                  [ SHARE ]
                </button>
              ) : (
                <button className="btn muted" onClick={onStopScreenShare} aria-label="Stop sharing screen">
                  [ STOP SHARE ]
                </button>
              )}
              {pipSupported && hasRemoteVideo && (
                <button className="btn" onClick={togglePip} aria-label={isPip ? "Exit picture-in-picture" : "Enter picture-in-picture"}>
                  {isPip ? "[ EXIT PIP ]" : "[ PIP ]"}
                </button>
              )}
              <button className="btn" onClick={toggleFullscreen} aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}>
                {isFullscreen ? "[ EXIT FS ]" : "[ FULLSCREEN ]"}
              </button>
            </div>
            <div className="controls-right">
              <button
                className={`btn ${showDiag ? "active" : ""}`}
                onClick={() => setShowDiag((d) => !d)}
                aria-label="Toggle diagnostics panel"
              >
                [ DIAG ]
              </button>
              <button className="btn danger" onClick={onEndCall} aria-label="End call">
                [ END CALL ]
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
