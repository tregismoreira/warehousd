import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../src/config/schema";
import { dataColsOf } from "../src/config/collection";

function cfg(relation: unknown, over: Record<string, unknown> = {}) {
  return {
    project: "t",
    collections: {
      matters: {
        description: "Matters",
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          client_id: { type: "uuid", posture: "allow", fk: "clients.id" },
          stray_id: { type: "uuid", posture: "allow" },
          client: { posture: "allow", relation },
          ...over,
        },
      },
      clients: {
        description: "Clients",
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          name: { type: "text", posture: "allow" },
          billing_email: { type: "text", posture: "allow" },
        },
      },
      policies: {
        type: "file",
        description: "Policies",
        source: "./x",
        fields: { title: { posture: "allow" }, content: { posture: "allow" } },
      },
    },
  };
}

function errors(relation: unknown, over: Record<string, unknown> = {}): string[] {
  const r = ConfigSchema.safeParse(cfg(relation, over));
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

const OK = {
  collection: "clients",
  on: "client_id",
  select: { name: { posture: "allow" } },
};

describe("relation config", () => {
  it("accepts a well-formed to-one relation", () => {
    expect(errors(OK)).toEqual([]);
  });

  it("accepts a masked sub-field", () => {
    expect(
      errors({
        ...OK,
        select: {
          name: { posture: "allow" },
          billing_email: {
            posture: { read: "mask", write: "deny" },
            mask: { transform: "domain" },
          },
        },
      }),
    ).toEqual([]);
  });

  it("rejects an unknown target collection", () => {
    expect(errors({ ...OK, collection: "nope" }).join(" ")).toContain('unknown collection "nope"');
  });

  it("rejects a file collection as a target", () => {
    expect(errors({ ...OK, collection: "policies" }).join(" ")).toContain("dataset");
  });

  it("rejects an `on` field that carries no fk", () => {
    expect(errors({ ...OK, on: "stray_id" }).join(" ")).toContain("does not have fk");
  });

  it("rejects an `on` field whose fk names a different collection", () => {
    expect(errors({ ...OK, collection: "clients", on: "id" }).join(" ")).toContain(
      "does not have fk",
    );
  });

  it("rejects a select key that is not a field of the target", () => {
    expect(errors({ ...OK, select: { nope: { posture: "allow" } } }).join(" ")).toContain(
      'target collection "clients" has no field "nope"',
    );
  });

  it("rejects an empty select", () => {
    expect(errors({ ...OK, select: {} }).length).toBeGreaterThan(0);
  });

  it("rejects write: allow on a relation field", () => {
    const r = ConfigSchema.safeParse(
      cfg(OK, { client: { relation: OK, posture: { read: "allow", write: "allow" } } }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects a relation combined with type, pk, fk, view_join or searchable", () => {
    for (const extra of [
      { type: "text" },
      { pk: true },
      { fk: "clients.id" },
      { view_join: { table: "clients", column: "name", on: "client_id" } },
      { searchable: true },
    ]) {
      const r = ConfigSchema.safeParse(cfg(OK, { client: { relation: OK, ...extra } }));
      expect(r.success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("rejects a relation whose target is reached through another relation", () => {
    const nested = {
      project: "t",
      collections: {
        a: {
          description: "A",
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            b_id: { type: "uuid", posture: "allow", fk: "b.id" },
            b: {
              posture: "allow",
              relation: { collection: "b", on: "b_id", select: { c: { posture: "allow" } } },
            },
          },
        },
        b: {
          description: "B",
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            c_id: { type: "uuid", posture: "allow", fk: "a.id" },
            c: {
              posture: "allow",
              relation: { collection: "a", on: "c_id", select: { id: { posture: "allow" } } },
            },
          },
        },
      },
    };
    const r = ConfigSchema.safeParse(nested);
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.map((i) => i.message).join(" ")).toContain("is itself a relation");
  });

  it("keeps a relation field out of the stored column list", () => {
    const parsed = ConfigSchema.parse(cfg(OK));
    expect(dataColsOf(parsed.collections.matters!)).not.toContain("client");
    expect(dataColsOf(parsed.collections.matters!)).toContain("client_id");
  });

  // A relation resolves once per host document, so hosting one on a foreign table would pull the
  // remote collection over the wire per document. Refused for the same reason view_join is.
  it("rejects a relation on an external collection", () => {
    const external = cfg(OK) as unknown as {
      collections: Record<string, Record<string, unknown>>;
    };
    external.collections.matters!.source_ref = { source: "erp", table: "matters" };
    const r = ConfigSchema.safeParse(external);
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.map((i) => i.message).join(" ")).toContain(
        "relations are not resolved across a source_ref",
      );
  });
});

describe("to-many relation config", () => {
  function many(relation: unknown, timeIndexes: unknown[] = [{ fields: ["matter_id"] }]) {
    return {
      project: "t",
      collections: {
        matters: {
          description: "Matters",
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            entries: { posture: "allow", relation },
          },
        },
        time_entries: {
          description: "Time",
          indexes: timeIndexes,
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            matter_id: { type: "uuid", posture: "allow", fk: "matters.id" },
            person_id: { type: "uuid", posture: "allow" },
            hours: { type: "numeric", posture: "allow" },
            entry_date: { type: "date", posture: "allow" },
          },
        },
      },
    };
  }
  function errs(relation: unknown, idx?: unknown[]): string[] {
    const r = ConfigSchema.safeParse(many(relation, idx));
    return r.success ? [] : r.error.issues.map((i) => i.message);
  }
  const OK_MANY = {
    collection: "time_entries",
    via: "matter_id",
    select: { hours: { posture: "allow" } },
    limit: 50,
    order: { field: "entry_date", dir: "desc" },
  };

  it("accepts a well-formed to-many relation", () => {
    expect(errs(OK_MANY)).toEqual([]);
  });

  it("rejects a to-many with no limit", () => {
    const { limit: _drop, ...noLimit } = OK_MANY;
    expect(errs(noLimit).length).toBeGreaterThan(0);
  });

  it("rejects a to-many with no order", () => {
    const { order: _drop, ...noOrder } = OK_MANY;
    expect(errs(noOrder).length).toBeGreaterThan(0);
  });

  it("rejects a limit above the ceiling", () => {
    expect(errs({ ...OK_MANY, limit: 5000 }).length).toBeGreaterThan(0);
  });

  it("rejects both on and via in one relation", () => {
    expect(errs({ ...OK_MANY, on: "id" }).length).toBeGreaterThan(0);
  });

  it("rejects a via field that carries no fk back to this collection", () => {
    expect(errs({ ...OK_MANY, via: "person_id" }).join(" ")).toContain("fk");
  });

  it("rejects an order field the target does not have", () => {
    expect(errs({ ...OK_MANY, order: { field: "nope", dir: "asc" } }).join(" ")).toContain("nope");
  });

  it("REFUSES a to-many whose via field is not covered by a declared index on the target", () => {
    expect(errs(OK_MANY, []).join(" ")).toContain("is not indexed");
    expect(errs(OK_MANY, [{ fields: ["person_id"] }]).join(" ")).toContain("is not indexed");
  });

  it("accepts a via field that leads a composite index on the target", () => {
    expect(errs(OK_MANY, [{ fields: ["matter_id", "entry_date"] }])).toEqual([]);
  });
});
