import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb } from "./helpers/web-db";
import { getClientPolicy } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
beforeAll(async () => { db = await setupWebDb("oauthdcr"); }, 60_000);
afterAll(async () => { await db?.end(); });

it("a dynamically registered client gets allowed_scopes = {env:dev, env:live} at registration", async () => {
  const res = await db.auth.api.registerMcpClient({
    body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "DCR Client" },
    asResponse: true,
  } as any);
  const { client_id } = await res.json();
  const policy = await getClientPolicy(getAppPool(), client_id);
  expect(policy.allowedScopes.sort()).toEqual(["env:dev", "env:live"]);
});
