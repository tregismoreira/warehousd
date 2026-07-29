import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import {
  createAppSchema, applyConfig, createPools, makeBroker, withOrg, getClientPolicy,
  createTrustedIssuer, listTrustedIssuers, getTrustedIssuer,
} from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import type { BrokerContext } from "../src/types";
import type { WarehousdConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";

let p: Provisioned, app: Pool, pools: any;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "test",
  collections: {
    people: {
      description: "People",
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        email: { type: "text", posture: { read: "allow", write: "allow" } },
        owner: { type: "text", posture: "allow" },
        status: { type: "text", posture: "allow" },
      },
    },
  },
});

let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("task-8-1");
  app = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(app);
  await applyConfig(app, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live, devWrite: p.urls.devWrite, liveWrite: p.urls.liveWrite });
  broker = makeBroker(pools, cfg);
}, 60_000);

afterAll(async () => { await app.end(); await pools.end(); await p.end(); });

describe("listRevisions", () => {
  it("returns multiple revisions in order", async () => {
    const userId = "rev_list_user";
    const grantId = await requestGrant(app, {
      userId, collection: "people", env: "live", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "owner"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read"] });

    const docId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    // Insert 3 revisions for the same document
    const revIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const revId = await app.query(
        `select gen_random_uuid() as id`
      ).then(r => r.rows[0].id);
      revIds.push(revId);
      await app.query(
        `insert into data_live.people (org_id, id, email, owner, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
         values ('default', $1, $2, $3, $4, $5, now(), $6, $7, $8, $9, $10)`,
        [docId, `user${i}@ex.com`, `owner${i}`, revId, i + 1, userId, "update", "approved", ["email"], i === 2]);
    }

    const ctx: BrokerContext = { userId, env: "live", orgId: "default", via: "session" };
    const result = await broker.listRevisions(ctx, { collection: "people", id: docId });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.revisions).toHaveLength(3);
      expect(result.revisions[0].seq).toBe(1);
      expect(result.revisions[1].seq).toBe(2);
      expect(result.revisions[2].seq).toBe(3);
      expect(result.revisions[0].op).toBe("update");
      expect(result.revisions[0].fields).toEqual(["email"]);
      expect(result.revisions[0].status).toBe("approved");
    }
  });

  it("refuses with no_grant when user has no grant", async () => {
    const docId = "00000000-0000-0000-0000-000000000000";
    const ctx: BrokerContext = { userId: "no_grant_user", env: "live", orgId: "default", via: "session" };
    const result = await broker.listRevisions(ctx, { collection: "people", id: docId });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_grant");
  });

  it("refuses with no_grant when read verb is denied", async () => {
    const userId = "no_read_verb_user";
    const grantId = await requestGrant(app, {
      userId, collection: "people", env: "live", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["update"] });

    const docId = "00000000-0000-0000-0000-000000000001";
    const ctx: BrokerContext = { userId, env: "live", orgId: "default", via: "session" };
    const result = await broker.listRevisions(ctx, { collection: "people", id: docId });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_grant");
  });

  it("returns not_found when document does not exist", async () => {
    const userId = "not_found_user";
    const grantId = await requestGrant(app, {
      userId, collection: "people", env: "live", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email"],
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: ["read"] });

    const docId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const ctx: BrokerContext = { userId, env: "live", orgId: "default", via: "session" };
    const result = await broker.listRevisions(ctx, { collection: "people", id: docId });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });

  it("returns not_found when document is excluded by filter", async () => {
    const userId = "filtered_user";
    const grantId = await requestGrant(app, {
      userId, collection: "people", env: "live", orgId: "default",
      purposeLabel: "test", allowedFields: ["id", "email", "owner"],
    });
    await approveGrant(app, cfg, grantId, "admin", {
      verbs: ["read"],
      documentFilter: { field: "owner", op: "eq", value: "admin" },
    });

    const docId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const revId = (await app.query("select gen_random_uuid() as id")).rows[0].id;
    await app.query(
      `insert into data_live.people (org_id, id, email, owner, _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, _rev_fields, _current)
       values ('default', $1, 'user@ex.com', 'other_user', $2, 1, now(), $3, 'create', 'approved', '{}', true)`,
      [docId, revId, userId]);

    const ctx: BrokerContext = { userId, env: "live", orgId: "default", via: "session" };
    const result = await broker.listRevisions(ctx, { collection: "people", id: docId });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });
});

