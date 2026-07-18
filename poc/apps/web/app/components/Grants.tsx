"use client";
import { useEffect, useState } from "react";
export function Grants({ persona, onChange }: { persona: string; onChange: () => void }) {
  const [data, setData] = useState<{ mine: any[]; pending: any[] }>({ mine: [], pending: [] });
  const load = () => fetch(`/api/grants?user=${persona}`).then((r) => r.json()).then(setData);
  useEffect(() => { load(); }, [persona]);
  async function act(action: string, id: string, allowedFields?: string[]) {
    await fetch("/api/grants", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, id, by: persona, allowedFields,
        expiresAt: new Date(Date.parse("2099-01-01")).toISOString() }) });
    await load(); onChange();
  }
  return (
    <div className="panel" style={{ height: "100%", overflow: "auto" }}>
      <h3>Grants — {persona}</h3>
      {data.mine.map((g) => (
        <div key={g.id} className="mono">
          {g.collection} · {g.status} · [{(g.allowed_fields ?? []).join(",")}]
          {g.status === "approved" && <button onClick={() => act("revoke", g.id)}>revoke</button>}
        </div>
      ))}
      {persona === "marcus" && data.pending.length > 0 && <>
        <h4>Pending requests</h4>
        {data.pending.map((g) => (
          <div key={g.id} className="mono">
            {g.user_id} → {g.collection} [{(g.allowed_fields ?? []).join(",")}]
            <button onClick={() => act("approve", g.id, g.allowed_fields)}>approve</button>
            <button onClick={() => act("deny", g.id)}>deny</button>
          </div>
        ))}
      </>}
    </div>
  );
}
