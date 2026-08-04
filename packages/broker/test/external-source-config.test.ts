import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../src/config/schema";
import { foreignTableDDL, viewDDL, rlsDDL, tableDDL, grantImportDDL } from "../src/apply/ddl";

// The config rules and the SQL shape for a `source_ref` collection, without a database.
//
// Everything here is a way of getting connect-in-place wrong that should never reach Postgres:
// a collection that is both external and indexed, a join across a foreign table, a write path
// into someone else's database. Each is refused at load, so the mistake is a parse error in
// front of the person editing the file rather than a runtime surprise in front of a user.

const base = (over: Record<string, unknown> = {}) => ({
  project: "t",
  server: { port: 1 },
  sources: { crm: { type: "postgres", url: "postgres://u:p@crm.internal:5432/crm" } },
  collections: {
    accounts: {
      description: "d",
      source_ref: { source: "crm", table: "accounts" },
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        name: { type: "text", posture: "allow" },
      },
      ...over,
    },
  },
});

const errText = (cfg: unknown) => {
  const r = ConfigSchema.safeParse(cfg);
  if (r.success) throw new Error("expected the config to be refused, but it parsed");
  return r.error.issues.map((i) => i.message).join(" | ");
};

describe("sources and source_ref: what parses", () => {
  it("accepts a minimal external collection", () => {
    const r = ConfigSchema.safeParse(base());
    expect(r.success).toBe(true);
  });

  it("defaults the schema, the org and read_only", () => {
    const cfg = ConfigSchema.parse(base());
    expect(cfg.sources.crm).toMatchObject({ schema: "public", read_only: true });
    expect(cfg.collections.accounts!.source_ref).toMatchObject({ org: "default" });
  });

  it("accepts a remote column rename", () => {
    const r = ConfigSchema.safeParse(
      base({
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          name: { type: "text", posture: "allow", column: "acct_name" },
        },
      }),
    );
    expect(r.success).toBe(true);
  });
});

describe("sources and source_ref: what is refused", () => {
  it("a source that does not exist", () => {
    expect(
      errText({
        ...base(),
        sources: { other: { type: "postgres", url: "postgres://x/y" } },
      }),
    ).toMatch(/unknown source "crm"/);
  });

  it("a file collection with source_ref", () => {
    expect(errText(base({ type: "file", source: "./x" }))).toMatch(/dataset collections/);
  });

  it("an external collection that also names a source directory", () => {
    expect(errText(base({ source: "./docs" }))).toMatch(/no `source` directory/);
  });

  it("writable: true on an external collection", () => {
    expect(
      errText(
        base({
          writable: true,
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            name: { type: "text", posture: { read: "allow", write: "allow" } },
          },
        }),
      ),
    ).toMatch(/not supported on a `source_ref` collection/);
  });

  it("a view_join across a foreign table", () => {
    // Resolving one would pull the whole remote relation across per row.
    expect(
      errText({
        ...base(),
        collections: {
          ...base().collections,
          accounts: {
            description: "d",
            source_ref: { source: "crm", table: "accounts" },
            fields: {
              id: { type: "uuid", posture: "allow", pk: true },
              owner_id: { type: "uuid", posture: "allow", fk: "people.id" },
              owner_name: {
                type: "text",
                posture: "allow",
                view_join: { table: "people", column: "name", on: "owner_id" },
              },
            },
          },
          people: {
            description: "d",
            fields: {
              id: { type: "uuid", posture: "allow", pk: true },
              name: { type: "text", posture: "allow" },
            },
          },
        },
      }),
    ).toMatch(/joins are not resolved across a source_ref/);
  });

  it("searchable on an external collection", () => {
    expect(
      errText(
        base({
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            body: { type: "text", posture: "allow", searchable: true },
          },
        }),
      ),
    ).toMatch(/generated tsv column would have to live on the remote table/);
  });

  it("`column:` on a collection that is not external", () => {
    expect(
      errText({
        project: "t",
        server: { port: 1 },
        collections: {
          local: {
            description: "d",
            fields: {
              id: { type: "uuid", posture: "allow", pk: true },
              name: { type: "text", posture: "allow", column: "other" },
            },
          },
        },
      }),
    ).toMatch(/no remote column to rename/);
  });

  it("a non-identifier remote table or column name", () => {
    for (const cfg of [
      {
        ...base(),
        collections: {
          accounts: {
            ...base().collections.accounts,
            source_ref: { source: "crm", table: "not a table" },
          },
        },
      },
      base({
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          name: { type: "text", posture: "allow", column: 'x"; drop table y --' },
        },
      }),
    ])
      expect(ConfigSchema.safeParse(cfg).success).toBe(false);
  });
});

describe("the SQL an external collection generates", () => {
  const cfg = ConfigSchema.parse(
    base({
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        name: { type: "text", posture: "allow", column: "acct_name" },
      },
    }),
  );

  it("declares each column explicitly, mapping a renamed one", () => {
    const ddl = foreignTableDDL("accounts", cfg);
    expect(ddl).toContain(`create foreign table data_live."_ext_accounts"`);
    expect(ddl).toContain(`"name" text options (column_name 'acct_name')`);
    // Never `import foreign schema`: a column added upstream must not appear by itself.
    expect(ddl).not.toMatch(/import foreign schema/i);
  });

  it("marks both the server and the table read-only", () => {
    const ddl = foreignTableDDL("accounts", cfg);
    expect(ddl).toContain("updatable %L");
    expect(ddl).toContain(`updatable 'false'`);
  });

  it("keeps the password out of anything but the user mapping", () => {
    const ddl = foreignTableDDL("accounts", cfg);
    const mapping = ddl.slice(ddl.indexOf("create user mapping"));
    expect(mapping).toContain("'p'");
    // Not on the server definition, not on the foreign table.
    expect(ddl.slice(0, ddl.indexOf("create user mapping"))).not.toContain("'p'");
  });

  it("gives live no base table and no RLS, and dev an ordinary one", () => {
    expect(tableDDL("live", "accounts", cfg)).toBe("");
    expect(rlsDDL("live", "accounts", cfg)).toBe("");
    // Dev is a normal local table, which is what keeps env parity true.
    expect(tableDDL("dev", "accounts", cfg)).toContain("create table if not exists data_synth");
    expect(rlsDDL("dev", "accounts", cfg)).toContain("row level security");
  });

  it("builds the live view over the foreign table with a constant org predicate", () => {
    const v = viewDDL("live", "accounts", cfg);
    expect(v).toContain(`from data_live."_ext_accounts" base`);
    // A foreign table has no org_id to compare, so the request's org is compared to the source's.
    expect(v).toContain(`current_setting('warehousd.org_id', true) = 'default'`);
  });

  it("never grants the import role anything on it", () => {
    expect(grantImportDDL("accounts", cfg)).toBe("");
  });

  it("escapes a quote in an FDW option rather than trusting it", () => {
    const odd = ConfigSchema.parse({
      ...base(),
      sources: { crm: { type: "postgres", url: "postgres://u:p'x@crm.internal:5432/crm" } },
    });
    expect(foreignTableDDL("accounts", odd)).toContain("'p''x'");
  });
});
