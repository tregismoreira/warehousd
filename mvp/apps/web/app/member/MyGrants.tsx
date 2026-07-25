"use client";
import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/common/DataTable";
import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge, type GrantStatus } from "@/components/common/StatusBadge";
import { Mono } from "@/components/common/Mono";

type MeGrant = {
  id: string; collection: string; env: "dev" | "live";
  status: string; effectiveStatus: GrantStatus;
  allowed_fields: string[] | null; purpose_label: string | null;
  requested_at: string; expires_at: string | null;
  document_filter: { field: string; op: string; value: unknown } | null;
};

const columns: ColumnDef<MeGrant, unknown>[] = [
  { accessorKey: "collection", header: "Collection",
    cell: ({ row }) => <span className="font-medium">{row.original.collection}</span> },
  { accessorKey: "env", header: "Env",
    cell: ({ row }) => <Mono>{row.original.env}</Mono> },
  { accessorKey: "effectiveStatus", header: "Status",
    cell: ({ row }) => <StatusBadge status={row.original.effectiveStatus} /> },
  { accessorKey: "allowed_fields", header: "Fields",
    cell: ({ row }) => (
      <Mono className="text-muted-foreground">
        {(row.original.allowed_fields ?? []).join(", ") || "—"}
      </Mono>
    ) },
  { id: "scope", header: "Document scope",
    cell: ({ row }) => {
      const f = row.original.document_filter;
      if (!f) return <span className="text-xs text-muted-foreground">Whole collection</span>;
      return <Mono>{`${f.field} ${f.op} ${JSON.stringify(f.value)}`}</Mono>;
    } },
  { accessorKey: "expires_at", header: "Expires",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.expires_at ? new Date(row.original.expires_at).toLocaleString() : "No expiry"}
      </span>
    ) },
];

export function MyGrants() {
  const [grants, setGrants] = useState<MeGrant[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/me/grants")
      .then((r) => r.json())
      .then((d) => setGrants(d.grants ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <DataTable
      columns={columns} data={grants} loading={loading}
      empty={
        <EmptyState
          icon={KeyRound}
          title="No grants yet"
          description="Access is deny-by-default. Request a grant on a collection to start querying it."
        />
      }
    />
  );
}
