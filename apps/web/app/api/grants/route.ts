import { NextRequest } from "next/server";
import { getAppPool, getConfig } from "../../lib/broker";
import {
  approveGrant,
  denyGrant,
  revokeGrant,
  requestGrant,
  validateGrantRequest,
  unmaskableFields,
  isPrincipal,
  listGroups,
  userPrincipal,
  GROUP_PREFIX,
  expiringGrants,
} from "@warehousd/broker";
import { requireSession, requireRole, atLeast } from "../../../lib/authz";
import { readJson } from "../../../lib/rest";
import { readEnvCookie } from "../../../lib/session";
import { buildApproval } from "../../../lib/approve";

// The window the manager inbox calls "soon". A week is long enough to act on and short enough
// that the panel is empty most days, which is what keeps it worth looking at.
const EXPIRING_SOON_DAYS = 7;

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  const user = guard.user;
  const app = getAppPool();
  const cfg = getConfig();
  const workspace = guard.workspaceId;
  // A member's own grants are now the ones held for THEM — their personal grants plus every
  // group grant they inherit. Keyed on user_id it would have shown a group grant only to whoever
  // happened to request it, and shown nothing to the people it actually gives access to.
  const principals = await app.query<{ group_name: string }>(
    `select distinct group_name from app.user_groups where workspace_id=$1 and user_id=$2`,
    [workspace, user.id],
  );
  const mineFor = [
    userPrincipal(user.id),
    ...principals.rows.map((r) => `${GROUP_PREFIX}${r.group_name}`),
  ];
  const mine = await app.query(
    `select * from app.grants where workspace_id=$1 and (principal = any($2) or user_id=$3)
     order by requested_at desc`,
    [workspace, mineFor, user.id],
  );
  // The pending queue is approver-only data: it names who asked for what, and why. A member
  // calling this endpoint directly used to receive the whole workspace's queue. It is also
  // workspace-scoped: a manager approves for their own tenant, never another's.
  const pending = atLeast(guard.role, "manager")
    ? await app.query(
        `select * from app.grants where workspace_id=$1 and status='pending' order by requested_at desc`,
        [workspace],
      )
    : { rows: [] as typeof mine.rows };

  const active = atLeast(guard.role, "manager")
    ? await app.query(
        `select * from app.grants where workspace_id=$1 and status='approved' order by decided_at desc nulls last`,
        [workspace],
      )
    : { rows: [] as typeof mine.rows };

  const enriched = (rows: typeof mine.rows) =>
    rows.map((g) => ({
      ...g,
      collectionType: cfg.collections[g.collection]?.type || "dataset",
      taxonomyFields: cfg.collections[g.collection]?.taxonomies ?? [],
      // Which of this collection's fields the config lets a grant carry UNMASKED. The approver
      // sees a second checkbox only for these — a masked field with `unmask: deny` offers no
      // choice, and rendering one that always fails would be worse than rendering none.
      unmaskableFields: unmaskableFields(cfg, g.collection),
    }));

  // §P7. Approved, live, and about to lapse. An approver renewing access before it stops working
  // is making a decision; finding out because a query started refusing is not.
  const expiring = atLeast(guard.role, "manager")
    ? await expiringGrants(app, { workspaceId: workspace, within: EXPIRING_SOON_DAYS })
    : [];

  return Response.json({
    mine: enriched(mine.rows),
    pending: enriched(pending.rows),
    active: enriched(active.rows),
    expiring,
  });
}

/** The bare name inside a namespaced principal: `group:legal` → `legal`. */
function principalName(principal: string): string {
  return principal.slice(principal.indexOf(":") + 1);
}

