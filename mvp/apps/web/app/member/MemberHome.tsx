"use client";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/common/PageHeader";
import { MyGrants } from "./MyGrants";
import { RequestAccessSheet } from "./RequestAccessSheet";

type MeGrant = {
  id: string; collection: string; env: "dev" | "live";
  status: string; effectiveStatus: string;
  allowed_fields: string[] | null; purpose_label: string | null;
  requested_at: string; expires_at: string | null;
  document_filter: { field: string; op: string; value: unknown } | null;
};

export function MemberHome() {
  const [grants, setGrants] = useState<MeGrant[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/me/grants");
      const data = await res.json();
      setGrants(data.grants ?? []);
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
        title="My grants"
        description="Access is deny-by-default: a collection is invisible until a grant covers it, and every grant is evaluated at query time."
        action={<RequestAccessSheet onDone={load} />}
      />
      <MyGrants grants={grants} loading={loading} />
    </>
  );
}
