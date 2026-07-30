import { cookieHeader, cookiePair } from "./cookies";

// Sign in via SSO provider using the real Better Auth /sign-in/sso and /sso/callback endpoints.
export async function ssoSignIn(
  auth: { handler: (req: Request) => Promise<Response> },
  providerId: string,
  callbackURL: string,
): Promise<{ res: Response; cookie: string; location: string }> {
  // Step 1: POST /sign-in/sso to get authorization URL and state cookie
  const signInUrl = new URL("http://localhost:8722/api/auth/sign-in/sso");
  const signInRes = await auth.handler(
    new Request(signInUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId, callbackURL }),
    }),
  );

  const signInBody = (await signInRes.json()) as { url: string; redirect: boolean };
  const authorizationUrl = signInBody.url;

  // Extract state cookie from Set-Cookie header
  const setCookieHeader = signInRes.headers.get("set-cookie") ?? "";
  const stateCookie = cookiePair(setCookieHeader);

  // Step 2: Fetch the authorization URL (real HTTP to fake IdP)
  const idpRes = await fetch(authorizationUrl, { redirect: "manual" });
  const callbackLocation = idpRes.headers.get("location") ?? "";

  // Step 3: Follow the callback to Better Auth's /sso/callback/:providerId
  const callbackRes = await auth.handler(
    new Request(callbackLocation, {
      headers: { cookie: stateCookie },
    }),
  );

  // Extract session cookie from callback response (might have multiple Set-Cookie headers)
  const callbackSetCookie = callbackRes.headers.get("set-cookie") ?? "";
  const sessionCookie = cookieHeader(callbackSetCookie);

  // Get the redirect location from /sso/callback
  let finalLocation = callbackRes.headers.get("location") ?? "";

  // If the callback URL is itself an endpoint that needs further processing (e.g., /api/auth/mcp/authorize),
  // we may need to follow additional redirects. Continue until we reach the final destination.
  let sessionCookieToUse = sessionCookie;
  if (finalLocation && finalLocation.includes("/api/auth/")) {
    const followRes = await auth.handler(
      new Request(new URL(finalLocation, "http://localhost:8722"), {
        headers: { cookie: sessionCookieToUse },
      }),
    );

    // Capture any additional cookies
    const followSetCookie = followRes.headers.get("set-cookie") ?? "";
    if (followSetCookie) {
      sessionCookieToUse = cookieHeader(followSetCookie);
    }

    finalLocation = followRes.headers.get("location") ?? finalLocation;
  }

  return { res: callbackRes, cookie: sessionCookieToUse, location: finalLocation };
}
