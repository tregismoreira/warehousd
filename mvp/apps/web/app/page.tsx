"use client";
import { useState } from "react";
import { Chat } from "./components/Chat";
import { Evidence } from "./components/Evidence";
import { Grants } from "./components/Grants";
import { PERSONAS } from "./lib/persona";

export default function Page() {
  const [persona, setPersona] = useState("mia");
  const [env, setEnv] = useState<"dev" | "live">("dev");
  const [tick, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column", padding: 12, gap: 12 }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <b>warehousd security console</b>
        <select value={persona} onChange={(e) => { setPersona(e.target.value); bump(); }}>
          {PERSONAS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <label><input type="radio" checked={env === "dev"} onChange={() => { setEnv("dev"); bump(); }} /> dev</label>
        <label><input type="radio" checked={env === "live"} onChange={() => { setEnv("live"); bump(); }} /> live</label>
      </header>
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, minHeight: 0 }}>
        <Chat persona={persona} env={env} onTurn={bump} />
        <Evidence refreshKey={tick} />
        <Grants persona={persona} onChange={bump} />
      </div>
    </main>
  );
}
