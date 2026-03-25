// HMAC-SHA256 message authentication for WebRTC data channels.
// Derives a shared key from both peers' DTLS fingerprints (sorted
// lexicographically so host and joiner compute the same key).

const SALT = new TextEncoder().encode("synced-hmac-v1");
const HMAC_LEN = 32; // SHA-256 output

function extractFingerprint(sdp: string): string | null {
  const m = sdp.match(/a=fingerprint:\S+ (\S+)/);
  return m ? m[1] : null;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function concat(...bufs: (ArrayBuffer | Uint8Array)[]): ArrayBuffer {
  const total = bufs.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) {
    out.set(new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer), off);
    off += b.byteLength;
  }
  return out.buffer;
}

export async function deriveHmacKey(
  localSdp: string,
  remoteSdp: string
): Promise<CryptoKey | null> {
  const localFp = extractFingerprint(localSdp);
  const remoteFp = extractFingerprint(remoteSdp);
  if (!localFp || !remoteFp) return null;

  const sorted = [localFp, remoteFp].sort();
  const ikm = new TextEncoder().encode(sorted[0] + "|" + sorted[1]);

  const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: new Uint8Array(0) },
    baseKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

// --- JSON message signing (chat, reactions, typing, presence, file-meta, file-end) ---

export async function signMessage(key: CryptoKey, jsonStr: string): Promise<string> {
  const data = new TextEncoder().encode(jsonStr);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return JSON.stringify({ p: jsonStr, h: bytesToHex(sig) });
}

export async function verifyMessage(
  key: CryptoKey,
  envelope: string
): Promise<string | null> {
  try {
    const { p, h } = JSON.parse(envelope);
    if (!p || !h) return null;
    const data = new TextEncoder().encode(p);
    const sig = hexToBytes(h);
    const valid = await crypto.subtle.verify("HMAC", key, sig.buffer as ArrayBuffer, data);
    return valid ? p : null;
  } catch {
    return null;
  }
}

// --- Binary chunk signing (file transfer) ---

export async function signChunk(
  key: CryptoKey,
  chunk: ArrayBuffer,
  fileId: string,
  index: number
): Promise<ArrayBuffer> {
  const idBytes = new TextEncoder().encode(fileId);
  const idxBytes = new Uint32Array([index]).buffer;
  const msg = concat(idBytes, idxBytes, chunk);
  const sig = await crypto.subtle.sign("HMAC", key, msg);
  return concat(sig, chunk); // [32B HMAC][chunk]
}

export async function verifyChunk(
  key: CryptoKey,
  data: ArrayBuffer,
  fileId: string,
  index: number
): Promise<ArrayBuffer | null> {
  if (data.byteLength < HMAC_LEN) return null;
  const sig = data.slice(0, HMAC_LEN);
  const chunk = data.slice(HMAC_LEN);
  const idBytes = new TextEncoder().encode(fileId);
  const idxBytes = new Uint32Array([index]).buffer;
  const msg = concat(idBytes, idxBytes, chunk);
  const valid = await crypto.subtle.verify("HMAC", key, sig, msg);
  return valid ? chunk : null;
}
