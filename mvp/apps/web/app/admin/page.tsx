"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/common/PageHeader";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { RegenSynthCard } from "./RegenSynthCard";

export default function AdminOverview() {
  const [collections, setCollections] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [pendingGrantCount, setPendingGrantCount] = useState(0);
  const [auditTotal, setAuditTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [collectionsRes, usersRes, grantsRes, auditRes] = await Promise.all([
          fetch("/api/admin/collections"),
          fetch("/api/admin/users"),
          fetch("/api/grants"),
          fetch("/api/audit?limit=1"),
        ]);

        if (collectionsRes.ok) {
          const data = await collectionsRes.json();
          setCollections(data.collections);
        }

        if (usersRes.ok) {
          const data = await usersRes.json();
          setUsers(data.users);
        }

        if (grantsRes.ok) {
          const data = await grantsRes.json();
          setPendingGrantCount(data.pending?.length ?? 0);
        }

        if (auditRes.ok) {
          const data = await auditRes.json();
          setAuditTotal(data.total ?? 0);
        }
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  const driftedCollections = collections.filter((c) => c.status === "drifted");
  const adminCount = users.filter((u) => u.role === "admin").length;
  const managerCount = users.filter((u) => u.role === "manager").length;
  const memberCount = users.filter((u) => u.role === "member").length;

  return (
    <div>
      <PageHeader
        title="Overview"
        description="Collections, identity and audit for this deployment."
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Collections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{collections.length}</div>
            {driftedCollections.length > 0 && (
              <p className="text-xs text-red-600 mt-1">
                <Link href="/admin/collections" className="hover:underline">
                  {driftedCollections.length} drifted
                </Link>
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Users by Role</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{users.length}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {adminCount} admin, {managerCount} manager, {memberCount} member
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending Grants</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pendingGrantCount}</div>
            {pendingGrantCount > 0 && (
              <p className="text-xs text-orange-600 mt-1">
                Awaiting approval
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Audit Events</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{auditTotal}</div>
            <p className="text-xs text-muted-foreground mt-1">
              <Link href="/admin/audit" className="hover:underline">
                View audit log
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RegenSynthCard />
      </div>
    </div>
  );
}
