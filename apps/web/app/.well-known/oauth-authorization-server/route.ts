import { oAuthDiscoveryMetadata } from "better-auth/plugins";
import { auth } from "../../../lib/auth";

// OIDC discovery metadata for the OAuth authorization server (RFC 9728).
// Handler provided by Better Auth's mcp plugin (better-auth/plugins).
export const GET = oAuthDiscoveryMetadata(auth);
