import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, marcusCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("admintax");
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@harbor.demo", "demo");
}, 60_000);

afterAll(async () => {
  await db?.end();
});

function req(cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost:8722/api/admin/taxonomies", { headers });
}

async function get(cookie?: string) {
  const { GET } = await import("../app/api/admin/taxonomies/route");
  return GET(req(cookie) as any);
}

async function vocabularies(cookie: string) {
  const body = await (await get(cookie)).json();
  return body.vocabularies as {
    slug: string;
    label: string;
    multiple: boolean;
    source: { collection: string; slug: string; label: string } | null;
    applied: boolean;
    collections: string[];
    terms: { slug: string; label: string; documentCount: number }[];
  }[];
}

describe("GET /api/admin/taxonomies", () => {
  it("401s anonymously and 403s for a manager", async () => {
    expect((await get()).status).toBe(401);
    expect((await get(marcusCookie)).status).toBe(403);
  });

  it("returns every vocabulary in the configuration with its bound collections", async () => {
    const vocabs = await vocabularies(anaCookie);
    expect(vocabs.map((v) => v.slug).sort()).toEqual(["client", "department", "tags"]);

    const department = vocabs.find((v) => v.slug === "department")!;
    expect(department.label).toBe("Department");
    expect(department.multiple).toBe(false);
    expect(department.applied).toBe(true);
    expect(department.collections.sort()).toEqual(["announcements", "policies", "precedents"]);
  });

  it("marks a multi-value vocabulary as such — grants on it use array overlap", async () => {
    const tags = (await vocabularies(anaCookie)).find((v) => v.slug === "tags")!;
    expect(tags.multiple).toBe(true);
    expect(tags.terms.map((t) => t.slug)).toContain("privileged");
  });

  it("distinguishes a YAML vocabulary from a dataset-sourced one", async () => {
    const vocabs = await vocabularies(anaCookie);
    expect(vocabs.find((v) => v.slug === "department")!.source).toBeNull();
    expect(vocabs.find((v) => v.slug === "client")!.source).toEqual({
      collection: "clients",
      slug: "client_number",
      label: "name",
    });
  });

  // The whole reason terms are read from app.terms rather than resolved from the YAML: a
  // dataset-sourced vocabulary has no YAML terms, so a config-only resolver shows `c-0042`
  // where a person needs to read a client's name.
  it("resolves a dataset-sourced vocabulary's labels instead of echoing its slugs", async () => {
    const client = (await vocabularies(anaCookie)).find((v) => v.slug === "client")!;
    expect(client.terms.length).toBeGreaterThan(0);
    for (const t of client.terms) {
      expect(t.slug).toMatch(/^c-\d{4}$/);
      expect(t.label).not.toBe(t.slug);
      expect(t.label.length).toBeGreaterThan(0);
    }
  });

  it("counts documents per term for the cookie's environment", async () => {
    const dev = (await vocabularies(anaCookie)).find((v) => v.slug === "department")!;
    const used = dev.terms.filter((t) => t.documentCount > 0);
    expect(used.length).toBeGreaterThan(0);

    const live = (await vocabularies(`${anaCookie}; wh_env=live`)).find(
      (v) => v.slug === "department",
    )!;
    // dev and live index different source directories, so the same vocabulary covers a different
    // amount of data in each. That difference is what makes the env switcher mean something.
    expect(live.terms.map((t) => t.documentCount)).not.toEqual(
      dev.terms.map((t) => t.documentCount),
    );
  });

  it("reports a vocabulary that was never applied rather than pretending it has no terms", async () => {
    await getAppPool().query(`delete from app.terms where vocabulary_id in
      (select id from app.vocabularies where slug='department')`);
    await getAppPool().query(`delete from app.vocabularies where slug='department'`);

    const department = (await vocabularies(anaCookie)).find((v) => v.slug === "department")!;
    expect(department.applied).toBe(false);
    expect(department.terms).toEqual([]);
    // Still declared, still bound — the configuration is unchanged, only the deployment is behind.
    expect(department.collections.sort()).toEqual(["announcements", "policies", "precedents"]);
  });
});
