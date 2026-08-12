import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { requestGrant, approveGrant, validateGrantRequest } from "../src/grants/manage";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";

// The decision side of the two-tier deny, and of filter evaluability.
//
// `validateGrantRequest` guards the request side and `buildApproval` (apps/web) derives an
// approver's field set from the YAML — but both are caller-side guarantees, and the broker is the
// trust boundary. Every test here calls `approveGrant` directly, which is exactly what an adapter
// that skipped the console would do.
const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  collections: {
    people: {
      description: "d",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        full_name: { type: "text", posture: "allow" },
        hired_on: { type: "date", posture: "allow" },
        profile: { type: "json", posture: "allow" },
        // Masked, not denied: `mask` is a disclosure level, so the field stays grantable.
        salary: {
          type: "numeric",
          posture: { read: "mask", write: "deny", unmask: "allow" },
          mask: { transform: "bucket", width: 1000 },
        },
        ssn: { type: "text", posture: "deny" },
      },
    },
  },
});

let p: Provisioned, admin: Pool;

beforeAll(async () => {
  p = await provision("approveceiling");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
});

afterAll(async () => {
  await admin.end();
  await p.end();
});

// Deliberately not through validateGrantRequest: the row is written with whatever fields the
// caller names, which is the state an approval has to survive.
//
// A fresh requester per call, because `grants_one_active` allows one live grant per
// (user, collection, env) and several tests here leave an approved one behind.
let requester = 0;
async function ask(allowedFields: string[]): Promise<string> {
  return requestGrant(admin, {
    userId: `asker-${requester++}`,
    collection: "people",
    workspaceId: "default",
    env: "dev",
    purposeLabel: "t",
    allowedFields,
  });
}

async function statusOf(id: string): Promise<string> {
  return (await admin.query(`select status from app.grants where id=$1`, [id])).rows[0].status;
}

async function storedFilter(id: string): Promise<unknown> {
  return (await admin.query(`select document_filter from app.grants where id=$1`, [id])).rows[0]
    .document_filter;
}

describe("approveGrant — the field ceiling", () => {
  it("refuses a field the config denies, however it was asked for", async () => {
    const id = await ask(["id", "ssn"]);
    const r = await approveGrant(admin, cfg, id, "marcus");
    expect(r).toMatchObject({ ok: false, error: "field_not_grantable" });
    expect(await statusOf(id)).toBe("pending");
  });

  it("refuses a denied field handed in as an approver's override", async () => {
    const id = await ask(["id"]);
    const r = await approveGrant(admin, cfg, id, "marcus", { allowedFields: ["id", "ssn"] });
    expect(r).toMatchObject({ ok: false, error: "field_not_grantable" });
    expect(await statusOf(id)).toBe("pending");
  });

  it("refuses a field that is not on the collection at all", async () => {
    const id = await ask(["id", "no_such_field"]);
    const r = await approveGrant(admin, cfg, id, "marcus");
    expect(r).toMatchObject({ ok: false, error: "field_not_grantable" });
  });

  // The refusal names the offending fields so an approver can be told which box was wrong,
  // and names only those — a denied field's *value* is nowhere in this path, but its existence
  // is already public to anyone holding the config.
  it("names the fields it refused", async () => {
    const id = await ask(["id", "ssn", "no_such_field"]);
    const r = await approveGrant(admin, cfg, id, "marcus");
    expect(r).toMatchObject({ ok: false, detail: "ssn, no_such_field" });
  });

  it("allows a masked field: mask is a disclosure level, not a refusal", async () => {
    const id = await ask(["id", "salary"]);
    expect(await approveGrant(admin, cfg, id, "marcus", { unmaskedFields: ["salary"] })).toEqual({
      ok: true,
    });
    expect(await statusOf(id)).toBe("approved");
  });

  // The ceiling runs before the unmask rules, which take allowedFields as their base set. A
  // non-grantable field admitted into that set would become an admissible unmask target.
  it("refuses the field before considering it as an unmask target", async () => {
    const id = await ask(["id"]);
    const r = await approveGrant(admin, cfg, id, "marcus", {
      allowedFields: ["id", "ssn"],
      unmaskedFields: ["ssn"],
    });
    expect(r).toMatchObject({ ok: false, error: "field_not_grantable" });
  });

  it("still approves a grant whose fields are all grantable", async () => {
    const id = await ask(["id", "full_name"]);
    expect(await approveGrant(admin, cfg, id, "marcus")).toEqual({ ok: true });
    expect(await statusOf(id)).toBe("approved");
  });
});

