import { useRef, useState, useCallback, useEffect, type MutableRefObject } from "react";
import { deriveHmacKey } from "../utils/channelAuth";
import { preferVideoCodecs, preferAudioCodecs, optimizeOpusInSDP } from "../utils/codecConfig";
import type { SignalingHook, SignalingMessage, AudioProcessingState } from "../types";

const DEFAULT_ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ],
};

export interface WebRTCHook {
  init: (iceConfig: RTCConfiguration | null) => void;
  connectionState: string;
  chatChannel: RTCDataChannel | null;
  fileChannel: RTCDataChannel | null;
  remoteStream: MediaStream;
  remoteScreenStream: MediaStream;
  /** Incremented whenever remote tracks change (add/remove/mute/unmute). Use as
   *  a dependency signal to recompute derived values like hasRemoteVideo. */
  streamRevision: number;
  localStream: MediaStream | null;
  startCall: (withVideo?: boolean) => Promise<void>;
  endCall: () => void;
  shareScreen: () => Promise<void>;
  stopScreenShare: () => Promise<void>;
  screenStream: MediaStream | null;
  toggleAudio: () => void;
  toggleVideo: () => Promise<void>;
  cleanup: () => void;
  getFingerprint: () => string | null;
  callError: string | null;
  pcRef: MutableRefObject<RTCPeerConnection | null>;
  localStreamRef: MutableRefObject<MediaStream | null>;
  hmacKey: CryptoKey | null;
  audioProcessing: AudioProcessingState;
  toggleAudioProcessing: (key: keyof AudioProcessingState) => Promise<void>;
  setLocalStream: (fn: (s: MediaStream | null) => MediaStream | null) => void;
}

