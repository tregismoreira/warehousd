"use client";
import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { authClient } from "../../lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="flex min-h-screen items-center justify-center p-6">{children}</main>;
}

function LoginInner() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
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
    setSubmitting(true);
    const { error } = await authClient.signIn.email({ email, password, callbackURL: returnTo });
    if (error) { setErr(error.message ?? "login failed"); setSubmitting(false); }
    else window.location.href = returnTo;
  }

  async function signInWithSSO(providerId: string, providerType: string) {
    try {
      setErr(null);
      const { error } = await authClient.signIn.sso({
        providerId,
        callbackURL: returnTo,
        ...(providerType === "saml" && { providerType: "saml" }),
      });
      if (error) setErr(error.message ?? "SSO sign-in failed");
    } catch {
      setErr("SSO sign-in failed");
    }
  }

  if (loading) {
    return (
      <Centered>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </Centered>
    );
  }

  if (!providers.length && !localLoginEnabled) {
    return (
      <Centered>
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>No login method is configured</CardTitle>
          </CardHeader>
        </Card>
      </Centered>
    );
  }

  const localLoginForm = (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email" placeholder="email" type="email" autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password" placeholder="password" type="password" autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <Button type="submit" className="w-full" disabled={submitting}>
        Sign in
      </Button>
      {err && <p className="text-sm text-deny" role="alert">{err}</p>}
    </form>
  );

  const demoCreds = DEMO && (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p><strong className="text-foreground">Demo credentials</strong> (password <code className="font-mono">demo</code>):</p>
      <ul className="space-y-1">
        {DEMO_CREDS.map((c) => (
          <li key={c.email}>
            <button
              type="button"
              className="font-mono underline-offset-2 hover:underline"
              onClick={() => { setEmail(c.email); setPassword("demo"); }}
            >
              {c.email}
            </button>{" "}— {c.role}
          </li>
        ))}
      </ul>
    </div>
  );

  // SSO is default (≥1 provider configured)
  if (providers.length) {
    return (
      <Centered>
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>warehousd security console</CardTitle>
            <CardDescription>Sign in to continue</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {providers.map((p) => (
              <Button
                key={p.providerId}
                variant="outline"
                className="w-full"
                onClick={() => signInWithSSO(p.providerId, p.type)}
              >
                Sign in with your company account
              </Button>
            ))}

            {localLoginEnabled && (
              <details>
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  Use a local account
                </summary>
                <div className="mt-4 space-y-4">
                  {localLoginForm}
                  {demoCreds}
                </div>
              </details>
            )}
            {err && !localLoginEnabled && <p className="text-sm text-deny" role="alert">{err}</p>}
          </CardContent>
        </Card>
      </Centered>
    );
  }

  // Local login only (no SSO providers)
  return (
    <Centered>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>warehousd security console</CardTitle>
          <CardDescription>Sign in to continue</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {localLoginForm}
          {demoCreds}
        </CardContent>
      </Card>
    </Centered>
  );
}

export default function Login() {
  return (
    <Suspense fallback={<Centered><p className="text-sm text-muted-foreground">Loading...</p></Centered>}>
      <LoginInner />
    </Suspense>
  );
}
