"use client";
import { useEffect, useState } from "react";
import { Loader2, ListChecks } from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/common/DataTable";
import { Button } from "@/components/ui/button";
import { Mono } from "@/components/common/Mono";
import { EmptyState } from "@/components/common/EmptyState";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type ActiveGrant = {
  id: string;
  user_id: string;
  collection: string;
  env: "dev" | "live";
  allowed_fields: string[] | null;
  expires_at: string | null;
  document_filter: { field: string; op: string; value: unknown } | null;
};

export function ActiveGrants() {
  const [grants, setGrants] = useState<ActiveGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  // One dialog for the whole table, keyed off which grant is pending revocation. Rendering it
  // inside the row meant `load()`'s re-render unmounted it mid-confirm.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const pending = grants.find((g) => g.id === pendingId) ?? null;

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/grants");
      const data = await res.json();
      setGrants(data.active ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  async function revoke(id: string) {
    setRevoking(id);
    try {
      const res = await fetch("/api/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revoke", id }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error("Failed to revoke", { description: err.error });
        return;
      }
      toast.success("Grant revoked");
      setPendingId(null);
      await load();
    } finally {
      setRevoking(null);
    }
  }

  const columns: ColumnDef<ActiveGrant, unknown>[] = [
    {
      accessorKey: "user_id",
      header: "User",
      cell: ({ row }) => <Mono>{row.original.user_id}</Mono>,
    },
    {
      accessorKey: "collection",
      header: "Collection",
      cell: ({ row }) => <span className="font-medium">{row.original.collection}</span>,
    },
    { accessorKey: "env", header: "Env", cell: ({ row }) => <Mono>{row.original.env}</Mono> },
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
        const f = row.original.document_filter;
        if (!f) return <span className="text-xs text-muted-foreground">Whole collection</span>;
        return <Mono>{`${f.field} ${f.op} ${JSON.stringify(f.value)}`}</Mono>;
      },
    },
    {
      accessorKey: "expires_at",
      header: "Expires",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.expires_at
            ? new Date(row.original.expires_at).toLocaleString()
            : "No expiry"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button variant="destructive" size="sm" onClick={() => setPendingId(row.original.id)}>
          Revoke
        </Button>
      ),
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        data={grants}
        loading={loading}
        empty={
          <EmptyState
            icon={ListChecks}
            title="No active grants"
            description="Approved grants across the deployment will show up here, with revoke taking effect on the next query."
          />
        }
      />

      <AlertDialog
        open={pending !== null}
        onOpenChange={(v) => {
          if (!v) setPendingId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke {pending?.user_id}&rsquo;s access to {pending?.collection}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Revocation is immediate — their very next query is refused, with no token refresh
              involved. They can request access again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={(e) => {
                // Keep the dialog mounted while the POST is in flight so the spinner is real;
                // `revoke` closes it once the refetch has landed.
                e.preventDefault();
                if (pending) void revoke(pending.id);
              }}
              disabled={revoking !== null}
            >
              {revoking !== null && <Loader2 size={16} className="mr-2 animate-spin" />}
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
