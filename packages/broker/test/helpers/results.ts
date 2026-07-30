import type { MutationResult, Refusal, VisibleSchema } from "../../src/types";

export type AppliedMutation = Extract<MutationResult, { status: "applied" }>;
export type PendingMutation = Extract<MutationResult, { status: "pending" }>;
export type CollectionListing = { name: string; description: string };

// Every broker verb returns a union whose refusal arm is part of the contract, so a suite that
// wants the success arm has to say so. These assert the arm and narrow it, which is the part
// `if (r.ok)` could not do:
//
//  - `MutationResult` has *two* success arms — `applied` (documentId/rev) and `pending`
//    (proposalId) — so `if (r.ok)` leaves the pair unresolved and `r.documentId` untypeable.
//  - Worse, a block of assertions wrapped in `if (r.ok)` silently ran zero of them if the result
//    ever changed arm. Asserting fails loudly instead, naming the arm it actually got.

export function assertApplied(r: MutationResult): asserts r is AppliedMutation {
  if (!r.ok) throw new Error(`expected an applied mutation, got refusal: ${r.reason}`);
  if (r.status !== "applied")
    throw new Error(`expected an applied mutation, got status ${r.status}`);
}

export function assertPending(r: MutationResult): asserts r is PendingMutation {
  if (!r.ok) throw new Error(`expected a pending proposal, got refusal: ${r.reason}`);
  if (r.status !== "pending")
    throw new Error(`expected a pending proposal, got status ${r.status}`);
}

// `describeCollection` and `listCollections` return their payload bare rather than in an `{ ok }`
// envelope, so the refusal arm is the only one carrying `ok` — that is what discriminates them.
export function assertSchema(r: VisibleSchema | Refusal): asserts r is VisibleSchema {
  if ("ok" in r) throw new Error(`expected a collection schema, got refusal: ${r.reason}`);
}

export function assertListing(r: CollectionListing[] | Refusal): asserts r is CollectionListing[] {
  if (!Array.isArray(r)) throw new Error(`expected a collection listing, got refusal: ${r.reason}`);
}
