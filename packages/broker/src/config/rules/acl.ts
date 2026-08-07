import type { CollectionRule } from "./types";

// Per-document ACLs. Each refusal here is a shape v1 has no answer for, refused while the author
// is looking at the file rather than as a broken join at apply time.
//
// One rule, not three: the branches are an if/else chain on purpose. A file collection with
// `acl: true` and no pk has one problem — it is a file collection — and reporting the missing pk
// alongside it would send the author to add a key the file kind cannot carry.
export const aclPreconditions: CollectionRule = {
  id: "acl/preconditions",
  check(c, ctx) {
    if (!c.acl) return;
    // A file collection's documents are chunks of a file, so an ACL would have to key on `file_id`
    // rather than a declared pk, add a second join to the file branch of viewDDL, and settle what
    // the indexer's write path does with one. Out of scope for v1 — see docs/architecture.md,
    // "Per-document ACLs".
    if (c.type === "file")
      ctx.addIssue({
        code: "custom",
        message: `acl: true is not supported on a file collection — an ACL is keyed on the declared primary key, and a file collection declares none`,
      });
    // An external collection's rows live in someone else's database. There is no local base table
    // to join an ACL against, and its view has no org_id column to carry the tenant half of the
    // join predicate.
    else if (c.source_ref)
      ctx.addIssue({
        code: "custom",
        message: `acl: true is not supported on a source_ref collection — warehousd does not own those rows`,
      });
    else if (!Object.values(c.fields).some((f) => f.pk))
      ctx.addIssue({
        code: "custom",
        message: `acl: true requires a field with pk: true — an ACL is keyed on document identity`,
      });
  },
};

export const ACL_RULES: CollectionRule[] = [aclPreconditions];
