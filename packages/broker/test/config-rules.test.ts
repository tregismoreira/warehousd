import { describe, it, expect } from "vitest";
import type { z } from "zod";
import { ConfigSchema, type RawCollection } from "../src/config/schema";
import { collectionRules, runCollectionRules, type CollectionRule } from "../src/config/rules";
import { fieldNameShape, aclColumnReserved } from "../src/config/rules/fields";
import { taxonomyFieldType, taxonomyFieldConstraints } from "../src/config/rules/taxonomy";
import { viewJoinTarget, viewJoinWriteDeny } from "../src/config/rules/view-join";
import {
  fileRequiresSource,
  fileMetadataFieldType,
  fileMetadataFieldConstraints,
} from "../src/config/rules/file";
import { datasetFieldRequiresType } from "../src/config/rules/dataset";
import {
  searchableNotOnFile,
  searchableTextOnly,
  searchableTsvCollision,
} from "../src/config/rules/searchable";
import { writableRequiresWritableField } from "../src/config/rules/writable";
import { aclPreconditions } from "../src/config/rules/acl";
import {
  sourceRefNotOnFile,
  sourceRefHasNoSourceDir,
  sourceRefNotWritable,
  sourceRefNoViewJoin,
  sourceRefNoSearchable,
  columnRequiresSourceRef,
} from "../src/config/rules/source-ref";
import {
  importColumnTargetExists,
  importColumnTargetStorable,
  importColumnTargetUnique,
  importNotOnFile,
} from "../src/config/rules/import";
import {
  maskRequiresTransform,
  transformRequiresMaskPosture,
  unmaskRequiresMaskPosture,
  pkNotMaskable,
  searchableNotMaskable,
  fileContentPathNotMaskable,
  maskTransformType,
} from "../src/config/rules/mask";

// The point of the registry: a rule is exercised by calling it, with the smallest collection that
// makes it fire, and without parsing a whole config to get there. Before this, every one of these
// assertions had to go through `ConfigSchema.parse` on a complete document.

function coll(over: Partial<RawCollection> = {}): RawCollection {
  return {
    description: "a collection",
    type: "dataset",
    taxonomies: [],
    acl: false,
    fields: {},
    ...over,
  };
}

function messagesFrom(rule: CollectionRule, c: RawCollection): string[] {
  const messages: string[] = [];
  const ctx: z.RefinementCtx = {
    value: c,
    issues: [],
    addIssue(arg) {
      messages.push(typeof arg === "string" ? arg : (arg.message ?? ""));
    },
  };
  rule.check(c, ctx);
  return messages;
}

/** Fires with a message containing `needle`. */
function fires(rule: CollectionRule, c: RawCollection, needle: string) {
  const m = messagesFrom(rule, c);
  expect(m.join("\n")).toContain(needle);
}

/** Says nothing at all. */
function silent(rule: CollectionRule, c: RawCollection) {
  expect(messagesFrom(rule, c)).toEqual([]);
}

describe("field rules", () => {
  it("field/name-shape refuses a name that is not an identifier", () => {
    fires(fieldNameShape, coll({ fields: { "bad-name": { posture: "allow" } } }), "invalid");
    silent(fieldNameShape, coll({ fields: { good_name: { posture: "allow" } } }));
  });

  it("field/acl-reserved refuses a field called _acl", () => {
    fires(aclColumnReserved, coll({ fields: { _acl: { posture: "allow" } } }), "reserved");
    silent(aclColumnReserved, coll({ fields: { acl: { posture: "allow" } } }));
  });
});

describe("taxonomy rules", () => {
  it("taxonomy/field-type wants text", () => {
    const c = coll({
      taxonomies: ["dept"],
      fields: { dept: { type: "int", posture: "allow" } },
    });
    fires(taxonomyFieldType, c, "must be type text");
    silent(
      taxonomyFieldType,
      coll({ taxonomies: ["dept"], fields: { dept: { posture: "allow" } } }),
    );
  });

  it("taxonomy/field-constraints refuses pk/fk/view_join", () => {
    const c = coll({
      taxonomies: ["dept"],
      fields: { dept: { type: "text", posture: "allow", pk: true } },
    });
    fires(taxonomyFieldConstraints, c, "may not set pk/fk/view_join");
  });

  it("both taxonomy rules ignore a vocabulary with no bound field", () => {
    const c = coll({ taxonomies: ["dept"], fields: {} });
    silent(taxonomyFieldType, c);
    silent(taxonomyFieldConstraints, c);
  });
});

