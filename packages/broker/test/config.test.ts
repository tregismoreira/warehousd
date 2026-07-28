import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config/load";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "wh-cfg-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const base = `
project: cortex
server: { port: 8722 }
collections:
  people:
    description: Employee directory
    fields:
      id: { type: uuid, posture: allow, pk: true }
      email: { type: text, posture: allow }
      home_address: { type: text, posture: deny }
synthetic:
  documents_per_collection: { people: 40 }
`;

it("parses base config", () => {
  writeFileSync(join(dir, "warehousd.yml"), base);
  const cfg = loadConfig(dir);
  expect(cfg.project).toBe("cortex");
  expect(cfg.collections.people.fields.home_address.posture).toBe("deny");
  expect(cfg.collections.people.fields.id.pk).toBe(true);
});

it("deep-merges warehousd.local.yml over base", () => {
  writeFileSync(join(dir, "warehousd.yml"), base);
  writeFileSync(join(dir, "warehousd.local.yml"), `server: { port: 9999 }`);
  const cfg = loadConfig(dir);
  expect(cfg.server.port).toBe(9999);
  expect(cfg.collections.people.description).toBe("Employee directory");
});

it("interpolates ${env:VAR}", () => {
  process.env.WH_TEST_PORT = "7000";
  writeFileSync(join(dir, "warehousd.yml"),
    base.replace("port: 8722", "port: ${env:WH_TEST_PORT}"));
  rmSync(join(dir, "warehousd.local.yml"), { force: true });
  const cfg = loadConfig(dir);
  expect(cfg.server.port).toBe(7000);
});

it("skips interpolation inside YAML comment lines", () => {
  writeFileSync(join(dir, "warehousd.yml"),
    base + "\n# This line contains ${env:UNDEFINED_VAR} in a comment");
  rmSync(join(dir, "warehousd.local.yml"), { force: true });
  // Should not throw even though UNDEFINED_VAR is not set
  const cfg = loadConfig(dir);
  expect(cfg.project).toBe("cortex");
});

it("skips interpolation inside a trailing inline comment on a real line", () => {
  process.env.WH_TEST_PORT2 = "7001";
  const yml = `
project: cortex
server:
  port: \${env:WH_TEST_PORT2}  # alternative: \${env:UNDEFINED_VAR2}
collections:
  people:
    description: Employee directory
    fields:
      id: { type: uuid, posture: allow, pk: true }
      email: { type: text, posture: allow }
      home_address: { type: text, posture: deny }
synthetic:
  documents_per_collection: { people: 40 }
`;
  writeFileSync(join(dir, "warehousd.yml"), yml);
  rmSync(join(dir, "warehousd.local.yml"), { force: true });
  const cfg = loadConfig(dir);
  expect(cfg.server.port).toBe(7001);
});

it("rejects a field with an unknown posture", () => {
  writeFileSync(join(dir, "warehousd.yml"),
    base.replace("posture: deny", "posture: sometimes"));
  rmSync(join(dir, "warehousd.local.yml"), { force: true });
  expect(() => loadConfig(dir)).toThrow();
});

import { ConfigSchema } from "../src/config/schema";

const baseSchema = { project: "t", collections: {} as Record<string, unknown> };
const doc = (over: object = {}) => ({
  type: "file", description: "d", source: "./docs",
  fields: { title: { posture: "allow" }, content: { posture: "allow" }, path: { posture: "deny" } },
  ...over,
});

describe("file collection config", () => {
  it("accepts a valid file collection and fills canonical field types", () => {
    const cfg = ConfigSchema.parse({ ...baseSchema, collections: { policies: doc() } });
    const c = cfg.collections.policies;
    expect(c.type).toBe("file");
    expect(c.fields.title.type).toBe("text");
  });
  it("defaults type to dataset", () => {
    const cfg = ConfigSchema.parse({ ...baseSchema, collections: { people: {
      description: "d", fields: { id: { type: "uuid", posture: "allow", pk: true } } } } });
    expect(cfg.collections.people.type).toBe("dataset");
  });
  it("rejects a file collection without source", () => {
    expect(() => ConfigSchema.parse({ ...baseSchema, collections: { policies: doc({ source: undefined }) } })).toThrow();
  });
  it("rejects a field outside the fixed set", () => {
    expect(() => ConfigSchema.parse({ ...baseSchema, collections: { policies: doc({
      fields: { titl: { posture: "allow" } } }) } })).toThrow(/titl/);
  });
  it("rejects any collection name containing __", () => {
    expect(() => ConfigSchema.parse({ ...baseSchema, collections: { "people__docs": {
      description: "d", fields: { id: { type: "uuid", posture: "allow" } } } } })).toThrow(/__/);
  });
  it("rejects a structured field with no type", () => {
    expect(() => ConfigSchema.parse({ ...baseSchema, collections: { people: {
      description: "d", fields: { name: { posture: "allow" } } } } })).toThrow();
  });
});

