import { useState, type FormEvent } from "react";
import ThemeSelector from "./ThemeSelector";

interface HomeProps {
  onHost: () => void;
  onJoin: (addr: string) => void;
  themeId: string;
  onThemeChange: (id: string) => void;
}

export default function Home({ onHost, onJoin, themeId, onThemeChange }: HomeProps) {
  const [joinAddr, setJoinAddr] = useState("");

  return (
    <div className="home">
      <img src="/logo.png" alt="Synced" className="home-logo" />
      <h1>Synced</h1>
      <p className="subtitle">Encrypted peer-to-peer communication. No accounts. No traces.</p>

      <div className="home-actions">
        <button className="btn primary" onClick={onHost}>
          Host a Session
        </button>

        <div className="divider">// // // // //</div>

        <form
          className="join-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (joinAddr.trim()) onJoin(joinAddr.trim());
          }}
        >
          <input
            type="text"
            placeholder="Enter host address (ip:port)"
            value={joinAddr}
            onChange={(e) => setJoinAddr(e.target.value)}
          />
          <button className="btn" type="submit" disabled={!joinAddr.trim()}>
            [ JOIN ]
          </button>
        </form>
      </div>

      <ThemeSelector currentTheme={themeId} onSelect={onThemeChange} />
    </div>
  );
}
