import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import {
  canonicalize,
  admits,
  validateDocumentFilters,
  validateGrantFilters,
} from "../src/grants/filters";
import {
  ConfigSchema,
  type CollectionConfig,
  type FieldConfig,
  type WarehousdConfig,
} from "../src/config/schema";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import type { BrokerContext, DocumentFilter } from "../src/types";
import { makeCtx } from "./helpers/ctx";
import { assertApplied } from "./helpers/results";

// A grant's document filter is evaluated twice in this codebase: in SQL on the read path
// (sql/build.ts) and in process on the write path (grants/filters.ts). This file is the assertion
// that the two agree, made against a live Postgres rather than against an assumption about one.
//
// The contract under test is not "JavaScript reproduces Postgres" — it cannot, and does not try.
// It is: for every filter that validateDocumentFilters admits, the in-process evaluator returns
// exactly what `col = $1` returns in the database. Anything the two could not agree on is refused
// by validation instead, on both paths, so it never reaches either evaluator.

let p: Provisioned, admin: Pool;

const PG_TYPE: Record<string, string> = {
  text: "text",
  uuid: "uuid",
  int: "integer",
  numeric: "numeric",
  timestamptz: "timestamptz",
  date: "date",
  boolean: "boolean",
};

beforeAll(async () => {
  p = await provision("filter-parity");
  admin = new Pool({ connectionString: p.urls.admin });
  const cols = Object.entries(PG_TYPE)
    .map(([n, t]) => `c_${n} ${t}`)
    .join(", ");
  await admin.query(`create table public.parity (${cols})`);
}, 60_000);

afterAll(async () => {
  await admin.end();
  await p.end();
});

// One collection whose fields cover every declared type, so canonicalize() is reached through the
// same shape the broker uses rather than called with a bare type string.
const collection = (): CollectionConfig =>
  ConfigSchema.parse({
    project: "t",
    collections: {
      c: {
        description: "d",
        fields: Object.fromEntries(
          Object.keys(PG_TYPE).map((t) => [`c_${t}`, { type: t, posture: "allow" }]),
        ),
      },
    },
  }).collections.c!;

type Case = { type: string; stored: string | null; filter: unknown; note?: string };