export async function POST(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  const user = guard.user;
  const parsed = await readJson(req);
  if (!parsed.ok) return Response.json({ error: "invalid_body" }, { status: 400 });
  const body = parsed.value as {
    action?: string;
    id?: string;
    collection?: string;
    purposeLabel?: string;
    purposeDetail?: string;
    fields?: string[];
    allowedFields?: string[];
    unmaskedFields?: string[];
    principal?: string;
    expiresAt?: string;
    selectedPaths?: string[];
    selectedTerms?: string[];
    verbs?: string[];
  };
  const { action } = body;
  const app = getAppPool();
  const cfg = getConfig();

  if (action === "request") {
    // Any authenticated user may ask. Requester and env come from the session and the signed
    // cookie — a userId or env in the body is never read.
    const { collection, purposeLabel, purposeDetail, fields } = body;
    // Same answer validateGrantRequest gives a collection name that isn't one — it just cannot be
    // asked the question unless the name is a string.
    if (typeof collection !== "string")
      return Response.json({ error: "unknown_collection" }, { status: 400 });

    const validation = validateGrantRequest(cfg, collection, purposeLabel, fields);
    if (!validation.ok) return Response.json({ error: validation.error }, { status: 400 });

    // Asking on behalf of a GROUP is a manager's act, not a member's: it is a request for access
    // that a whole population will inherit, and anyone who could make it for themselves could
    // make it for everyone. A member asking gets their own principal, as they always did.
    let principal = userPrincipal(user.id);
    if (typeof body.principal === "string" && body.principal !== principal) {
      if (!atLeast(guard.role, "manager"))
        return Response.json({ error: "forbidden" }, { status: 403 });
      if (!isPrincipal(body.principal))
        return Response.json({ error: "invalid_principal" }, { status: 400 });
      // A group that nobody is in is a grant that gives nobody anything, and reads as though it
      // did — the most common way a typed group name goes unnoticed.
      if (body.principal.startsWith(GROUP_PREFIX)) {
        const known = await listGroups(app, guard.workspaceId);
        const name = principalName(body.principal);
        if (!known.includes(name))
          return Response.json({ error: "unknown_group" }, { status: 400 });
      }
      principal = body.principal;
    }

    const requestId = await requestGrant(app, {
      userId: user.id,
      collection,
      env: readEnvCookie(req),
      workspaceId: guard.workspaceId,
      purposeLabel: (purposeLabel as string).trim(),
      purposeDetail: typeof purposeDetail === "string" ? purposeDetail.trim() : undefined,
      allowedFields: validation.fields,
      principal,
    });
    return Response.json({ ok: true, requestId });
  }

  // approve/deny/revoke are privileged.
  const priv = await requireRole(req, "manager");
  if (!priv.ok) return priv.response;
  const by = user.id; // decided_by comes from the session, never the request body

  const workspace = priv.workspaceId;

  if (action !== "approve" && action !== "deny" && action !== "revoke")
    return Response.json({ error: "unknown_action" }, { status: 400 });

  // A grant id that is absent or not a string matches no row, which is what the lookups below
  // would have concluded anyway.
  const { id } = body;
  if (typeof id !== "string") return Response.json({ error: "unknown_grant" }, { status: 404 });

  if (action === "approve") {
    const cur = await app.query(
      `select collection, allowed_fields, status from app.grants where id=$1 and workspace_id=$2`,
      [id, workspace],
    );
    const row = cur.rows[0];
    if (!row) return Response.json({ error: "unknown_grant" }, { status: 404 });
    if (row.status !== "pending") return Response.json({ error: "not_pending" }, { status: 409 });

    const built = buildApproval(cfg, row.allowed_fields ?? [], {
      collection: row.collection,
      allowedFields: body.allowedFields,
      unmaskedFields: body.unmaskedFields,
      expiresAt: body.expiresAt,
      selectedPaths: body.selectedPaths,
      selectedTerms: body.selectedTerms,
    });
    if (!built.ok) return Response.json({ error: built.error }, { status: 400 });

    const approved = await approveGrant(app, cfg, id, by, {
      ...built.opts,
      ...(body.verbs !== undefined ? { verbs: body.verbs } : {}),
      workspaceId: workspace,
    });
    if (!approved.ok) {
      // 403 for self-approval, not 400: the request is well-formed and the grant is fine, it is
      // the caller who may not be the one to decide it. Only a different person changes that.
      // Same mapping lib/rest.ts gives the identical reason code on the proposal path.
      const status =
        approved.error === "unknown_grant"
          ? 404
          : approved.error === "self_approval_denied"
            ? 403
            : 400;
      return Response.json({ error: approved.error }, { status });
    }
    // A warning, never a refusal: the personal grant just approved is narrower than a group grant
    // the subject inherits, and because `user:` wins it will REDUCE their access. Surprising, but
    // refusing it would make the purpose-bound personal grant impossible to express.
    return Response.json({ ok: true, ...(approved.warning ? { warning: approved.warning } : {}) });
  }
  if (action === "deny") {
    const denied = await denyGrant(app, id, by, workspace);
    if (!denied) return Response.json({ error: "unknown_grant" }, { status: 404 });
    return Response.json({ ok: true });
  }
  // revoke: the only action left, checked off above rather than tested again here.
  const revoked = await revokeGrant(app, id, by, workspace);
  if (!revoked) return Response.json({ error: "unknown_grant" }, { status: 404 });
  return Response.json({ ok: true });
}
