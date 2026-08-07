"use client";
import { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";
import { DataTable } from "@/components/common/DataTable";
import { EmptyState } from "@/components/common/EmptyState";
import { Mono } from "@/components/common/Mono";
import { Button } from "@/components/ui/button";
import { requestJson } from "@/lib/client-api";

// §P7's third surface: access recertification. Table stakes for the compliance buyer this product
// is aimed at, and until now there was no way to ask "who still needs this?" at all.
//
// Sorted by last use, nulls first, because a grant nobody has ever exercised is the easiest revoke
// a reviewer will ever make.

type ReviewRow = {
  id: string;
  userId: string;
  collection: string;
  env: string;
  principal: string;
  allowedFields: string[];
  approvedAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  uses: number;
};

const WINDOWS = [30, 60, 90, 180];

export function AccessReview() {
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await requestJson<{ grants: ReviewRow[] }>(`/api/admin/access-review?days=${days}`);
    if (res.ok) setRows(res.data.grants);
    else toast.error(`Could not load the review: ${res.error}`);
    setLoading(false);
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string) {
    const res = await requestJson(`/api/grants/${id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Revoked — it stops working on the next query.");
      void load();
    } else toast.error(`Could not revoke: ${res.error}`);
  }

  const columns: ColumnDef<ReviewRow, unknown>[] = [
    {
      id: "principal",
      header: "Held by",
      cell: ({ row }) => (
        <Mono>{row.original.principal.slice(row.original.principal.indexOf(":") + 1)}</Mono>
      ),
    },
    {
      accessorKey: "collection",
      header: "Collection",
      cell: ({ row }) => <span className="font-medium">{row.original.collection}</span>,
    },
    { accessorKey: "env", header: "Env", cell: ({ row }) => <Mono>{row.original.env}</Mono> },
    {
      id: "fields",
      header: "Fields",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">{row.original.allowedFields.length}</span>
      ),
    },
    {
      id: "lastUsedAt",
      header: "Last used",
      cell: ({ row }) =>
        row.original.lastUsedAt ? (
          <span className="text-xs text-muted-foreground">
            {new Date(row.original.lastUsedAt).toLocaleDateString()} · {row.original.uses} call
            {row.original.uses === 1 ? "" : "s"}
          </span>
        ) : (
          // The whole reason to look at this page.
          <span className="text-xs font-medium text-deny">never used</span>
        ),
    },
    {
      id: "expiresAt",
      header: "Expires",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.expiresAt
            ? new Date(row.original.expiresAt).toLocaleDateString()
            : "no expiry"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" onClick={() => void revoke(row.original.id)}>
          Revoke
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Approved more than</span>
        {WINDOWS.map((n) => (
          <Button
            key={n}
            variant={n === days ? "default" : "outline"}
            size="sm"
            onClick={() => setDays(n)}
          >
            {n} days
          </Button>
        ))}
        <span className="text-muted-foreground">ago</span>
      </div>
      <DataTable
        columns={columns}
        data={rows}
        loading={loading}
        empty={
          <EmptyState
            icon={ShieldCheck}
            title="Nothing to recertify"
            description={`No approved grant is older than ${days} days.`}
          />
        }
      />
    </div>
  );
}
