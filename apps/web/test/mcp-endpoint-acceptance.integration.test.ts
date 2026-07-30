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
import { upsertClientPolicy } from "@warehousd/broker";
import {
  DENIED_CANARY,
  SSN_CANARY,
  LIVE_ONLY_CANARY,
  DOC_RESTRICTED_CANARY,
} from "../../../packages/broker/test/fixtures/canaries";

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
      `insert into data_synth.departments (id,name) values (gen_random_uuid(),'Fin') returning id`,
    )
  ).rows[0].id;
  const person = (
    await admin.query(
      `insert into data_synth.people (id,full_name,email,department_id,home_address,phone)
     values (gen_random_uuid(),'Canary Person','canary@x', $1, $2, '555') returning id`,
      [dep, DENIED_CANARY],
    )
  ).rows[0].id;
  await admin.query(
    `insert into data_synth.salaries (id,person_id,job_title,base_salary,currency,effective_date,ssn)
     values (gen_random_uuid(), $1, 'Senior Accountant', 100000,'USD','2023-01-01',$2)`,
    [person, SSN_CANARY],
  );

  // mia: full grantable fields on people/salaries (dev + live), and policies (dev + live).
  // live grants need a future expires_at — hasApprovedLiveGrant (env-scope eligibility check)
  // requires expires_at > now(), and NULL fails that comparison.
  for (const env of ["dev", "live"] as const) {
    const expiresAt = env === "live" ? new Date(Date.now() + 86_400_000).toISOString() : null;
    await admin.query(
      `insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at) values
       ('mia','people', array['id','full_name','email','department_name','department_id'],$1,'approved',$2),
       ('mia','salaries', array['id','person_id','job_title','base_salary','currency','effective_date'],$1,'approved',$2),
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
