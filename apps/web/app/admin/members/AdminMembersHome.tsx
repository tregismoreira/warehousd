"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/PageHeader";
import { requestJson } from "@/lib/client-api";
import { MembersTable, type Member } from "./MembersTable";
import { AddMemberDialog } from "./AddMemberDialog";

export function AdminMembersHome() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const res = await requestJson<{ members: Member[] }>("/api/admin/members");
    if (res.ok) setMembers(res.data.members);
    else toast.error(`Failed to load members: ${res.error}`);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <PageHeader
        title="Members"
        description="Who belongs to this workspace, and their role in it. A role here is scoped to this workspace only — the same person can hold a different role in another one."
        action={<AddMemberDialog onAdded={load} />}
      />
      <MembersTable members={members} loading={loading} onRefresh={load} />
    </>
  );
}
