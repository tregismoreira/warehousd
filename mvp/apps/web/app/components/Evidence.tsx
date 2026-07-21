"use client";
import { useEffect, useState } from "react";
export function Evidence({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { fetch("/api/audit").then((r) => r.json()).then(setRows); }, [refreshKey]);
  return (
    <div className="panel" style={{ height: "100%", overflow: "auto" }}>
      <h3>Evidence — audit trail</h3>
      {rows.map((r) => (
        <div key={r.id} className="mono">
          <span className={r.outcome === "allowed" ? "allow" : "deny"} />
          {r.user_id}/{r.env} · {r.collection} · {r.reason ?? "ok"} · [{(r.fields_returned ?? []).join(",")}]
        </div>
      ))}
    </div>
  );
}
