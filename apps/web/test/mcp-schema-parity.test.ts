import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  QueryIntentSchema,
  DocSearchIntentSchema,
  GetDocumentIntentSchema,
  MutationIntentSchema,
} from "@warehousd/broker";
import { toolByName, advertise } from "../lib/mcp-tools";

// No database — this suite checks that what mcp-tools.ts *advertises* still matches what it
// *enforces*, and it needs nothing but the schemas themselves for that.

type JsonObjectSchema = {
  type: "object";
  properties: Record<string, { enum?: unknown[] }>;
  required?: string[];
};

function enforcedShape(schema: z.ZodType): JsonObjectSchema {
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as JsonObjectSchema;
}

describe("mcp-schema-parity: derived tools match what the handler enforces", () => {
  const cases: { tool: string; schema: z.ZodType; omit?: string[] }[] = [
    // `after` is enforced but deliberately not advertised — see the rationale on the `omit` in
    // mcp-tools.ts. Named here for the same reason `op` is below: the omission is a decision, so
    // the parity check has to know about it or it reports a decision as drift.
    { tool: "query_collection", schema: QueryIntentSchema, omit: ["after"] },
    { tool: "search_documents", schema: DocSearchIntentSchema },
    { tool: "create_document", schema: MutationIntentSchema.options[0], omit: ["op"] },
    { tool: "update_document", schema: MutationIntentSchema.options[1], omit: ["op"] },
    { tool: "delete_document", schema: MutationIntentSchema.options[2], omit: ["op"] },
  ];

  for (const { tool, schema, omit } of cases) {
    it(`${tool}: advertised property keys, required, and enums match the enforced schema`, () => {
      const enforced = enforcedShape(schema);
      const omitSet = new Set(omit ?? []);
      const enforcedKeys = Object.keys(enforced.properties)
        .filter((k) => !omitSet.has(k))
        .sort();
      const enforcedRequired = (enforced.required ?? []).filter((k) => !omitSet.has(k)).sort();

      const advertised = toolByName(tool)!.inputSchema;
      expect(Object.keys(advertised.properties).sort()).toEqual(enforcedKeys);
      expect([...(advertised.required ?? [])].sort()).toEqual(enforcedRequired);

      for (const key of enforcedKeys) {
        const enforcedEnum = enforced.properties[key]?.enum;
        if (enforcedEnum) {
          const advertisedProp = advertised.properties[key] as { enum?: unknown[] };
          expect(advertisedProp.enum).toEqual(enforcedEnum);
        }
      }
    });
  }
});

describe("mcp-schema-parity: regression — offset", () => {
  // The bug this whole change exists to fix: query_collection and search_documents accepted
  // `offset` at the broker but never advertised it, so a model could not paginate.
  it("query_collection advertises offset", () => {
    expect(toolByName("query_collection")!.inputSchema.properties).toHaveProperty("offset");
  });

  it("search_documents advertises offset", () => {
    expect(toolByName("search_documents")!.inputSchema.properties).toHaveProperty("offset");
  });
});

describe("mcp-schema-parity: get_document exception", () => {
  it("advertised properties equal the union of both GetDocumentIntentSchema branches, required is exactly [collection]", () => {
    const branchKeys = new Set<string>();
    for (const branch of GetDocumentIntentSchema.options) {
      for (const key of Object.keys(enforcedShape(branch).properties)) branchKeys.add(key);
    }

    const advertised = toolByName("get_document")!.inputSchema;
    expect(new Set(Object.keys(advertised.properties))).toEqual(branchKeys);
    expect(advertised.required).toEqual(["collection"]);
  });
});

describe("mcp-schema-parity: description preservation", () => {
  // Checked in so a deletion fails loudly rather than the assertion silently narrowing to
  // whatever properties happen to still have one. Every entry here carried a description in
  // mcp-tools.ts before the derivation change (git show HEAD~N:apps/web/lib/mcp-tools.ts, the
  // commit before this file existed) and must still carry one now — offset is new, not preserved.
  const PROPERTIES_WITH_DESCRIPTIONS: Record<string, string[]> = {
    list_collections: [],
    describe_collection: [],
    query_collection: ["collection", "fields", "limit", "aggregate", "groupBy"],
    search_documents: ["collection", "mode"],
    get_document: ["collection", "id", "path"],
    create_document: ["values"],
    update_document: ["id", "values", "expect"],
    delete_document: ["id", "expect"],
    request_access: ["purpose", "fields"],
  };

  for (const [tool, properties] of Object.entries(PROPERTIES_WITH_DESCRIPTIONS)) {
    for (const property of properties) {
      it(`${tool}.${property} still has a description`, () => {
        const schema = toolByName(tool)!.inputSchema;
        const prop = schema.properties[property] as { description?: unknown } | undefined;
        expect(typeof prop?.description).toBe("string");
        expect((prop?.description as string).length).toBeGreaterThan(0);
      });
    }
  }
});

describe("mcp-schema-parity: advertise() throws on a stray description", () => {
  it("throws when given a description for a property that does not exist", () => {
    expect(() => advertise(MutationIntentSchema.options[0], { bogus: "nope" })).toThrow(/bogus/);
  });

  it("does not throw for a real property", () => {
    expect(() => advertise(MutationIntentSchema.options[0], { values: "ok" })).not.toThrow();
  });
});
