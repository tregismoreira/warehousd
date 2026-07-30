"use client";
import { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";
import { DataTable } from "@/components/common/DataTable";
import { EmptyState } from "@/components/common/EmptyState";
import { Mono } from "@/components/common/Mono";
import { AddIssuerDialog } from "./AddIssuerDialog";

export type TrustedIssuer = {
  id: string;
  issuer: string;
  jwksUri: string;
  audience: string;
  subjectClaim: string;
  createdAt: string;
};

export function TrustedIssuers() {
  const [issuers, setIssuers] = useState<TrustedIssuer[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const res = await fetch("/api/trusted-issuers");
      if (!res.ok) throw new Error(`Failed to load issuers: ${res.status}`);
      const data = await res.json();
      setIssuers(data.issuers ?? []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Failed to load issuers: ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const columns: ColumnDef<TrustedIssuer, unknown>[] = [
    {
      accessorKey: "issuer",
      header: "Issuer",
      cell: ({ row }) => <Mono className="text-xs">{row.original.issuer}</Mono>,
    },
    {
      accessorKey: "jwksUri",
      header: "JWKS URI",
      cell: ({ row }) => (
        <Mono className="text-xs text-muted-foreground">{row.original.jwksUri}</Mono>
      ),
    },
    {
      accessorKey: "audience",
      header: "Audience",
      cell: ({ row }) => <Mono className="text-xs">{row.original.audience}</Mono>,
    },
    {
      accessorKey: "subjectClaim",
      header: "Subject claim",
      cell: ({ row }) => <Mono className="text-xs">{row.original.subjectClaim}</Mono>,
    },
    {
      accessorKey: "createdAt",
      header: "Added",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {new Date(row.original.createdAt).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <AddIssuerDialog onCreated={load} />
      </div>

      <DataTable
        columns={columns}
        data={issuers}
        loading={loading}
        empty={
          <EmptyState
            icon={ShieldCheck}
            title="No trusted issuers"
            description="Register your IdP to let its tokens be exchanged for warehousd tokens at /v1/token."
          />
        }
      />
    </div>
  );
}
