"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/PageHeader";
import { ProposalsTable, type Proposal } from "./ProposalsTable";

export function ReviewHome() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/proposals?status=pending");
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setProposals(data.proposals);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Failed to load proposals: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <PageHeader
        title="Proposal review"
        description="Review and approve pending document changes. Each proposal shows the fields affected, but not their values — fetch the current document to review the actual content."
      />
      <ProposalsTable proposals={proposals} loading={loading} onRefresh={load} />
    </>
  );
}
