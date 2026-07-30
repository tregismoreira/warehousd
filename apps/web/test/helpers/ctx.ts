import type { BrokerContext } from "@warehousd/broker";

// The web-side twin of packages/broker/test/helpers/ctx.ts — same defaults, same reason. It is a
// second copy rather than a cross-package import because `test/` is not part of either package's
// published surface, so reaching into the broker's test helpers from here would couple two
// tsconfig programs together for four lines.
export function makeCtx(over: Partial<BrokerContext> & { userId: string }): BrokerContext {
  return { orgId: "default", env: "dev", allowedCollections: null, via: "session", ...over };
}
