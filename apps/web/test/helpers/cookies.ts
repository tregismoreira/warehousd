// `Set-Cookie: name=value; Path=/; HttpOnly` → `name=value`, which is all a Cookie header may
// carry back. Written out seven times across the SSO helpers and suites before this; collected
// here because `noUncheckedIndexedAccess` cannot see that `String.split` always yields at least
// one element, and seven `!`s would have been seven places to be wrong instead of one.
export function cookiePair(setCookie: string): string {
  return (setCookie.split(";")[0] ?? setCookie).trim();
}

// A single `set-cookie` header value may hold several cookies, comma-joined. The lookahead is what
// keeps the split off the commas inside an `Expires=Wed, 01 Jan ...` attribute: only a comma
// followed by `<token>=` starts a new cookie.
export function cookieHeader(setCookie: string): string {
  return setCookie
    .split(/,(?=[^;]+?=)/)
    .map(cookiePair)
    .join("; ");
}
