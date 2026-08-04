"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/PageHeader";
import { requestJson } from "@/lib/client-api";
import { ProposalsTable, type Proposal } from "./ProposalsTable";

export function ReviewHome() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const res = await requestJson<{ proposals: Proposal[] }>("/api/proposals?status=pending");
    if (res.ok) setProposals(res.data.proposals);
    else toast.error(`Failed to load proposals: ${res.error}`);
    setLoading(false);
  };

  useEffect(() => {
    void load();
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
