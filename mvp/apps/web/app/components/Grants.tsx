"use client";
import { useEffect, useState } from "react";

type Grant = {
  id: string; user_id: string; collection: string; env: string; status: string;
  allowed_fields: string[] | null; purpose_label: string | null; expires_at: string | null;
  collectionType?: string;
  taxonomyField?: string | null;
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
  const [docPaths, setDocPaths] = useState<Record<string, string[]>>({});
  const [selectedPaths, setSelectedPaths] = useState<Record<string, Set<string>>>({});
  const [terms, setTerms] = useState<Record<string, { slug: string; label: string }[]>>({});
  const [selectedTerms, setSelectedTerms] = useState<Record<string, Set<string>>>({});

  const load = () => fetch(`/api/grants?user=${persona}`).then((r) => r.json()).then(setData);
  useEffect(() => { load(); }, [persona]);

  async function loadDocPaths(grantId: string, g: Grant) {
    if (g.collectionType !== "document") return;
    const key = `${g.collection}:${g.env}`;
    if (docPaths[key]) return;

    const res = await fetch(`/api/grants/doc-paths?collection=${g.collection}&env=${g.env}`);
    const data = await res.json();
    if (data.paths) {
      setDocPaths(prev => ({ ...prev, [key]: data.paths }));
      setSelectedPaths(prev => ({ ...prev, [grantId]: new Set() }));
    }
  }

  async function loadTerms(grantId: string, g: Grant) {
    if (!g.taxonomyField) return;
    if (terms[g.collection]) return;
    const res = await fetch(`/api/grants/terms?collection=${g.collection}`);
    const data = await res.json();
    if (data.terms) {
      setTerms(prev => ({ ...prev, [g.collection]: data.terms }));
      setSelectedTerms(prev => ({ ...prev, [grantId]: new Set() }));
    }
  }

  async function act(action: string, id: string, allowedFields?: string[],
    selectedPaths?: string[], termSlugs?: string[]) {
    await fetch("/api/grants", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, id, by: persona, allowedFields, selectedPaths,
        selectedTerms: termSlugs,
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
          {others.map((g) => {
            const isDocument = g.collectionType === "document";
            const pathKey = `${g.collection}:${g.env}`;
            const paths = docPaths[pathKey] || [];
            const selected = selectedPaths[g.id] || new Set();

            return (
              <div key={g.id} className="panel" style={{ padding: "8px 10px", marginBottom: 6 }}>
                <GrantRow g={{ ...g, collection: `${g.user_id} → ${g.collection}` }} />
                {isDocument && paths.length > 0 && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--muted)" }}>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>
                      Document paths (optional — leave empty for full access):
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {paths.map(path => (
                        <label key={path} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                          <input
                            type="checkbox"
                            checked={selected.has(path)}
                            onChange={(e) => {
                              const newSelected = new Set(selected);
                              if (e.target.checked) newSelected.add(path);
                              else newSelected.delete(path);
                              setSelectedPaths(prev => ({ ...prev, [g.id]: newSelected }));
                            }}
                          />
                          {path}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {isDocument && !paths.length && (
                  <button
                    onClick={() => loadDocPaths(g.id, g)}
                    style={{ marginTop: 8, fontSize: 11 }}
                  >
                    Load document paths
                  </button>
                )}
                {g.taxonomyField && (terms[g.collection]?.length ?? 0) > 0 && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--muted)" }}>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>
                      Categories (optional — leave empty for full access; overrides path selection):
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {terms[g.collection]!.map(t => (
                        <label key={t.slug} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                          <input
                            type="checkbox"
                            checked={(selectedTerms[g.id] ?? new Set()).has(t.slug)}
                            onChange={(e) => {
                              const next = new Set(selectedTerms[g.id] ?? new Set<string>());
                              if (e.target.checked) next.add(t.slug); else next.delete(t.slug);
                              setSelectedTerms(prev => ({ ...prev, [g.id]: next }));
                            }}
                          />
                          {t.label} <span className="mono" style={{ color: "var(--muted)", fontSize: 10 }}>({t.slug})</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {g.taxonomyField && !(terms[g.collection]?.length) && (
                  <button onClick={() => loadTerms(g.id, g)} style={{ marginTop: 8, fontSize: 11 }}>
                    Load categories
                  </button>
                )}
                <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                  <button
                    onClick={() => act("approve", g.id, g.allowed_fields ?? [],
                      Array.from(selected), Array.from(selectedTerms[g.id] ?? new Set<string>()))}
                  >
                    approve
                  </button>
                  <button onClick={() => act("deny", g.id)}>deny</button>
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
