"use client";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/common/DataTable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Mono } from "@/components/common/Mono";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

export type Client = {
  clientId: string;
  displayName: string;
  allowedScopes: string[];
  promotedAt: string | null;
  promotedBy: string | null;
  createdAt: string;
  lastTokenAt: string | null;
};

export function ClientsTable({ clients, loading, onRefresh }: { clients: Client[]; loading: boolean; onRefresh: () => Promise<void> }) {
  const [actionId, setActionId] = useState<string | null>(null);
  const [actionType, setActionType] = useState<"promote" | "demote" | null>(null);

  async function promote(clientId: string) {
    setActionId(clientId);
    setActionType("promote");
    try {
      const res = await fetch(`/api/oauth-clients/${clientId}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "promote" }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error("Failed to promote", { description: err.error });
        return;
      }
      toast.success("Client promoted to env:live");
      await onRefresh();
    } finally {
      setActionId(null);
      setActionType(null);
    }
  }

  async function demote(clientId: string) {
    setActionId(clientId);
    setActionType("demote");
    try {
      const res = await fetch(`/api/oauth-clients/${clientId}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "demote" }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error("Failed to demote", { description: err.error });
        return;
      }
      toast.success("Client demoted to env:dev");
      await onRefresh();
    } finally {
      setActionId(null);
      setActionType(null);
    }
  }

  const columns: ColumnDef<Client, unknown>[] = [
    {
      accessorKey: "displayName",
      header: "Name",
      cell: ({ row }) => <span className="font-medium">{row.original.displayName}</span>,
    },
    {
      accessorKey: "clientId",
      header: "Client ID",
      cell: ({ row }) => <Mono copyable>{row.original.clientId}</Mono>,
    },
    {
      accessorKey: "allowedScopes",
      header: "Scopes",
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.allowedScopes.map((scope) => (
            <Badge key={scope} variant="outline" className={cn(
              "font-mono text-xs",
              scope === "env:live" ? "text-allow" : undefined,
            )}>
              {scope}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      id: "promotion",
      header: "Promoted",
      cell: ({ row }) => {
        if (!row.original.promotedAt) return <span className="text-xs text-muted-foreground">—</span>;
        return (
          <span className="text-xs text-muted-foreground">
            {new Date(row.original.promotedAt).toLocaleDateString()} by {row.original.promotedBy}
          </span>
        );
      },
    },
    {
      id: "lastToken",
      header: "Last token issued",
      cell: ({ row }) => {
        if (!row.original.lastTokenAt) return <span className="text-xs text-muted-foreground">Never</span>;
        return (
          <span className="text-xs text-muted-foreground">
            {new Date(row.original.lastTokenAt).toLocaleDateString()}
          </span>
        );
      },
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => {
        const isPromoted = row.original.allowedScopes.includes("env:live");
        const isLocked = actionId === row.original.clientId && actionType !== null;

        if (!isPromoted) {
          return (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm">Promote</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Promote {row.original.displayName} to live?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This client will be able to receive <Mono>env:live</Mono> tokens on its next refresh — within 15 minutes. Live data is still filtered through each calling user&rsquo;s own grants.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => promote(row.original.clientId)}
                    disabled={isLocked}
                  >
                    {isLocked && <Loader2 size={16} className="mr-2 animate-spin" />}
                    Promote
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          );
        }

        return (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm">Demote</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Demote {row.original.displayName} to dev?</AlertDialogTitle>
                <AlertDialogDescription>
                  <Mono>env:live</Mono> is removed on the next token refresh — within 15 minutes. Existing tokens keep working until they expire.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive hover:bg-destructive/90"
                  onClick={() => demote(row.original.clientId)}
                  disabled={isLocked}
                >
                  {isLocked && <Loader2 size={16} className="mr-2 animate-spin" />}
                  Demote
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        );
      },
    },
  ];

  return <DataTable columns={columns} data={clients} loading={loading} />;
}
