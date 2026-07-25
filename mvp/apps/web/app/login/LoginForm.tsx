"use client";
import { useState } from "react";
import { authClient } from "../../lib/auth-client";

interface LoginFormProps {
  demo: boolean;
  disabled: boolean;
}

const DEMO_CREDS = [
  { email: "ana@meridian.demo", role: "admin" },
  { email: "marcus@meridian.demo", role: "manager" },
  { email: "mia@meridian.demo", role: "member" },
];

export default function LoginForm({ demo, disabled }: LoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const { error } = await authClient.signIn.email({ email, password, callbackURL: "/" });
    if (error) setErr(error.message ?? "login failed");
    else window.location.href = "/";
  }

  if (disabled) {
    return <main style={{ padding: 24 }}>
      <h2>Local login is disabled</h2>
      <p>Sign in through your organization&rsquo;s SSO provider.</p>
    </main>;
  }

  return (
    <main style={{ padding: 24, maxWidth: 360 }}>
      <h2>warehousd security console</h2>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit">Sign in</button>
        {err && <p style={{ color: "crimson" }}>{err}</p>}
      </form>
      {demo && (
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
