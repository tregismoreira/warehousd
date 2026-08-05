import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { bootstrapBrokerDb, provision, type Provisioned } from "./helpers/db";
import {
  createAppSchema,
  applyConfig,
  createPools,
  makeBroker,
  SEED_REV_COLUMNS,
  SEED_REV_VALUES,
  type Pools,
} from "../src/index";
import { ConfigSchema } from "../src/config/schema";
import { MASK_KEY_ENV } from "../src/sql/mask";
import { makeCtx } from "./helpers/ctx";

// A hosted Postgres does not put its extensions in `public`. Supabase ships pgcrypto preinstalled
// in a schema called `extensions`, which makes `create extension if not exists pgcrypto` a silent
// no-op — and then every unqualified reference this codebase makes to one of those extensions'
// objects resolves for nobody:
//
//   hmac()                        a masked read, at request time, as warehousd_dev
//   vector(n), vector_cosine_ops  the file-collection DDL, at apply time, as the app role
//
// Both halves are covered below, because they fail in different places for the same reason and a
// fix for one is not a fix for the other. This whole file is the `extensions` schema; nothing in
// it is about masking or about file collections beyond using them as the two witnesses.
const cfg = ConfigSchema.parse({
  project: "extsp",
  server: { port: 1 },
  collections: {
    staff: {
      description: "Staff",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        name: { type: "text", posture: "allow" },
        pseudonym: {
          type: "text",
          posture: { read: "mask", write: "deny" },
          mask: { transform: "hash" },
        },
      },
    },
    docs: {
      type: "file",
      description: "Docs",
      source: "./seed/docs",
      fields: {
        title: { posture: "allow" },
        content: { posture: "allow" },
      },
    },
  },
});

const ID = "00000001-0000-4000-8000-000000000000";

let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  process.env[MASK_KEY_ENV] = "test-mask-key";
  // Bare, not the template: the template already created pgcrypto and vector in `public`, and
  // where the extensions live is the entire subject.
  p = await provision("extsp", { bare: true });
  // max: 1 deliberately. applyConfig checks a client out for its whole run, so this pool has
  // nothing left to hand anyone until it gives that client back — every statement below is the
  // gate on it doing so. A leaked client here is not a slow test, it is a hung one.
  admin = new Pool({ connectionString: p.urls.admin, max: 1 });
  await admin.query(`
    create schema extensions;
    create extension pgcrypto with schema extensions;
    create extension vector with schema extensions;
  `);
  // The same helper that builds the shared template, rather than ensureSchemasAndRoles: it only
  // creates a role that is missing, where ensureSchemasAndRoles also re-asserts the password.
  // Roles are cluster-global, and this file runs in the parallel pass — bootstrap.test.ts is in
  // SERIAL_TESTS for touching exactly that row.
  await bootstrapBrokerDb(p.urls.admin);
  await createAppSchema(admin);

  // Fails here without the fix, on the file collection's `embedding vector(n)` column: the
  // extension exists, so `create extension if not exists vector` does nothing, and the type is
  // not on this session's search_path.
  await applyConfig(admin, cfg);

  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);

  await admin.query(
    `insert into data_synth.staff (${SEED_REV_COLUMNS}, id, name, pseudonym)
     values (${SEED_REV_VALUES}, $1, 'Ada', 'raw-value')`,
    [ID],
  );
  await admin.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status)
     values ('mia','staff',$1,'dev','approved')`,
    [["id", "name", "pseudonym"]],
  );
}, 60_000);

afterAll(async () => {
  delete process.env[MASK_KEY_ENV];
  await admin.end();
  await pools.end();
  await p.end();
});

describe("extensions installed outside public", () => {
  it("still lets a masked read resolve hmac() as warehousd_dev", async () => {
    // The failure this replaces is `function hmac(text, text, unknown) does not exist`, swallowed
    // into internal_error at request time — long after apply and boot both reported success.
    const r = await broker.query(makeCtx({ userId: "mia", env: "dev" }), {
      collection: "staff",
      fields: ["id", "pseudonym"],
    });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) throw new Error("unreachable");
    expect(String(r.documents[0]!.pseudonym)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r.documents)).not.toContain("raw-value");
  });

  it("puts the extension schema on each data role's search_path, for this database only", async () => {
    const s = await admin.query<{ rolname: string; setconfig: string[] }>(
      `select r.rolname, s.setconfig
         from pg_db_role_setting s
         join pg_roles r on r.oid = s.setrole
         join pg_database d on d.oid = s.setdatabase
        where d.datname = current_database() and r.rolname like 'warehousd\\_%'`,
    );
    const paths = Object.fromEntries(s.rows.map((r) => [r.rolname, r.setconfig]));
    for (const role of ["warehousd_dev", "warehousd_live"]) {
      expect(paths[role]).toContain("search_path=public, extensions");
    }
    // Scoped `in database`, because roles are cluster-global and a plain `alter role … set`
    // would reach into every other database on this server — including a sibling checkout's.
    const global = await admin.query(
      `select 1 from pg_db_role_setting where setdatabase = 0
         and setrole = (select oid from pg_roles where rolname = 'warehousd_dev')`,
    );
    expect(global.rowCount).toBe(0);
  });

  it("grants the data roles usage on that schema", async () => {
    // search_path alone is not enough: a schema the role cannot USE is a schema whose functions
    // it cannot resolve, and the error is the identical "does not exist".
    const r = await admin.query<{ has: boolean }>(
      `select bool_and(has_schema_privilege(rolname, 'extensions', 'usage')) as has
         from pg_roles where rolname like 'warehousd\\_%'`,
    );
    expect(r.rows[0]!.has).toBe(true);
  });
});