describe("approveGrant — filter evaluability", () => {
  it("refuses a filter on a field the collection does not have", async () => {
    const id = await ask(["id", "full_name"]);
    const r = await approveGrant(admin, cfg, id, "marcus", {
      documentFilters: [{ field: "department", op: "eq", value: "legal" }],
    });
    expect(r).toMatchObject({ ok: false, error: "invalid_filter" });
    expect(await statusOf(id)).toBe("pending");
  });

  // json equality is structural in Postgres and cannot be reproduced in process, so filters.ts
  // refuses it on both evaluators. Approval is where an approver is present to hear that.
  it("refuses a filter on a json field", async () => {
    const id = await ask(["id", "profile"]);
    const r = await approveGrant(admin, cfg, id, "marcus", {
      documentFilters: [{ field: "profile", op: "eq", value: { team: "legal" } }],
    });
    expect(r).toMatchObject({ ok: false, error: "invalid_filter" });
  });

  it("refuses a value that is not a valid instance of its column's type", async () => {
    const id = await ask(["id", "hired_on"]);
    const r = await approveGrant(admin, cfg, id, "marcus", {
      documentFilters: [{ field: "hired_on", op: "eq", value: "last tuesday" }],
    });
    expect(r).toMatchObject({ ok: false, error: "invalid_filter" });
  });

  it("refuses one bad value inside an `in` list", async () => {
    const id = await ask(["id", "hired_on"]);
    const r = await approveGrant(admin, cfg, id, "marcus", {
      documentFilters: [{ field: "hired_on", op: "in", value: ["2026-01-01", "whenever"] }],
    });
    expect(r).toMatchObject({ ok: false, error: "invalid_filter" });
  });

  it("stores an evaluable filter", async () => {
    const id = await ask(["id", "hired_on"]);
    expect(
      await approveGrant(admin, cfg, id, "marcus", {
        documentFilters: [{ field: "hired_on", op: "eq", value: "2026-01-01" }],
      }),
    ).toEqual({ ok: true });
    expect(await storedFilter(id)).toEqual([{ field: "hired_on", op: "eq", value: "2026-01-01" }]);
  });

  // `$self` is not a literal until loadActiveGrant binds it to the caller's id, so there is
  // nothing to canonicalise at approval time. Refusing it here would break every self-scoped
  // grant; the bound value is still checked at use time.
  it("accepts $self, which has no value to canonicalise yet", async () => {
    const id = await ask(["id", "full_name"]);
    expect(
      await approveGrant(admin, cfg, id, "marcus", {
        documentFilters: [{ field: "id", op: "eq", value: "$self" }],
      }),
    ).toEqual({ ok: true });
  });

  it("accepts $self inside an `in` list alongside a real value", async () => {
    const id = await ask(["id", "full_name"]);
    expect(
      await approveGrant(admin, cfg, id, "marcus", {
        documentFilters: [
          {
            field: "id",
            op: "in",
            value: ["$self", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
          },
        ],
      }),
    ).toEqual({ ok: true });
  });

  // The sentinel excuses only itself. A neighbouring value in the same predicate is still checked.
  it("refuses a bad value sitting next to $self", async () => {
    const id = await ask(["id", "full_name"]);
    const r = await approveGrant(admin, cfg, id, "marcus", {
      documentFilters: [{ field: "id", op: "in", value: ["$self", "not-a-uuid"] }],
    });
    expect(r).toMatchObject({ ok: false, error: "invalid_filter" });
  });
});

// The request side keeps only the rules a request can actually break. A grant request carries no
// predicates — the approver picks the values and the server picks the column — so approveGrant
// above is the only writer of a document filter, and the only place the filter rule needs to live.
describe("validateGrantRequest — the field ceiling on the request side", () => {
  it("refuses a denied field", () => {
    expect(validateGrantRequest(cfg, "people", "why", ["id", "ssn"])).toEqual({
      ok: false,
      error: "field_not_grantable",
    });
  });

  it("accepts a grantable one", () => {
    expect(validateGrantRequest(cfg, "people", "why", ["id"])).toEqual({
      ok: true,
      fields: ["id"],
    });
  });
});
