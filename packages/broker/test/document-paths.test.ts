import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import {
  createAppSchema,
  applyConfig,
  createPools,
  indexCollection,
  syncDatasetTerms,
  loadTaxonomyBindings,
  DEFAULT_WORKSPACE_ID,
  type Pools,
} from "../src/index";
import { loadConfig } from "../src/config/load";
import { listDocumentPaths } from "../src/documents/paths";

let p: Provisioned, admin: Pool, pools: Pools;
const harborDir = new URL("../../../examples/harbor", import.meta.url).pathname;
const cfg = loadConfig(harborDir);

const OTHER_ORG = "workspace-tenant-b";
const dev = { env: "dev", workspaceId: DEFAULT_WORKSPACE_ID } as const;
const live = { env: "live", workspaceId: DEFAULT_WORKSPACE_ID } as const;

beforeAll(async () => {
  p = await provision("docpaths");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  await syncDatasetTerms(admin, cfg, "dev", DEFAULT_WORKSPACE_ID);
  await indexCollection(
    admin,
    "dev",
    "policies",
    `${harborDir}/seed/docs-dev`,
    DEFAULT_WORKSPACE_ID,
    {
      taxonomies: await loadTaxonomyBindings(admin, cfg, "policies", "dev", DEFAULT_WORKSPACE_ID),
    },
  );
  await syncDatasetTerms(admin, cfg, "live", DEFAULT_WORKSPACE_ID);
  await indexCollection(
    admin,
    "live",
    "policies",
    `${harborDir}/seed/docs-live`,
    DEFAULT_WORKSPACE_ID,
    {
      taxonomies: await loadTaxonomyBindings(admin, cfg, "policies", "live", DEFAULT_WORKSPACE_ID),
    },
  );

  // A second tenant's file, written straight in rather than through indexCollection, so this test
  // proves a *reader* scoped to one workspace never sees the other's paths — independent of
  // whatever indexCollection itself does or does not enforce.
  const fileId = "11111111-1111-1111-1111-111111111111";
  await admin.query(
    `insert into data_synth."policies__files" (id, workspace_id, title, path, owner, checksum, updated_at, department, tags)
     values ($1, $2, 'Tenant B handbook', 'tenant-b/handbook.md', 'b@example.com', 'deadbeef', now(), 'hr', array['compliance'])`,
    [fileId, OTHER_ORG],
  );
  await admin.query(
    `insert into data_synth."policies__documents" (id, workspace_id, file_id, document_seq, content)
     values ('22222222-2222-2222-2222-222222222222', $1, $2, 0, 'tenant b content')`,
    [OTHER_ORG, fileId],
  );

  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
}, 60_000);

afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

describe("listDocumentPaths", () => {
  it("returns the dev source paths on the dev pool", async () => {
    const paths = await listDocumentPaths(pools, dev, cfg, "policies");
    expect(paths).toContain("remote-work.md");
    expect(paths.length).toBeGreaterThan(0);
  });

  it("returns different paths for live — the env wall holds", async () => {
    const devPaths = await listDocumentPaths(pools, dev, cfg, "policies");
    const livePaths = await listDocumentPaths(pools, live, cfg, "policies");
    expect(livePaths).not.toEqual(devPaths);
    expect(livePaths).toContain("security.md");
    expect(devPaths).not.toContain("security.md");
  });

  // The workspace used to be pinned to DEFAULT_WORKSPACE_ID inside this function, so an approver in any other
  // tenant was shown the default tenant's filenames and offered them as a grant scope.
  it("scopes to the caller's workspace — neither tenant sees the other's paths", async () => {
    const mine = await listDocumentPaths(pools, dev, cfg, "policies");
    const theirs = await listDocumentPaths(
      pools,
      { env: "dev", workspaceId: OTHER_ORG },
      cfg,
      "policies",
    );

    expect(theirs).toEqual(["tenant-b/handbook.md"]);
    expect(mine).not.toContain("tenant-b/handbook.md");
    expect(theirs).not.toContain("remote-work.md");
  });

  it("throws on a dataset collection rather than guessing a table name", async () => {
    await expect(listDocumentPaths(pools, dev, cfg, "people")).rejects.toThrow(
      /not a file collection/,
    );
  });

  it("throws on an unknown collection", async () => {
    await expect(listDocumentPaths(pools, dev, cfg, "nope")).rejects.toThrow(/Unknown collection/);
  });
});
