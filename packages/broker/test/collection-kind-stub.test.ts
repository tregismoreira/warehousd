import { describe, it, expect } from "vitest";
import { collectionKinds, kindOf, kindRules, type CollectionKind } from "../src/config/kinds";
import { collectionRules } from "../src/config/rules";
import { supportedVerbs } from "../src/config/load";
import type { CollectionConfig, WarehousdConfig } from "../src/config/schema";

// §D's actual claim, tested rather than asserted: **a third kind is a registry entry and nothing
// else.**
//
// The refactor's whole justification was that `type: "dataset" | "file"` was branched on in 26
// files, so a mailbox or a Drive mirror meant finding forty branches. A test that only checks the
// two kinds we happen to have does not test that at all — it would pass just as well against the
// forty branches. So this file registers a kind that does not exist in `src/`, drives the code
// paths a real one goes through, and touches nothing under `verbs/`, `apply/` or
// `config/schema.ts`.
//
// A REAL third kind edits two files, both inside `config/kinds/`: its own module, and the id list
// in `kinds/ids.ts` that `z.enum` reads at module-evaluation time. A test cannot re-evaluate the
// schema module, so the id list is where the demonstration stops — everything past the parse is
// exercised below.
//
// **Registered at module scope, before anything parses a config.** `collectionRules()` memoises on
// first use, and a stub registered after that first call would be invisible to it — which is the
// one thing this file is here to prove is not the case.

const stubRuleId = "mailbox/stub-rule";

const mailboxKind: CollectionKind = {
  id: "mailbox",
  rules: [{ id: stubRuleId, check: () => {} }],
  // Deliberately unlike either existing kind: append-only, addressed by `message_id`, searched
  // over a fixed column. If any of these came back as the dataset's answer, something outside the
  // registry is still deciding.
  supportedVerbs: () => ["create"],
  documentKey: (_c, intent) =>
    "id" in intent ? { field: "message_id", op: "eq", value: intent.id } : null,
  searchable: () => ({ mode: "tsv", fields: ["body"] }),
  chunked: true,
  synthesisable: false,
  pkField: () => null,
  identityField: () => "message_id",
  aclKeyField: () => "message_id",
  ddl: {
    table: (env, collection) => `create table ${env}_${collection}_mailbox ();`,
    view: (env, collection) => `create view ${env}_${collection}_v as select 1;`,
    rlsTables: (schema, collection) => [`${schema}.${collection}_mailbox`],
    grantImport: () => "",
    grantWrite: (schema, role, collection) => `grant insert on ${schema}.${collection} to ${role};`,
    declaredTables: () => [],
  },
};

// The one line a new kind adds. `collectionKinds` is a plain object literal, so this is the same
// edit `kinds/index.ts` makes — made from here to prove nothing else has to change with it.
(collectionKinds as Record<string, CollectionKind>).mailbox = mailboxKind;

const mailbox = {
  type: "mailbox",
  description: "d",
  writable: true,
  taxonomies: [],
  acl: false,
  fields: { message_id: { type: "text", posture: "allow" }, body: { type: "text" } },
} as unknown as CollectionConfig;

describe("a kind that exists only in this test", () => {
  it("resolves through the registry", () => {
    expect(kindOf(mailbox)).toBe(mailboxKind);
    expect(kindOf(mailbox).id).toBe("mailbox");
  });

  it("contributes its rules to the shared rule registry", () => {
    expect(kindRules().map((r) => r.id)).toContain(stubRuleId);
    // And through the memoised list the schema walks, not only through the getter.
    expect(collectionRules().map((r) => r.id)).toContain(stubRuleId);
  });

  it("decides its own verb support through the shared helper, with no edit under verbs/", () => {
    // `dataset` would have said create+update+delete for a writable collection; `file` would have
    // said create. Asked through `supportedVerbs`, which is what mutate.ts and grants/manage.ts
    // call — so this is the answer the write path would get.
    const cfg = { collections: { inbox: mailbox } } as unknown as WarehousdConfig;
    expect(supportedVerbs(cfg, "inbox")).toEqual(["create"]);
  });

  it("decides how a document is addressed, with no edit under verbs/", () => {
    expect(kindOf(mailbox).documentKey(mailbox, { collection: "inbox", id: "m-1" })).toEqual({
      field: "message_id",
      op: "eq",
      value: "m-1",
    });
  });

  it("decides its own DDL and its own RLS surface, with no edit under apply/", () => {
    const kind = kindOf(mailbox);
    expect(kind.ddl.table("dev", "inbox", { collections: {} } as never)).toContain("_mailbox");
    expect(kind.ddl.rlsTables("data_dev", "inbox")).toEqual(["data_dev.inbox_mailbox"]);
  });

  it("declares its own identity and shape, with no edit under config/schema.ts", () => {
    const kind = kindOf(mailbox);
    expect(kind.pkField(mailbox)).toBeNull();
    expect(kind.identityField(mailbox)).toBe("message_id");
    expect(kind.aclKeyField(mailbox)).toBe("message_id");
    expect(kind.chunked).toBe(true);
    expect(kind.synthesisable).toBe(false);
    expect(kind.searchable(mailbox)).toEqual({ mode: "tsv", fields: ["body"] });
  });
});