describe("view_join rules", () => {
  const withJoin = (on: string, table: string, fields: RawCollection["fields"] = {}) =>
    coll({
      fields: {
        attorney_name: { type: "text", posture: "allow", view_join: { table, column: "n", on } },
        ...fields,
      },
    });

  it("view-join/target-field refuses an unknown `on` field", () => {
    fires(viewJoinTarget, withJoin("missing", "people"), "unknown field");
  });

  it("view-join/target-field refuses an `on` field with no fk", () => {
    fires(
      viewJoinTarget,
      withJoin("owner_id", "people", { owner_id: { type: "uuid", posture: "allow" } }),
      "does not have fk",
    );
  });

  it("view-join/target-field refuses an fk pointing at another table", () => {
    fires(
      viewJoinTarget,
      withJoin("owner_id", "people", {
        owner_id: { type: "uuid", posture: "allow", fk: "matters.id" },
      }),
      "but field",
    );
  });

  it("view-join/target-field accepts a resolving join", () => {
    silent(
      viewJoinTarget,
      withJoin("owner_id", "people", {
        owner_id: { type: "uuid", posture: "allow", fk: "people.id" },
      }),
    );
  });

  it("view-join/write-deny refuses write: allow on a joined field", () => {
    const c = coll({
      fields: {
        attorney_name: {
          type: "text",
          posture: { read: "allow", write: "allow", unmask: "deny" },
          view_join: { table: "people", column: "n", on: "owner_id" },
        },
      },
    });
    fires(viewJoinWriteDeny, c, "always write-deny");
  });
});

describe("file rules", () => {
  it("file/requires-source", () => {
    fires(fileRequiresSource, coll({ type: "file" }), "requires `source`");
    silent(fileRequiresSource, coll({ type: "file", source: "./docs" }));
    silent(fileRequiresSource, coll({ type: "dataset" }));
  });

  it("file/metadata-field-type refuses an untyped or wrongly typed extra field", () => {
    const c = coll({ type: "file", source: "./d", fields: { matter: { posture: "allow" } } });
    fires(fileMetadataFieldType, c, "must have type");
    silent(
      fileMetadataFieldType,
      coll({ type: "file", source: "./d", fields: { matter: { type: "text", posture: "allow" } } }),
    );
  });

  it("file/metadata-field-type leaves FILE_FIELDS and bound vocabularies alone", () => {
    silent(
      fileMetadataFieldType,
      coll({
        type: "file",
        source: "./d",
        taxonomies: ["dept"],
        fields: { title: { posture: "allow" }, dept: { posture: "allow" } },
      }),
    );
  });

  it("file/metadata-field-constraints refuses pk on metadata", () => {
    const c = coll({
      type: "file",
      source: "./d",
      fields: { matter: { type: "text", posture: "allow", pk: true } },
    });
    fires(fileMetadataFieldConstraints, c, "cannot have pk/fk/view_join");
  });
});

describe("dataset rules", () => {
  it("dataset/field-requires-type", () => {
    fires(
      datasetFieldRequiresType,
      coll({ fields: { name: { posture: "allow" } } }),
      "requires a type",
    );
    silent(
      datasetFieldRequiresType,
      coll({ fields: { name: { type: "text", posture: "allow" } } }),
    );
    // A bound term field gets its type from the transform.
    silent(
      datasetFieldRequiresType,
      coll({ taxonomies: ["dept"], fields: { dept: { posture: "allow" } } }),
    );
    silent(
      datasetFieldRequiresType,
      coll({ type: "file", fields: { title: { posture: "allow" } } }),
    );
  });
});

