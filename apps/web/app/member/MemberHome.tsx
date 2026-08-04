"use client";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/common/PageHeader";
import { requestJson } from "@/lib/client-api";
import { MyGrants, type MeGrant } from "./MyGrants";
import { RequestAccessSheet } from "./RequestAccessSheet";

export function MemberHome() {
  const [grants, setGrants] = useState<MeGrant[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const res = await requestJson<{ grants?: MeGrant[] }>("/api/me/grants");
    if (res.ok) setGrants(res.data.grants ?? []);
    setLoading(false);
  };

  useEffect(() => {
    void load();
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
