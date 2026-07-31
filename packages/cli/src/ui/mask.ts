// Secrets the CLI holds but should not shout. `start` used to print the admin password and the
// dev client secret in full on every run, so both ended up in shell scrollback, in screen shares
// and in any terminal recording — for a product whose whole claim is that a denied field never
// appears anywhere. The values still exist in `.warehousd/state.json` and `outputs.json` (mode
// 0600) and still go out in full over `--json`, which is the machine contract. Only the human
// rendering is masked, and `warehousd secrets --show` reveals it on request.

// Below this length a prefix/suffix reveal would give away most of the value, so nothing is shown.
const FULL_HIDE_BELOW = 12;
const KEEP = 4;

export function maskSecret(value: string, unicode = true): string {
  if (!value) return "";
  const hidden = (unicode ? "•" : "*").repeat(8);
  if (value.length < FULL_HIDE_BELOW) return hidden;
  const ellipsis = unicode ? "…" : "...";
  return `${value.slice(0, KEEP)}${ellipsis}${value.slice(-KEEP)}`;
}

// A Postgres URL carries its password in the middle of an otherwise safe-looking string, so
// printing the connection string is printing the credential. Masks only the password component
// and leaves the rest legible, because the host, port and database name are what the reader is
// actually there for.
export function maskUrlPassword(url: string, unicode = true): string {
  if (!url) return "";
  // Matched directly rather than via `new URL`, which is the wrong tool twice over: it re-encodes
  // on the way back out, and it happily parses `user:secret@host` as scheme `user:` with no
  // password at all — returning the credential untouched.
  // `replace`, not `match`: the host, port and database name after the '@' are the reason anyone
  // reads this line, and rebuilding from capture groups alone silently truncated them.
  const withScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/@]+:)([^@/]+)(@)/;
  if (withScheme.test(url)) {
    return url.replace(withScheme, (_m, head: string, pw: string, at: string) => {
      return `${head}${maskSecret(pw, unicode)}${at}`;
    });
  }
  const bare = /^([^:/@\s]+:)([^@/\s]+)(@)/;
  if (bare.test(url)) {
    return url.replace(bare, (_m, head: string, pw: string, at: string) => {
      return `${head}${maskSecret(pw, unicode)}${at}`;
    });
  }
  return url;
}
