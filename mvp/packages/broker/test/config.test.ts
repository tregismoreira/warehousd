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
  rows_per_collection: { people: 40 }
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

it("rejects a field with an unknown posture", () => {
  writeFileSync(join(dir, "warehousd.yml"),
    base.replace("posture: deny", "posture: sometimes"));
  rmSync(join(dir, "warehousd.local.yml"), { force: true });
  expect(() => loadConfig(dir)).toThrow();
});

import { ConfigSchema } from "../src/config/schema";

const baseSchema = { project: "t", collections: {} as Record<string, unknown> };
const doc = (over: object = {}) => ({
  type: "document", description: "d", source: "./docs",
  fields: { title: { posture: "allow" }, content: { posture: "allow" }, path: { posture: "deny" } },
  ...over,
});

describe("document collection config", () => {
  it("accepts a valid document collection and fills canonical field types", () => {
    const cfg = ConfigSchema.parse({ ...baseSchema, collections: { policies: doc() } });
    const c = cfg.collections.policies;
    expect(c.type).toBe("document");
    expect(c.fields.title.type).toBe("text");
  });
  it("defaults type to structured", () => {
    const cfg = ConfigSchema.parse({ ...baseSchema, collections: { people: {
      description: "d", fields: { id: { type: "uuid", posture: "allow", pk: true } } } } });
    expect(cfg.collections.people.type).toBe("structured");
  });
  it("rejects a document collection without source", () => {
    expect(() => ConfigSchema.parse({ ...baseSchema, collections: { policies: doc({ source: undefined }) } })).toThrow();
  });
  it("rejects a document field outside the fixed set", () => {
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
