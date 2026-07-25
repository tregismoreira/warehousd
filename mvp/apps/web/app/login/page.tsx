"use client";
import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { authClient } from "../../lib/auth-client";

const LOCAL_LOGIN_DISABLED = process.env.NEXT_PUBLIC_LOCAL_LOGIN_DISABLED === "true";
const DEMO = process.env.NEXT_PUBLIC_WAREHOUSD_DEMO === "true";

const DEMO_CREDS = [
  { email: "ana@meridian.demo", role: "admin" },
  { email: "marcus@meridian.demo", role: "manager" },
  { email: "mia@meridian.demo", role: "member" },
];

interface SSOProvider {
  providerId: string;
  domain: string;
  type: string;
}

export default function Login() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<SSOProvider[]>([]);
  const [localLoginEnabled, setLocalLoginEnabled] = useState(false);

  // Compute returnTo: if OAuth authorize continuation, use that; otherwise "/"
  const returnTo = (() => {
    const clientId = searchParams.get("client_id");
    const responseType = searchParams.get("response_type");
    if (clientId && responseType) {
      return "/api/auth/mcp/authorize?" + searchParams.toString();
    }
    return "/";
  })();

  // Fetch SSO status on mount
  useEffect(() => {
    async function fetchSSOStatus() {
      try {
        const res = await fetch("/api/sso/status");
        if (res.ok) {
          const data = await res.json();
          setProviders(data.providers ?? []);
          setLocalLoginEnabled(data.localLoginEnabled ?? false);
        }
      } catch {
        // Silently fail - show login form anyway
      } finally {
        setLoading(false);
      }
    }

    fetchSSOStatus();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const { error } = await authClient.signIn.email({ email, password, callbackURL: returnTo });
    if (error) setErr(error.message ?? "login failed");
    else window.location.href = returnTo;
  }

  async function signInWithSSO(providerId: string) {
    try {
      setErr(null);
      const { error } = await authClient.signIn.sso({ providerId, callbackURL: returnTo });
      if (error) setErr(error.message ?? "SSO sign-in failed");
    } catch (e) {
      setErr("SSO sign-in failed");
    }
  }

  // No login method configured
  if (loading) {
    return <main style={{ padding: 24 }}>
      <p>Loading...</p>
    </main>;
  }

  if (!providers.length && !localLoginEnabled) {
    return <main style={{ padding: 24 }}>
      <h2>No login method is configured</h2>
    </main>;
  }

  // SSO is default (≥1 provider configured)
  if (providers.length) {
    return (
      <main style={{ padding: 24, maxWidth: 360 }}>
        <h2>warehousd security console</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {providers.map((p) => (
            <button
              key={p.providerId}
              onClick={() => signInWithSSO(p.providerId)}
              style={{
                padding: 12,
                fontSize: 14,
                border: "1px solid #ccc",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Sign in with your company account
            </button>
          ))}

          {localLoginEnabled && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "#666" }}>
                Use a local account
              </summary>
              <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
                <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="submit">Sign in</button>
                {err && <p style={{ color: "crimson" }}>{err}</p>}
              </form>
              {DEMO && (
                <div style={{ marginTop: 12, fontSize: 12 }}>
                  <b>Demo credentials</b> (password <code>demo</code>):
                  <ul>{DEMO_CREDS.map((c) => (
                    <li key={c.email}><button style={{ font: "inherit", cursor: "pointer" }}
                      onClick={() => { setEmail(c.email); setPassword("demo"); }}>
                      {c.email}</button> — {c.role}</li>
                  ))}</ul>
                </div>
              )}
            </details>
          )}
        </div>
        {err && <p style={{ color: "crimson", marginTop: 12 }}>{err}</p>}
      </main>
    );
  }

  // Local login only (no SSO providers)
  return (
    <main style={{ padding: 24, maxWidth: 360 }}>
      <h2>warehousd security console</h2>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit">Sign in</button>
        {err && <p style={{ color: "crimson" }}>{err}</p>}
      </form>
      {DEMO && (
        <div style={{ marginTop: 16, fontSize: 13 }}>
          <b>Demo credentials</b> (password <code>demo</code>):
          <ul>{DEMO_CREDS.map((c) => (
            <li key={c.email}><button style={{ font: "inherit" }}
              onClick={() => { setEmail(c.email); setPassword("demo"); }}>
              {c.email}</button> — {c.role}</li>
          ))}</ul>
        </div>
      )}
    </main>
  );
}
