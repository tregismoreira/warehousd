// The console's client components all talk to the same JSON API, and each one had written out the
// same plumbing: set the content type, check `res.ok`, parse the body, dig `error` out of it, and
// have something printable ready for when the body is not JSON at all. Fifteen copies of six lines
// is fifteen places for one of them to be subtly different.
//
// This owns the wire and nothing else. State, toasts, reloads and refetches stay in the component,
// because those are what actually differ between call sites — the fetch never was.
export async function requestJson<T = Record<string, unknown>>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const headers = new Headers(init?.headers);
    // Only a string body is JSON. FormData carries a multipart boundary the browser has to set
    // itself, and naming a content type over it breaks the parse on the server.
    if (typeof init?.body === "string" && !headers.has("content-type"))
      headers.set("content-type", "application/json");

    const res = await fetch(url, { ...init, headers });
    const body: unknown = await res.json().catch(() => null);

    if (!res.ok) {
      const reported = (body as { error?: unknown } | null)?.error;
      return { ok: false, error: typeof reported === "string" ? reported : `HTTP ${res.status}` };
    }
    return { ok: true, data: body as T };
  } catch (e) {
    // A network failure or an aborted request never reached a status code. It is still something
    // the caller has to show a person, so it arrives in the same shape as a refusal.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
