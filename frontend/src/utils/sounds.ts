// Terminal-aesthetic sound effects via Web Audio API oscillators
// No audio files needed — all sounds generated programmatically
// Exception: the incoming call ringtone uses a WAV file decoded into an AudioBuffer

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  // Resume suspended context (browsers suspend until user gesture)
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

// ── Warm-up: call this on ANY user gesture (click/tap) to unlock AudioContext ──
// This ensures the context is "running" before we need to play the ringtone.
export function warmUpAudio(): void {
  try {
    const c = getCtx();
    if (c.state === "suspended") c.resume().catch(() => {});
  } catch {
    // AudioContext not available
  }
}

// ── Incoming call ringtone (looping WAV via Web Audio API) ──
// Pre-decoded AudioBuffer avoids autoplay issues since we reuse the
// already-unlocked AudioContext instead of creating a new HTMLAudioElement.

let ringtoneBuffer: AudioBuffer | null = null;
let ringtoneSource: AudioBufferSourceNode | null = null;
let ringtoneGain: GainNode | null = null;
let ringtoneLoading = false;

/** Pre-fetch and decode the ringtone WAV. Call early (e.g., on page load). */
export function preloadRingtone(): void {
  if (ringtoneBuffer || ringtoneLoading) return;
  ringtoneLoading = true;
  fetch("/ringtone.wav")
    .then((r) => r.arrayBuffer())
    .then((buf) => getCtx().decodeAudioData(buf))
    .then((decoded) => {
      ringtoneBuffer = decoded;
      ringtoneLoading = false;
    })
    .catch(() => {
      ringtoneLoading = false;
    });
}

/** Start playing the ringtone in a loop. Safe to call multiple times. */
export function startRingtone(): void {
  // Already playing
  if (ringtoneSource) return;

  try {
    const c = getCtx();
    if (c.state === "suspended") c.resume().catch(() => {});

    if (!ringtoneBuffer) {
      // Buffer not ready — try to load now, then play when ready
      if (!ringtoneLoading) preloadRingtone();
      // Fallback: play a simple oscillator ringtone pattern
      _playFallbackRing();
      return;
    }

    const source = c.createBufferSource();
    source.buffer = ringtoneBuffer;
    source.loop = true;

    const gain = c.createGain();
    gain.gain.setValueAtTime(0.4, c.currentTime);
    source.connect(gain);
    gain.connect(c.destination);
    source.start(0);

    ringtoneSource = source;
    ringtoneGain = gain;
  } catch {
    // AudioContext not available — silent fail
  }
}

/** Stop the ringtone. */
export function stopRingtone(): void {
  if (ringtoneSource) {
    try {
      ringtoneSource.stop();
      ringtoneSource.disconnect();
    } catch { /* already stopped */ }
    ringtoneSource = null;
  }
  if (ringtoneGain) {
    try { ringtoneGain.disconnect(); } catch { /* ok */ }
    ringtoneGain = null;
  }
  // Also stop the fallback interval if active
  if (_fallbackTimer !== null) {
    clearInterval(_fallbackTimer);
    _fallbackTimer = null;
  }
}

// Fallback ringtone using oscillators (if WAV hasn't loaded yet)
let _fallbackTimer: ReturnType<typeof setInterval> | null = null;
function _playFallbackRing(): void {
  if (_fallbackTimer !== null) return;
  // Play immediately then repeat
  const ring = () => {
    beep(880, 0.15, "sine", 0.15);
    setTimeout(() => beep(880, 0.15, "sine", 0.15), 200);
  };
  ring();
  _fallbackTimer = setInterval(ring, 1500);
}

function beep(freq: number, duration: number, type: OscillatorType = "sine", volume: number = 0.15): void {
  try {
    const c = getCtx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, c.currentTime);
    gain.gain.setValueAtTime(volume, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(c.currentTime);
    osc.stop(c.currentTime + duration);
  } catch {
    // AudioContext not available
  }
}

// Message sent — soft ascending click
export function playMessageSent(): void {
  beep(800, 0.06, "sine", 0.08);
  setTimeout(() => beep(1200, 0.04, "sine", 0.06), 50);
}

// Message received — two-tone descending
export function playMessageReceived(): void {
  beep(1000, 0.08, "sine", 0.1);
  setTimeout(() => beep(700, 0.06, "sine", 0.08), 70);
}

// Peer connected — ascending triad
export function playPeerConnected(): void {
  beep(523, 0.12, "triangle", 0.12); // C5
  setTimeout(() => beep(659, 0.12, "triangle", 0.1), 120); // E5
  setTimeout(() => beep(784, 0.15, "triangle", 0.08), 240); // G5
}

// Peer disconnected — descending minor
export function playPeerDisconnected(): void {
  beep(784, 0.12, "triangle", 0.12); // G5
  setTimeout(() => beep(622, 0.12, "triangle", 0.1), 120); // Eb5
  setTimeout(() => beep(523, 0.18, "triangle", 0.08), 240); // C5
}

// Call ended — low double beep
export function playCallEnded(): void {
  beep(440, 0.1, "square", 0.08);
  setTimeout(() => beep(330, 0.15, "square", 0.06), 150);
}

// File transfer complete — cheerful ascending
export function playFileComplete(): void {
  beep(660, 0.08, "sine", 0.1);
  setTimeout(() => beep(880, 0.08, "sine", 0.08), 80);
  setTimeout(() => beep(1100, 0.12, "sine", 0.06), 160);
}

// Error — low buzz
export function playError(): void {
  beep(200, 0.15, "sawtooth", 0.08);
  setTimeout(() => beep(180, 0.2, "sawtooth", 0.06), 100);
}
