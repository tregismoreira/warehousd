import type { ApplyStatus } from "@/lib/apply-status";
import type { Posture } from "@/components/common/PostureBadge";

// The shapes /api/admin/collections and /api/admin/collections/[name] answer with. Declared once
// so the list and the detail cannot disagree about what a field is.

export type ViewJoin = { table: string; column: string; on: string };

export type Field = {
  name: string;
  type: string | null;
  posture: Posture;
  pk: boolean;
  fk: string | null;
  view_join: ViewJoin | null;
  relation: { collection: string; on: string | null; fields: string[] } | null;
  nullable: boolean;
  searchable: boolean;
};

export type CollectionSummary = {
  name: string;
  description: string;
  type: "dataset" | "file";
  taxonomies: string[];
  status: ApplyStatus;
  appliedAt: string | null;
  fields: Field[];
  /**
   * null when nothing has been applied to this environment — not the same as zero.
   *
   * Only present when the request asked for counts (`?counts=1`), which the list does and the
   * endpoint's three other callers deliberately do not. Typed as required because the list is
   * the only consumer of this shape.
   */
  documentCount: number | null;
};

export type VocabularySource = { collection: string; slug: string; label: string };

export type BoundVocabulary = {
  field: string;
  label: string;
  multiple: boolean;
  source: VocabularySource | null;
  /** false when the vocabulary is declared in warehousd.yml but has never been applied. */
  applied: boolean;
  terms: { slug: string; label: string; documentCount: number }[];
};

/** The caller's own approved grant on this collection, in this environment. */
export type MyGrant = {
  id: string;
  allowedFields: string[];
  verbs: string[];
  documentFilter: { field: string; op: string; value: unknown }[] | null;
  expiresAt: string | null;
};

export type CollectionDetail = {
  name: string;
  description: string;
  type: "dataset" | "file";
  writable: boolean;
  /** `acl: true` in warehousd.yml — the collection carries per-document ACLs. */
  acl: boolean;
  status: ApplyStatus;
  appliedAt: string | null;
  env: "dev" | "live";
  documentCount: number | null;
  fields: Field[];
  taxonomies: BoundVocabulary[];
  /** The broker's own FILTER_OPS, served by the route so the browser never imports the broker. */
  filterOps: string[];
  grant: MyGrant | null;
};

export type FileRow = {
  id: string;
  checksum: string;
  documentCount: number;
  title?: string | null;
  path?: string;
  owner?: string | null;
  updated_at?: string;
};
