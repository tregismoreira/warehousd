import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../src/config/schema";
import { indexName } from "../src/config/collection";
import { tableDDL } from "../src/apply/ddl";

// A config that parses, minus the `indexes` block each case supplies.
function cfg(indexes: unknown, extraFields: Record<string, unknown> = {}) {
  return {
    project: "t",
    collections: {
      matters: {
        description: "Matters",
        indexes,
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          status: { type: "text", posture: "allow" },
          opened_at: { type: "timestamptz", posture: "allow" },
          blob: { type: "json", posture: "allow" },
          client_id: { type: "uuid", posture: "allow", fk: "clients.id" },
          client_name: {
            type: "text",
            posture: "allow",
            view_join: { table: "clients", column: "name", on: "client_id" },
          },
          ...extraFields,
        },
      },
      clients: {
        description: "Clients",
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          name: { type: "text", posture: "allow" },
        },
      },
    },
  };
}

function errors(indexes: unknown, extraFields: Record<string, unknown> = {}): string[] {
  const r = ConfigSchema.safeParse(cfg(indexes, extraFields));
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe("indexes config", () => {
  it("defaults to an empty list when the key is absent", () => {
    const r = ConfigSchema.safeParse({
      project: "t",
      collections: {
        matters: {
          description: "Matters",
          fields: { id: { type: "uuid", posture: "allow", pk: true } },
        },
      },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.collections.matters!.indexes).toEqual([]);
  });

  it("accepts a single-field and a composite index", () => {
    expect(errors([{ fields: ["status"] }, { fields: ["status", "opened_at"] }])).toEqual([]);
  });

  it("rejects an unknown field", () => {
    expect(errors([{ fields: ["nope"] }]).join(" ")).toContain('unknown field "nope"');
  });

  it("rejects a view_join field", () => {
    expect(errors([{ fields: ["client_name"] }]).join(" ")).toContain("is not stored");
  });

  it("rejects a json field", () => {
    expect(errors([{ fields: ["blob"] }]).join(" ")).toContain("type json");
  });

  it("rejects a duplicated field within one index", () => {
    expect(errors([{ fields: ["status", "status"] }]).join(" ")).toContain('names "status" twice');
  });

  it("rejects two indexes over the same field list", () => {
    expect(errors([{ fields: ["status"] }, { fields: ["status"] }]).join(" ")).toContain(
      "declared twice",
    );
  });

  it("rejects an index whose generated name exceeds the Postgres identifier limit", () => {
    const long = "a".repeat(60);
    expect(
      errors([{ fields: [long] }], { [long]: { type: "text", posture: "allow" } }).join(" "),
    ).toContain("too long");
  });

  it("rejects an empty field list and more than four fields", () => {
    expect(errors([{ fields: [] }]).length).toBeGreaterThan(0);
    expect(
      errors([{ fields: ["id", "status", "opened_at", "client_id", "blob"] }]).length,
    ).toBeGreaterThan(0);
  });

  it("rejects an unknown key inside an index entry", () => {
    expect(errors([{ fields: ["status"], unique: true }]).length).toBeGreaterThan(0);
  });

  it("builds a deterministic index name", () => {
    expect(indexName("matters", ["status", "opened_at"])).toBe("matters_ix_status_opened_at");
  });
});

describe("index DDL", () => {
  const parsed = ConfigSchema.parse(
    cfg([{ fields: ["status"] }, { fields: ["status", "opened_at"] }]),
  );

  it("appends the declared pk so a keyset walk can use the index", () => {
    const sql = tableDDL("live", "matters", parsed);
    expect(sql).toContain(
      `create index if not exists "matters_ix_status" on data_live.matters (workspace_id, "status", "id") where _current and _rev_op <> 'delete';`,
    );
    expect(sql).toContain(
      `create index if not exists "matters_ix_status_opened_at" on data_live.matters (workspace_id, "status", "opened_at", "id") where _current and _rev_op <> 'delete';`,
    );
  });

  it("does not repeat the pk when the pk is already a declared field", () => {
    const withPk = ConfigSchema.parse(cfg([{ fields: ["id"] }]));
    const sql = tableDDL("live", "matters", withPk);
    expect(sql).toContain(`"matters_ix_id" on data_live.matters (workspace_id, "id") where`);
  });

  it("emits the structural history index on every dataset, declared or not", () => {
    const none = ConfigSchema.parse(cfg([]));
    const sql = tableDDL("dev", "matters", none);
    expect(sql).toContain(
      `create index if not exists "matters_history_idx" on data_synth.matters (workspace_id, "id", _rev_seq);`,
    );
  });

  it("emits the same declared indexes into both environments", () => {
    expect(tableDDL("dev", "matters", parsed)).toContain(
      `on data_synth.matters (workspace_id, "status", "id")`,
    );
    expect(tableDDL("live", "matters", parsed)).toContain(
      `on data_live.matters (workspace_id, "status", "id")`,
    );
  });
});
