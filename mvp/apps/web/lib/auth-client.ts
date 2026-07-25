import { createAuthClient } from "better-auth/react";

// Same-origin by default: the browser already knows the host and port it loaded from, so the
// auth client must not depend on a build-time NEXT_PUBLIC_BETTER_AUTH_URL. The published image
// is built once and served on whatever port `warehousd start` publishes.
export const authClient = createAuthClient({ baseURL: "" });
