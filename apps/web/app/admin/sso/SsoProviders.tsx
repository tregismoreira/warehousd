"use client";
import { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";
import { Trash2, AlertCircle, CheckCircle, AlertTriangle } from "lucide-react";
import { DataTable } from "@/components/common/DataTable";
import { EmptyState } from "@/components/common/EmptyState";
import { Mono } from "@/components/common/Mono";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AddProviderSheet } from "./AddProviderSheet";
import { cn } from "@/lib/utils";

type Provider = {
  providerId: string;
  issuer: string;
  domain: string;
  type: "oidc" | "saml";
};

// /api/sso/status is the unauthenticated endpoint and returns less than /api/sso/providers: no
// issuer, and no domain. This page reads issuer and domain from the admin route above and uses
// status only for the count and the local-login flag, so the narrower shape is the accurate one.
type StatusInfo = {
  providers: Pick<Provider, "providerId" | "type">[];
  localLoginEnabled: boolean;
};

export function SsoProviders() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [statusInfo, setStatusInfo] = useState<StatusInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function loadProviders() {
    try {
      const [providersRes, statusRes] = await Promise.all([
        fetch("/api/sso/providers"),
        fetch("/api/sso/status"),
      ]);

      if (!providersRes.ok) throw new Error("Failed to load providers");
      if (!statusRes.ok) throw new Error("Failed to load status");

      const providersData = await providersRes.json();
      const statusData = await statusRes.json();

      setProviders(providersData.providers || []);
      setStatusInfo(statusData);
      setLoading(false);
    } catch (e) {
      console.error("Failed to load providers:", e);
      toast.error("Failed to load providers");
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProviders();
  }, []);

  async function deleteProvider(providerId: string) {
    setDeleting(providerId);
    try {
      const res = await fetch(`/api/sso/providers/${providerId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        throw new Error("Failed to delete provider");
      }

      toast.success("Provider deleted");
      await loadProviders();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Error: ${msg}`);
    } finally {
      setDeleting(null);
    }
  }

  function getStatusCard() {
    if (!statusInfo) return null;

    const hasProviders = statusInfo.providers.length > 0;
    const { localLoginEnabled } = statusInfo;

    if (hasProviders && localLoginEnabled) {
      return {
        icon: CheckCircle,
        color: "text-allow",
        title: "SSO configured",
        description: "Users can sign in with SSO or local credentials.",
      };
    }

    if (hasProviders && !localLoginEnabled) {
      return {
        icon: CheckCircle,
        color: "text-allow",
        title: "SSO enabled",
        description: "SSO is the only way in.",
      };
    }

    if (!hasProviders && localLoginEnabled) {
      return {
        icon: AlertTriangle,
        color: "text-pending",
        title: "No SSO configured",
        description: "Everyone signs in with local credentials — configure SSO before deploying.",
      };
    }

    return {
      icon: AlertCircle,
      color: "text-deny",
      title: "No login method configured",
      description: "Nobody can sign in.",
    };
  }

  const statusCard = getStatusCard();

  const columns: ColumnDef<Provider, unknown>[] = [
    {
      accessorKey: "providerId",
      header: "Provider ID",
      cell: ({ row }) => <Mono className="text-sm">{row.original.providerId}</Mono>,
    },
    {
      id: "type",
      header: "Type",
      cell: ({ row }) => (
        <Badge variant="outline" className="font-mono text-xs">
          {row.original.type.toUpperCase()}
        </Badge>
      ),
    },
    {
      accessorKey: "issuer",
      header: "Issuer",
      cell: ({ row }) => (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Mono className="text-sm truncate max-w-xs">{row.original.issuer}</Mono>
            </TooltipTrigger>
            <TooltipContent>{row.original.issuer}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ),
    },
    {
      accessorKey: "domain",
      header: "Domain",
      cell: ({ row }) => <span className="text-sm">{row.original.domain}</span>,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => {
        const isDeleting = deleting === row.original.providerId;

        return (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" disabled={isDeleting}>
                <Trash2 size={16} />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {row.original.providerId}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Users who signed in through this provider will lose their linked accounts and must
                  sign in again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteProvider(row.original.providerId)}
                  disabled={isDeleting}
                  className="bg-destructive hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      {statusCard && (
        <div
          className={cn(
            "rounded-lg border p-4",
            statusCard.color === "text-allow" && "bg-allow/5 border-allow/20",
            statusCard.color === "text-pending" && "bg-pending/5 border-pending/20",
            statusCard.color === "text-deny" && "bg-deny/5 border-deny/20",
          )}
        >
          <div className="flex items-start gap-3">
            <statusCard.icon size={20} className={cn("mt-0.5 shrink-0", statusCard.color)} />
            <div>
              <h3 className="font-medium text-sm">{statusCard.title}</h3>
              <p className="text-sm text-muted-foreground mt-1">{statusCard.description}</p>
            </div>
          </div>
        </div>
      )}

      <div className="flex justify-between items-center">
        <h3 className="text-sm font-medium">Providers</h3>
        <AddProviderSheet onAdded={loadProviders} />
      </div>

      <DataTable
        columns={columns}
        data={providers}
        loading={loading}
        empty={
          <EmptyState
            icon={AlertCircle}
            title="No providers configured"
            description="Add your first identity provider to enable SSO."
          />
        }
      />
    </div>
  );
}
