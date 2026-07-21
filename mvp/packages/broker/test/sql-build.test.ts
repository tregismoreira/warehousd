import { describe, it, expect } from "vitest";
import { buildSelect } from "../src/sql/build";
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

it("ANDs rowFilter into where with parameterized values", () => {
  const { text, values } = buildSelect("dev", { collection: "policies", fields: ["title"] },
    ["title", "content"], { rowFilter: { field: "path", op: "in", value: ["hr/pto.md", "hr/benefits.md"] } });
  expect(text).toContain(`"path" in ($1, $2)`);
  expect(values).toEqual(["hr/pto.md", "hr/benefits.md"]);
});

it("empty in-list compiles to constant false, not a SQL error (design test 8)", () => {
  const { text } = buildSelect("dev", { collection: "policies", fields: ["title"] },
    ["title"], { rowFilter: { field: "path", op: "in", value: [] } });
  expect(text).toContain("false");
  expect(text).not.toContain("in ()");
});