// stored values are written with an explicit cast and read back through the driver, so the JS side
// sees exactly the value the write path would hold. filter values are the grant author's input.
const CASES: Case[] = [
  // text — the only type the old String() comparison got right, kept as the control
  { type: "text", stored: "abc", filter: "abc" },
  { type: "text", stored: "abc", filter: "abd" },
  { type: "text", stored: "100", filter: 100, note: "number against a text column" },

  // uuid — Postgres compares 128-bit values, so spelling is insignificant
  {
    type: "uuid",
    stored: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    filter: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  },
  {
    type: "uuid",
    stored: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    filter: "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11",
  },
  {
    type: "uuid",
    stored: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    filter: "{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}",
  },
  {
    type: "uuid",
    stored: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    filter: "a0eebc999c0b4ef8bb6d6bb9bd380a11",
  },
  {
    type: "uuid",
    stored: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    filter: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  },

  // int — driver returns a number
  { type: "int", stored: "5", filter: 5 },
  { type: "int", stored: "5", filter: "5" },
  { type: "int", stored: "5", filter: "+5" },
  { type: "int", stored: "5", filter: " 5 " },
  { type: "int", stored: "5", filter: 6 },
  { type: "int", stored: "-5", filter: -5 },

  // numeric — driver returns a *string*, so String() coercion compared "100.00" to "100"
  { type: "numeric", stored: "100.00", filter: 100 },
  { type: "numeric", stored: "100.00", filter: "100" },
  { type: "numeric", stored: "100.00", filter: "100.00" },
  { type: "numeric", stored: "100.00", filter: "100.000" },
  { type: "numeric", stored: "100.00", filter: "1e2" },
  { type: "numeric", stored: "100.00", filter: "+100" },
  { type: "numeric", stored: "0", filter: "-0", note: "signed zero is one value" },
  { type: "numeric", stored: "0.5", filter: ".5" },
  { type: "numeric", stored: "100.00", filter: 101 },
  // Precision: these two differ in Postgres but collapse to the same IEEE double, so a Number()
  // comparison would report a match between two different values — the over-permissive direction.
  {
    type: "numeric",
    stored: "1000000000000000000000000000000",
    filter: "1000000000000000000000000000001",
  },
  {
    type: "numeric",
    stored: "1000000000000000000000000000000",
    filter: "1000000000000000000000000000000",
  },

  // timestamptz — driver returns a Date
  { type: "timestamptz", stored: "2026-07-29T12:00:00Z", filter: "2026-07-29T12:00:00Z" },
  { type: "timestamptz", stored: "2026-07-29T12:00:00Z", filter: "2026-07-29 12:00:00+00:00" },
  { type: "timestamptz", stored: "2026-07-29T12:00:00Z", filter: "2026-07-29T09:00:00-03:00" },
  {
    type: "timestamptz",
    stored: "2026-07-29T12:00:00Z",
    filter: "2026-07-29T12:00:00.500Z",
    note: "sub-second precision is significant to both",
  },
  { type: "timestamptz", stored: "2026-07-29T12:00:00Z", filter: "2026-07-29T12:00:00.000Z" },
  { type: "timestamptz", stored: "2026-07-29T12:00:00Z", filter: "2026-07-29T13:00:00Z" },

  // date — driver returns a Date at *local* midnight
  { type: "date", stored: "2026-07-29", filter: "2026-07-29" },
  { type: "date", stored: "2026-07-29", filter: "2026-07-30" },
  { type: "date", stored: "2026-01-01", filter: "2026-01-01" },
  { type: "date", stored: "2026-12-31", filter: "2026-12-31" },

  // boolean — every canonical spelling Postgres takes
  { type: "boolean", stored: "true", filter: true },
  { type: "boolean", stored: "true", filter: "true" },
  { type: "boolean", stored: "true", filter: "t" },
  { type: "boolean", stored: "true", filter: "TRUE" },
  { type: "boolean", stored: "true", filter: "yes" },
  { type: "boolean", stored: "true", filter: "on" },
  { type: "boolean", stored: "true", filter: "1" },
  { type: "boolean", stored: "true", filter: false },
  { type: "boolean", stored: "false", filter: "f" },
  { type: "boolean", stored: "false", filter: "off" },
  { type: "boolean", stored: "false", filter: "0" },
  { type: "boolean", stored: "false", filter: "no" },

  // NULL columns match nothing, including the string "null" — which the old String() comparison
  // matched, admitting every null-valued row on the write path while SQL refused it.
  { type: "text", stored: null, filter: "null" },
  { type: "text", stored: null, filter: "" },
  { type: "int", stored: null, filter: 0 },
  { type: "timestamptz", stored: null, filter: "2026-07-29T12:00:00Z" },
];

describe("document filter: in-process evaluation matches SQL", () => {
  const c = collection();

  for (const k of CASES) {
    const field = `c_${k.type}`;
    const label =
      `${k.type}: stored ${JSON.stringify(k.stored)} vs filter ${JSON.stringify(k.filter)}` +
      (k.note ? ` (${k.note})` : "");

    it(label, async () => {
      // Validation gates both paths. A filter it refuses never reaches either evaluator, so it is
      // outside the parity contract — but it must be refused, not silently mishandled.
      const invalid = validateDocumentFilters([{ field, op: "eq", value: k.filter }], c);
      expect(invalid, `case is admitted by validation`).toBeNull();

      await admin.query(`truncate public.parity`);
      await admin.query(`insert into public.parity (${field}) values ($1::${PG_TYPE[k.type]})`, [
        k.stored,
      ]);

      // What the database says, through a bound parameter — the read path's semantics exactly.
      const sql = await admin.query(
        `select coalesce(${field} = $1, false) as m from public.parity`,
        [k.filter as never],
      );
      const sqlMatch: boolean = sql.rows[0]!.m;

      // What the write path says, against the row as the driver hands it over. Through `admits`,
      // which is the door the verbs use: the collection has no ACL, so it reduces to the filter
      // half — the same call every verb makes on a collection without `acl: true`.
      const row = (await admin.query(`select * from public.parity`)).rows[0]!;
      const jsMatch = admits(
        row,
        { documentFilter: [{ field, op: "eq", value: k.filter }], principals: [] },
        c,
      );

      expect(jsMatch, `SQL said ${sqlMatch}, in-process said ${jsMatch}`).toBe(sqlMatch);
    });
  }

  it("covers every declared field type that can carry a filter", () => {
    // A type added to the config schema without a case here would silently go untested.
    const tested = new Set(CASES.map((k) => k.type));
    const declared = Object.keys(PG_TYPE);
    expect([...tested].sort()).toEqual(declared.sort());
  });
});

