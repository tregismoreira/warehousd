import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData } from "./helpers/web-db";
import {
  upsertClientPolicy,
  approveGrant,
  requestGrant,
  createClientSecret,
  loadConfig,
  type WarehousdConfig,
} from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

const harborDir = new URL("../../../examples/harbor", import.meta.url).pathname;
const harborCfg: WarehousdConfig = loadConfig(harborDir);

// End to end through POST /v1/proposals/decide: the REST envelope a real caller sees, not the
// broker return value directly — apps/web/test/rest-api.integration.test.ts's "proposals" section
// covers the single-decision routes this one complements.
describe("POST /v1/proposals/decide", () => {
  let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
  let marcusToken: string;
  let miaToken: string;

  async function mintHeadlessToken(clientName: string, robotUserId: string) {
    const app = getAppPool();
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: clientName },
      asResponse: true,
    } as any);
    const { client_id } = await reg.json();
    await upsertClientPolicy(app, client_id, clientName, ["env:dev"]);
    await app.query(
      `update app.client_policies set mode='headless', robot_user_id=$1 where client_id=$2`,
      [robotUserId, client_id],
    );
    const { secret } = await createClientSecret(
      app,
      client_id,
      "default",
      new Date(Date.now() + 86_400_000),
      "test",
    );

    const { POST } = await import("../app/v1/token/route");
    const tokenReq = new Request("http://localhost:8722/v1/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id,
        client_secret: secret,
        scope: "env:dev",
      }).toString(),
    });
    const res = await POST(tokenReq as any);
    return (await res.json()).access_token as string;
  }

  beforeAll(async () => {
    db = await setupWebDbWithData("proposalsbatch");
    const app = getAppPool();
    const fields = ["id", "title", "notes", "assignee", "created_at"];

    // marcus: read + approve, direct mode — the decider.
    const marcusGrant = await requestGrant(app, {
      userId: "marcus",
      collection: "matter_tasks",
      workspaceId: "default",
      env: "dev",
      purposeLabel: "test",
      allowedFields: fields,
    });
    await approveGrant(app, harborCfg, marcusGrant, "marcus", {
      verbs: ["read", "approve"],
      mode: "direct",
    });

    // mia: read + create, proposal_only — every create of hers lands pending. She holds no
    // approve verb, so a self-approval attempt is refused on four eyes before the verb is even
    // checked (matching rest-api.integration.test.ts's single-decision "four eyes over REST").
    const miaGrant = await requestGrant(app, {
      userId: "mia",
      collection: "matter_tasks",
      workspaceId: "default",
      env: "dev",
      purposeLabel: "test",
      allowedFields: fields,
    });
    await approveGrant(app, harborCfg, miaGrant, "marcus", {
      verbs: ["read", "create"],
      mode: "proposal_only",
    });

    marcusToken = await mintHeadlessToken("Marcus Client", "marcus");
    miaToken = await mintHeadlessToken("Mia Client", "mia");
  }, 60_000);

  afterAll(async () => {
    await db?.end();
  });

  function req(body: unknown, token: string) {
    return new Request("http://localhost:8722/v1/proposals/decide", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  async function proposeTask(title: string): Promise<string> {
    const { POST: Create } = await import("../app/v1/collections/[c]/documents/route");
    const res = await Create(
      new Request("http://localhost:8722/v1/collections/matter_tasks/documents", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${miaToken}` },
        body: JSON.stringify({ title, notes: "n", assignee: "mia" }),
      }) as any,
      { params: Promise.resolve({ c: "matter_tasks" }) },
    );
    expect(res.status).toBe(202);
    const { proposalId } = await res.json();
    return proposalId as string;
  }

  it("200 with batchId and per-proposal outcomes on success", async () => {
    const p1 = await proposeTask("Batch task 1");
    const p2 = await proposeTask("Batch task 2");

    const { POST } = await import("../app/v1/proposals/decide/route");
    const res = await POST(
      req(
        {
          decisions: [
            { proposalId: p1, action: "approve" },
            { proposalId: p2, action: "approve" },
          ],
        },
        marcusToken,
      ) as any,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.batchId).toBe("string");
    expect(body.decisions).toHaveLength(2);
    expect(body.decisions.every((d: any) => d.ok === true)).toBe(true);
    expect(body.decisions.map((d: any) => d.proposalId).sort()).toEqual([p1, p2].sort());
  });

  it("403 with the full envelope on a four-eyes failure", async () => {
    const own = await proposeTask("Self-approve attempt");

    const { POST } = await import("../app/v1/proposals/decide/route");
    const res = await POST(
      req({ decisions: [{ proposalId: own, action: "approve" }] }, miaToken) as any,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("self_approval_denied");
    // The full batch envelope, not refuse()'s bare `{ error }` — failedProposalId is not a
    // disclosure, since the caller supplied it in the request.
    expect(body.failedProposalId).toBe(own);
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0].ok).toBe(false);
    expect(body.decisions[0].reason).toBe("self_approval_denied");
    expect(typeof body.batchId).toBe("string");
  });

  it("400 on a malformed body", async () => {
    const { POST } = await import("../app/v1/proposals/decide/route");
    const res = await POST(
      new Request("http://localhost:8722/v1/proposals/decide", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${marcusToken}` },
        body: JSON.stringify([1, 2, 3]), // an array, not an object — readJson refuses it
      }) as any,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_intent" });
  });

  it("401 when unauthenticated", async () => {
    const { POST } = await import("../app/v1/proposals/decide/route");
    const res = await POST(
      new Request("http://localhost:8722/v1/proposals/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decisions: [] }),
      }) as any,
    );
    expect(res.status).toBe(401);
  });
});
