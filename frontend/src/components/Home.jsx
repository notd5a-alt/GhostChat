import { useState } from "react";

export default function Home({ onHost, onJoin }) {
  const [joinAddr, setJoinAddr] = useState("");

  return (
    <div className="home">
      <img src="/logo.png" alt="GhostChat" className="home-logo" />
      <h1>GhostChat</h1>
      <p className="subtitle">Encrypted peer-to-peer communication. No accounts. No traces.</p>

      <div className="home-actions">
        <button className="btn primary" onClick={onHost}>
          Host a Session
        </button>

        <div className="divider">// // // // //</div>

        <form
          className="join-form"
          onSubmit={(e) => {
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
    </div>
  );
}
