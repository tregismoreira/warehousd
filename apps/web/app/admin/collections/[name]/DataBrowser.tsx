"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { History, KeyRound, Loader2, Plus, Search, Table2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable } from "@/components/common/DataTable";
import { EmptyState } from "@/components/common/EmptyState";
import { Mono } from "@/components/common/Mono";
import { cn } from "@/lib/utils";
import { requestJson } from "@/lib/client-api";
import type { CollectionDetail, Field } from "../types";

type Row = Record<string, unknown>;
type Filter = { field: string; op: string; value: string };

/** One asked-for read. Held as a value so React's dependency list is the truth about it. */
type RunSpec = {
  fields: string[];
  filters: { field: string; op: string; value: unknown }[];
  orderBy: string;
  orderDir: "asc" | "desc";
  limit: number;
  offset: number;
  /** Non-empty only for a file collection's full-text search, which is a different verb. */
  q: string;
};

// Search and query are different broker verbs, not one verb with a flag: search ranks documents
// by relevance and takes no filters or ordering, so a spec carrying `q` goes to the other route.
function requestFor(
  collection: string,
  type: "dataset" | "file",
  spec: RunSpec,
): Promise<Response> {
  const base = `/api/collections/${encodeURIComponent(collection)}`;
  if (type === "file" && spec.q) {
    const qs = new URLSearchParams({
      q: spec.q,
      limit: String(spec.limit),
      offset: String(spec.offset),
    });
    for (const f of spec.fields) qs.append("fields", f);
    return fetch(`${base}/search?${qs}`);
  }
  return fetch(`${base}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fields: spec.fields,
      filters: spec.filters,
      ...(spec.orderBy ? { orderBy: { field: spec.orderBy, dir: spec.orderDir } } : {}),
      limit: spec.limit,
      offset: spec.offset,
    }),
  });
}

// The BrokerResult union, as the console routes hand it back verbatim.
type Result =
  | { ok: true; documents: Row[]; fieldsReturned: string[]; auditId: string | null }
  | { ok: false; reason: string; auditId: string | null };

const LIMITS = [25, 50, 100] as const;

// Three states a field can be in, and the whole reason this browser exists rather than a generic
// SQL console: deny-by-default is invisible until you can see what you are *not* being shown.
type Access = "granted" | "grantable" | "denied";

function accessOf(field: Field, granted: string[]): Access {
  if (field.posture.read !== "allow") return "denied";
  return granted.includes(field.name) ? "granted" : "grantable";
}

const ACCESS_LABEL: Record<Access, string> = {
  granted: "granted",
  grantable: "grantable, not granted",
  denied: "denied by posture",
};

/**
 * Browse a collection's actual documents, through the broker and nobody else.
 *
 * Every request here goes to /api/collections/[c]/query or /search with the console session's own
 * context, so an admin sees exactly what their own grants allow and each page of results writes
 * one audit row. There is deliberately no console-only read path: the broker stays the only
 * reader of collection tables, and no refusal semantics exist here that do not exist for an MCP
 * client asking the same question.
 */
export function DataBrowser({
  detail,
  onGrantChanged,
}: {
  detail: CollectionDetail;
  onGrantChanged: () => Promise<void>;
}) {
  const granted = useMemo(() => detail.grant?.allowedFields ?? [], [detail.grant]);
  const grantable = useMemo(
    () => detail.fields.filter((f) => f.posture.read === "allow").map((f) => f.name),
    [detail.fields],
  );

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Filter[]>([]);
  const [orderBy, setOrderBy] = useState("");
  const [orderDir, setOrderDir] = useState<"asc" | "desc">("asc");
  const [limit, setLimit] = useState<number>(25);
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [requesting, setRequesting] = useState(false);
  // The query that was actually asked for, frozen at the moment it was asked. Editing a filter
  // does not re-read: a read is an audited decision, so it happens when somebody asks for one.
  const [spec, setSpec] = useState<RunSpec | null>(null);

  useEffect(() => {
    setPicked(new Set(granted));
    setFilters([]);
    setOrderBy("");
    setSpec(null);
    setResult(null);
  }, [granted, detail.name, detail.env]);

  useEffect(() => {
    if (!spec) return;
    let cancelled = false;
    setLoading(true);

    void requestFor(detail.name, detail.type, spec)
      .then((r) => r.json())
      .then((body: Result) => {
        if (!cancelled) setResult(body);
      })
      .catch(() => {
        if (!cancelled) setResult({ ok: false, reason: "internal_error", auditId: null });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [spec, detail.name, detail.type]);

  function run() {
    setSpec({
      fields: granted.filter((f) => picked.has(f)),
      filters: filters.filter((f) => f.field).map(toIntentFilter),
      orderBy,
      orderDir,
      limit,
      offset: 0,
      q: detail.type === "file" ? search.trim() : "",
    });
  }

  // Paging moves the query that ran, not the form as it stands now: otherwise "Next" on a result
  // set would quietly run whatever had been typed since, and page 2 would not belong to page 1.
  function page(offset: number) {
    setSpec((s) => (s ? { ...s, offset } : s));
  }

  const offset = spec?.offset ?? 0;

  // One click, two existing actions, and the refusal decides what it meant. On dev the approve
  // leg succeeds and the documents are there on the next run; on live it comes back
  // self_approval_denied and the request is left pending for somebody else — which is the rule
  // working, not an error.
  async function requestAndApprove() {
    setRequesting(true);
    try {
      const asked = await requestJson<{ requestId: string }>("/api/grants", {
        method: "POST",
        body: JSON.stringify({
          action: "request",
          collection: detail.name,
          purposeLabel: "console browsing",
          purposeDetail: `Requested from the admin console's ${detail.name} data browser.`,
          fields: grantable,
        }),
      });
      if (!asked.ok) {
        toast.error("Request failed", { description: asked.error });
        return;
      }

      const approved = await requestJson("/api/grants", {
        method: "POST",
        body: JSON.stringify({
          action: "approve",
          id: asked.data.requestId,
          allowedFields: grantable,
        }),
      });
      if (approved.ok) {
        toast.success("Access granted", { description: `${detail.name} in ${detail.env}.` });
        await onGrantChanged();
        return;
      }

      if (approved.error === "self_approval_denied") {
        toast.info("Requested — awaiting another approver", {
          description: `A live grant cannot be approved by the person who asked for it. It is in the manager inbox.`,
        });
        return;
      }
      toast.error("Approval failed", { description: approved.error });
    } finally {
      setRequesting(false);
    }
  }

  const columns: ColumnDef<Row, unknown>[] = useMemo(() => {
    const cols = result?.ok ? result.fieldsReturned : [];
    const fieldCols: ColumnDef<Row, unknown>[] = cols.map((name) => ({
      id: name,
      header: name,
      accessorFn: (row: Row) => row[name],
      cell: ({ row }) => <Cell value={row.original[name]} />,
    }));

    // Revision history exists only for a document with a declared pk (a dataset collection) —
    // a file collection's identity is `path`, which has no revision history to link to.
    const pkField = detail.fields.find((f) => f.pk)?.name;
    if (!pkField) return fieldCols;

    const historyCol: ColumnDef<Row, unknown> = {
      id: "_history",
      header: "",
      cell: ({ row }) => {
        const docId = row.original[pkField];
        if (docId === null || docId === undefined) return null;
        // A primary key is a string or a number; a pk of any other declared type would still
        // need to round-trip through the URL, and JSON.stringify is the only safe way to do
        // that for a shape String() cannot be trusted to render meaningfully.
        const docIdStr =
          typeof docId === "string" || typeof docId === "number"
            ? String(docId)
            : JSON.stringify(docId);
        return (
          <Link
            href={`/admin/collections/${detail.name}/documents/${encodeURIComponent(docIdStr)}/history`}
            aria-label="Revision history"
            title="Revision history"
          >
            <History className="h-4 w-4" />
          </Link>
        );
      },
    };
    return [...fieldCols, historyCol];
  }, [result, detail.fields, detail.name]);

  if (!detail.grant)
    return (
      <EmptyState
        icon={KeyRound}
        title="No grant on this collection"
        description={`Deny-by-default: nothing is readable until a grant says so, not even for an admin. ${grantable.length} of ${detail.fields.length} fields are grantable here.`}
        action={
          <Button onClick={() => void requestAndApprove()} disabled={requesting}>
            {requesting && <Loader2 size={16} className="mr-2 animate-spin" />}
            Request &amp; approve access
          </Button>
        }
      />
    );

  return (
    <div className="space-y-4">
      <FieldLegend fields={detail.fields} granted={granted} />

      <div className="grid gap-4 rounded-lg border p-4">
        <div className="space-y-2">
          <Label>Fields</Label>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {detail.fields.map((f) => {
              const access = accessOf(f, granted);
              return (
                <label
                  key={f.name}
                  className={cn(
                    "flex items-center gap-2 font-mono text-xs",
                    access !== "granted" && "text-muted-foreground",
                  )}
                  title={ACCESS_LABEL[access]}
                >
                  <Checkbox
                    checked={picked.has(f.name)}
                    disabled={access !== "granted"}
                    onCheckedChange={(v) => {
                      const next = new Set(picked);
                      if (v) next.add(f.name);
                      else next.delete(f.name);
                      setPicked(next);
                    }}
                  />
                  <span className={cn(access === "denied" && "line-through")}>{f.name}</span>
                </label>
              );
            })}
          </div>
        </div>

        {detail.type === "file" && (
          <div className="space-y-2">
            <Label htmlFor="doc-search">Search</Label>
            <div className="relative">
              <Search
                size={16}
                className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="doc-search"
                placeholder="Full-text search across documents"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && run()}
                className="pl-8"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              With a search term the results are documents ranked by relevance, and filters and
              ordering do not apply — relevance is the order.
            </p>
          </div>
        )}

        <FilterBuilder
          fields={granted}
          ops={detail.filterOps}
          filters={filters}
          onChange={setFilters}
          disabled={detail.type === "file" && !!search.trim()}
        />

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <Label htmlFor="order-field">Order by</Label>
            <Select value={orderBy} onValueChange={setOrderBy}>
              <SelectTrigger id="order-field" className="w-48">
                <SelectValue placeholder="Unordered" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Unordered</SelectItem>
                {granted.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="order-dir">Direction</Label>
            <Select value={orderDir} onValueChange={(v) => setOrderDir(v as "asc" | "desc")}>
              <SelectTrigger id="order-dir" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">asc</SelectItem>
                <SelectItem value="desc">desc</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="page-size">Page size</Label>
            <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
              <SelectTrigger id="page-size" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIMITS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={() => run()} disabled={loading || picked.size === 0}>
            {loading && <Loader2 size={16} className="mr-2 animate-spin" />}
            Run query
          </Button>
        </div>
      </div>

      {result && !result.ok && <Refusal reason={result.reason} />}

      {(spec !== null || loading) && (
        <>
          <DataTable
            columns={columns}
            data={result?.ok ? result.documents : []}
            loading={loading}
            empty={
              <EmptyState
                icon={Table2}
                title="No documents"
                description="Nothing matched, or the grant's document filter excludes everything on this page."
              />
            }
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {result?.ok ? (
                <>
                  Documents {offset + 1}–{offset + result.documents.length} · audit{" "}
                  {/* Null once the deployment sets `audit.enabled: false`. Saying so beats an
                      empty space where an id used to be. */}
                  {result.auditId ? <Mono>{result.auditId}</Mono> : "disabled"}
                </>
              ) : (
                " "
              )}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0 || loading}
                onClick={() => page(Math.max(0, offset - limit))}
              >
                Previous
              </Button>
              {/* No total to page against: the broker answers a page, not a count, and asking
                  for one would be a second audited read of the same documents. A short page is
                  the last page. */}
              <Button
                variant="outline"
                size="sm"
                disabled={loading || !result?.ok || result.documents.length < limit}
                onClick={() => page(offset + limit)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FieldLegend({ fields, granted }: { fields: Field[]; granted: string[] }) {
  const counts = { granted: 0, grantable: 0, denied: 0 };
  for (const f of fields) counts[accessOf(f, granted)]++;
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-allow" />
        {counts.granted} granted
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-muted-foreground" />
        {counts.grantable} grantable, not granted
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-deny" />
        {counts.denied} denied by posture — never grantable
      </span>
    </div>
  );
}

function FilterBuilder({
  fields,
  ops,
  filters,
  onChange,
  disabled,
}: {
  fields: string[];
  ops: string[];
  filters: Filter[];
  onChange: (f: Filter[]) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label>Filters</Label>
      {disabled ? (
        <p className="text-xs text-muted-foreground">
          Not applied while a search term is set — search returns documents ranked by relevance.
        </p>
      ) : (
        <>
          {filters.map((f, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Select
                value={f.field}
                onValueChange={(v) => onChange(replace(filters, i, { ...f, field: v }))}
              >
                <SelectTrigger aria-label={`Filter ${i + 1} field`} className="w-48">
                  <SelectValue placeholder="Field" />
                </SelectTrigger>
                <SelectContent>
                  {fields.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={f.op}
                onValueChange={(v) => onChange(replace(filters, i, { ...f, op: v }))}
              >
                <SelectTrigger aria-label={`Filter ${i + 1} operator`} className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ops.map((op) => (
                    <SelectItem key={op} value={op}>
                      {op}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                aria-label={`Filter ${i + 1} value`}
                placeholder={f.op === "in" ? "comma, separated, values" : "value"}
                value={f.value}
                onChange={(e) => onChange(replace(filters, i, { ...f, value: e.target.value }))}
                className="w-56"
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove filter ${i + 1}`}
                onClick={() => onChange(filters.filter((_, j) => j !== i))}
              >
                <Trash2 size={16} />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={fields.length === 0}
            onClick={() =>
              onChange([...filters, { field: fields[0] ?? "", op: ops[0] ?? "eq", value: "" }])
            }
          >
            <Plus size={16} className="mr-2" />
            Add filter
          </Button>
        </>
      )}
    </div>
  );
}

// The reason codes the console can meet here, spelled out. `no_grant` is handled above as an
// empty state rather than an error — it is the expected state of a collection nobody asked for.
const REASONS: Record<string, string> = {
  expired_grant: "The grant on this collection has expired. Ask for a new one.",
  field_denied: "The grant does not cover one of the fields in that query.",
  unknown_field: "That query names a field this collection does not have.",
  invalid_intent: "The broker could not make sense of that query. Check the filter values.",
  internal_error: "Something failed on the way to the database. The decision was still audited.",
  no_grant: "The grant on this collection is gone. Reload the page.",
};

function Refusal({ reason }: { reason: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-deny/30 bg-deny/5 p-3 text-sm">
      <Badge variant="outline" className="font-mono text-xs text-deny">
        {reason}
      </Badge>
      <span className="text-muted-foreground">
        {REASONS[reason] ?? "The broker refused that query."}
      </span>
    </div>
  );
}

// Everything on this side of the wire came back through JSON, so a value is a string, a number,
// a boolean, or a structure — a `multiple` vocabulary's text[] arrives as an array, a json column
// as an object. Narrowed rather than String()'d, or an object renders as "[object Object]".
function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(display).join(", ");
  return JSON.stringify(value);
}

function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined)
    return <span className="text-xs text-muted-foreground">null</span>;
  const text = display(value);
  // Anything that was not prose to begin with reads as data, and mono says so.
  if (typeof value !== "string") return <Mono className="text-muted-foreground">{text}</Mono>;
  return (
    <span className="block max-w-md truncate text-sm" title={text}>
      {text}
    </span>
  );
}

function replace<T>(list: T[], index: number, next: T): T[] {
  return list.map((x, i) => (i === index ? next : x));
}

// `in` takes a list; everything else takes one value. Numbers and booleans are converted so a
// numeric comparison is a numeric comparison — Postgres will not compare `text` to `numeric`,
// and the refusal that produces reads as the console's fault rather than the value's.
function toIntentFilter(f: Filter): { field: string; op: string; value: unknown } {
  if (f.op === "in")
    return {
      field: f.field,
      op: f.op,
      value: f.value
        .split(",")
        .map((v) => coerce(v.trim()))
        .filter((v) => v !== ""),
    };
  return { field: f.field, op: f.op, value: coerce(f.value) };
}

function coerce(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}
