import type { BrokerContext } from "../../src/types";

// One factory for the ~230 BrokerContext literals the suite used to spell out by hand.
//
// Every dimension defaults to its widest, least interesting answer, so a suite states only the
// dimension it is about — `makeCtx({ userId: "alice", env: "live" })` rather than four fields of which
// two are noise. `allowedCollections: null` is "no ceiling", which is what omitting the field used
// to mean before packages/broker/src/types.ts made it required.
//
// The point of the factory is that the *next* required field on BrokerContext is a one-line change
// here instead of a 230-literal sweep. Phase 4.3 adding `allowedCollections` is what proved that;
// see the plan's 5.2.1.
export function makeCtx(over: Partial<BrokerContext> & { userId: string }): BrokerContext {
  return { workspaceId: "default", env: "dev", allowedCollections: null, via: "session", ...over };
}