export default function useWebRTC(signaling: SignalingHook, isHost: boolean): WebRTCHook {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const chatChannelRef = useRef<RTCDataChannel | null>(null);
  const fileChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const makingOfferRef = useRef(false);
  const negotiationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const negotiationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHostRef = useRef(isHost);
  const signalingRef = useRef(signaling);

  isHostRef.current = isHost;
  signalingRef.current = signaling;

  const screenStreamRef = useRef<MediaStream | null>(null);
  // Guard flag — set during cleanup to signal pending async ops to bail out
  const cleaningUpRef = useRef(false);

  const [connectionState, setConnectionState] = useState("new");
  const [chatChannel, setChatChannel] = useState<RTCDataChannel | null>(null);
  const [fileChannel, setFileChannel] = useState<RTCDataChannel | null>(null);
  const remoteStreamRef = useRef<MediaStream>(new MediaStream());
  const remoteScreenStreamRef = useRef<MediaStream>(new MediaStream());
  const [streamRevision, setStreamRevision] = useState(0);
  const bumpRevision = useCallback(() => setStreamRevision((r) => r + 1), []);
  const pendingScreenTrackRef = useRef(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [hmacKey, setHmacKey] = useState<CryptoKey | null>(null);
  const hmacDerivedRef = useRef(false);
  const [audioProcessing, setAudioProcessing] = useState<AudioProcessingState>({
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
  });

  const setupDataChannel = useCallback((channel: RTCDataChannel, type: "chat" | "file") => {
    channel.onopen = () => {
      if (type === "chat") setChatChannel(channel);
      else setFileChannel(channel);
    };
    channel.onclose = () => {
      if (type === "chat") setChatChannel(null);
      else setFileChannel(null);
    };
    if (type === "chat") chatChannelRef.current = channel;
    else fileChannelRef.current = channel;
  }, []);

  const cleanup = useCallback(() => {
    // Signal all pending async operations (shareScreen, toggleVideo, etc.) to bail out
    cleaningUpRef.current = true;

    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    // Clear screen track onended handlers to prevent stale closure leaks (C8)
    screenStreamRef.current?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    screenStreamRef.current = null;
    screenAudioSenderRef.current = null;
    screenVideoSenderRef.current = null;
    cameraVideoSenderRef.current = null;
    sharingInProgressRef.current = false;
    pendingScreenTrackRef.current = false;
    // Clear track event handlers to prevent leaks
    const pc = pcRef.current;
    if (pc) {
      pc.getSenders().forEach((s) => {
        if (s.track) {
          s.track.onended = null;
          s.track.onmute = null;
          s.track.onunmute = null;
        }
      });
      pc.getReceivers().forEach((r) => {
        if (r.track) {
          r.track.onended = null;
          r.track.onmute = null;
          r.track.onunmute = null;
        }
      });
      // Null out PC event handlers to prevent stale closure callbacks (H3)
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.ontrack = null;
      pc.onnegotiationneeded = null;
      pc.ondatachannel = null;
      pc.close();
    }
    pcRef.current = null;
    // Reset negotiation queue so pending ops don't run on closed PC
    negotiationQueueRef.current = Promise.resolve();
    if (negotiationTimeoutRef.current !== null) {
      clearTimeout(negotiationTimeoutRef.current);
      negotiationTimeoutRef.current = null;
    }
    makingOfferRef.current = false;
    chatChannelRef.current = null;
    fileChannelRef.current = null;
    setChatChannel(null);
    setFileChannel(null);
    setLocalStream(null);
    setScreenStream(null);
    remoteStreamRef.current = new MediaStream();
    remoteScreenStreamRef.current = new MediaStream();
    bumpRevision();
    setCallError(null);
    setHmacKey(null);
    hmacDerivedRef.current = false;
    setAudioProcessing({ noiseSuppression: true, echoCancellation: true, autoGainControl: true });
    setConnectionState("new");

    // Reset cleanup flag so next init() cycle works normally
    cleaningUpRef.current = false;
  }, []);

  const init = useCallback((iceConfig: RTCConfiguration | null) => {
    if (pcRef.current) return;

    const host = isHostRef.current;
    const sig = signalingRef.current;
    const log = (msg: string) => signalingRef.current.addLog(msg);

    if (typeof RTCPeerConnection === "undefined") {
      log("ERROR: RTCPeerConnection not available in this webview");
      setCallError(
        "WebRTC is not supported in this webview. On Linux, install gstreamer WebRTC plugins: sudo apt install gstreamer1.0-nice gstreamer1.0-plugins-bad libgstwebrtc-full-1.0-0"
      );
      return;
    }

    log(`RTC init host=${host} iceServers=${(iceConfig || DEFAULT_ICE_CONFIG).iceServers?.length ?? 0}`);
    const pc = new RTCPeerConnection(iceConfig || DEFAULT_ICE_CONFIG);
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        signalingRef.current.send({
          type: "ice-candidate",
          candidate: e.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      log(`RTC connectionState: ${pc.connectionState}`);
      setConnectionState(pc.connectionState);
      if (pc.connectionState === "connected" && !hmacDerivedRef.current
          && pc.localDescription && pc.remoteDescription) {
        // Guard prevents concurrent calls; retry with backoff on failure (C1)
        hmacDerivedRef.current = true;
        let retries = 0;
        const maxRetries = 2;
        const attemptDerive = () => {
          if (!pc.localDescription?.sdp || !pc.remoteDescription?.sdp) return;
          deriveHmacKey(pc.localDescription.sdp, pc.remoteDescription.sdp)
            .then((key) => {
              if (key) {
                setHmacKey(key);
              } else if (retries < maxRetries) {
                retries++;
                setTimeout(attemptDerive, 1000 * retries);
              } else {
                log("HMAC key derivation failed after retries");
                hmacDerivedRef.current = false;
              }
            })
            .catch(() => {
              if (retries < maxRetries) {
                retries++;
                setTimeout(attemptDerive, 1000 * retries);
              } else {
                log("HMAC key derivation failed after retries");
                hmacDerivedRef.current = false;
              }
            });
        };
        attemptDerive();
      }
    };

    // Remote media tracks — route screen share tracks to a separate stream
    // based on track ID sent via signaling (contentHint doesn't propagate over WebRTC).
    pc.ontrack = (e) => {
      const isScreen = e.track.kind === "video" && pendingScreenTrackRef.current;
      if (isScreen) pendingScreenTrackRef.current = false;
      const targetRef = isScreen ? remoteScreenStreamRef : remoteStreamRef;
      const target = targetRef.current;

      if (!target.getTracks().includes(e.track)) {
        target.addTrack(e.track);
        bumpRevision();
      }

      // Force re-render on mute/unmute so consumers re-evaluate track state
      // (tracks arrive muted, unmute when media flows, mute when remote ends call)
      e.track.onmute = bumpRevision;
      e.track.onunmute = bumpRevision;

      e.track.onended = () => {
        // Check both streams and remove from whichever contains the track
        for (const ref of [remoteStreamRef, remoteScreenStreamRef]) {
          const s = ref.current;
          if (s.getTracks().includes(e.track)) {
            s.removeTrack(e.track);
          }
        }
        bumpRevision();
      };
    };

    if (host) {
      setupDataChannel(pc.createDataChannel("chat", { ordered: true }), "chat");
      setupDataChannel(pc.createDataChannel("file", { ordered: true }), "file");
    } else {
      pc.ondatachannel = (e) => {
        const ch = e.channel;
        setupDataChannel(ch, ch.label === "chat" ? "chat" : "file");
      };
    }

    // Serialized offer creation — prevents duplicate/racing offers
    let peerPresent = false;
    // Track what was negotiated to prevent infinite renegotiation loops.
    // Only count senders (local tracks we control) — receivers and sctp.maxChannels
    // change asynchronously after negotiation completes, which would cause the
    // fingerprint to differ on the next onnegotiationneeded and trigger a loop.
    let lastNegotiatedFingerprint = "";
    let lastNegotiationTime = 0;
    const MIN_NEGOTIATION_INTERVAL = 2000; // ms — prevent rapid renegotiation

    // ICE candidate queue — buffer candidates arriving before remote description
    const pendingCandidates: RTCIceCandidateInit[] = [];

    const flushPendingCandidates = async () => {
      const pc = pcRef.current;
      if (!pc) return;
      while (pendingCandidates.length > 0) {
        const c = pendingCandidates.shift()!;
        try { await pc.addIceCandidate(c); } catch { /* stale candidate */ }
      }
    };

    const getNegotiationFingerprint = (): string => {
      const pc = pcRef.current;
      if (!pc) return "";
      // Include track IDs to detect replaceTrack changes, not just count
      const ids = pc.getSenders().filter((s) => s.track).map((s) => s.track!.id).sort().join(",");
      return `s${ids}`;
    };

    const enqueueNegotiation = () => {
      negotiationQueueRef.current = negotiationQueueRef.current.then(async () => {
        const pc = pcRef.current;
        if (!pc || pc.signalingState !== "stable" || makingOfferRef.current) {
          log(`RTC negotiate SKIP pc=${!!pc} state=${pc?.signalingState} making=${makingOfferRef.current}`);
          return;
        }
        try {
          makingOfferRef.current = true;
          log("RTC creating offer...");
          const offer = await pc.createOffer();
          if (pc.signalingState !== "stable") { log("RTC offer aborted (not stable)"); return; }
          if (offer.sdp) offer.sdp = optimizeOpusInSDP(offer.sdp, !!screenAudioSenderRef.current);
          await pc.setLocalDescription(offer);
          log("RTC offer created, sending");
          signalingRef.current.send({
            type: "offer",
            sdp: pc.localDescription!.sdp,
          });
        } catch (err) {
          log(`RTC negotiate ERROR: ${err}`);
          console.error("negotiation error:", err);
        } finally {
          makingOfferRef.current = false;
        }
      });
    };

    // Suppress negotiation until a peer has joined — prevents sending
    // offers into the void (which leaves the PC stuck in have-local-offer).
    // Also prevent redundant renegotiation by checking if anything actually
    // changed (tracks/channels) since the last negotiation.
    pc.onnegotiationneeded = () => {
      const fp = getNegotiationFingerprint();
      const now = Date.now();
      const elapsed = now - lastNegotiationTime;
      log(`RTC onnegotiationneeded fp=${fp} last=${lastNegotiatedFingerprint} peer=${peerPresent} elapsed=${elapsed}ms`);
      if (peerPresent && fp !== lastNegotiatedFingerprint) {
        lastNegotiatedFingerprint = fp;
        // Enforce minimum interval to prevent renegotiation storms
        if (elapsed < MIN_NEGOTIATION_INTERVAL) {
          const delay = MIN_NEGOTIATION_INTERVAL - elapsed;
          log(`RTC negotiate delayed ${delay}ms (cooldown)`);
          negotiationTimeoutRef.current = setTimeout(() => {
            negotiationTimeoutRef.current = null;
            enqueueNegotiation();
          }, delay);
        } else {
          enqueueNegotiation();
        }
        lastNegotiationTime = now;
      }
    };

    // Register signaling handler — uses a closure over the current PC instance.
    // The handler checks pcRef identity to bail if PC was replaced (C2).
    sig.onMessage(async (msg: SignalingMessage) => {
      // Bail if PC was replaced or cleaned up since handler was registered
      if (pcRef.current !== pc) { log(`RTC msg ${msg.type} ignored (stale pc)`); return; }
      if (!pc) { log(`RTC msg ${msg.type} ignored (no pc)`); return; }
      const host = isHostRef.current;

      try {
        log(`RTC handle ${msg.type} pcState=${pc.signalingState}`);
        if (msg.type === "offer") {
          const collision =
            makingOfferRef.current || pc.signalingState !== "stable";
          if (collision && host) {
            log("RTC offer ignored (impolite collision)");
            return;
          }
          if (collision) {
            // Rollback must complete before accepting the new offer (spec requirement)
            await pc.setLocalDescription({ type: "rollback" });
            await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          } else {
            await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          }
          await flushPendingCandidates();
          const answer = await pc.createAnswer();
          if (answer.sdp) answer.sdp = optimizeOpusInSDP(answer.sdp, !!screenAudioSenderRef.current);
          await pc.setLocalDescription(answer);
          log("RTC answer created, sending");
          signalingRef.current.send({
            type: "answer",
            sdp: pc.localDescription!.sdp,
          });
        } else if (msg.type === "answer") {
          if (pc.signalingState === "have-local-offer") {
            await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
            await flushPendingCandidates();
          }
        } else if (msg.type === "ice-candidate" && msg.candidate) {
          // Queue candidates arriving before remote description is set
          if (!pc.remoteDescription) {
            pendingCandidates.push(msg.candidate);
          } else {
            try {
              await pc.addIceCandidate(msg.candidate);
            } catch { /* stale candidate */ }
          }
        } else if (msg.type === "peer-joined") {
          log(`RTC peer-joined host=${host} pcState=${pc.signalingState}`);
          peerPresent = true;
          if (host) {
            if (pc.signalingState === "have-local-offer") {
              log("RTC rolling back stuck have-local-offer");
              await pc.setLocalDescription({ type: "rollback" });
            }
            // Mark the current state as the fingerprint so onnegotiationneeded
            // doesn't re-trigger for the same data channels we're about to negotiate
            lastNegotiatedFingerprint = getNegotiationFingerprint();
            lastNegotiationTime = Date.now();
            log(`RTC calling enqueueNegotiation (fp=${lastNegotiatedFingerprint})`);
            enqueueNegotiation();
          } else {
            log("RTC joiner waiting for offer");
          }
        } else if (msg.type === "screen-sharing") {
          // Peer is sharing/stopping screen — flag for ontrack routing
          if (msg.active) {
            pendingScreenTrackRef.current = true;
          } else {
            pendingScreenTrackRef.current = false;
            // Clean up screen stream when peer stops sharing
            const screenStream = remoteScreenStreamRef.current;
            screenStream.getTracks().forEach((t) => screenStream.removeTrack(t));
            bumpRevision();
          }
        } else if (msg.type === "peer-disconnected") {
          peerPresent = false;
          cleanup();
        }
      } catch (err) {
        console.error("signaling handler error:", err);
      }
    });
  }, [setupDataChannel, cleanup]);

  const startCall = useCallback(async (_withVideo = false) => {
    const pc = pcRef.current;
    if (!pc) return;
    setCallError(null);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCallError(
        "Camera/microphone not available. This requires a browser like Chrome — pywebview's embedded browser does not support WebRTC media."
      );
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasAudio = devices.some((d) => d.kind === "audioinput");

      if (!hasAudio) {
        setCallError("No microphone found on this device.");
        return;
      }

      // Always start audio-only; camera stays off until user turns it on
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        },
        video: false,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      // Set codec preferences after transceivers exist
      preferAudioCodecs(pc);
    } catch (err) {
      console.error("startCall failed:", err);
      setCallError((err as Error).message || "Failed to access camera/microphone");
    }
  }, []);

  const endCall = useCallback(() => {
    const pc = pcRef.current;
    if (!pc) return;
    // Stop screen share tracks and clear onended handlers (H5)
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      screenStreamRef.current = null;
    }
    // Remove screen senders explicitly to prevent dangling bandwidth usage
    if (screenVideoSenderRef.current) {
      try { pc.removeTrack(screenVideoSenderRef.current); } catch { /* already removed */ }
      screenVideoSenderRef.current = null;
    }
    if (screenAudioSenderRef.current) {
      try { pc.removeTrack(screenAudioSenderRef.current); } catch { /* already removed */ }
      screenAudioSenderRef.current = null;
    }
    if (cameraVideoSenderRef.current) {
      try { pc.removeTrack(cameraVideoSenderRef.current); } catch { /* already removed */ }
      cameraVideoSenderRef.current = null;
    }
    sharingInProgressRef.current = false;
    // Stop all remaining media senders (mic, camera)
    pc.getSenders().forEach((s) => {
      if (s.track) {
        s.track.stop();
        pc.removeTrack(s);
      }
    });
    localStreamRef.current = null;
    setLocalStream(null);
    setScreenStream(null);
  }, []);

  const screenAudioSenderRef = useRef<RTCRtpSender | null>(null);
  const sharingInProgressRef = useRef(false);
  const screenVideoSenderRef = useRef<RTCRtpSender | null>(null);
  const cameraVideoSenderRef = useRef<RTCRtpSender | null>(null);

   
  const stopScreenShare = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !screenStreamRef.current) return;

    sharingInProgressRef.current = false;
    // Clear onended handlers before stopping tracks to prevent double-fire (C8)
    screenStreamRef.current.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    screenStreamRef.current = null;
    setScreenStream(null);

    // Remove the system audio sender
    if (screenAudioSenderRef.current) {
      try { pc.removeTrack(screenAudioSenderRef.current); } catch { /* already removed */ }
      screenAudioSenderRef.current = null;
    }

    // Remove the screen video sender — camera sender is untouched (dual stream model)
    if (screenVideoSenderRef.current) {
      try { pc.removeTrack(screenVideoSenderRef.current); } catch { /* already removed */ }
      screenVideoSenderRef.current = null;
    }

    // Notify receiver that screen sharing stopped
    signalingRef.current.send({ type: "screen-sharing", active: false });
  }, []);

  const shareScreen = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || sharingInProgressRef.current) return;

    if (!navigator.mediaDevices?.getDisplayMedia) {
      setCallError("Screen sharing is not supported in this browser.");
      return;
    }

    setCallError(null);
    sharingInProgressRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 }, cursor: "always" } as MediaTrackConstraints,
        audio: {
          // Disable speech processing for system audio — these cause muffling
          // of music, game audio, and video playback
          noiseSuppression: false,
          echoCancellation: false,
          autoGainControl: false,
        },
        // Ask Chrome to offer system audio checkbox when sharing entire screen
        // (without this, audio is only offered for tab/window shares)
        systemAudio: "include",
        // Allow user to switch shared surface mid-share
        surfaceSwitching: "include",
        // Ensure "Entire Screen" option is available in the picker
        monitorTypeSurfaces: "include",
      } as any);

      // Abort if stopScreenShare or cleanup was called while awaiting getDisplayMedia (C4/H4)
      if (!sharingInProgressRef.current || cleaningUpRef.current || pcRef.current !== pc) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      screenStreamRef.current = stream;

      // Add screen track as a SEPARATE sender (dual stream — camera stays untouched)
      const screenTrack = stream.getVideoTracks()[0];

      // Clean up any stale screen video sender from a previous share session
      if (screenVideoSenderRef.current) {
        try { pc.removeTrack(screenVideoSenderRef.current); } catch { /* already removed */ }
        screenVideoSenderRef.current = null;
      }

      // Add screen as a new video sender — triggers onnegotiationneeded
      screenVideoSenderRef.current = pc.addTrack(screenTrack, stream);

      // Set screen-optimized codec preferences (VP9 for sharp text/code)
      preferVideoCodecs(pc, "screen");

      // Notify receiver of the screen track ID (contentHint doesn't propagate over WebRTC)
      signalingRef.current.send({ type: "screen-sharing", active: true, trackId: screenTrack.id });

      // Hint encoder to prioritize pixel-perfect sharpness for text/code
      // Set AFTER replaceTrack/addTrack so the transceiver is active
      if ("contentHint" in screenTrack) screenTrack.contentHint = "detail";

      // Set initial screen share bitrate — bandwidth adaptation will adjust
      // to the correct tier within one poll cycle (~3s). Use conservative
      // 1.5Mbps default to avoid burst-induced packet loss on poor connections.
      const screenSender = screenVideoSenderRef.current;
      if (screenSender) {
        try {
          const params = screenSender.getParameters();
          if (params.encodings?.length > 0) {
            params.encodings[0].maxBitrate = 1_500_000;
            params.encodings[0].maxFramerate = 30;
            (params.encodings[0] as any).degradationPreference = "maintain-framerate";
            await screenSender.setParameters(params);
          }
        } catch { /* encoding params not supported */ }
      }

      // Add system audio track if the user chose to share it
      // Clean up any previous screen audio sender first to prevent duplicates
      if (screenAudioSenderRef.current) {
        try { pc.removeTrack(screenAudioSenderRef.current); } catch { /* already removed */ }
        screenAudioSenderRef.current = null;
      }
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        // Hint encoder to preserve fidelity for system audio (not speech-optimized)
        if ("contentHint" in audioTrack) audioTrack.contentHint = "music";
        // Ensure speech processing is disabled (fallback if getDisplayMedia ignored constraints)
        try {
          await audioTrack.applyConstraints({
            noiseSuppression: false,
            echoCancellation: false,
            autoGainControl: false,
          });
        } catch { /* constraints not supported for display audio */ }
        try {
          screenAudioSenderRef.current = pc.addTrack(audioTrack, stream);
          // Set higher bitrate for screen share audio (music/system audio needs more than voice)
          const params = screenAudioSenderRef.current.getParameters();
          if (params.encodings?.length > 0) {
            params.encodings[0].maxBitrate = 128_000; // 128kbps for stereo music
            await screenAudioSenderRef.current.setParameters(params);
          }
        } catch (err) {
          console.error("failed to add screen audio:", err);
        }
      }

      // Register onended BEFORE state update to prevent race with browser's
      // built-in "Stop sharing" button firing before handler is attached.
      // Guard against firing while shareScreen() is still executing (B6) —
      // sharingInProgressRef is cleared in the finally block below.
      screenTrack.onended = () => {
        if (sharingInProgressRef.current) return;
        stopScreenShare().catch((err: unknown) =>
          console.error("stopScreenShare from onended failed:", err)
        );
      };

      // State update after all track operations are complete
      setScreenStream(stream);
    } catch (err) {
      const e = err as DOMException;
      if (e.name !== "AbortError" && e.name !== "NotAllowedError") {
        setCallError(e.message || "Failed to share screen");
      }
    } finally {
      sharingInProgressRef.current = false;
    }
  }, [stopScreenShare]);

  const toggleAudio = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = !track.enabled;
    setLocalStream((s) => (s ? new MediaStream(s.getTracks()) : s));
  }, []);

  const toggleVideo = useCallback(async () => {
    const pc = pcRef.current;
    const stream = localStreamRef.current;
    if (!pc || !stream) return;

    // Camera and screen share are independent (dual stream model) — no blocking needed

    const existingTrack = stream.getVideoTracks()[0];
    if (existingTrack) {
      // Turn camera off — use cameraVideoSenderRef for reliable lookup (B2)
      const sender = cameraVideoSenderRef.current
        && pc.getSenders().includes(cameraVideoSenderRef.current)
        ? cameraVideoSenderRef.current
        : pc.getSenders().find((s) => s.track === existingTrack);
      existingTrack.stop();
      stream.removeTrack(existingTrack);
      if (sender) {
        try { await sender.replaceTrack(null); } catch { /* sender gone */ }
      }
    } else {
      // Turn camera on — constrain resolution to avoid initial bandwidth spike
      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
        });
        if (cleaningUpRef.current) { videoStream.getTracks().forEach((t) => t.stop()); return; }
        const newTrack = videoStream.getVideoTracks()[0];
        stream.addTrack(newTrack);
        // Use dedicated camera sender ref — never fall back to screenVideoSenderRef
        const existingSender = cameraVideoSenderRef.current
          && pc.getSenders().includes(cameraVideoSenderRef.current)
          ? cameraVideoSenderRef.current
          : null;
        if (existingSender) {
          await existingSender.replaceTrack(newTrack);
        } else {
          cameraVideoSenderRef.current = pc.addTrack(newTrack, stream);
        }
        // Set video codec preferences after adding video transceiver
        preferVideoCodecs(pc, "camera");
        // Set initial camera bitrate — bandwidth adaptation will adjust after
        // connection quality is measured, but this prevents the browser from
        // starting at an extremely conservative bitrate (~300kbps).
        const camSender = cameraVideoSenderRef.current;
        if (camSender) {
          try {
            const params = camSender.getParameters();
            if (params.encodings?.length > 0) {
              params.encodings[0].maxBitrate = 1_500_000;
              params.encodings[0].maxFramerate = 24;
              (params.encodings[0] as any).degradationPreference = "maintain-framerate";
              await camSender.setParameters(params);
            }
          } catch { /* encoding params not supported */ }
        }
      } catch (err) {
        // Show error feedback so user knows why camera didn't turn on (B3)
        const msg = (err as DOMException)?.name === "NotAllowedError"
          ? "Camera permission denied."
          : "Failed to access camera.";
        setCallError(msg);
        return;
      }
    }
    setLocalStream(new MediaStream(stream.getTracks()));
  }, []);

  const toggleAudioProcessing = useCallback(async (key: keyof AudioProcessingState) => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    const pc = pcRef.current;
    if (!pc) return;

    // Read current value from track settings (not state) to avoid stale closure
    const currentSettings = track.getSettings();
    const nextVal = !(currentSettings[key] ?? true);

    // ── Fast path: try applyConstraints first ──
    // This works reliably for DISABLING features (EC off, NS off) on most
    // browsers and avoids the audio gap + device lock of full track replacement.
    try {
      await track.applyConstraints({ [key]: nextVal });
      const actualVal = track.getSettings()[key];
      if (actualVal === nextVal) {
        setAudioProcessing((prev) => ({ ...prev, [key]: nextVal }));
        return; // Browser honored the constraint — done
      }
    } catch {
      // applyConstraints not supported or failed — fall through to track replacement
    }

    // ── Slow path: full track replacement ──
    // Needed when re-enabling NS/EC because browsers set up audio processing
    // pipelines at track creation time and can't re-enable them dynamically.

    // Capture the sender BEFORE stopping the old track (the reference is still valid)
    const sender = pc.getSenders().find(
      (s) => s.track === track || s.track?.kind === "audio",
    );

    // Build constraints preserving current device + all processing settings
    const deviceId = currentSettings.deviceId;
    const constraints: MediaTrackConstraints = {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      noiseSuppression: key === "noiseSuppression" ? nextVal : (currentSettings.noiseSuppression ?? true),
      echoCancellation: key === "echoCancellation" ? nextVal : (currentSettings.echoCancellation ?? true),
      autoGainControl: key === "autoGainControl" ? nextVal : (currentSettings.autoGainControl ?? true),
    };

    // Stop the old track FIRST to release the device — on Windows (WASAPI),
    // some drivers only allow one active capture at a time. Calling getUserMedia
    // while the old track is still live can fail or return a silent track.
    track.stop();

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      if (cleaningUpRef.current || !localStreamRef.current || pcRef.current !== pc) {
        newStream.getTracks().forEach((t) => t.stop());
        return;
      }

      const newTrack = newStream.getAudioTracks()[0];

      // Replace the track on the PC sender (no renegotiation needed)
      if (sender) {
        await sender.replaceTrack(newTrack);
      }

      // Swap into the local stream
      localStreamRef.current.removeTrack(track);
      localStreamRef.current.addTrack(newTrack);
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()));

      // Read actual settings from the new track — browser may not honor all constraints
      const newSettings = newTrack.getSettings();
      setAudioProcessing({
        noiseSuppression: newSettings.noiseSuppression ?? true,
        echoCancellation: newSettings.echoCancellation ?? true,
        autoGainControl: newSettings.autoGainControl ?? true,
      });
    } catch (err) {
      console.warn("toggleAudioProcessing: track replacement failed:", err);

      // Emergency fallback — the old track is already stopped, so we must
      // restore audio or the user is left with silence. Try the default device.
      try {
        const fallbackStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cleaningUpRef.current || !localStreamRef.current || pcRef.current !== pc) {
          fallbackStream.getTracks().forEach((t) => t.stop());
          return;
        }
        const fallbackTrack = fallbackStream.getAudioTracks()[0];
        if (sender) await sender.replaceTrack(fallbackTrack);
        localStreamRef.current.removeTrack(track);
        localStreamRef.current.addTrack(fallbackTrack);
        setLocalStream(new MediaStream(localStreamRef.current.getTracks()));

        const fbSettings = fallbackTrack.getSettings();
        setAudioProcessing({
          noiseSuppression: fbSettings.noiseSuppression ?? true,
          echoCancellation: fbSettings.echoCancellation ?? true,
          autoGainControl: fbSettings.autoGainControl ?? true,
        });
      } catch {
        console.error("toggleAudioProcessing: emergency fallback also failed — no audio");
      }
    }
  }, []);

  const getFingerprint = useCallback((): string | null => {
    const sdp = pcRef.current?.localDescription?.sdp;
    if (!sdp) return null;
    const match = sdp.match(/a=fingerprint:\S+ (\S+)/);
    return match ? match[1] : null;
  }, []);

  // Auto-switch audio device when current one disappears mid-call
  useEffect(() => {
    if (!localStream) return;
    const handleDeviceChange = async () => {
      const pc = pcRef.current;
      if (!pc || cleaningUpRef.current) return;
      const currentTrack = localStreamRef.current?.getAudioTracks()[0];
      if (!currentTrack) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      // Re-check after async — cleanup may have run during enumeration (M2)
      if (cleaningUpRef.current || !localStreamRef.current || pcRef.current !== pc) return;
      const audioDevices = devices.filter((d) => d.kind === "audioinput");
      const currentId = currentTrack.getSettings().deviceId;
      const stillExists = audioDevices.some((d) => d.deviceId === currentId);
      if (!stillExists && audioDevices.length > 0) {
        try {
          // Preserve user's audio processing preferences from current track
          const settings = currentTrack.getSettings();
          const newStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              noiseSuppression: settings.noiseSuppression ?? true,
              echoCancellation: settings.echoCancellation ?? true,
              autoGainControl: settings.autoGainControl ?? true,
            },
          });
          // Re-check after getUserMedia — cleanup may have run (M2)
          if (cleaningUpRef.current || !localStreamRef.current || pcRef.current !== pc) {
            newStream.getTracks().forEach((t) => t.stop());
            return;
          }
          const newTrack = newStream.getAudioTracks()[0];
          const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
          if (sender) {
            await sender.replaceTrack(newTrack);
            currentTrack.stop();
            localStreamRef.current.removeTrack(currentTrack);
            localStreamRef.current.addTrack(newTrack);
            setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
          } else {
            newTrack.stop(); // no sender to attach to
          }
        } catch (err) {
          console.error("device switch failed:", err);
        }
      }
    };
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, [localStream]);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  return {
    init,
    connectionState,
    chatChannel,
    fileChannel,
    remoteStream: remoteStreamRef.current,
    remoteScreenStream: remoteScreenStreamRef.current,
    streamRevision,
    localStream,
    startCall,
    endCall,
    shareScreen,
    stopScreenShare,
    screenStream,
    toggleAudio,
    toggleVideo,
    cleanup,
    getFingerprint,
    callError,
    pcRef,
    localStreamRef,
    hmacKey,
    audioProcessing,
    toggleAudioProcessing,
    setLocalStream,
  };
}
