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
});
