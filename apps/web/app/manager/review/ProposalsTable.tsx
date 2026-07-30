"use client";
import { useState } from "react";
import { Inbox } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/common/DataTable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Mono } from "@/components/common/Mono";
import { EmptyState } from "@/components/common/EmptyState";
import { ProposalDetail } from "./ProposalDetail";

export type Proposal = {
  proposalId: string;
  collection: string;
  op: string;
  fields: string[];
  proposedBy: string;
  proposedAt: string;
  documentId: string;
};

export function ProposalsTable({
  proposals,
  loading,
  onRefresh,
}: {
  proposals: Proposal[];
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedProposal = proposals.find((p) => p.proposalId === selectedId) ?? null;

  const columns: ColumnDef<Proposal, unknown>[] = [
    {
      accessorKey: "collection",
      header: "Collection",
      cell: ({ row }) => <span className="font-medium">{row.original.collection}</span>,
    },
    {
      accessorKey: "op",
      header: "Operation",
      cell: ({ row }) => (
        <Badge variant="outline" className="font-mono text-xs">
          {row.original.op}
        </Badge>
      ),
    },
    {
      accessorKey: "fields",
      header: "Fields changed",
      cell: ({ row }) => (
        <div className="text-sm text-muted-foreground">
          {row.original.fields.length === 0 ? "—" : row.original.fields.join(", ")}
        </div>
      ),
    },
    {
      accessorKey: "proposedBy",
      header: "Requested by",
      cell: ({ row }) => <Mono className="text-xs">{row.original.proposedBy}</Mono>,
    },
    {
      accessorKey: "proposedAt",
      header: "Created",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {new Date(row.original.proposedAt).toLocaleString()}
        </span>
      ),
    },
    {
      id: "review",
      header: "",
      cell: ({ row }) => (
        <Button size="sm" variant="ghost" onClick={() => setSelectedId(row.original.proposalId)}>
          Review
        </Button>
      ),
    },
  ];

  if (selectedProposal) {
    return (
      <ProposalDetail
        proposal={selectedProposal}
        onClose={() => setSelectedId(null)}
        onRefresh={onRefresh}
      />
    );
  }

  return (
    <DataTable
      columns={columns}
      data={proposals}
      loading={loading}
      empty={
        <EmptyState
          icon={Inbox}
          title="No pending proposals"
          description="Approved or rejected proposals will no longer appear here."
        />
      }
    />
  );
}
