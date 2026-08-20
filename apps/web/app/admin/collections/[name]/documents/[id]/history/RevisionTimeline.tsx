"use client";

import { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { History, GitCompare } from "lucide-react";
import { DataTable } from "@/components/common/DataTable";
import { EmptyState } from "@/components/common/EmptyState";
import { Mono } from "@/components/common/Mono";
import { Button } from "@/components/ui/button";

type Revision = {
  rev: string;
  seq: number;
  at: string;
  by: string;
  op: string;
  status: string;
  fields: string[];
};

type Change = { field: string; before: unknown; after: unknown };

// A value rendered for a diff cell. A masked field arrives already transformed, so there is
// nothing to hide here — but null and undefined must be distinguishable from an empty string,
// because "the field was cleared" and "the field held nothing" are different edits.
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "—";
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function RevisionTimeline({ collection, id }: { collection: string; id: string }) {
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [changes, setChanges] = useState<Change[] | null>(null);

  useEffect(() => {
    setError(null);
    setRevisions(null);
    void (async () => {
      const r = await fetch(
        `/api/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}/revisions`,
      );
      if (!r.ok) {
        setError(`${r.status}`);
        return;
      }
      const body = await r.json();
      setRevisions(body.revisions ?? []);
    })();
  }, [collection, id]);

  useEffect(() => {
    if (!from || !to) {
      setChanges(null);
      return;
    }
    void (async () => {
      const r = await fetch(
        `/api/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}` +
          `/revisions/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      if (!r.ok) {
        setChanges([]);
        return;
      }
      const body = await r.json();
      setChanges(body.changes ?? []);
    })();
  }, [collection, id, from, to]);

  if (error)
    return (
      <EmptyState
        icon={History}
        title="History unavailable"
        description={`Request failed (${error}).`}
      />
    );

  const columns: ColumnDef<Revision, unknown>[] = [
    { accessorKey: "seq", header: "#", size: 60 },
    {
      accessorKey: "at",
      header: "When",
      cell: ({ row }) => <Mono>{new Date(row.original.at).toLocaleString()}</Mono>,
      size: 200,
    },
    {
      accessorKey: "by",
      header: "By",
      cell: ({ row }) => <Mono>{row.original.by}</Mono>,
      size: 120,
    },
    { accessorKey: "op", header: "Operation", size: 100 },
    { accessorKey: "status", header: "Status", size: 100 },
    {
      id: "fields",
      header: "Fields changed",
      // Only the fields this caller may read are listed; the broker filters the rest out.
      cell: ({ row }) =>
        row.original.fields.length ? (
          <Mono className="text-muted-foreground">{row.original.fields.join(", ")}</Mono>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      size: 220,
    },
    {
      id: "compare",
      header: "Compare",
      cell: ({ row }) => (
        <span className="flex gap-2">
          <Button
            type="button"
            variant={from === row.original.rev ? "secondary" : "outline"}
            size="xs"
            onClick={() => setFrom(row.original.rev)}
            aria-label={`Compare from revision ${row.original.seq}`}
          >
            From
          </Button>
          <Button
            type="button"
            variant={to === row.original.rev ? "secondary" : "outline"}
            size="xs"
            onClick={() => setTo(row.original.rev)}
            aria-label={`Compare to revision ${row.original.seq}`}
          >
            To
          </Button>
        </span>
      ),
      size: 140,
    },
  ];

  const changeColumns: ColumnDef<Change, unknown>[] = [
    {
      accessorKey: "field",
      header: "Field",
      cell: ({ row }) => <Mono>{row.original.field}</Mono>,
    },
    { accessorKey: "before", header: "Before", cell: ({ row }) => cellText(row.original.before) },
    { accessorKey: "after", header: "After", cell: ({ row }) => cellText(row.original.after) },
  ];

  return (
    <div className="space-y-6">
      <DataTable
        columns={columns}
        data={revisions ?? []}
        loading={revisions === null}
        empty={
          <EmptyState
            icon={History}
            title="No revisions"
            description="This document has no recorded history."
          />
        }
      />

      {changes && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">Changes</h2>
          <DataTable
            columns={changeColumns}
            data={changes}
            empty={
              <EmptyState
                icon={GitCompare}
                title="No visible changes"
                description="Nothing you can read moved between these two revisions. A masked field shows as unchanged even when its value moved."
              />
            }
          />
        </section>
      )}
    </div>
  );
}
