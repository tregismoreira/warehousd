import { oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { auth } from "../../../lib/auth";

// RFC 9728 protected-resource metadata for OAuth resource server discovery.
// Handler provided by Better Auth's mcp plugin (better-auth/plugins).
export const GET = oAuthProtectedResourceMetadata(auth);
