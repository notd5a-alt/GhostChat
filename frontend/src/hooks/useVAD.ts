import { useState, useEffect, useRef } from "react";

// Voice Activity Detection — detects if an audio stream is "speaking"
// Uses AnalyserNode with voice-range frequency weighting for better accuracy.
const THRESHOLD = 15; // min weighted average amplitude to count as speaking
const POLL_MS = 100; // check every 100ms
const HOLD_MS = 300; // stay "speaking" for 300ms after last detection (debounce)

// Voice frequency range indices for fftSize=256 at 48kHz sample rate
// Each bin = sampleRate / fftSize = ~187.5 Hz
// Voice range ~85Hz-3kHz → bins ~0-16 out of 128
const VOICE_BIN_START = 0;
const VOICE_BIN_END = 16;

export default function useVAD(
  localStream: MediaStream | null,
  remoteStream: MediaStream | null
): { localSpeaking: boolean; remoteSpeaking: boolean } {
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [remoteSpeaking, setRemoteSpeaking] = useState(false);

  const localCtxRef = useRef<AudioContext | null>(null);
  const remoteCtxRef = useRef<AudioContext | null>(null);
  const prevLocalTrackIdRef = useRef<string | null>(null);
  const prevRemoteTrackIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!localStream) {
      setLocalSpeaking(false);
      prevLocalTrackIdRef.current = null;
      return;
    }
    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) {
      setLocalSpeaking(false);
      return;
    }

    // Skip recreation if the actual audio track hasn't changed
    if (audioTrack.id === prevLocalTrackIdRef.current && localCtxRef.current?.state !== "closed") {
      return;
    }
    prevLocalTrackIdRef.current = audioTrack.id;

    // Close previous context before creating new one to prevent AudioContext exhaustion
    if (localCtxRef.current && localCtxRef.current.state !== "closed") {
      localCtxRef.current.close().catch(() => {});
    }

    let ctx: AudioContext;
    try {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch { return; }
    localCtxRef.current = ctx;

    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    let holdTimeout: any = null;
    const interval = setInterval(() => {
      if (audioTrack.readyState === "ended") return;
      if (ctx.state === "suspended") ctx.resume();
      analyser.getByteFrequencyData(data);
      // Weight toward voice frequency range (85Hz-3kHz) for better discrimination
      let sum = 0;
      const end = Math.min(VOICE_BIN_END, data.length);
      for (let i = VOICE_BIN_START; i < end; i++) sum += data[i];
      const avg = sum / (end - VOICE_BIN_START);
      if (avg > THRESHOLD) {
        if (holdTimeout) clearTimeout(holdTimeout);
        holdTimeout = null;
        setLocalSpeaking(true);
      } else if (!holdTimeout) {
        holdTimeout = setTimeout(() => setLocalSpeaking(false), HOLD_MS);
      }
    }, POLL_MS);

    return () => {
      clearInterval(interval);
      if (holdTimeout) clearTimeout(holdTimeout);
      source.disconnect();
      analyser.disconnect(); // H14: prevent orphaned node in audio graph
      ctx.close().catch(() => {});
      localCtxRef.current = null;
    };
  }, [localStream]);

  useEffect(() => {
    if (!remoteStream) {
      setRemoteSpeaking(false);
      prevRemoteTrackIdRef.current = null;
      return;
    }
    const audioTrack = remoteStream.getAudioTracks()[0];
    if (!audioTrack) {
      setRemoteSpeaking(false);
      return;
    }

    // Skip recreation if the actual audio track hasn't changed
    if (audioTrack.id === prevRemoteTrackIdRef.current && remoteCtxRef.current?.state !== "closed") {
      return;
    }
    prevRemoteTrackIdRef.current = audioTrack.id;

    // Close previous context before creating new one to prevent AudioContext exhaustion
    if (remoteCtxRef.current && remoteCtxRef.current.state !== "closed") {
      remoteCtxRef.current.close().catch(() => {});
    }

    let ctx: AudioContext;
    try {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch { return; }
    remoteCtxRef.current = ctx;

    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    let holdTimeout: any = null;
    const interval = setInterval(() => {
      if (audioTrack.readyState === "ended") return;
      if (ctx.state === "suspended") ctx.resume();
      analyser.getByteFrequencyData(data);
      // Weight toward voice frequency range (85Hz-3kHz) for better discrimination
      let sum = 0;
      const end = Math.min(VOICE_BIN_END, data.length);
      for (let i = VOICE_BIN_START; i < end; i++) sum += data[i];
      const avg = sum / (end - VOICE_BIN_START);
      if (avg > THRESHOLD) {
        if (holdTimeout) clearTimeout(holdTimeout);
        holdTimeout = null;
        setRemoteSpeaking(true);
      } else if (!holdTimeout) {
        holdTimeout = setTimeout(() => setRemoteSpeaking(false), HOLD_MS);
      }
    }, POLL_MS);

    return () => {
      clearInterval(interval);
      if (holdTimeout) clearTimeout(holdTimeout);
      source.disconnect();
      analyser.disconnect(); // H14: prevent orphaned node in audio graph
      ctx.close().catch(() => {});
      remoteCtxRef.current = null;
    };
  }, [remoteStream]);

  return { localSpeaking, remoteSpeaking };
}
