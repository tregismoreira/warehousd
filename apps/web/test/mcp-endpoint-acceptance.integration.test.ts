// Closes the Phase 3 acceptance gate items not covered by mcp-endpoint.integration.test.ts:
// the hostile-intent probe suite over query_collection, a search_documents success path
// asserting _rank/document_seq, the dev/live env wall across all five tools (incl. forged
// env args), and §10 test 6 (env parity). Uses setupWebDbWithData, which applies the
// harbor YAML, generates synthetic data, seeds live data, and indexes policies for both
// envs — the same recipe as scripts/dev-bootstrap.ts — so DEV_DATABASE_URL/LIVE_DATABASE_URL
// serve real data instead of just exercising refusal paths.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { authorizeAndGetCode, pkcePair } from "./helpers/oauth";
import { upsertClientPolicy, SEED_REV_COLUMNS, SEED_REV_VALUES } from "@warehousd/broker";
import {
  DENIED_CANARY,
  SSN_CANARY,
  MASK_RAW_CANARY,
  LIVE_ONLY_CANARY,
  DOC_RESTRICTED_CANARY,
} from "../../../packages/broker/test/fixtures/canaries";

// Every dataset table carries NOT NULL revision bookkeeping, so a fixture insert has to
// be a well-formed `create` revision. These are literals; every value stays bound.
const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let admin: Pool;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("mcpaccept");
  admin = new Pool({ connectionString: db.appUrl });
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");

  // Plant canaries in denied columns directly, mirroring packages/broker/test/probe.test.ts —
  // the only thing that should block them is posture, not a missing grant.
  const dep = (
    await admin.query(
      `insert into data_synth.departments (${R}, id,name) values (${RV}, gen_random_uuid(),'Fin') returning id`,
    )
  ).rows[0].id;
  const person = (
    await admin.query(
      `insert into data_synth.people (${R}, id,full_name,email,department_id,home_address,phone)
     values (${RV}, gen_random_uuid(),'Canary Person','canary@x', $1, $2, '555') returning id`,
      [dep, DENIED_CANARY],
    )
  ).rows[0].id;
  await admin.query(
    `insert into data_synth.salaries (${R}, id,person_id,job_title,base_salary,currency,effective_date,ssn,bank_account,pay_band)
     values (${RV}, gen_random_uuid(), $1, 'Senior Accountant', 100000,'USD','2023-01-01',$2,$3,97300)`,
    [person, SSN_CANARY, `${MASK_RAW_CANARY}-4321`],
  );

  // mia: full grantable fields on people/salaries (dev + live), and policies (dev + live).
  // live grants need a future expires_at — hasApprovedLiveGrant (env-scope eligibility check)
  // requires expires_at > now(), and NULL fails that comparison.
  for (const env of ["dev", "live"] as const) {
    const expiresAt = env === "live" ? new Date(Date.now() + 86_400_000).toISOString() : null;
    await admin.query(
      `insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at) values
       ('mia','people', array['id','full_name','email','department_name','department_id'],$1,'approved',$2),
       ('mia','salaries', array['id','person_id','job_title','base_salary','currency','effective_date','bank_account','pay_band'],$1,'approved',$2),
       ('mia','policies', array['title','content','owner','updated_at','category'],$1,'approved',$2)`,
      [env, expiresAt],
    );
  }
}, 120_000);

afterAll(async () => {
  await admin?.end();
  await db?.end();
});

async function mintAccessToken(scope: string) {
  const app = admin;
  const reg = await db.auth.api.registerMcpClient({
    body: {
      redirect_uris: ["http://localhost:9999/callback"],
      client_name: "MCP Acceptance Test Client",
    },
    asResponse: true,
  } as any);
  const { client_id, client_secret } = await reg.json();
  await upsertClientPolicy(app, client_id, "MCP Acceptance Test Client", ["env:dev", "env:live"]);
  const { verifier, challenge } = pkcePair();
  const { code } = await authorizeAndGetCode(db.auth, {
    clientId: client_id,
    scope,
    cookie: miaCookie,
    challenge,
  });
  const tokenRes = await db.auth.api.mcpOAuthToken({
    body: {
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:9999/callback",
      client_id,
      client_secret,
      code_verifier: verifier,
    },
    asResponse: true,
  } as any);
  return (await tokenRes.json()).access_token as string;
}

