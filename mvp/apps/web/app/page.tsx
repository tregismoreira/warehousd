"use client";
import { useEffect, useState } from "react";
import { Chat } from "./components/Chat";
import { Evidence } from "./components/Evidence";
import { Grants } from "./components/Grants";
import { authClient } from "../lib/auth-client";

export default function Page() {
  const { data: session, isPending } = authClient.useSession();
  const [env, setEnv] = useState<"dev" | "live">("dev");
  const [tick, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);

  useEffect(() => {
    if (!isPending && !session) window.location.href = "/login";
  }, [isPending, session]);

  if (isPending || !session) return <main style={{ padding: 24 }}>Loading…</main>;

  const role = (session.user as { role?: string }).role ?? "member";
  const canApprove = role === "manager" || role === "admin";

  async function setEnvServer(next: "dev" | "live") {
    await fetch("/api/env", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: next }) });
    setEnv(next); bump();
  }

  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column", padding: 12, gap: 12 }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <b>warehousd security console</b>
        <span>{session.user.email} ({role})</span>
        <label><input type="radio" checked={env === "dev"} onChange={() => setEnvServer("dev")} /> dev</label>
        <label><input type="radio" checked={env === "live"} onChange={() => setEnvServer("live")} /> live</label>
        <button onClick={async () => { await authClient.signOut(); window.location.href = "/login"; }}>
          Sign out</button>
      </header>
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, minHeight: 0 }}>
        <Chat onTurn={bump} />
        <Evidence refreshKey={tick} />
        <Grants canApprove={canApprove} onChange={bump} />
      </div>
    </main>
  );
}
