"use client";
import { useState } from "react";
import { Loader2, MoreVertical } from "lucide-react";
import { toast } from "sonner";
import type { DataTableColumn } from "@/components/common/DataTable";
import { DataTable } from "@/components/common/DataTable";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Mono } from "@/components/common/Mono";
import { EmptyState } from "@/components/common/EmptyState";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { requestJson } from "@/lib/client-api";
import { ApiKeyDetail } from "./ApiKeyDetail";

export type ClientSecretInfo = {
  id: string;
  prefix: string;
  createdAt: Date;
  createdBy: string;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

export type ApiKey = {
  clientId: string;
  displayName: string;
  allowedScopes: string[];
  allowedCollections: string[] | null;
  mode: "delegated" | "headless";
  robotUserId: string | null;
  trustedIssuerId: string | null;
  createdAt: string;
  secrets: ClientSecretInfo[];
};

export function ApiKeysTable({
  keys,
  loading,
  onRefresh,
}: {
  keys: ApiKey[];
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [actionId, setActionId] = useState<string | null>(null);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  // Derived from `keys` (not a snapshot) so ApiKeyDetail always sees the post-onRefresh state —
  // no need for it to hand-patch fields locally after rotate/promote/revoke.
  const selectedKey = keys.find((k) => k.clientId === selectedKeyId) ?? null;

  async function revokeSecret(clientId: string, secretId: string, secretPrefix: string) {
    setActionId(secretId);
    try {
      const res = await requestJson(`/api/api-keys/${clientId}/revoke`, {
        method: "POST",
        body: JSON.stringify({ secretId }),
      });
      if (!res.ok) {
        toast.error("Failed to revoke", { description: res.error });
        return;
      }
      toast.success(`Revoked ${secretPrefix}`);
      await onRefresh();
    } finally {
      setActionId(null);
    }
  }

  function isExpiringSoon(expiresAt: Date): boolean {
    const daysUntilExpiry = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return daysUntilExpiry < 30 && daysUntilExpiry > 0;
  }

  function isExpired(expiresAt: Date): boolean {
    return expiresAt.getTime() < Date.now();
  }

  function hasUnusedSecrets(key: ApiKey): boolean {
    return key.secrets.some((s) => !s.revokedAt && !s.lastUsedAt);
  }

  function getLatestActiveSecret(key: ApiKey): ClientSecretInfo | undefined {
    return key.secrets.find((s) => !s.revokedAt);
  }

  const columns: DataTableColumn<ApiKey>[] = [
    {
      accessorKey: "displayName",
      header: "Name",
      cell: ({ row }) => <span className="font-medium">{row.original.displayName}</span>,
    },
    {
      accessorKey: "mode",
      header: "Mode",
      cell: ({ row }) => (
        <Badge variant="outline" className="font-mono text-xs">
          {row.original.mode}
        </Badge>
      ),
    },
    {
      id: "allowedScopes",
      header: "Env",
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.allowedScopes.map((scope) => (
            <Badge
              key={scope}
              variant="outline"
              className={cn("font-mono text-xs", scope === "env:live" ? "text-allow" : undefined)}
            >
              {scope}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      id: "ceiling",
      header: "Collections",
      cell: ({ row }) => {
        if (!row.original.allowedCollections)
          return <span className="text-xs text-muted-foreground">—</span>;
        return <Mono className="text-xs">{`[${row.original.allowedCollections.join(", ")}]`}</Mono>;
      },
    },
    {
      id: "expiry",
      header: "Expiry",
      cell: ({ row }) => {
        const secret = getLatestActiveSecret(row.original);
        if (!secret) return <span className="text-xs text-muted-foreground">—</span>;
        const expiresAt = new Date(secret.expiresAt);
        const isExp = isExpired(expiresAt);
        const isSoon = isExpiringSoon(expiresAt);
        return (
          <span
            className={cn(
              "text-xs",
              isExp
                ? "text-destructive font-medium"
                : isSoon
                  ? "text-pending font-medium"
                  : "text-muted-foreground",
            )}
          >
            {expiresAt.toLocaleDateString()}
          </span>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => {
        const secret = getLatestActiveSecret(row.original);
        if (!secret)
          return (
            <Badge variant="secondary" className="text-xs">
              No active secret
            </Badge>
          );

        const expiresAt = new Date(secret.expiresAt);
        const isExp = isExpired(expiresAt);
        if (isExp)
          return (
            <Badge variant="destructive" className="text-xs">
              Expired
            </Badge>
          );

        const isSoon = isExpiringSoon(expiresAt);
        if (isSoon)
          return (
            <Badge variant="secondary" className="text-xs bg-pending/10 text-pending">
              Expiring soon
            </Badge>
          );

        const hasUnused = hasUnusedSecrets(row.original);
        if (hasUnused)
          return (
            <Badge variant="secondary" className="text-xs">
              Unused
            </Badge>
          );

        if (secret.lastUsedAt) {
          const daysAgo = Math.floor(
            (Date.now() - new Date(secret.lastUsedAt).getTime()) / (1000 * 60 * 60 * 24),
          );
          return <span className="text-xs text-muted-foreground">Used {daysAgo}d ago</span>;
        }
        return <span className="text-xs text-muted-foreground">—</span>;
      },
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <MoreVertical size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setSelectedKeyId(row.original.clientId)}>
              Manage
            </DropdownMenuItem>
            {row.original.secrets.find((s) => !s.revokedAt) && (
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => {
                  const secret = getLatestActiveSecret(row.original);
                  if (secret) {
                    void revokeSecret(row.original.clientId, secret.id, secret.prefix);
                  }
                }}
              >
                {actionId === getLatestActiveSecret(row.original)?.id && (
                  <Loader2 size={16} className="mr-2 animate-spin" />
                )}
                Revoke secret
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  if (selectedKey) {
    return (
      <ApiKeyDetail
        keyData={selectedKey}
        onClose={() => setSelectedKeyId(null)}
        onRefresh={onRefresh}
      />
    );
  }

  return (
    <DataTable
      columns={columns}
      data={keys}
      loading={loading}
      empty={
        <EmptyState
          icon={MoreVertical}
          title="No API keys yet"
          description="Create an API key to enable programmatic access. Choose delegated mode to use OAuth SSO, or headless for robot users."
        />
      }
    />
  );
}
