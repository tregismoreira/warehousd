import type { WarehousdConfig } from "./config/schema";
import type { Pools } from "./db/pools";
import type { Embedder } from "./providers";
import { makeVerbDeps } from "./verbs/deps";
import { makeReadVerbs } from "./verbs/read";
import { makeMutateVerb } from "./verbs/mutate";
import { makeProposeVerbs } from "./verbs/propose";
import { makeHistoryVerbs } from "./verbs/history";
import { makeAclVerbs } from "./acl/manage";
import { makeExplainVerb } from "./verbs/explain";

// The composition root, and nothing else.
//
// This file was 1,399 lines holding fifteen verbs, five module helpers, ~25 copies of the same
// ten-field audit literal, three copies of REV_COLS and eight of the primary-key lookup. The verbs
// have moved to verbs/*, grouped by what they do rather than by having been written on the same
// day; the duplication they shared has moved to the helpers each of them now imports
// (audit/decision.ts, config/collection.ts, sql/ident.ts, grants/filters.ts).
//
// What is left is the wiring, and the guarantee that every adapter still gets exactly the same
// object it always did. No verb closes over this scope any more: each family takes VerbDeps
// explicitly, so what a verb touches is visible in its signature and a test can hand it a stub.
export function makeBroker(
  pools: Pools,
  cfg: WarehousdConfig,
  opts: { embedder?: Embedder | undefined } = {},
) {
  const deps = makeVerbDeps(pools, cfg, opts);

  const { query, describeCollection, listCollections, searchDocuments, getDocument } =
    makeReadVerbs(deps);
  const mutate = makeMutateVerb(deps);
  const { approveProposal, rejectProposal, listProposals, getProposal, decideProposals } =
    makeProposeVerbs(deps);
  const { changes, listRevisions } = makeHistoryVerbs(deps);
  // Not grant verbs, and not MCP tools: managing an ACL is authorised against the caller's
  // standing (console role, or the client's can_manage_acl flag), never against a grant. See
  // acl/manage.ts.
  const { getDocumentAcl, setDocumentAcl } = makeAclVerbs(deps);
  // Console-only, and authorised the same way: it answers about a SUBJECT, so asking about
  // somebody else is a manager's act. There is deliberately no MCP tool — a model that could ask
  // why a field is denied could map the shape of what it cannot see. See verbs/explain.ts.
  const { explainAccess } = makeExplainVerb(deps);

  return {
    query,
    describeCollection,
    listCollections,
    searchDocuments,
    getDocument,
    mutate,
    approveProposal,
    rejectProposal,
    listProposals,
    decideProposals,
    changes,
    listRevisions,
    explainAccess,
    getProposal,
    getDocumentAcl,
    setDocumentAcl,
  };
}
