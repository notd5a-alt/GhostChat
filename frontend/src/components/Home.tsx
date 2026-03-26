import { useState, type FormEvent } from "react";
import ThemeSelector from "./ThemeSelector";
import {
  getServerMode,
  setServerMode,
  getRemoteUrl,
  setRemoteUrl,
  type ServerMode,
} from "../config";

interface HomeProps {
  onCreateRoom: () => void;
  onJoinRoom: (code: string) => void;
  roomError: string | null;
  themeId: string;
  onThemeChange: (id: string) => void;
}

export default function Home({ onCreateRoom, onJoinRoom, roomError, themeId, onThemeChange }: HomeProps) {
  const [joinCode, setJoinCode] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [serverMode, setServerModeState] = useState<ServerMode>(getServerMode);
  const [remoteUrl, setRemoteUrlState] = useState(getRemoteUrl);

  const handleModeChange = (mode: ServerMode) => {
    setServerModeState(mode);
    setServerMode(mode);
  };

  const handleUrlChange = (url: string) => {
    setRemoteUrlState(url);
    setRemoteUrl(url);
  };

  const remoteReady = serverMode === "local" || remoteUrl.trim().length > 0;

  return (
    <div className="home">
      <img src="/logo.png" alt="Synced" className="home-logo" />
      <h1>Synced</h1>
      <p className="subtitle">Encrypted peer-to-peer communication. No accounts. No traces.</p>

      <div className="home-actions">
        <button
          className="btn primary"
          onClick={onCreateRoom}
          disabled={!remoteReady}
        >
          Create Room
        </button>

        <div className="divider">// // // // //</div>

        <form
          className="join-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (joinCode.trim()) onJoinRoom(joinCode.trim());
          }}
        >
          <input
            type="text"
            placeholder="Enter room code"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            style={{ textTransform: "uppercase", letterSpacing: "0.15em" }}
          />
          <button className="btn" type="submit" disabled={!joinCode.trim() || !remoteReady}>
            [ JOIN ]
          </button>
        </form>

        {roomError && (
          <p className="room-error">{roomError}</p>
        )}
      </div>

      <button
        className="btn small server-settings-toggle"
        onClick={() => setShowSettings((s) => !s)}
      >
        {showSettings ? "[ HIDE SERVER ]" : "[ SERVER ]"}
      </button>

      {showSettings && (
        <div className="server-settings">
          <div className="server-mode-toggle">
            <button
              className={`btn small ${serverMode === "local" ? "active" : ""}`}
              onClick={() => handleModeChange("local")}
            >
              LOCAL
            </button>
            <button
              className={`btn small ${serverMode === "remote" ? "active" : ""}`}
              onClick={() => handleModeChange("remote")}
            >
              REMOTE
            </button>
          </div>

          {serverMode === "local" && (
            <p className="server-hint">
              Using local backend (localhost). Both peers must be on the same network.
            </p>
          )}

          {serverMode === "remote" && (
            <>
              <input
                type="text"
                className="server-url-input"
                placeholder="http://your-server:9876"
                value={remoteUrl}
                onChange={(e) => handleUrlChange(e.target.value)}
              />
              <p className="server-hint">
                {remoteUrl.trim()
                  ? `Signaling via ${remoteUrl.trim()}`
                  : "Enter your signaling server URL to connect."}
              </p>
            </>
          )}
        </div>
      )}

      <ThemeSelector currentTheme={themeId} onSelect={onThemeChange} />
    </div>
  );
}
