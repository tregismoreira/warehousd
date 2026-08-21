"use client";
import { useEffect, useState } from "react";
import { Inbox as InboxIcon } from "lucide-react";
import type { DataTableColumn } from "@/components/common/DataTable";
import { DataTable } from "@/components/common/DataTable";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Mono } from "@/components/common/Mono";
import { requestJson } from "@/lib/client-api";
import { ApproveSheet, type PendingGrant } from "./ApproveSheet";

type GrantRow = PendingGrant;

// §P7. Approved, live, and lapsing within the week.
type ExpiringGrant = {
  id: string;
  userId: string;
  collection: string;
  env: string;
  principal: string;
  expiresAt: string;
};

export function Inbox() {
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [expiring, setExpiring] = useState<ExpiringGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PendingGrant | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    const res = await requestJson<{ pending?: GrantRow[]; expiring?: ExpiringGrant[] }>(
      "/api/grants",
    );
    if (res.ok) {
      setGrants(
        (res.data.pending ?? []).map((g) => ({
          ...g,
          collectionType: g.collectionType || "dataset",
        })),
      );
      setExpiring(res.data.expiring ?? []);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const columns: DataTableColumn<GrantRow>[] = [
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
      {expiring.length > 0 && (
        <div className="mt-6 space-y-2 rounded-lg border border-deny/20 bg-deny/5 p-4">
          <p className="text-sm font-semibold">
            {expiring.length} grant{expiring.length === 1 ? "" : "s"} lapse within a week
          </p>
          <p className="text-xs text-muted-foreground">
            Access stops on the date shown, with no further notice. Renewing is a new request.
          </p>
          <ul className="space-y-1 text-xs">
            {expiring.map((g) => (
              <li key={g.id} className="flex items-center gap-2">
                <Mono>{g.principal.slice(g.principal.indexOf(":") + 1)}</Mono>
                <span className="text-muted-foreground">on</span>
                <Mono>{g.collection}</Mono>
                <Mono>{g.env}</Mono>
                <span className="text-muted-foreground">
                  until {new Date(g.expiresAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ApproveSheet grant={selected} open={sheetOpen} onOpenChange={setSheetOpen} onDone={load} />
    </>
  );
}
