import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Protected API routes: unauthenticated → 401. /api/auth/* is intentionally NOT matched
// (login itself must be reachable). Full verification happens in each route via deriveContext;
// this is the fast gate.
export function middleware(req: NextRequest) {
  const cookie = getSessionCookie(req);
  if (!cookie) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/chat/:path*", "/api/grants/:path*", "/api/audit/:path*", "/api/env/:path*"],
};
