import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { toolByName } from "../lib/mcp-tools";
import { setupWebDbWithConfig } from "./helpers/web-db";
import { makeCtx } from "./helpers/ctx";
import { requestGrant, approveGrant } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

// Its own file (not folded into mcp-write-tools.test.ts): apps/web/app/lib/broker.ts's pools
// are created once per process and reused across every ensureConfigAndBroker() rebuild in that
// process — mixing a write-pool-dependent test into a file whose earlier tests already
// triggered getBroker() (before DEV_WRITE_DATABASE_URL is set) leaves the write pool null for
// the rest of that file. A fresh file gets a fresh module instance.
const fixtureDir = new URL("./fixtures/rest-api", import.meta.url).pathname;
const c = makeCtx({ userId: "mia" });

describe("mcp-tools: create_document under a proposal_only grant", () => {
  let db: Awaited<ReturnType<typeof setupWebDbWithConfig>>;

  beforeAll(async () => {
    db = await setupWebDbWithConfig("mcpwritetoolsproposal", fixtureDir);
    const app = getAppPool();
    const grantId = await requestGrant(app, {
      userId: "mia",
      collection: "feedback",
      orgId: "default",
      env: "dev",
      purposeLabel: "test",
      allowedFields: ["id", "title", "message", "submitted_by", "created_at"],
    });
    await approveGrant(app, db.cfg, grantId, "marcus", {
      verbs: ["read", "create"],
      mode: "proposal_only",
    });
  }, 60_000);
  afterAll(async () => {
    await db?.end();
  });

  it("yields status: pending, invisible until a human approves", async () => {
    const tool = toolByName("create_document")!;
    const out = (await tool.handler(c, {
      collection: "feedback",
      values: { title: "t", message: "m", submitted_by: "mia" },
    })) as { ok: boolean; status?: string; proposalId?: string };
    expect(out.ok).toBe(true);
    expect(out.status).toBe("pending");
    expect(out.proposalId).toBeDefined();
  });
});
