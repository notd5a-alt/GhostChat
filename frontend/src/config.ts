/**
 * Signaling server URL resolution.
 *
 * Modes:
 *  - "local"  → use window.location.origin (sidecar / local backend)
 *  - "remote" → use a user-configured remote signaling server URL
 *
 * Persisted in localStorage so the choice survives reloads.
 */

export type ServerMode = "local" | "remote";

const MODE_KEY = "synced_server_mode";
const URL_KEY = "synced_signaling_url";

/** Default remote signaling server — always used for remote mode. */
export const DEFAULT_REMOTE_URL = "https://synced-relay.duckdns.org:9876";

export function getServerMode(): ServerMode {
  const stored = localStorage.getItem(MODE_KEY);
  if (stored === "remote") return "remote";
  // If VITE_SIGNALING_URL is baked in, default to remote
  if (import.meta.env.VITE_SIGNALING_URL) return "remote";
  return "local";
}

export function setServerMode(mode: ServerMode): void {
  localStorage.setItem(MODE_KEY, mode);
}

export function getRemoteUrl(): string {
  return DEFAULT_REMOTE_URL;
}

export function setRemoteUrl(url: string): void {
  localStorage.setItem(URL_KEY, url.replace(/\/+$/, ""));
}

export function getSignalingBaseUrl(): string {
  const mode = getServerMode();
  if (mode === "remote") {
    const remote = getRemoteUrl();
    if (remote) return remote;
  }
  return window.location.origin;
}

/** HTTP(S) base URL for REST API calls. */
export function getApiBaseUrl(): string {
  return getSignalingBaseUrl().replace(/^ws(s?):/i, "http$1:");
}

/** WS(S) base URL for WebSocket connections. */
export function getWsBaseUrl(): string {
  return getSignalingBaseUrl().replace(/^http(s?):/i, "ws$1:");
}
