import { NextRequest } from "next/server";
import { findCollection, listFiles, readPosture, type FileSummary } from "@warehousd/broker";
import { getBroker, getAppPool, getConfig } from "../../../../../lib/broker";
import { requireRole } from "../../../../../../lib/authz";
import { readEnvCookie, orgOf } from "../../../../../../lib/session";

// The fixed file fields that carry a posture and appear in a FileSummary. `id`, `checksum` and
// `documentCount` are structural — they name no configured field, so no posture applies to them
// and no grant could ever carry them.
const POSTURED = ["title", "path", "owner", "updated_at"] as const;

// The indexed files behind a file collection.
//
// Being an admin buys the inventory, not the contents: `path` is `posture: deny` in the harbor
// example precisely because it gates documents without being readable, and a denied field must
// not appear in a response — invariant 4 makes no exception for the console. So a field is
// returned when its posture allows reading, or when the caller's own approved grant names it,
// and is absent from every row otherwise. Absent, not null: a null still says the column exists
// and this file has no value for it.
//
// `fields` tells the client which of them survived, so the table can drop a column rather than
// render one full of blanks.
export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const { name } = await params;
  const cfg = getConfig();
  const c = findCollection(cfg, name);
  if (!c) return Response.json({ error: "unknown_collection" }, { status: 404 });
  if (c.type !== "file") return Response.json({ error: "not_a_file_collection" }, { status: 400 });

  const env = readEnvCookie(req);
  const orgId = orgOf(guard.user);

  const granted: string[] =
    (
      await getAppPool().query(
        `select allowed_fields from app.grants
        where org_id=$1 and user_id=$2 and collection=$3 and env=$4 and status='approved'
          and (expires_at is null or expires_at > now())
        order by requested_at desc limit 1`,
        [orgId, guard.user.id, name, env],
      )
    ).rows[0]?.allowed_fields ?? [];

  const visible = POSTURED.filter((f) => {
    const field = c.fields[f];
    return field ? readPosture(field) === "allow" || granted.includes(f) : false;
  });

  let files: FileSummary[];
  try {
    files = await listFiles(getBroker().pools, { env, orgId }, cfg, name);
  } catch (err) {
    // A collection declared but not applied to this environment has no view to read. That is a
    // state of the stack rather than a fault in the request, which is the same distinction the
    // import route draws with its 503s. The driver message never leaves the server.
    console.error("[admin] listFiles failed", { collection: name, env, err });
    return Response.json({ error: "unavailable" }, { status: 503 });
  }

  return Response.json({
    collection: name,
    env,
    fields: visible,
    files: files.map((f) => ({
      id: f.id,
      checksum: f.checksum,
      documentCount: f.documentCount,
      ...Object.fromEntries(visible.map((k) => [k, f[k]])),
    })),
  });
}
