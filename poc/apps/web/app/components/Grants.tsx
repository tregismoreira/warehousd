"use client";
import { useEffect, useState } from "react";

type Grant = {
  id: string; user_id: string; collection: string; env: string; status: string;
  allowed_fields: string[] | null; purpose_label: string | null; expires_at: string | null;
};

const STATUS_COLOR: Record<string, string> = {
  approved: "var(--allow)", pending: "#d29922", denied: "var(--deny)", revoked: "var(--deny)",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span style={{
      color: STATUS_COLOR[status] ?? "var(--muted)", border: `1px solid ${STATUS_COLOR[status] ?? "var(--muted)"}`,
      borderRadius: 4, padding: "1px 6px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5,
    }}>
      {status}
    </span>
  );
}

function GrantRow({ g, action }: { g: Grant; action?: React.ReactNode }) {
  return (
    <div className="panel" style={{ padding: "8px 10px", marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div>
          <b>{g.collection}</b>{" "}
          <span className="mono" style={{ color: "var(--muted)", fontSize: 11 }}>({g.env})</span>
          {g.purpose_label && (
            <span style={{ color: "var(--muted)", fontSize: 12 }}> — {g.purpose_label}</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <StatusBadge status={g.status} />
          {action}
        </div>
      </div>
      <div className="mono" style={{ color: "var(--muted)", fontSize: 11, marginTop: 4 }}>
        fields: {(g.allowed_fields ?? []).join(", ") || "(none)"}
      </div>
    </div>
  );
}

export function Grants({ persona, onChange }: { persona: string; onChange: () => void }) {
  const [data, setData] = useState<{ mine: Grant[]; pending: Grant[] }>({ mine: [], pending: [] });
  const load = () => fetch(`/api/grants?user=${persona}`).then((r) => r.json()).then(setData);
  useEffect(() => { load(); }, [persona]);
  async function act(action: string, id: string, allowedFields?: string[]) {
    await fetch("/api/grants", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, id, by: persona, allowedFields,
        expiresAt: new Date(Date.parse("2099-01-01")).toISOString() }) });
    await load(); onChange();
  }

  const canApprove = persona === "marcus" || persona === "ana";
  const others = canApprove ? data.pending.filter((g) => g.user_id !== persona) : [];

  return (
    <div className="panel" style={{ height: "100%", overflow: "auto" }}>
      <h3>Grants — {persona}</h3>
      <p style={{ color: "var(--muted)", fontSize: 12, marginTop: -6, marginBottom: 12 }}>
        A grant is what lets {persona} query a collection — deny-by-default, so no grant means no access.
        Each grant lists exactly which fields are visible and can be revoked at any time.
      </p>

      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
        {persona}&rsquo;s access
      </div>
      {data.mine.length === 0 && (
        <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 12 }}>No grants yet.</div>
      )}
      {data.mine.map((g) => (
        <GrantRow key={g.id} g={g}
          action={g.status === "approved" && (
            <button onClick={() => act("revoke", g.id)}>revoke</button>
          )} />
      ))}

      {others.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 16, marginBottom: 6 }}>
            Pending requests awaiting your approval
          </div>
          {others.map((g) => (
            <GrantRow key={g.id} g={{ ...g, collection: `${g.user_id} → ${g.collection}` }}
              action={
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => act("approve", g.id, g.allowed_fields ?? [])}>approve</button>
                  <button onClick={() => act("deny", g.id)}>deny</button>
                </div>
              } />
          ))}
        </>
      )}
    </div>
  );
}
