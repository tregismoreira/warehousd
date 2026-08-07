"use client";
import { useState } from "react";
import { KeyRound } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/common/DataTable";
import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge, type GrantStatus } from "@/components/common/StatusBadge";
import { Mono } from "@/components/common/Mono";
import { Button } from "@/components/ui/button";
import { AccessExplainer } from "@/app/components/AccessExplainer";

export type MeGrant = {
  id: string;
  collection: string;
  env: "dev" | "live";
  status: string;
  effectiveStatus: GrantStatus;
  allowed_fields: string[] | null;
  purpose_label: string | null;
  requested_at: string;
  expires_at: string | null;
  document_filter: { field: string; op: string; value: unknown }[] | null;
};

const columns: ColumnDef<MeGrant, unknown>[] = [
  {
    accessorKey: "collection",
    header: "Collection",
    cell: ({ row }) => <span className="font-medium">{row.original.collection}</span>,
  },
  { accessorKey: "env", header: "Env", cell: ({ row }) => <Mono>{row.original.env}</Mono> },
  {
    accessorKey: "effectiveStatus",
    header: "Status",
    cell: ({ row }) => <StatusBadge status={row.original.effectiveStatus} />,
  },
  {
    accessorKey: "allowed_fields",
    header: "Fields",
    cell: ({ row }) => (
      <Mono className="text-muted-foreground">
        {(row.original.allowed_fields ?? []).join(", ") || "—"}
      </Mono>
    ),
  },
  {
    id: "scope",
    header: "Document scope",
    cell: ({ row }) => {
      const fs = row.original.document_filter;
      if (!fs || fs.length === 0)
        return <span className="text-xs text-muted-foreground">Whole collection</span>;
      return (
        <Mono>{fs.map((f) => `${f.field} ${f.op} ${JSON.stringify(f.value)}`).join(" AND ")}</Mono>
      );
    },
  },
  {
    accessorKey: "expires_at",
    header: "Expires",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.expires_at ? new Date(row.original.expires_at).toLocaleString() : "No expiry"}
      </span>
    ),
  },
];

export function MyGrants({ grants, loading }: { grants: MeGrant[]; loading: boolean }) {
  // §P5's third surface. A member who cannot see a field has no way to tell "the config denies it"
  // from "my grant does not carry it" from "it is masked" — and those are three different things
  // to do about it. Asking about yourself needs no role.
  const [explaining, setExplaining] = useState<string | null>(null);

  const withExplain: ColumnDef<MeGrant, unknown>[] = [
    ...columns,
    {
      id: "explain",
      header: "",
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setExplaining((c) => (c === row.original.collection ? null : row.original.collection))
          }
        >
          {explaining === row.original.collection ? "Hide" : "Why?"}
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <DataTable
        columns={withExplain}
        data={grants}
        loading={loading}
        empty={
          <EmptyState
            icon={KeyRound}
            title="No grants yet"
            description="Access is deny-by-default. Request a grant on a collection to start querying it."
          />
        }
      />
      {explaining && (
        <div className="space-y-2">
          <p className="text-sm font-semibold">
            What you can see of <Mono>{explaining}</Mono>
          </p>
          <AccessExplainer collection={explaining} />
        </div>
      )}
    </div>
  );
}