describe("taxonomies", () => {
  const base = {
    project: "t", server: { port: 1 },
    taxonomies: { category: { label: "Category", terms: { hr: { label: "HR" }, finance: { label: "Finance" } } } },
    collections: {},
  };

  it("parses and auto-adds the bound term field as text/allow (structured)", () => {
    const cfg = ConfigSchema.parse({ ...base, collections: {
      notes: { description: "d", taxonomies: ["category"], fields: {
        id: { type: "uuid", posture: "allow", pk: true } } } } });
    expect(cfg.collections.notes!.fields.category).toEqual({ posture: "allow", type: "text" });
    expect(cfg.taxonomies.category!.terms.hr!.label).toBe("HR");
  });

  it("accepts the vocabulary slug as an extra file field and fills type text", () => {
    const cfg = ConfigSchema.parse({ ...base, collections: {
      briefs: { description: "d", type: "file", source: "./x", taxonomies: ["category"], fields: {
        title: { posture: "allow" }, content: { posture: "allow" }, category: { posture: "deny" } } } } });
    expect(cfg.collections.briefs!.fields.category).toEqual({ posture: "deny", type: "text" });
  });

  it("auto-adds the term field on a bound file collection when omitted", () => {
    const cfg = ConfigSchema.parse({ ...base, collections: {
      briefs: { description: "d", type: "file", source: "./x", taxonomies: ["category"], fields: {
        title: { posture: "allow" }, content: { posture: "allow" } } } } });
    expect(cfg.collections.briefs!.fields.category).toEqual({ posture: "allow", type: "text" });
  });

  it("rejects binding an undeclared vocabulary", () => {
    expect(() => ConfigSchema.parse({ ...base, collections: {
      notes: { description: "d", taxonomies: ["nope"], fields: {
        id: { type: "uuid", posture: "allow", pk: true } } } } })).toThrow(/unknown vocabulary|binds unknown/);
  });

  it("rejects reserved and malformed vocabulary slugs", () => {
    expect(() => ConfigSchema.parse({ ...base,
      taxonomies: { title: { label: "T", terms: {} } } })).toThrow(/invalid/);
    expect(() => ConfigSchema.parse({ ...base,
      taxonomies: { "Bad-Slug": { label: "B", terms: {} } } })).toThrow(/invalid/);
  });

  it("rejects malformed term slugs", () => {
    expect(() => ConfigSchema.parse({ ...base,
      taxonomies: { category: { label: "C", terms: { Bad_Term: { label: "x" } } } } }))
      .toThrow(/kebab-case/);
  });

  it("rejects a non-text bound field and pk/fk/view_join on it", () => {
    expect(() => ConfigSchema.parse({ ...base, collections: {
      notes: { description: "d", taxonomies: ["category"], fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        category: { type: "int", posture: "allow" } } } } })).toThrow(/must be type text/);
    expect(() => ConfigSchema.parse({ ...base, collections: {
      notes: { description: "d", taxonomies: ["category"], fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        category: { posture: "allow", view_join: { table: "departments", column: "name", on: "dept_id" } } } } } }))
      .toThrow(/pk\/fk\/view_join/);
  });

  it("rejects untyped extra file fields and allows typed metadata fields", () => {
    // Untyped field without type is rejected
    expect(() => ConfigSchema.parse({ ...base, collections: {
      briefs: { description: "d", type: "file", source: "./x", taxonomies: ["category"], fields: {
        title: { posture: "allow" }, sneaky: { posture: "allow" } } } } })).toThrow(/must have type text\/date/);
    // Typed metadata field is allowed
    const cfg = ConfigSchema.parse({ ...base, collections: {
      briefs: { description: "d", type: "file", source: "./x", taxonomies: ["category"], fields: {
        title: { posture: "allow" }, filed_date: { type: "date", posture: "allow" } } } } });
    expect(cfg.collections.briefs.fields.filed_date.type).toBe("date");
  });
});

it("accepts database.port, server.image and demo", () => {
  const dir = mkdtempSync(join(tmpdir(), "wh-cfg-"));
  writeFileSync(join(dir, "warehousd.yml"), `
project: p
demo: true
database: { managed: true, port: 8723 }
server: { port: 8722, image: "ghcr.io/warehousd/warehousd:dev" }
collections:
  a: { description: d, fields: { id: { type: uuid, posture: allow, pk: true } } }
`);
  const cfg = loadConfig(dir);
  expect(cfg.database?.port).toBe(8723);
  expect(cfg.server.image).toBe("ghcr.io/warehousd/warehousd:dev");
  expect(cfg.demo).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

it("defaults demo to false and leaves image/port undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "wh-cfg-"));
  writeFileSync(join(dir, "warehousd.yml"), `
project: p
collections:
  a: { description: d, fields: { id: { type: uuid, posture: allow, pk: true } } }
`);
  const cfg = loadConfig(dir);
  expect(cfg.demo).toBe(false);
  expect(cfg.server.image).toBeUndefined();
  expect(cfg.database?.port).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});
