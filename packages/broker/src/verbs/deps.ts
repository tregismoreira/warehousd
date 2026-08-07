import type { Pool } from "pg";
import type { Pools } from "../db/pools";
import type { WarehousdConfig } from "../config/schema";
import type { Embedder } from "../providers";
import { auditEnabled } from "../config/load";
import { auditDestination, type AuditDestination } from "../audit/decision";

// What every verb family needs, handed over explicitly rather than closed over.
//
// The verbs used to be fifteen nested functions inside `makeBroker`, each reaching freely into its
// scope for `pools`, `cfg` and `app`. That reads fine and makes every verb untestable in isolation
// and every dependency invisible: nothing in a verb's signature said what it touched. Passing this
// object means a verb's needs are declared, and a test can hand it a stub pool.
export type VerbDeps = {
  pools: Pools;
  // pools.app. Named separately because it is the control plane — grants and audit — and no data
  // ever flows through it. Every verb uses it; almost none should use `pools` directly.
  app: Pool;
  cfg: WarehousdConfig;
  // A term field bound to a `multiple: true` vocabulary is a text[] column (apply/ddl.ts), so
  // buildSelect has to reach for `&&`/`= any` rather than `in`/`=`. Omitting this makes it
  // compare text[] against text, which Postgres rejects outright.
  isMultiValueField: (field: string) => boolean;
  // Injected, never constructed here — the implementations live in @warehousd/providers so the
  // broker keeps no ONNX runtime and makes no outbound call. Absent means semantic search is not
  // configured, and `search_documents` refuses `semantic`/`hybrid` rather than silently
  // downgrading to text: a caller that asked for one and got the other has no way to tell.
  embedder?: Embedder | undefined;
  // Resolved once here rather than read from `cfg` at each verb's audit writer, so that "is this
  // deployment audited" has one answer for the life of the broker rather than one per verb.
  auditEnabled: boolean;
  // WHERE an audited decision goes — the same reasoning, one step further. `makeAuditWriter` takes
  // it as its fourth argument; see audit/sinks/.
  auditTo: AuditDestination;
};

export function makeVerbDeps(
  pools: Pools,
  cfg: WarehousdConfig,
  opts: { embedder?: Embedder | undefined } = {},
): VerbDeps {
  return {
    pools,
    app: pools.app,
    cfg,
    ...(opts.embedder ? { embedder: opts.embedder } : {}),
    // `taxonomies` is optional-chained, not indexed: callers that hand-build a config object and
    // cast it never get zod's default, so the key is genuinely absent for most of the test suite.
    isMultiValueField: (field: string) => cfg.taxonomies?.[field]?.multiple ?? false,
    auditEnabled: auditEnabled(cfg),
    // Read through the one helper rather than assembled here: the import path and the console's
    // regen need the same answer, and a second copy is how one of them keeps writing to Postgres
    // after the deployment has been pointed elsewhere. See audit/decision.ts.
    auditTo: auditDestination(cfg),
  };
}
