import { useState, useEffect, useRef } from "react";

/**
 * Measures microphone input level (0-100) from an audio stream.
 * Used to show a real-time sensitivity meter on the call UI.
 *
 * Tracks audio track identity — only recreates AudioContext when the
 * actual audio track changes, not when the stream object is replaced
 * (which happens on toggleAudio, toggleVideo, device switch).
 */
export default function useMicLevel(stream: MediaStream | null): number {
  const [level, setLevel] = useState(0);
  const ctxRef = useRef<AudioContext | null>(null);
  const prevTrackIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!stream) {
      setLevel(0);
      prevTrackIdRef.current = null;
      return;
    }

    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack || !audioTrack.enabled) {
      setLevel(0);
      return;
    }

    // Skip recreation if the actual audio track hasn't changed
    if (audioTrack.id === prevTrackIdRef.current && ctxRef.current?.state !== "closed") {
      return;
    }
    prevTrackIdRef.current = audioTrack.id;

    // Close previous AudioContext before creating new one to prevent exhaustion
    if (ctxRef.current && ctxRef.current.state !== "closed") {
      ctxRef.current.close().catch(() => {});
    }

    let ctx: AudioContext;
    try {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch {
      return;
    }
    ctxRef.current = ctx;

    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    const interval = setInterval(() => {
      if (audioTrack.readyState === "ended") { setLevel(0); return; }
      if (ctx.state === "suspended") ctx.resume();
      analyser.getByteFrequencyData(data);
      // Use RMS for smoother, more representative level
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      // Normalize to 0-100 (255 is max byte value)
      const normalized = Math.min(100, Math.round((rms / 128) * 100));
      setLevel(normalized);
    }, 50);

    return () => {
      clearInterval(interval);
      source.disconnect();
      analyser.disconnect(); // H14: prevent orphaned node in audio graph
      ctx.close().catch(() => {});
      ctxRef.current = null;
    };
  }, [stream]);

  return level;
}
