import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import {
  createAppSchema, applyConfig, createPools, indexCollection, syncDatasetTerms, loadTaxonomyBindings, type Pools,
} from "../src/index";
import { loadConfig } from "../src/config/load";
import { listDocumentPaths } from "../src/documents/paths";

let p: Provisioned, admin: Pool, pools: Pools;
const harborDir = new URL("../../../examples/harbor", import.meta.url).pathname;
const cfg = loadConfig(harborDir);

beforeAll(async () => {
  p = await provision("docpaths");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  await syncDatasetTerms(admin, cfg, "dev");
  await indexCollection(admin, "dev", "policies", `${harborDir}/seed/docs-dev`,
    { taxonomies: await loadTaxonomyBindings(admin, cfg, "policies", "dev") });
  await syncDatasetTerms(admin, cfg, "live");
  await indexCollection(admin, "live", "policies", `${harborDir}/seed/docs-live`,
    { taxonomies: await loadTaxonomyBindings(admin, cfg, "policies", "live") });
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
}, 60_000);

afterAll(async () => { await admin.end(); await pools.end(); await p.end(); });

describe("listDocumentPaths", () => {
  it("returns the dev source paths on the dev pool", async () => {
    const paths = await listDocumentPaths(pools, "dev", cfg, "policies");
    expect(paths).toContain("remote-work.md");
    expect(paths.length).toBeGreaterThan(0);
  });

  it("returns different paths for live — the env wall holds", async () => {
    const dev = await listDocumentPaths(pools, "dev", cfg, "policies");
    const live = await listDocumentPaths(pools, "live", cfg, "policies");
    expect(live).not.toEqual(dev);
    expect(live).toContain("security.md");
    expect(dev).not.toContain("security.md");
  });

  it("throws on a dataset collection rather than guessing a table name", async () => {
    await expect(listDocumentPaths(pools, "dev", cfg, "people")).rejects.toThrow(/not a file collection/);
  });

  it("throws on an unknown collection", async () => {
    await expect(listDocumentPaths(pools, "dev", cfg, "nope")).rejects.toThrow(/Unknown collection/);
  });
});
