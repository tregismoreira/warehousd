import { describe, it, expect } from "vitest";
import { buildSelect, UnsupportedFilter } from "../src/sql/build";
import { QueryIntentSchema } from "../src/intents/schema";
import type { QueryIntent } from "../src/types";

it("selects only granted fields, parameterizes filter values, caps limit", () => {
  const intent: QueryIntent = {
    collection: "people",
    fields: ["id", "email"],
    filters: [{ field: "email", op: "like", value: "%@x" }],
    orderBy: { field: "id", dir: "asc" },
    limit: 9999,
  };
  const { text, values } = buildSelect("dev", intent, ["id", "email"]);
  expect(text).toContain(`from data_synth.v_people`);
  expect(text).toMatch(/select\s+"id",\s+"email"/i);
  expect(text).not.toContain("home_address");
  expect(text).toContain("limit 500");           // MAX_LIMIT
  expect(values).toEqual(["%@x"]);
});

it("builds aggregate + groupBy expressions", () => {
  const intent: QueryIntent = {
    collection: "salaries",
    aggregate: [{ fn: "avg", field: "base_salary" }],
    groupBy: ["job_title"],
    filters: [{ field: "effective_date", op: "gte", value: "2020-01-01" }],
  };
  const { text } = buildSelect("live", intent, ["base_salary", "job_title", "effective_date"]);
  expect(text).toContain(`avg("base_salary") as "avg_base_salary"`);
  expect(text).toContain(`group by "job_title"`);
  expect(text).toContain(`from data_live.v_salaries`);
});

it("expands `in` operator to a parameter list", () => {
  const intent: QueryIntent = {
    collection: "people", fields: ["id"],
    filters: [{ field: "id", op: "in", value: ["a", "b", "c"] }],
  };
  const { text, values } = buildSelect("dev", intent, ["id"]);
  expect(text).toContain(`"id" in ($1, $2, $3)`);
  expect(values).toEqual(["a", "b", "c"]);
});

it("ANDs documentFilters into where with parameterized values", () => {
  const { text, values } = buildSelect("dev", { collection: "policies", fields: ["title"] },
    ["title", "content"], { documentFilters: [{ field: "path", op: "in", value: ["hr/pto.md", "hr/benefits.md"] }] });
  expect(text).toContain(`"path" in ($1, $2)`);
  expect(values).toEqual(["hr/pto.md", "hr/benefits.md"]);
});

it("empty in-list compiles to constant false, not a SQL error (design test 8)", () => {
  const { text } = buildSelect("dev", { collection: "policies", fields: ["title"] },
    ["title"], { documentFilters: [{ field: "path", op: "in", value: [] }] });
  expect(text).toContain("false");
  expect(text).not.toContain("in ()");
});

it("multi-value `in` becomes array overlap, single-value stays `in`", () => {
  const multi = buildSelect("dev", { collection: "case_files", fields: ["title"] },
    ["title"], {
      documentFilters: [{ field: "tags", op: "in", value: ["litigation", "discovery"] }],
      isMultiValueField: (f) => f === "tags",
    });
  expect(multi.text).toContain(`"tags" && $1::text[]`);
  expect(multi.text).not.toContain(`"tags" in (`);
  expect(multi.values).toEqual([["litigation", "discovery"]]);

  // same predicate, non-multi field: the scalar `in` form, one param per value
  const single = buildSelect("dev", { collection: "case_files", fields: ["title"] },
    ["title"], { documentFilters: [{ field: "tags", op: "in", value: ["litigation", "discovery"] }] });
  expect(single.text).toContain(`"tags" in ($1, $2)`);
});

it("multi-value `eq` asks whether the value is any() of the column", () => {
  const { text, values } = buildSelect("dev", { collection: "case_files", fields: ["title"] },
    ["title"], {
      documentFilters: [{ field: "tags", op: "eq", value: "privileged" }],
      isMultiValueField: (f) => f === "tags",
    });
  expect(text).toContain(`= any("tags")`);
  expect(values).toEqual(["privileged"]);
});

it("an empty multi-value in-list still denies everything (no overlap against empty)", () => {
  const { text } = buildSelect("dev", { collection: "case_files", fields: ["title"] },
    ["title"], {
      documentFilters: [{ field: "tags", op: "in", value: [] }],
      isMultiValueField: (f) => f === "tags",
    });
  expect(text).toContain("false");
  expect(text).not.toContain("&&");
});

