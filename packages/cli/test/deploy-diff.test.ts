import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { loadConfig, type WarehousdConfig } from "@warehousd/broker";
import { renderConfigDiff } from "../src/deploy/diff";

function makeConfig(yaml: string): WarehousdConfig {
  process.env.DATABASE_URL = "postgres://localhost/test";
  const projectDir = mkdtempSync(join(tmpdir(), "wh-diff-test-"));
  writeFileSync(join(projectDir, "warehousd.yml"), yaml);
  const config = loadConfig(projectDir);
  rmSync(projectDir, { recursive: true, force: true });
  return config;
}

describe("renderConfigDiff", () => {
  it("returns no previous deploy state message when prev is null", () => {
    const next = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
`);

    const result = renderConfigDiff(null, next);
    expect(result).toBe("no previous deploy state on this machine — deploying full config");
  });

  it("returns no changes when configs are identical", () => {
    const config = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
`);

    const result = renderConfigDiff(config, config);
    expect(result).toBe("no changes");
  });

  it("reports field read posture change allow→deny", () => {
    const prev = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      email:
        type: text
        posture: allow
`);

    const next = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      email:
        type: text
        posture: deny
`);

    const result = renderConfigDiff(prev, next);
    expect(result).toContain("items.email");
    expect(result).toContain("read allow → deny");
    expect(result).toContain("HIGH CONSEQUENCE");
  });

  it("reports field write posture change allow→deny separately", () => {
    const prev = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      email:
        type: text
        posture:
          read: allow
          write: allow
`);

    const next = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      email:
        type: text
        posture:
          read: allow
          write: deny
`);

    const result = renderConfigDiff(prev, next);
    expect(result).toContain("items.email");
    expect(result).toContain("write allow → deny");
    expect(result).toContain("HIGH CONSEQUENCE");
    expect(result).not.toContain("read allow → deny");
  });

  it("reports collection added and removed", () => {
    const prev = makeConfig(`
project: test
server:
  port: 8722
collections:
  old_collection:
    description: Old
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
`);

    const next = makeConfig(`
project: test
server:
  port: 8722
collections:
  new_collection:
    description: New
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
`);

    const result = renderConfigDiff(prev, next);
    expect(result).toContain("removed: old_collection");
    expect(result).toContain("added: new_collection");
  });

  it("reports field added to existing collection", () => {
    const prev = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
`);

    const next = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
      name:
        type: text
        posture: allow
`);

    const result = renderConfigDiff(prev, next);
    expect(result).toContain("Fields in 'items'");
    expect(result).toContain("+ name");
  });

  it("reports field removed from existing collection", () => {
    const prev = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
      name:
        type: text
        posture: allow
`);

    const next = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
`);

    const result = renderConfigDiff(prev, next);
    expect(result).toContain("Fields in 'items'");
    expect(result).toContain("- name");
  });

  it("reports writable added to collection", () => {
    const prev = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
      name:
        type: text
        posture:
          read: allow
          write: allow
`);

    const next = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    writable: true
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
      name:
        type: text
        posture:
          read: allow
          write: allow
`);

    const result = renderConfigDiff(prev, next);
    expect(result).toContain("Collection 'items'");
    expect(result).toContain("writable added");
  });

  it("reports writable removed from collection", () => {
    const prev = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    writable: true
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
      name:
        type: text
        posture:
          read: allow
          write: allow
`);

    const next = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
      name:
        type: text
        posture:
          read: allow
          write: allow
`);

    const result = renderConfigDiff(prev, next);
    expect(result).toContain("Collection 'items'");
    expect(result).toContain("writable removed");
  });

  it("reports deploy region changed", () => {
    const prev = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
deploy:
  target: fly
  app_name: my-app
  region: gru
  database:
    managed: true
`);

    const next = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
deploy:
  target: fly
  app_name: my-app
  region: iad
  database:
    managed: true
`);

    const result = renderConfigDiff(prev, next);
    expect(result).toContain("Deploy:");
    expect(result).toContain("region: gru");
    expect(result).toContain("region: iad");
  });

  it("reports deploy app_name changed", () => {
    const prev = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
deploy:
  target: fly
  app_name: old-app
  region: gru
  database:
    managed: true
`);

    const next = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
deploy:
  target: fly
  app_name: new-app
  region: gru
  database:
    managed: true
`);

    const result = renderConfigDiff(prev, next);
    expect(result).toContain("Deploy:");
    expect(result).toContain("app_name: old-app");
    expect(result).toContain("app_name: new-app");
  });

  it("reports deploy database change from managed to url", () => {
    const prev = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
deploy:
  target: fly
  app_name: my-app
  region: gru
  database:
    managed: true
`);

    const next = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
deploy:
  target: fly
  app_name: my-app
  region: gru
  database:
    url: postgres://example.com/db
`);

    const result = renderConfigDiff(prev, next);
    expect(result).toContain("Deploy:");
    expect(result).toContain("managed: true");
    expect(result).toContain("postgres://example.com/db");
  });

  it("reports taxonomy added to collection", () => {
    const prev = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
`);

    const next = makeConfig(`
project: test
server:
  port: 8722
taxonomies:
  status:
    label: Status
    terms:
      open:
        label: Open
collections:
  items:
    description: Items
    type: dataset
    taxonomies: [status]
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
`);

    const result = renderConfigDiff(prev, next);
    expect(result).toContain("Taxonomies:");
    expect(result).toContain("'status': added to 'items'");
  });

  it("reports taxonomy removed from collection", () => {
    const prev = makeConfig(`
project: test
server:
  port: 8722
taxonomies:
  status:
    label: Status
    terms:
      open:
        label: Open
collections:
  items:
    description: Items
    type: dataset
    taxonomies: [status]
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
`);

    const next = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
`);

    const result = renderConfigDiff(prev, next);
    expect(result).toContain("Taxonomies:");
    expect(result).toContain("'status': removed from 'items'");
  });

  it("reports multiple changes at once with proper grouping", () => {
    const prev = makeConfig(`
project: test
server:
  port: 8722
taxonomies:
  priority:
    label: Priority
    terms:
      high:
        label: High
collections:
  old_coll:
    description: Old
    type: dataset
    taxonomies: [priority]
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
      sensitive:
        type: text
        posture: allow
`);

    const next = makeConfig(`
project: test
server:
  port: 8722
taxonomies:
  status:
    label: Status
    terms:
      active:
        label: Active
collections:
  new_coll:
    description: New
    type: dataset
    taxonomies: [status]
    fields:
      id:
        type: uuid
        posture: allow
        pk: true
      name:
        type: text
        posture: allow
`);

    const result = renderConfigDiff(prev, next);
    expect(result).toContain("removed: old_coll");
    expect(result).toContain("added: new_coll");
  });

  it("distinguishes read posture change from write posture change in same field", () => {
    const prev = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      secret:
        type: text
        posture:
          read: allow
          write: allow
`);

    const next = makeConfig(`
project: test
server:
  port: 8722
collections:
  items:
    description: Items
    type: dataset
    fields:
      secret:
        type: text
        posture:
          read: deny
          write: deny
`);

    const result = renderConfigDiff(prev, next);
    expect(result).toContain("read allow → deny");
    expect(result).toContain("write allow → deny");
    const lines = result.split("\n");
    const readLine = lines.find((l) => l.includes("read allow → deny"));
    const writeLine = lines.find((l) => l.includes("write allow → deny"));
    expect(readLine).toBeDefined();
    expect(writeLine).toBeDefined();
    expect(readLine).not.toEqual(writeLine);
  });
});
