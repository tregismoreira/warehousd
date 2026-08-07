import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectionKinds, kindOf, COLLECTION_KIND_IDS } from "../src/config/kinds";
import { collectionRules } from "../src/config/rules";
import { ConfigSchema, type CollectionConfig } from "../src/config/schema";

// §D. `type: "dataset" | "file"` was branched on in 26 files, so a third kind meant finding forty
// branches and getting every one right — and the cost of missing one is not uniform: miss the
// branch in import/validate.ts and you get a write path with no validation.

const cfg = ConfigSchema.parse({
  project: "test",
  collections: {
    people: {
      description: "d",
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        name: { type: "text", posture: { read: "allow", write: "allow" }, searchable: true },
      },
    },
    plain: {
      description: "d",
      fields: { id: { type: "uuid", posture: "allow", pk: true } },
    },
    policies: {
      description: "d",
      type: "file",
      source: "./docs",
      writable: true,
      fields: {
        title: { posture: "allow" },
        content: { posture: { read: "allow", write: "allow" } },
        path: { posture: "allow" },
      },
    },
  },
});

const people = cfg.collections.people!;
const plain = cfg.collections.plain!;
const policies = cfg.collections.policies!;

describe("the registry is the only place a kind is named", () => {
  it("registers every declared id, and nothing else", () => {
    expect(Object.keys(collectionKinds).sort()).toEqual([...COLLECTION_KIND_IDS].sort());
    for (const [id, kind] of Object.entries(collectionKinds)) expect(kind.id).toBe(id);
  });

  it("folds every kind's rules into the rule registry", () => {
    const ids = new Set(collectionRules().map((r) => r.id));
    for (const kind of Object.values(collectionKinds))
      for (const rule of kind.rules) expect(ids.has(rule.id)).toBe(true);
  });

  it("falls back to dataset for a type the schema would have defaulted", () => {
    // A hand-built config object that never went through the schema. Landing on `dataset` is what
    // the schema's own default would have done.
    expect(kindOf({ type: "nope" } as unknown as CollectionConfig).id).toBe("dataset");
  });
});

describe("supportedVerbs is structural", () => {
  it("a file collection only ever supports create", () => {
    // It is a record of what was INGESTED and only ever grows. No grant can make it revisable.
    expect(collectionKinds.file.supportedVerbs(policies)).toEqual(["create"]);
  });

  it("a dataset supports all three", () => {
    expect(collectionKinds.dataset.supportedVerbs(people)).toEqual(["create", "update", "delete"]);
  });

  it("neither supports anything without writable: true", () => {
    expect(collectionKinds.dataset.supportedVerbs(plain)).toEqual([]);
  });
});

describe("documentKey", () => {
  it("a file is addressed by path or file_id", () => {
    expect(
      kindOf(policies).documentKey(policies, { collection: "policies", path: "a.md" }),
    ).toEqual({ field: "path", op: "eq", value: "a.md" });
    expect(kindOf(policies).documentKey(policies, { collection: "policies", id: "f1" })).toEqual({
      field: "file_id",
      op: "eq",
      value: "f1",
    });
  });

  it("a dataset is addressed by its declared pk", () => {
    expect(kindOf(people).documentKey(people, { collection: "people", id: "p1" })).toEqual({
      field: "id",
      op: "eq",
      value: "p1",
    });
  });

  it("is null where the kind cannot address what the intent describes", () => {
    // A path against a dataset — there is no source file to name.
    expect(kindOf(people).documentKey(people, { collection: "people", path: "a.md" })).toBeNull();
    const noPk = ConfigSchema.parse({
      project: "t",
      collections: { t: { description: "d", fields: { a: { type: "text", posture: "allow" } } } },
    }).collections.t!;
    expect(kindOf(noPk).documentKey(noPk, { collection: "t", id: "x" })).toBeNull();
  });
});

describe("searchable", () => {
  it("a file collection always matches, over the generated tsv column", () => {
    expect(kindOf(policies).searchable(policies)).toEqual({ mode: "tsv", fields: [] });
  });

  it("a dataset matches only the fields that asked for it", () => {
    expect(kindOf(people).searchable(people)).toEqual({ mode: "fields", fields: ["name"] });
  });

  it("a dataset with none cannot be searched at all", () => {
    // Null rather than an empty field list: an empty result set reads as "nothing matched", which
    // is a different and wrong answer.
    expect(kindOf(plain).searchable(plain)).toBeNull();
  });
});

describe("identity and shape", () => {
  it("a file has no primary key and is addressed by path", () => {
    expect(kindOf(policies).pkField(policies)).toBeNull();
    expect(kindOf(policies).identityField(policies)).toBe("path");
  });

  it("a dataset's identity is its pk", () => {
    expect(kindOf(people).pkField(people)).toBe("id");
    expect(kindOf(people).identityField(people)).toBe("id");
  });

  it("only the chunked kind is chunked, and only the row kind is synthesisable", () => {
    expect(collectionKinds.file.chunked).toBe(true);
    expect(collectionKinds.file.synthesisable).toBe(false);
    expect(collectionKinds.dataset.chunked).toBe(false);
    expect(collectionKinds.dataset.synthesisable).toBe(true);
  });
});

describe("the DDL half is per kind", () => {
  it("a file collection builds two tables, a dataset one", () => {
    expect(
      kindOf(policies)
        .ddl.declaredTables("policies", cfg)
        .map((t) => t.table),
    ).toEqual(["policies__files", "policies__documents"]);
    expect(
      kindOf(people)
        .ddl.declaredTables("people", cfg)
        .map((t) => t.table),
    ).toEqual(["people"]);
  });

  it("the org-isolation policy lands on every table the kind stores rows in", () => {
    expect(kindOf(policies).ddl.rlsTables("data_synth", "policies")).toEqual([
      'data_synth."policies__files"',
      'data_synth."policies__documents"',
    ]);
    expect(kindOf(people).ddl.rlsTables("data_synth", "people")).toEqual(["data_synth.people"]);
  });

  it("the import role is never granted anything on a file collection", () => {
    // Files are populated by the indexer under the owner role, not by import.
    expect(kindOf(policies).ddl.grantImport("policies", cfg)).toBe("");
    expect(kindOf(people).ddl.grantImport("people", cfg)).toContain("warehousd_import");
  });
});

// The property the registry exists to create. A grep is a blunt instrument, but it is the only
// thing that catches the failure this refactor is about: a new branch on a kind id somewhere the
// registry does not know about.
describe("nothing outside the registry branches on a kind id", () => {
  const SRC = new URL("../src/", import.meta.url).pathname;

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  }

  it("only the kind registry and each kind's own rules mention the literal", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (!file.endsWith(".ts")) continue;
      const rel = file.slice(SRC.length);
      // The registry itself, and the rule modules — a rule for a kind guards on that kind, which
      // is what lets it be read on its own and handed to the kind that owns it.
      if (rel.startsWith("config/kinds/") || rel.startsWith("config/rules/")) continue;
      const body = readFileSync(file, "utf8");
      // config/schema.ts's transform fills a file collection's field types before any kind exists
      // to ask — it is the schema normalising its own output, not a behavioural branch.
      const lines = body.split("\n").filter((l) => /type\s*[!=]==\s*"file"/.test(l));
      const remaining = rel === "config/schema.ts" ? [] : lines;
      if (remaining.length) offenders.push(`${rel}: ${remaining.join(" | ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