describe("getClientPolicy", () => {
  it("returns default values for missing client", async () => {
    const policy = await getClientPolicy(app, "unknown_client");

    expect(policy.clientId).toBe("unknown_client");
    expect(policy.allowedScopes).toEqual(["env:dev"]);
    expect(policy.allowedCollections).toBeNull();
    expect(policy.mode).toBe("delegated");
    expect(policy.robotUserId).toBeNull();
    expect(policy.trustedIssuerId).toBeNull();
  });

  it("returns full row for existing client", async () => {
    const clientId = "test_client_full";
    const trustedIssuerId = "550e8400-e29b-41d4-a716-446655440000";
    await app.query(
      `insert into app.client_policies
       (client_id, allowed_scopes, allowed_collections, mode, robot_user_id, trusted_issuer_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [clientId, ["env:live"], ["collection1", "collection2"], "headless", "robot_123", trustedIssuerId]);

    const policy = await getClientPolicy(app, clientId);

    expect(policy.clientId).toBe(clientId);
    expect(policy.allowedScopes).toEqual(["env:live"]);
    expect(policy.allowedCollections).toEqual(["collection1", "collection2"]);
    expect(policy.mode).toBe("headless");
    expect(policy.robotUserId).toBe("robot_123");
    expect(policy.trustedIssuerId).toBe(trustedIssuerId);
  });
});

describe("trusted issuers", () => {
  it("creates and retrieves issuer", async () => {
    const issuer = await createTrustedIssuer(
      app, "default",
      "https://issuer.example.com",
      "https://issuer.example.com/.well-known/jwks.json",
      "https://api.example.com",
      "sub"
    );

    expect(issuer.id).toBeDefined();
    expect(issuer.issuer).toBe("https://issuer.example.com");
    expect(issuer.jwksUri).toBe("https://issuer.example.com/.well-known/jwks.json");
    expect(issuer.audience).toBe("https://api.example.com");
    expect(issuer.subjectClaim).toBe("sub");
    expect(issuer.orgId).toBe("default");

    const retrieved = await getTrustedIssuer(app, issuer.id, "default");
    expect(retrieved).not.toBeNull();
    if (retrieved) {
      expect(retrieved.id).toBe(issuer.id);
      expect(retrieved.issuer).toBe(issuer.issuer);
    }
  });

  it("lists issuers for org only", async () => {
    // Create issuer for default org
    const issuer1 = await createTrustedIssuer(
      app, "default",
      "https://issuer1.example.com",
      "https://issuer1.example.com/.well-known/jwks.json",
      "https://api1.example.com"
    );

    // Create issuer for other org
    await app.query(`insert into app.organizations (id, name) values ($1, $2)`, ["other_org", "Other Org"]);
    const issuer2 = await createTrustedIssuer(
      app, "other_org",
      "https://issuer2.example.com",
      "https://issuer2.example.com/.well-known/jwks.json",
      "https://api2.example.com"
    );

    const defaultIssuers = await listTrustedIssuers(app, "default");
    const otherIssuers = await listTrustedIssuers(app, "other_org");

    // Filter to just the issuers we created (there might be others from other tests)
    const defaultCreated = defaultIssuers.filter(i => i.id === issuer1.id);
    const otherCreated = otherIssuers.filter(i => i.id === issuer2.id);

    expect(defaultCreated).toHaveLength(1);
    expect(otherCreated).toHaveLength(1);
    expect(defaultCreated[0].orgId).toBe("default");
    expect(otherCreated[0].orgId).toBe("other_org");
  });

  it("returns null for issuer from another org", async () => {
    const issuer = await createTrustedIssuer(
      app, "default",
      "https://issuer3.example.com",
      "https://issuer3.example.com/.well-known/jwks.json",
      "https://api3.example.com"
    );

    const fromWrongOrg = await getTrustedIssuer(app, issuer.id, "other_org");
    expect(fromWrongOrg).toBeNull();
  });
});

describe("getProposal", () => {
  // A create is the case that motivates this method: the document is not in any view until
  // it is approved, so getDocument cannot show a reviewer what they are about to approve.
  async function proposeAs(userId: string, verbs: string[], allowedFields: string[]) {
    const grantId = await requestGrant(app, {
      userId, collection: "people", env: "live", orgId: "default",
      purposeLabel: "test", allowedFields,
    });
    await approveGrant(app, cfg, grantId, "admin", { verbs: verbs as any, mode: "proposal_only" });
  }

  const ctx = (userId: string): BrokerContext =>
    ({ userId, orgId: "default", env: "live", via: "session" });

  it("returns the proposed values of a pending create", async () => {
    await proposeAs("gp_author", ["read", "create"], ["id", "email", "owner", "status"]);
    const created = await broker.mutate(ctx("gp_author"), {
      collection: "people", op: "create",
      values: { email: "proposed@example.com", owner: "gp_author", status: "new" },
    });
    expect(created.ok).toBe(true);
    const proposalId = (created as { proposalId: string }).proposalId;

    await proposeAs("gp_approver", ["read", "approve"], ["id", "email", "owner", "status"]);
    const got = await broker.getProposal(ctx("gp_approver"), proposalId);

    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.op).toBe("create");
    expect(got.values.email).toBe("proposed@example.com");
    expect(got.fieldsReturned).toContain("email");
  });

  it("omits values for fields outside the reviewer's grant", async () => {
    await proposeAs("gp_author2", ["read", "create"], ["id", "email", "owner", "status"]);
    const created = await broker.mutate(ctx("gp_author2"), {
      collection: "people", op: "create",
      values: { email: "secret@example.com", owner: "gp_author2", status: "new" },
    });
    const proposalId = (created as { proposalId: string }).proposalId;

    // This reviewer may not read `email`, so the proposed value must not reach them.
    await proposeAs("gp_narrow", ["read", "approve"], ["id", "owner"]);
    const got = await broker.getProposal(ctx("gp_narrow"), proposalId);

    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.fieldsReturned).not.toContain("email");
    expect(got.values.email).toBeUndefined();
    expect(got.values.owner).toBe("gp_author2");
  });

  it("refuses a reader who does not hold approve", async () => {
    await proposeAs("gp_author3", ["read", "create"], ["id", "email", "owner", "status"]);
    const created = await broker.mutate(ctx("gp_author3"), {
      collection: "people", op: "create",
      values: { email: "x@example.com", owner: "gp_author3", status: "new" },
    });
    const proposalId = (created as { proposalId: string }).proposalId;

    await proposeAs("gp_readonly", ["read"], ["id", "email", "owner"]);
    const got = await broker.getProposal(ctx("gp_readonly"), proposalId);

    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.reason).toBe("no_grant");
  });

  it("refuses an unknown proposal id", async () => {
    await proposeAs("gp_seeker", ["read", "approve"], ["id", "email"]);
    const got = await broker.getProposal(ctx("gp_seeker"), "f47ac10b-58cc-4372-a567-0e02b2c3d4ff");
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.reason).toBe("not_found");
  });
});
