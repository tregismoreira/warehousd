import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// The credential endpoints, and only those. A cross-site POST here establishes a session, which
// is the one thing an attacker's page can usefully cause.
//
// Better Auth does not gate these on Origin: its `originCheck` middleware guards routes that
// carry a redirect target (`callbackURL`, `redirectTo`) and validates *that* URL, so
// `trustedOrigins` is an open-redirect allowlist rather than a CSRF one. The JSON shape is
// protected in practice — a cross-origin `fetch` with `content-type: application/json` needs a
// CORS preflight, and the app answers none — but a form-encoded POST is a "simple request", gets
// no preflight, and succeeded: the browser would honour the Set-Cookie and log the victim into
// an account the attacker controls. Their subsequent writes and imports then land in it, audited
// as the attacker's user.
const CREDENTIAL_PATH = /^\/api\/auth\/(sign-in|sign-up)(\/|$)/;

// Deliberately NOT covered here:
// - /api/auth/sso/saml2/sp/acs/* — the SAML assertion is a cross-origin POST from the IdP. That
//   is the flow working, not an attack, and the IdP's origin is in WAREHOUSD_TRUSTED_ORIGINS.
// - /api/auth/mcp/token and the OAuth endpoints — server-to-server callers send no Origin at all,
//   and the gate below only refuses an Origin that is present and untrusted.
function trustedOrigins(): string[] {
  const base = process.env.BETTER_AUTH_URL ?? "http://localhost:8722";
  const extra = (process.env.WAREHOUSD_TRUSTED_ORIGINS ?? "").split(",");
  const out = new Set<string>();
  for (const value of [base, ...extra]) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    try {
      out.add(new URL(trimmed).origin);
    } catch {
      // A malformed entry is a config error, not a reason to trust everything: skip it.
    }
  }
  return [...out];
}

export function middleware(req: NextRequest) {
  if (CREDENTIAL_PATH.test(req.nextUrl.pathname)) {
    // Absent Origin means a non-browser caller (curl, a server). Browsers always send it on a
    // cross-site request, so absence cannot be an attack from a page.
    const origin = req.headers.get("origin");
    if (origin && !trustedOrigins().includes(origin)) {
      return NextResponse.json({ error: "untrusted_origin" }, { status: 403 });
    }
    return NextResponse.next();
  }

  const cookie = getSessionCookie(req);
  if (!cookie) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/api/auth/sign-in/:path*",
    "/api/auth/sign-up/:path*",
    "/api/grants/:path*",
    "/api/audit/:path*",
    "/api/env/:path*",
    "/api/sso/providers",
    "/api/sso/providers/:path*",
    "/api/admin/:path*",
    "/api/me/:path*",
    "/api/oauth-clients/:path*",
    "/api/connect-info",
  ],
};