describe("searchable rules", () => {
  it("searchable/not-on-file", () => {
    const c = coll({
      type: "file",
      source: "./d",
      fields: { content: { type: "text", posture: "allow", searchable: true } },
    });
    fires(searchableNotOnFile, c, "redundant");
  });

  it("searchable/text-only", () => {
    fires(
      searchableTextOnly,
      coll({ fields: { n: { type: "int", posture: "allow", searchable: true } } }),
      "not type text",
    );
    silent(
      searchableTextOnly,
      coll({ fields: { n: { type: "text", posture: "allow", searchable: true } } }),
    );
  });

  it("searchable/tsv-collision", () => {
    const c = coll({
      fields: {
        body: { type: "text", posture: "allow", searchable: true },
        body_tsv: { type: "text", posture: "allow" },
      },
    });
    fires(searchableTsvCollision, c, "collides");
  });
});

describe("writable rules", () => {
  it("writable/requires-writable-field", () => {
    fires(
      writableRequiresWritableField,
      coll({ writable: true, fields: { a: { type: "text", posture: "allow" } } }),
      "no field with write:allow",
    );
    silent(
      writableRequiresWritableField,
      coll({
        writable: true,
        fields: { a: { type: "text", posture: { read: "allow", write: "allow", unmask: "deny" } } },
      }),
    );
    silent(writableRequiresWritableField, coll({ fields: {} }));
  });
});

describe("acl rules", () => {
  it("acl/preconditions refuses a file collection", () => {
    fires(aclPreconditions, coll({ acl: true, type: "file", source: "./d" }), "file collection");
  });

  it("acl/preconditions refuses a source_ref collection", () => {
    const c = coll({ acl: true, source_ref: { source: "hr", table: "people", org: "default" } });
    fires(aclPreconditions, c, "source_ref collection");
  });

  it("acl/preconditions requires a pk", () => {
    fires(aclPreconditions, coll({ acl: true, fields: {} }), "requires a field with pk: true");
    silent(
      aclPreconditions,
      coll({ acl: true, fields: { id: { type: "uuid", posture: "allow", pk: true } } }),
    );
  });

  // The branches are an if/else chain on purpose: a file collection has one problem, and naming
  // the missing pk alongside it would send the author to add a key the file kind cannot carry.
  it("acl/preconditions reports one reason, not three", () => {
    const c = coll({ acl: true, type: "file", source: "./d", fields: {} });
    expect(messagesFrom(aclPreconditions, c)).toHaveLength(1);
  });
});

describe("source_ref rules", () => {
  const ref = { source: "hr", table: "people", org: "default" };

  it("source-ref/not-on-file", () => {
    fires(sourceRefNotOnFile, coll({ type: "file", source_ref: ref }), "dataset collections");
  });

  it("source-ref/no-source-dir", () => {
    fires(
      sourceRefHasNoSourceDir,
      coll({ source_ref: ref, source: "./d" }),
      "no `source` directory",
    );
    fires(
      sourceRefHasNoSourceDir,
      coll({ source_ref: ref, source_live: "./d" }),
      "no `source` directory",
    );
    silent(sourceRefHasNoSourceDir, coll({ source_ref: ref }));
  });

  it("source-ref/not-writable", () => {
    fires(sourceRefNotWritable, coll({ source_ref: ref, writable: true }), "not supported");
  });

  it("source-ref/no-view-join", () => {
    const c = coll({
      source_ref: ref,
      fields: {
        n: { type: "text", posture: "allow", view_join: { table: "t", column: "c", on: "o" } },
      },
    });
    fires(sourceRefNoViewJoin, c, "joins are not resolved");
  });

  it("source-ref/no-searchable", () => {
    const c = coll({
      source_ref: ref,
      fields: { n: { type: "text", posture: "allow", searchable: true } },
    });
    fires(sourceRefNoSearchable, c, "remote table");
  });

  it("column/requires-source-ref only fires without one", () => {
    const f = { type: "text" as const, posture: "allow" as const, column: "full_name" };
    fires(columnRequiresSourceRef, coll({ fields: { name: f } }), "no remote column to rename");
    silent(columnRequiresSourceRef, coll({ source_ref: ref, fields: { name: f } }));
  });
});

