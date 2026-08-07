import { NextRequest } from "next/server";
import { accessReview } from "@warehousd/broker";
import { getAppPool } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";
import { orgOf } from "../../../../lib/session";

/**
 * `GET /api/admin/access-review?days=90` — access recertification.
 *
 * Every approved grant older than `days`, with when it was last exercised. "Last used" comes from
 * `app.audit_events`: the grant id has been on every audit row since audit/decision.ts started
 * passing the grant rather than its id, so the data was already there and nothing was reading it.
 *
 * A grant nobody has used in ninety days is the easiest revoke a reviewer will ever make. This is
 * a query and not a sweep on purpose — expiring access on a schedule would make the console's
 * answer depend on when a job last ran, and the decision belongs to a person.
 */
export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "manager");
  if (!guard.ok) return guard.response;

  const raw = Number(new URL(req.url).searchParams.get("days"));
  const olderThanDays = Number.isFinite(raw) && raw >= 0 ? raw : 90;

  const rows = await accessReview(getAppPool(), {
    orgId: orgOf(guard.user),
    olderThanDays,
  });
  return Response.json({ olderThanDays, grants: rows });
}
