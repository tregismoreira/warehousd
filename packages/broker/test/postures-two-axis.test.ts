import { describe, it, expect } from "vitest";
import { ConfigSchema, normalizePosture, readPosture, writePosture } from "../src/config/schema";
import { grantableFields, writableFields } from "../src/config/load";

describe("two-axis postures", () => {
  it("bare 'allow' normalizes to {read:allow, write:deny}", () => {
    const p = normalizePosture("allow");
    expect(p).toEqual({ read: "allow", write: "deny" });
  });

  it("bare 'deny' normalizes to {read:deny, write:deny}", () => {
    const p = normalizePosture("deny");
    expect(p).toEqual({ read: "deny", write: "deny" });
  });

  it("object form round-trips unchanged", () => {
    const p = { read: "allow", write: "allow" };
    expect(normalizePosture(p)).toEqual(p);
  });

  it("readPosture and writePosture extract the right axis", () => {
    const f = { posture: { read: "allow", write: "deny" } };
    expect(readPosture(f as any)).toBe("allow");
    expect(writePosture(f as any)).toBe("deny");
  });

  it("parseConfig normalizes bare strings to {read, write} form", () => {
    const cfg = ConfigSchema.parse({
      project: "test",
      collections: {
        people: {
          description: "People",
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            email: { type: "text", posture: "allow" },
            phone: { type: "text", posture: "deny" },
            salary: { type: "numeric", posture: { read: "deny", write: "allow" } },
          },
        },
      },
    });

    const c = cfg.collections.people;
    expect(c.fields.id.posture).toEqual({ read: "allow", write: "deny" });
    expect(c.fields.email.posture).toEqual({ read: "allow", write: "deny" });
    expect(c.fields.phone.posture).toEqual({ read: "deny", write: "deny" });
    expect(c.fields.salary.posture).toEqual({ read: "deny", write: "allow" });
  });

  it("view_join + write:allow is a config error", () => {
    const result = ConfigSchema.safeParse({
      project: "test",
      collections: {
        people: {
          description: "People",
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            dept_name: { type: "text", posture: { read: "allow", write: "allow" }, view_join: "departments.name" },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("grantableFields returns read:allow fields only", () => {
    const cfg = ConfigSchema.parse({
      project: "test",
      collections: {
        people: {
          description: "People",
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            email: { type: "text", posture: "allow" },
            phone: { type: "text", posture: "deny" },
            ssn: { type: "text", posture: { read: "deny", write: "allow" } },
          },
        },
      },
    });

    expect(grantableFields(cfg, "people")).toEqual(["id", "email"]);
  });

  it("writableFields returns write:allow fields only", () => {
    const cfg = ConfigSchema.parse({
      project: "test",
      collections: {
        people: {
          description: "People",
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            email: { type: "text", posture: "allow" },
            ssn: { type: "text", posture: { read: "deny", write: "allow" } },
          },
        },
      },
    });

    expect(writableFields(cfg, "people")).toEqual(["ssn"]);
  });

  it("old bare-string JSON from app.collections.config normalizes on read", () => {
    // Simulate data read from the database that was stored before Phase 2
    const oldJSON = {
      description: "People",
      type: "dataset",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        email: { type: "text", posture: "allow" },
      },
    };

    // When we normalize it, bare strings become {read, write}
    const id_posture = normalizePosture((oldJSON.fields.id as any).posture);
    expect(id_posture).toEqual({ read: "allow", write: "deny" });
  });

  it("writable:true requires at least one writable field", () => {
    const result = ConfigSchema.safeParse({
      project: "test",
      collections: {
        people: {
          description: "People",
          writable: true,
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            email: { type: "text", posture: "allow" },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("writable:true with a writable field parses successfully", () => {
    const cfg = ConfigSchema.parse({
      project: "test",
      collections: {
        people: {
          description: "People",
          writable: true,
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            email: { type: "text", posture: { read: "allow", write: "allow" } },
          },
        },
      },
    });
    expect(cfg.collections.people.writable).toBe(true);
  });
});
