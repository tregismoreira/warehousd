import { kindOf } from "../kinds";
import type { CollectionRule } from "./types";

// Per-document ACLs. Each refusal here is a shape warehousd has no answer for, refused while the
// author is looking at the file rather than as a broken join at apply time.
//
// One rule, not two: the branches are an if/else chain on purpose. An external collection with no
// key has one problem — warehousd does not own its rows — and reporting the missing key alongside
// it would send the author to add one to a table they do not control.
export const aclPreconditions: CollectionRule = {
  id: "acl/preconditions",
  check(c, ctx) {
    if (!c.acl) return;
    // An external collection's rows live in someone else's database. There is no local base table
    // to join an ACL against, and its view has no workspace_id column to carry the tenant half of the
    // join predicate.
    if (c.source_ref)
      ctx.addIssue({
        code: "custom",
        message: `acl: true is not supported on a source_ref collection — warehousd does not own those rows`,
      });
    // Every kind that owns its rows has SOME column an ACL is keyed on: a dataset's declared
    // primary key, a file collection's `path`. A dataset with no pk has no document identity, so
    // there is nothing to address a policy to.
    else if (!kindOf(c).aclKeyField(c))
      ctx.addIssue({
        code: "custom",
        message: `acl: true requires a field with pk: true — an ACL is keyed on document identity`,
      });
  },
};

export const ACL_RULES: CollectionRule[] = [aclPreconditions];
