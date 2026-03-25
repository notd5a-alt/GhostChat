// Codec preference configuration for WebRTC
// Prefers VP9 > VP8 > H264 for real-time video (AV1 HW encode support is rare),
// Opus for audio with voice optimization

/**
 * Set video codec preferences on all video transceivers.
 * Prefers VP9 > VP8 > H264 for real-time video.
 * AV1 is deprioritized — most machines lack HW encode, and software AV1
 * causes 100ms+ latency and excessive CPU in real-time video.
 */
export function preferVideoCodecs(pc: RTCPeerConnection): void {
  if (!RTCRtpTransceiver.prototype.setCodecPreferences) return; // Safari fallback

  const transceivers = pc.getTransceivers();
  for (const t of transceivers) {
    if (t.sender?.track?.kind === "video" || t.receiver?.track?.kind === "video") {
      try {
        const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs;
        if (!codecs) continue;

        // Sort: VP9 first, then VP8, then H264, then AV1 (needs HW), then rest
        const sorted = [...codecs].sort((a, b) => {
          const rank = (c: { mimeType: string }): number => {
            const mime = c.mimeType.toLowerCase();
            if (mime.includes("vp9")) return 0;
            if (mime.includes("vp8")) return 1;
            if (mime.includes("h264")) return 2;
            if (mime.includes("av1") || mime.includes("av01")) return 3;
            return 4;
          };
          return rank(a) - rank(b);
        });

        t.setCodecPreferences(sorted);
      } catch {
        // setCodecPreferences not supported or codec list invalid
      }
    }
  }
}

/**
 * Set audio codec preferences — prefer Opus with voice optimization.
 * Configures: DTX (discontinuous transmission for silence), FEC, CBR off.
 */
export function preferAudioCodecs(pc: RTCPeerConnection): void {
  if (!RTCRtpTransceiver.prototype.setCodecPreferences) return;

  const transceivers = pc.getTransceivers();
  for (const t of transceivers) {
    if (t.sender?.track?.kind === "audio" || t.receiver?.track?.kind === "audio") {
      try {
        const codecs = RTCRtpReceiver.getCapabilities("audio")?.codecs;
        if (!codecs) continue;

        // Prefer Opus, then rest
        const sorted = [...codecs].sort((a, b) => {
          const isOpusA = a.mimeType.toLowerCase().includes("opus") ? 0 : 1;
          const isOpusB = b.mimeType.toLowerCase().includes("opus") ? 0 : 1;
          return isOpusA - isOpusB;
        });

        t.setCodecPreferences(sorted);
      } catch {
        // Fallback — browser will use default preference
      }
    }
  }
}

/**
 * Optimize Opus settings in SDP for voice communication.
 * Enables: DTX (saves bandwidth during silence), FEC (resilience to packet loss),
 * Sets: maxaveragebitrate to 48kbps (good quality wideband voice).
 */
export function optimizeOpusInSDP(sdp: string): string {
  if (!sdp) return sdp;

  const opusParams: Record<string, number> = {
    usedtx: 1, // Discontinuous transmission — saves bandwidth during silence
    useinbandfec: 1, // Forward error correction — resilience to packet loss
    maxaveragebitrate: 48000, // 48kbps — good quality for wideband voice
    // Don't force mono — screen share system audio may be stereo
  };

  // Find ALL Opus payload types (multi-stream SDPs may have more than one)
  const opusMatches = [...sdp.matchAll(/a=rtpmap:(\d+) opus\/48000/g)];
  if (opusMatches.length === 0) return sdp;

  let result = sdp;
  for (const match of opusMatches) {
    const pt = match[1];
    const fmtpRegex = new RegExp(`a=fmtp:${pt} (.+)`);
    const fmtpMatch = result.match(fmtpRegex);

    if (fmtpMatch) {
      // Parse existing params and merge
      const existing: Record<string, string> = {};
      fmtpMatch[1].split(";").forEach((p) => {
        const [k, v] = p.trim().split("=");
        if (k) existing[k] = v;
      });
      const merged = { ...existing, ...opusParams };
      const paramStr = Object.entries(merged)
        .map(([k, v]) => `${k}=${v}`)
        .join(";");
      result = result.replace(fmtpRegex, `a=fmtp:${pt} ${paramStr}`);
    } else {
      // Add fmtp line after rtpmap
      const paramStr = Object.entries(opusParams)
        .map(([k, v]) => `${k}=${v}`)
        .join(";");
      result = result.replace(
        `a=rtpmap:${pt} opus/48000`,
        `a=rtpmap:${pt} opus/48000\r\na=fmtp:${pt} ${paramStr}`
      );
    }
  }

  return result;
}
