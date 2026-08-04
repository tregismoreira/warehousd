"use client";
import { useEffect, useState } from "react";
import { Inbox as InboxIcon } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/common/DataTable";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Mono } from "@/components/common/Mono";
import { requestJson } from "@/lib/client-api";
import { ApproveSheet, type PendingGrant } from "./ApproveSheet";

type GrantRow = PendingGrant;

export function Inbox() {
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PendingGrant | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    const res = await requestJson<{ pending?: GrantRow[] }>("/api/grants");
    if (res.ok)
      setGrants(
        (res.data.pending ?? []).map((g) => ({
          ...g,
          collectionType: g.collectionType || "dataset",
        })),
      );
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const columns: ColumnDef<GrantRow, unknown>[] = [
    {
      accessorKey: "user_id",
      header: "Requester",
      cell: ({ row }) => <Mono>{row.original.user_id}</Mono>,
    },
    {
      accessorKey: "collection",
      header: "Collection",
      cell: ({ row }) => <span className="font-medium">{row.original.collection}</span>,
    },
    { accessorKey: "env", header: "Env", cell: ({ row }) => <Mono>{row.original.env}</Mono> },
    {
      accessorKey: "purpose_label",
      header: "Purpose",
      cell: ({ row }) => <span className="text-sm">{row.original.purpose_label || "—"}</span>,
    },
    {
      accessorKey: "requested_at",
      header: "Requested",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {new Date(row.original.requested_at).toLocaleString()}
        </span>
      ),
    },
    {
      id: "review",
      header: "",
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setSelected(row.original);
            setSheetOpen(true);
          }}
        >
          Review
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
            icon={InboxIcon}
            title="Nothing waiting"
            description="New access requests will appear here."
          />
        }
      />
      <ApproveSheet grant={selected} open={sheetOpen} onOpenChange={setSheetOpen} onDone={load} />
    </>
  );
}