describe("document filter: `in` lists agree with SQL", () => {
  const c = collection();
  const cases: { type: string; stored: string; list: unknown[] }[] = [
    { type: "numeric", stored: "100.00", list: ["1e2", "7"] },
    { type: "numeric", stored: "100.00", list: ["99", "101"] },
    { type: "timestamptz", stored: "2026-07-29T12:00:00Z", list: ["2026-07-29T09:00:00-03:00"] },
    { type: "date", stored: "2026-07-29", list: ["2026-07-28", "2026-07-29"] },
    { type: "boolean", stored: "true", list: ["t"] },
    { type: "int", stored: "5", list: [4, 5, 6] },
  ];

  for (const k of cases) {
    const field = `c_${k.type}`;
    it(`${k.type}: stored ${k.stored} in ${JSON.stringify(k.list)}`, async () => {
      expect(validateDocumentFilters([{ field, op: "in", value: k.list }], c)).toBeNull();

      await admin.query(`truncate public.parity`);
      await admin.query(`insert into public.parity (${field}) values ($1::${PG_TYPE[k.type]})`, [
        k.stored,
      ]);

      const params = k.list.map((_, i) => `$${i + 1}`).join(", ");
      const sql = await admin.query(
        `select coalesce(${field} in (${params}), false) as m from public.parity`,
        k.list as never[],
      );
      const row = (await admin.query(`select * from public.parity`)).rows[0]!;

      expect(
        admits(row, { documentFilter: [{ field, op: "in", value: k.list }], principals: [] }, c),
      ).toBe(sql.rows[0]!.m);
    });
  }
});