describe("import rules", () => {
  const fields = { base_salary: { type: "numeric" as const, posture: "deny" as const } };

  it("import/column-target-exists", () => {
    fires(
      importColumnTargetExists,
      coll({ fields, import: { columns: { "Base Salary (USD)": "salary" } } }),
      'unknown field "salary"',
    );
    silent(
      importColumnTargetExists,
      coll({ fields, import: { columns: { "Base Salary (USD)": "base_salary" } } }),
    );
  });

  it("import/column-target-storable refuses a view_join target", () => {
    const c = coll({
      fields: {
        attorney: {
          type: "text",
          posture: "allow",
          view_join: { table: "people", column: "n", on: "o" },
        },
      },
      import: { columns: { Attorney: "attorney" } },
    });
    fires(importColumnTargetStorable, c, "no column to import into");
  });

  it("import/column-target-unique refuses two headers aiming at one field", () => {
    const c = coll({
      fields,
      import: { columns: { Salary: "base_salary", "Base Salary (USD)": "base_salary" } },
    });
    fires(importColumnTargetUnique, c, "maps both");
  });

  it("import/not-on-file", () => {
    fires(
      importNotOnFile,
      coll({ type: "file", source: "./d", import: { columns: {} } }),
      "dataset collections",
    );
    silent(importNotOnFile, coll({ type: "file", source: "./d" }));
  });
});

describe("mask rules", () => {
  const masked = (over: Record<string, unknown> = {}) => ({
    type: "text" as const,
    posture: { read: "mask" as const, write: "deny" as const, unmask: "deny" as const },
    mask: { transform: "redact" as const },
    ...over,
  });

  it("mask/requires-transform", () => {
    const c = coll({
      fields: {
        ssn: { type: "text", posture: { read: "mask", write: "deny", unmask: "deny" } },
      },
    });
    fires(maskRequiresTransform, c, "declare the transform");
  });

  it("mask/transform-requires-mask-posture", () => {
    const c = coll({
      fields: { ssn: { type: "text", posture: "allow", mask: { transform: "redact" } } },
    });
    fires(transformRequiresMaskPosture, c, "only applied under read: mask");
  });

  it("mask/unmask-requires-mask-posture reads the DECLARED posture", () => {
    const c = coll({
      fields: {
        ssn: { type: "text", posture: { read: "allow", write: "deny", unmask: "allow" } },
      },
    });
    fires(unmaskRequiresMaskPosture, c, "nothing to unmask");
  });

  it("mask/pk-not-maskable", () => {
    fires(pkNotMaskable, coll({ fields: { id: masked({ pk: true }) } }), "primary key");
    silent(pkNotMaskable, coll({ fields: { id: masked() } }));
  });

  it("mask/searchable-not-maskable", () => {
    fires(
      searchableNotMaskable,
      coll({ fields: { body: masked({ searchable: true }) } }),
      "indexes the raw value",
    );
  });

  it("mask/file-content-path-not-maskable", () => {
    const c = coll({ type: "file", source: "./d", fields: { content: masked() } });
    fires(fileContentPathNotMaskable, c, "cannot be masked");
    silent(fileContentPathNotMaskable, coll({ fields: { content: masked() } }));
  });

  it("mask/transform-type", () => {
    const c = coll({
      fields: { hired: masked({ type: "date", mask: { transform: "last4" } }) },
    });
    fires(maskTransformType, c, "needs type text");
    // redact and hash apply to any type, so they are absent from MASK_TYPES.
    silent(maskTransformType, coll({ fields: { hired: masked({ type: "date" }) } }));
  });
});

describe("the registry itself", () => {
  it("gives every rule a unique id", () => {
    const ids = collectionRules().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stamps the rule id onto every issue it raises", () => {
    const raised: Record<string, unknown>[] = [];
    const ctx: z.RefinementCtx = {
      value: undefined,
      issues: [],
      addIssue(arg) {
        if (typeof arg !== "string") raised.push({ ...arg });
      },
    };
    runCollectionRules(
      [aclColumnReserved],
      coll({ fields: { _acl: { type: "text", posture: "allow" } } }),
      ctx,
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.params).toEqual({ rule: "field/acl-reserved" });
  });

  it("carries the id through a real ConfigSchema.parse", () => {
    const r = ConfigSchema.safeParse({
      project: "p",
      collections: {
        people: {
          description: "d",
          fields: { _acl: { type: "text", posture: "allow" } },
        },
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('"rule":"field/acl-reserved"');
  });
});