// SECURITY.md names "client-supplied input reaching SQL other than as a bound parameter" as a
// reportable vulnerability, and `aggregate[].fn` was exactly that: buildSelect emitted
// `${a.fn}(...)` straight from the intent. `a.field` went through q(); `a.fn` went through
// nothing. A payload with no double quote in it kept the generated alias valid, so the whole
// fragment parsed and the subquery ran on the data pool.
describe("no intent value reaches SQL as syntax", () => {
  // The literal payload from the audit. Kept verbatim: a paraphrase stops being the regression.
  const INJECTED_FN =
    "count(id) as z, (select current_setting('is_superuser')) as leak, count";

  it("rejects an injected aggregate fn at the schema", () => {
    const r = QueryIntentSchema.safeParse({
      collection: "salaries", aggregate: [{ fn: INJECTED_FN, field: "base_salary" }],
    });
    expect(r.success).toBe(false);
  });

  it("refuses an injected aggregate fn in the builder even if the schema is bypassed", () => {
    // buildSelect is reachable from getDocument/searchDocuments with broker-built intents, so it
    // owns this rule independently of whoever validated upstream.
    const intent = {
      collection: "salaries", aggregate: [{ fn: INJECTED_FN, field: "base_salary" }],
    } as unknown as QueryIntent;
    expect(() => buildSelect("live", intent, ["base_salary"])).toThrow(UnsupportedFilter);
  });

  it("does not carry an injected fn into the SELECT list or the column alias", () => {
    const intent = {
      collection: "salaries", aggregate: [{ fn: INJECTED_FN, field: "base_salary" }],
    } as unknown as QueryIntent;
    let text = "";
    try { text = buildSelect("live", intent, ["base_salary"]).text; } catch { /* expected */ }
    expect(text).not.toContain("current_setting");
    expect(text).not.toContain("as leak");
  });

  // OP_SQL and AGG_SQL are object literals, so a property read answers for every name on
  // Object.prototype: `op: "constructor"` yielded the Object constructor, whose string form then
  // landed in the statement.
  it("refuses a prototype-chain operator name rather than interpolating it", () => {
    for (const op of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const intent = {
        collection: "people", fields: ["id"],
        filters: [{ field: "id", op, value: "x" }],
      } as unknown as QueryIntent;
      expect(() => buildSelect("dev", intent, ["id"]), op).toThrow(UnsupportedFilter);
    }
  });

  it("still builds every legitimate aggregate function", () => {
    for (const fn of ["avg", "sum", "count", "min", "max"] as const) {
      const { text } = buildSelect("live",
        { collection: "salaries", aggregate: [{ fn, field: "base_salary" }] },
        ["base_salary"]);
      // The alias the broker reports as fieldsReturned is `<fn>_<field>` — unchanged.
      expect(text).toContain(`${fn}("base_salary") as "${fn}_base_salary"`);
    }
  });
});

// `limit` is capped, not refused — that is the documented contract and the probe suite asserts
// an oversized limit is allowed. What was broken is a limit that is not a number: `Math.max(1,
// "abc")` is NaN, so `limit: "abc"` produced `limit NaN`, which Postgres rejects — turning the
// caller's bad input into a 500.
describe("limit is type-checked at the schema and clamped by the builder", () => {
  it.each([
    ["a string", "abc"], ["a float", 2.5],
    ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY],
    ["null", null], ["an object", {}],
  ])("rejects a limit that is not an integer: %s", (_label, limit) => {
    expect(QueryIntentSchema.safeParse({ collection: "people", limit }).success).toBe(false);
  });

  it("accepts an oversized limit and clamps it to MAX_LIMIT", () => {
    const parsed = QueryIntentSchema.safeParse({ collection: "people", limit: 10_000 });
    expect(parsed.success).toBe(true);
    const { text } = buildSelect("dev", parsed.data as QueryIntent, ["id"]);
    expect(text).toContain("limit 500");
  });

  it("clamps a zero or negative limit up to 1 rather than emitting it", () => {
    for (const limit of [0, -5]) {
      const parsed = QueryIntentSchema.safeParse({ collection: "people", limit });
      expect(parsed.success).toBe(true);
      const { text } = buildSelect("dev", parsed.data as QueryIntent, ["id"]);
      expect(text).toContain("limit 1");
    }
  });
});

// Unknown keys are dropped rather than refused, and that is the invariant: §10 test 5 forges
// `env: "live"` into tool arguments and requires the call to succeed against dev, because the
// value has no code path that reads it. See the note at the top of intents/schema.ts.
it("ignores an unknown key rather than refusing the intent", () => {
  const parsed = QueryIntentSchema.safeParse({
    collection: "people", fields: ["id"], env: "live", userId: "someone-else",
  });
  expect(parsed.success).toBe(true);
  expect(parsed.data).toEqual({ collection: "people", fields: ["id"] });
});