describe("document filter validation refuses what the two paths could not agree on", () => {
  const c = collection();
  const refused: { label: string; field: string; value: unknown }[] = [
    // Postgres resolves a zone-less timestamp in the server's TimeZone and JavaScript would
    // resolve it in the process's, so the two can differ by hours. Refused rather than guessed.
    { label: "timestamptz without a zone", field: "c_timestamptz", value: "2026-07-29 12:00:00" },
    { label: "timestamptz that is not a timestamp", field: "c_timestamptz", value: "yesterday" },
    // Valid to Postgres, but "…T12:00:00+00" is NaN to the strict JavaScript date parser while
    // "… 12:00:00+00" parses to the right instant under the legacy one. Admitting bare-hour
    // offsets would make the separator decide whether a grant works.
    {
      label: "timestamptz with a bare-hour offset",
      field: "c_timestamptz",
      value: "2026-07-29T12:00:00+00",
    },
    {
      label: "timestamptz with a bare-hour offset, space separator",
      field: "c_timestamptz",
      value: "2026-07-29 12:00:00+00",
    },
    { label: "date in a non-ISO spelling", field: "c_date", value: "07/29/2026" },
    // Postgres accepts unambiguous prefixes of its boolean words; matching that exactly buys a
    // grant author nothing, so only the canonical spellings are admitted.
    { label: "boolean given as a prefix", field: "c_boolean", value: "tr" },
    { label: "boolean that is not a boolean", field: "c_boolean", value: "maybe" },
    { label: "int with a fractional part", field: "c_int", value: "5.5" },
    { label: "int in exponent form", field: "c_int", value: "1e2" },
    { label: "int beyond exact integer range", field: "c_int", value: 2 ** 53 },
    { label: "numeric that is not a number", field: "c_numeric", value: "abc" },
    { label: "numeric NaN", field: "c_numeric", value: "NaN" },
    { label: "uuid of the wrong length", field: "c_uuid", value: "a0eebc99" },
    { label: "an object where a scalar belongs", field: "c_text", value: { a: 1 } },
    { label: "a field the collection does not have", field: "nope", value: "x" },
  ];

  for (const r of refused)
    it(`refuses ${r.label}`, () => {
      const err = validateDocumentFilters([{ field: r.field, op: "eq", value: r.value }], c);
      expect(err).not.toBeNull();
      expect(err!.field).toBe(r.field);
    });

  it("refuses a value inside an `in` list, not only a scalar", () => {
    expect(
      validateDocumentFilters([{ field: "c_boolean", op: "in", value: ["t", "maybe"] }], c),
    ).not.toBeNull();
  });

  it("admits a null filter value, which matches nothing just as `col = NULL` does", () => {
    // Legal SQL, so not a validation error — but it must not match, including against a null
    // column. The parity cases above pin the matching half.
    expect(validateDocumentFilters([{ field: "c_text", op: "eq", value: null }], c)).toBeNull();
    expect(
      admits(
        { c_text: null },
        { documentFilter: [{ field: "c_text", op: "eq", value: null }], principals: [] },
        c,
      ),
    ).toBe(false);
    expect(
      admits(
        { c_text: "x" },
        { documentFilter: [{ field: "c_text", op: "eq", value: null }], principals: [] },
        c,
      ),
    ).toBe(false);
  });

  it("refuses a view_join field, which the write path cannot see at all", () => {
    // apply/ddl.ts skips view_join columns on the base table, so the read path (which queries the
    // view) could evaluate such a filter and the write path could not. Refusing on both is what
    // keeps them in step.
    const joined = ConfigSchema.parse({
      project: "t",
      collections: {
        c: {
          description: "d",
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            owner_id: { type: "uuid", posture: "allow", fk: "people.id" },
            owner_name: {
              type: "text",
              posture: "allow",
              view_join: { table: "people", column: "full_name", on: "owner_id" },
            },
          },
        },
      },
    }).collections.c!;
    const err = validateDocumentFilters([{ field: "owner_name", op: "eq", value: "Ada" }], joined);
    expect(err).not.toBeNull();
    expect(err!.detail).toContain("view_join");
  });

  it("refuses a json field, which the old comparison matched against everything", () => {
    // String({…}) is "[object Object]" for every object, so a json document filter used to admit
    // every row with any object in that column. Refusing is the safe direction and matches the
    // write path, which has no way to reproduce jsonb equality.
    const withJson = ConfigSchema.parse({
      project: "t",
      collections: {
        c: {
          description: "d",
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            meta: { type: "json", posture: "allow" },
          },
        },
      },
    }).collections.c!;
    expect(
      validateDocumentFilters([{ field: "meta", op: "eq", value: { a: 1 } }], withJson),
    ).not.toBeNull();
  });
});

describe("canonicalize", () => {
  // Guards the property the parity suite depends on: equal values share a canonical form and
  // unequal values do not. Cheap to state here, expensive to discover from a failing grant.
  const eq = (type: FieldConfig["type"], a: unknown, b: unknown) => {
    const ca = canonicalize(type, a),
      cb = canonicalize(type, b);
    expect(ca).not.toBeNull();
    expect(ca).toBe(cb);
  };

  it("collapses every spelling of the same numeric", () => {
    for (const v of ["100", "100.00", "1e2", "+100", " 100 ", "0.1e3", "10000e-2"])
      eq("numeric", v, 100);
  });

  it("keeps numerics apart beyond double precision", () => {
    expect(canonicalize("numeric", "1000000000000000000000000000000")).not.toBe(
      canonicalize("numeric", "1000000000000000000000000000001"),
    );
  });

  it("treats every spelling of zero as one value", () => {
    for (const v of ["0", "-0", "0.0", "0e10", "+0"]) eq("numeric", v, 0);
  });

  it("reads a date from its local components, not its UTC ones", () => {
    // The driver hands over `date` as a Date at local midnight. Using toISOString() would name
    // the previous day for any timezone east of UTC — a bug that only shows up on a machine
    // configured differently from the one the code was written on.
    const localMidnight = new Date(2026, 6, 29, 0, 0, 0, 0);
    expect(canonicalize("date", localMidnight)).toBe("2026-07-29");
  });

  it("refuses rather than guessing", () => {
    for (const [type, v] of [
      ["timestamptz", "2026-07-29 12:00:00"],
      ["date", "29/07/2026"],
      ["boolean", "tr"],
      ["int", "1e2"],
      ["numeric", "abc"],
      ["uuid", "nope"],
      ["json", {}],
    ] as [FieldConfig["type"], unknown][])
      expect(canonicalize(type, v), `${type} ${JSON.stringify(v)}`).toBeNull();
  });
});

