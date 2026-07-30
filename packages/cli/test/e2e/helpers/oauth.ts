import { createHash, randomBytes } from "node:crypto";

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function signInViaHttp(
  apiUrl: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${apiUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: apiUrl,
    },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sign-in failed: ${res.status} ${text}`);
  }

  const setCookie = res.headers.get("set-cookie") ?? "";
  if (!setCookie) {
    const body = await res.text();
    throw new Error(
      `No set-cookie header in sign-in response. Status: ${res.status}, Body: ${body}`,
    );
  }
  // Reduce "name=value; attrs" to just "name=value" pairs joined for a Cookie header. The `?? c`
  // is for the checker only: `String.split` always yields at least one element, which
  // `noUncheckedIndexedAccess` cannot see.
  return setCookie
    .split(/,(?=[^;]+?=)/)
    .map((c: string) => (c.split(";")[0] ?? c).trim())
    .join("; ");
}

export async function authorizeAndGetCode(
  apiUrl: string,
  opts: {
    clientId: string;
    redirectUri: string;
    scope: string;
    cookie: string;
    challenge: string;
  },
): Promise<{ code: string | null; location: string }> {
  const url = new URL(`${apiUrl}/api/auth/mcp/authorize`);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", opts.scope);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { cookie: opts.cookie, Origin: apiUrl },
    redirect: "manual",
  });

  const location = res.headers.get("location") ?? "";
  if (!location) {
    const body = await res.text();
    throw new Error(
      `No location header in authorize response. Status: ${res.status}, Body: ${body.substring(0, 500)}`,
    );
  }
  const code = location ? new URL(location, "http://localhost").searchParams.get("code") : null;
  return { code, location };
}

export async function exchangeCodeForToken(
  apiUrl: string,
  opts: {
    clientId: string;
    clientSecret: string;
    code: string;
    verifier: string;
    redirectUri: string;
  },
): Promise<{ access_token: string; scope: string }> {
  const res = await fetch(`${apiUrl}/api/auth/mcp/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code_verifier: opts.verifier,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  const body = await res.json();
  return { access_token: body.access_token, scope: body.scope };
}
