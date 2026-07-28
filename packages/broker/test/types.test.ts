import { describe, it, expect } from "vitest";
import type { QueryIntent, BrokerResult, BrokerContext } from "../src/types";

describe("types", () => {
  it("intent and result shapes are usable", () => {
    const ctx: BrokerContext = { userId: "u1", orgId: "default", env: "dev", via: "session" };
    const intent: QueryIntent = {
      collection: "salaries",
      filters: [{ field: "job_title", op: "eq", value: "Senior Accountant" }],
      aggregate: [{ fn: "avg", field: "base_salary" }],
      groupBy: ["job_title"],
      limit: 100,
    };
    const ok: BrokerResult = { ok: true, documents: [], fieldsReturned: [], auditId: "a" };
    expect(ctx.env).toBe("dev");
    expect(intent.collection).toBe("salaries");
    expect(ok.ok).toBe(true);
  });
});