// The comparator suite above pins the two evaluators against each other. This one pins the thing
// an operator actually cares about: one grant, one row, and the read verb and the write verb
// agreeing about whether that row is in scope. It is the assertion that fails if the write path
// ever stops routing through grants/filters.ts, however correct that module is on its own.
describe("a grant scopes read and write identically", () => {
  const wcfg: WarehousdConfig = ConfigSchema.parse({
    project: "parity",
    collections: {
      things: {
        description: "Things",
        writable: true,
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          name: { type: "text", posture: { read: "allow", write: "allow" } },
          owner: { type: "text", posture: { read: "allow", write: "allow" } },
          amount: { type: "numeric", posture: { read: "allow", write: "allow" } },
          count: { type: "int", posture: { read: "allow", write: "allow" } },
          due: { type: "date", posture: { read: "allow", write: "allow" } },
          at: { type: "timestamptz", posture: { read: "allow", write: "allow" } },
          active: { type: "boolean", posture: { read: "allow", write: "allow" } },
        },
      },
    },
  });

  const FIELDS = ["id", "name", "owner", "amount", "count", "due", "at", "active"];
  let wp: Provisioned, wapp: Pool, wpools: any, broker: ReturnType<typeof makeBroker>;
  let docId: string;

  beforeAll(async () => {
    wp = await provision("filter-parity-e2e");
    wapp = new Pool({ connectionString: wp.urls.admin });
    await createAppSchema(wapp);
    await applyConfig(wapp, wcfg);
    wpools = createPools({
      app: wp.urls.admin,
      dev: wp.urls.dev,
      live: wp.urls.live,
      devWrite: wp.urls.devWrite,
      liveWrite: wp.urls.liveWrite,
    });
    broker = makeBroker(wpools, wcfg);

    // One row, written through the broker so the stored values are exactly what the write path
    // produces rather than what a hand-written INSERT would.
    const seedGrant = await requestGrant(wapp, {
      userId: "seeder",
      collection: "things",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "seed",
      allowedFields: FIELDS,
    });
    await approveGrant(wapp, wcfg, seedGrant, "admin", { verbs: ["read", "create", "update"] });
    const created = await broker.mutate(makeCtx({ userId: "seeder" }), {
      collection: "things",
      op: "create",
      values: {
        name: "widget",
        owner: "ada",
        amount: "100.00",
        count: 5,
        due: "2026-07-29",
        at: "2026-07-29T12:00:00Z",
        active: true,
      },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    assertApplied(created);
    docId = created.documentId;
  }, 90_000);

  afterAll(async () => {
    await wapp.end();
    await wpools.end();
    await wp.end();
  });

  let seq = 0;
  // Runs one grant through both verbs and returns what each decided about the row.
  async function bothPaths(filter: DocumentFilter) {
    const userId = `parity_user_${seq++}`;
    const grantId = await requestGrant(wapp, {
      userId,
      collection: "things",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "parity",
      allowedFields: FIELDS,
    });
    // approveGrant refuses a filter it cannot evaluate, so an unevaluable one is written straight
    // onto the row instead — the state an approved grant reaches when the config changes under it,
    // and the only way to ask both verbs what they make of one.
    const evaluable = validateGrantFilters([filter], wcfg.collections.things!) === null;
    await approveGrant(wapp, wcfg, grantId, "admin", {
      verbs: ["read", "update"],
      ...(evaluable ? { documentFilters: [filter] } : {}),
    });
    if (!evaluable)
      await wapp.query(`update app.grants set document_filter=$2 where id=$1`, [
        grantId,
        JSON.stringify([filter]),
      ]);
    const ctx: BrokerContext = makeCtx({ userId });

    const read = await broker.query(ctx, { collection: "things", fields: ["id"] });
    const readReaches = read.ok
      ? read.documents.some((d) => d.id === docId)
      : `refused:${read.reason}`;

    // A no-op-ish update: it only has to get far enough to prove the filter admitted the row.
    const write = await broker.mutate(ctx, {
      collection: "things",
      op: "update",
      id: docId,
      values: { name: "widget" },
    });
    const writeReaches = write.ok ? true : `refused:${write.reason}`;

    return { readReaches, writeReaches };
  }

  // Each case: a filter that should match the seeded row, and one that should not. The spellings
  // differ from how the value was written on purpose — that difference is what used to break the
  // write path while leaving the read path working.
  const cases: { label: string; match: DocumentFilter; miss: DocumentFilter }[] = [
    {
      label: "text",
      match: { field: "owner", op: "eq", value: "ada" },
      miss: { field: "owner", op: "eq", value: "grace" },
    },
    {
      label: "numeric written as 100.00, filtered as 100",
      match: { field: "amount", op: "eq", value: 100 },
      miss: { field: "amount", op: "eq", value: 101 },
    },
    {
      label: "numeric filtered in exponent form",
      match: { field: "amount", op: "eq", value: "1e2" },
      miss: { field: "amount", op: "eq", value: "1e3" },
    },
    {
      label: "int",
      match: { field: "count", op: "eq", value: 5 },
      miss: { field: "count", op: "eq", value: 6 },
    },
    {
      label: "date",
      match: { field: "due", op: "eq", value: "2026-07-29" },
      miss: { field: "due", op: "eq", value: "2026-07-30" },
    },
    {
      label: "timestamptz filtered in a different but equal zone",
      match: { field: "at", op: "eq", value: "2026-07-29T09:00:00-03:00" },
      miss: { field: "at", op: "eq", value: "2026-07-29T09:00:00Z" },
    },
    {
      label: "boolean filtered as 't'",
      match: { field: "active", op: "eq", value: "t" },
      miss: { field: "active", op: "eq", value: "f" },
    },
    {
      label: "in-list over numerics",
      match: { field: "amount", op: "in", value: ["1e2", "7"] },
      miss: { field: "amount", op: "in", value: ["7", "8"] },
    },
  ];

  for (const k of cases) {
    it(`${k.label}: a matching filter admits the row on both paths`, async () => {
      const r = await bothPaths(k.match);
      expect(r.readReaches, "read path").toBe(true);
      expect(r.writeReaches, "write path").toBe(true);
    });

    it(`${k.label}: a non-matching filter excludes the row on both paths`, async () => {
      const r = await bothPaths(k.miss);
      expect(r.readReaches, "read path").toBe(false);
      expect(r.writeReaches, "write path").toBe("refused:not_found");
    });
  }

  it("an unevaluable filter refuses both paths for the same stated reason", async () => {
    // Before this, a filter neither evaluator could agree on read as invalid_intent and wrote as
    // not_found — the same broken grant reported two ways depending on the verb.
    const r = await bothPaths({ field: "at", op: "eq", value: "2026-07-29 12:00:00" });
    expect(r.readReaches).toBe("refused:invalid_intent");
    expect(r.writeReaches).toBe("refused:invalid_intent");
  });

  it("a write that re-states every field at its stored value is still admitted by a grant filtered on a date field", async () => {
    // coerce's date branch used to emit a full instant, which canonicalize (a calendar day) could
    // never match — so a grant scoped on `due` would refuse a write that merely restated it.
    const userId = `parity_user_${seq++}`;
    const grantId = await requestGrant(wapp, {
      userId,
      collection: "things",
      env: "dev",
      workspaceId: "default",
      purposeLabel: "parity",
      allowedFields: FIELDS,
    });
    await approveGrant(wapp, wcfg, grantId, "admin", {
      verbs: ["read", "update"],
      documentFilters: [{ field: "due", op: "eq", value: "2026-07-29" }],
    });
    const ctx: BrokerContext = makeCtx({ userId });
    const write = await broker.mutate(ctx, {
      collection: "things",
      op: "update",
      id: docId,
      values: {
        name: "widget",
        owner: "ada",
        amount: "100.00",
        count: 5,
        due: "2026-07-29",
        at: "2026-07-29T12:00:00Z",
        active: true,
      },
    });
    expect(write.ok, JSON.stringify(write)).toBe(true);
  });
});