function rpcRequest(token: string, body: unknown) {
  return new Request("http://localhost:8722/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

async function rpc(token: string, method: string, params?: unknown) {
  const { POST } = await import("../app/mcp/route");
  const res = await POST(rpcRequest(token, { jsonrpc: "2.0", id: 1, method, params }));
  const text = await res.text();
  const jsonLine = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .find((l) => l.startsWith("data: "))
        ?.slice(6);
  return { status: res.status, body: jsonLine ? JSON.parse(jsonLine) : null };
}

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const { body } = await rpc(token, "tools/call", { name, arguments: args });
  return JSON.parse(body.result.content[0].text);
}

describe("hostile-intent probe suite over MCP (§10 test 4)", () => {
  const probesPath = new URL("../../../packages/broker/test/fixtures/probes.json", import.meta.url);
  const allProbes = JSON.parse(readFileSync(probesPath, "utf8")) as {
    name: string;
    surface?: string;
    intent: Record<string, unknown>;
    expect: "allowed" | "refused";
  }[];

  it("query_collection: no probe leaks a canary; outcomes match expectations", async () => {
    const token = await mintAccessToken("env:dev");
    const probes = allProbes.filter((p) => !p.surface || p.surface === "query");
    expect(probes.length).toBeGreaterThan(0);

    for (const probe of probes) {
      const out = await callTool(token, "query_collection", probe.intent);
      const outcome = out.ok ? "allowed" : "refused";
      expect(outcome, `probe "${probe.name}"`).toBe(probe.expect);
      const payload = JSON.stringify(out);
      expect(payload.includes(DENIED_CANARY), `canary in response of "${probe.name}"`).toBe(false);
      expect(payload.includes(SSN_CANARY), `canary in response of "${probe.name}"`).toBe(false);
      // bank_account IS granted to mia, so only the mask keeps its raw value out of an
      // otherwise-allowed response — the strictest of the three canaries on this surface.
      expect(payload.includes(MASK_RAW_CANARY), `canary in response of "${probe.name}"`).toBe(
        false,
      );
    }
  });

  it("search_documents: no probe leaks a canary; outcomes match expectations", async () => {
    const token = await mintAccessToken("env:dev");
    const probes = allProbes.filter((p) => p.surface === "searchDocuments");
    expect(probes.length).toBeGreaterThan(0);

    for (const probe of probes) {
      const out = await callTool(token, "search_documents", probe.intent);
      const outcome = out.ok ? "allowed" : "refused";
      expect(outcome, `probe "${probe.name}"`).toBe(probe.expect);
      const payload = JSON.stringify(out);
      expect(payload.includes(DOC_RESTRICTED_CANARY), `canary in response of "${probe.name}"`).toBe(
        false,
      );
    }
  });
});

describe("search_documents success path (_rank/document_seq, grant-filtered)", () => {
  it("returns ranked documents with _rank + document_seq, ungranted path absent", async () => {
    const token = await mintAccessToken("env:dev");
    const out = await callTool(token, "search_documents", {
      collection: "policies",
      q: "expense reimbursement",
    });
    expect(out.ok).toBe(true);
    expect(out.documents.length).toBeGreaterThan(0);
    for (const row of out.documents) {
      expect(typeof row._rank).toBe("number");
      expect(typeof row.document_seq).toBe("number");
      expect(row).not.toHaveProperty("path");
      expect(row).not.toHaveProperty("tsv");
    }
  });
});

describe("env wall over MCP (§10 test 5, all five tools)", () => {
  it("a dev-token session never returns a live-only canary", async () => {
    const token = await mintAccessToken("env:dev");
    const calls: [string, Record<string, unknown>][] = [
      ["list_collections", {}],
      ["describe_collection", { name: "people" }],
      [
        "query_collection",
        {
          collection: "people",
          fields: ["id", "full_name", "email", "department_name"],
          limit: 500,
        },
      ],
      ["search_documents", { collection: "policies", q: "compliance security" }],
      ["request_access", { collection: "metrics", purpose: "env-wall check" }],
    ];
    for (const [name, args] of calls) {
      const out = await callTool(token, name, args);
      expect(JSON.stringify(out).includes(LIVE_ONLY_CANARY), name).toBe(false);
    }
  });

  it("forged env in tool arguments is ignored — dev token still reads dev data", async () => {
    const token = await mintAccessToken("env:dev");
    const out = await callTool(token, "query_collection", {
      collection: "people",
      fields: ["id", "full_name"],
      limit: 500,
      env: "live",
    });
    expect(out.ok).toBe(true);
    expect(JSON.stringify(out).includes(LIVE_ONLY_CANARY)).toBe(false);
    // dev has 40 synthetic people (harbor's synthetic.documents_per_collection) plus the
    // canary-planted row; live's seed has exactly 1. A leaked env switch would return 1 row.
    expect(out.documents.length).toBeGreaterThan(1);
  });
});

describe("§10 test 6: env parity", () => {
  it("identical intent under dev vs live grant returns identical shape, different data", async () => {
    const devToken = await mintAccessToken("env:dev");
    const liveToken = await mintAccessToken("env:live");
    const args = { collection: "people", fields: ["id", "full_name", "email"], limit: 1 };

    const devOut = await callTool(devToken, "query_collection", args);
    const liveOut = await callTool(liveToken, "query_collection", args);
    expect(devOut.ok).toBe(true);
    expect(liveOut.ok).toBe(true);
    expect(devOut.documents.length).toBe(1);
    expect(liveOut.documents.length).toBe(1);

    const devRow = devOut.documents[0];
    const liveRow = liveOut.documents[0];
    expect(Object.keys(devRow).sort()).toEqual(Object.keys(liveRow).sort());
    for (const k of Object.keys(devRow)) expect(typeof devRow[k]).toBe(typeof liveRow[k]);
    expect(devRow.email).not.toBe(liveRow.email);
  });
});

// The corpus reaches the MCP surface here rather than in a file of its own, because the token
// minting and the streamable-HTTP parsing already live above. `surface: "mcp"` probes carry a
// `tool` and `args` instead of an `intent`: they are hostile in ways a broker-level intent cannot
// express, because what they forge is the caller's identity and environment — which the adapter
// derives from the token and the tool arguments must never influence.
describe("§10 test 4 extended: hostile tool arguments over MCP", () => {
  const mcpProbes = JSON.parse(
    readFileSync(
      new URL("../../../packages/broker/test/fixtures/probes.json", import.meta.url),
      "utf8",
    ),
  ).filter((p: { surface?: string }) => p.surface === "mcp") as {
    name: string;
    tool: string;
    args: Record<string, unknown>;
    expect: "allowed" | "refused";
    expectReason?: string;
    assertDevOnly?: boolean;
  }[];

  it("ignores forged env, workspace and identity in tool arguments and leaks no canary", async () => {
    expect(mcpProbes.length).toBeGreaterThan(0);
    const token = await mintAccessToken("env:dev");

    for (const probe of mcpProbes) {
      const out = await callTool(token, probe.tool, probe.args);
      const outcome = out.ok ? "allowed" : "refused";
      expect(outcome, `probe "${probe.name}"`).toBe(probe.expect);
      // Pinned where the reason is the point. "metrics" is a real collection in harbor, so a
      // no_grant refusal proves the forged userId bought nothing; unknown_collection would mean
      // the probe was refused for a reason that has nothing to do with identity.
      if (probe.expectReason) {
        expect(out.reason, `refusal reason for "${probe.name}"`).toBe(probe.expectReason);
      }

      const payload = JSON.stringify(out);
      for (const canary of [DENIED_CANARY, SSN_CANARY, DOC_RESTRICTED_CANARY]) {
        expect(payload.includes(canary), `canary in response of "${probe.name}"`).toBe(false);
      }
      // A forged env must be ignored rather than honoured — and rather than errored, since an
      // error would tell the caller the parameter was noticed at all.
      if (probe.assertDevOnly) {
        expect(payload.includes(LIVE_ONLY_CANARY), `live data via "${probe.name}"`).toBe(false);
      }
    }
  });
});

// §6.1 rule 1: a client whose policy lacks env:live can ask for anything and still only ever
// receives env:dev. Repeating the scope is the shape worth checking — a rule that de-duplicates
// before intersecting, or intersects only the first occurrence, passes the single-value test and
// fails this one.
describe("scope stuffing at the token endpoint", () => {
  it("yields exactly one env scope, and it is env:dev", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: {
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "Scope Stuffing Client",
      },
      asResponse: true,
    } as never);
    const { client_id, client_secret } = await reg.json();
    // Policy allows dev only; the request below asks for live repeatedly anyway.
    await upsertClientPolicy(admin, client_id, "Scope Stuffing Client", ["env:dev"]);

    const { verifier, challenge } = pkcePair();
    const { code } = await authorizeAndGetCode(db.auth, {
      clientId: client_id,
      scope: "openid profile email offline_access env:live env:dev env:live env:live",
      cookie: miaCookie,
      challenge,
    });
    expect(code, "authorize did not return a code").toBeTruthy();

    // Exchanged through mcpOAuthToken, as oauth-scope.integration.test.ts does: the granted
    // scope is only observable in the token response, and the exchange needs the client secret.
    const tokenRes = await db.auth.api.mcpOAuthToken({
      body: {
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:9999/callback",
        client_id,
        client_secret,
        code_verifier: verifier,
      },
      asResponse: true,
    } as never);
    const tokens = (await tokenRes.json()) as { scope?: string };
    const envScopes = (tokens.scope ?? "").split(" ").filter((s) => s.startsWith("env:"));
    expect(envScopes).toEqual(["env:dev"]);
  });
});
