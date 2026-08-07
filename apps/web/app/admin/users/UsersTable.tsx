"use client";
import { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { requestJson } from "@/lib/client-api";
import { DataTable } from "@/components/common/DataTable";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { AccessExplainer } from "@/app/components/AccessExplainer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Users } from "lucide-react";

type User = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "manager" | "member";
  createdAt: string;
  grantCount: number;
};

const roleLabels = { admin: "Admin", manager: "Manager", member: "Member" };

function RoleSelect({ user, isSelf }: { user: User; isSelf: boolean }) {
  const [updating, setUpdating] = useState(false);

  async function updateRole(newRole: string) {
    if (newRole === user.role) return;
    setUpdating(true);
    try {
      const res = await requestJson(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: newRole }),
      });
      if (!res.ok) {
        toast.error(`Error: ${res.error}`);
        return;
      }
      toast.success(`Updated ${user.email} to ${roleLabels[newRole as keyof typeof roleLabels]}`);
      window.location.reload();
    } finally {
      setUpdating(false);
    }
  }

  const trigger = (
    <SelectTrigger disabled={isSelf || updating} className="w-32">
      <SelectValue placeholder={roleLabels[user.role]} defaultValue={user.role} />
    </SelectTrigger>
  );

  if (isSelf) {
    return (
      <Select value={user.role} disabled>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>{trigger}</TooltipTrigger>
            <TooltipContent>You cannot change your own role.</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <SelectContent>
          <SelectItem value="admin">Admin</SelectItem>
          <SelectItem value="manager">Manager</SelectItem>
          <SelectItem value="member">Member</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  return (
    <Select value={user.role} onValueChange={updateRole} disabled={updating}>
      {trigger}
      <SelectContent>
        <SelectItem value="admin">Admin</SelectItem>
        <SelectItem value="manager">Manager</SelectItem>
        <SelectItem value="member">Member</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function UsersTable() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  // §P5's effective-access matrix. This is what makes §P1's specificity rule comprehensible: a
  // grant count says a number, and the matrix says which fields it reaches and why the rest are
  // out — including when the deciding grant is one the user inherited from a group.
  const [subject, setSubject] = useState<User | null>(null);
  const [collections, setCollections] = useState<string[]>([]);
  const [collection, setCollection] = useState("");
  const session = authClient.useSession();
  const currentUserId = session.data?.user?.id;

  useEffect(() => {
    fetch("/api/admin/users")
      .then((r) => r.json())
      .then((data) => {
        setUsers(data.users);
        setLoading(false);
      })
      .catch((e) => {
        console.error("Failed to load users:", e);
        toast.error("Failed to load users");
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetch("/api/collections")
      .then((r) => r.json())
      .then((data: { collections?: { name: string }[] }) => {
        const names = (data.collections ?? []).map((c) => c.name);
        setCollections(names);
        setCollection((c) => c || (names[0] ?? ""));
      })
      .catch(() => setCollections([]));
  }, []);

  const columns: ColumnDef<User, unknown>[] = [
    { accessorKey: "email", header: "Email" },
    { accessorKey: "name", header: "Name" },
    {
      id: "role",
      header: "Role",
      cell: ({ row }) => {
        const isSelf = currentUserId === row.original.id;
        return <RoleSelect user={row.original} isSelf={isSelf} />;
      },
    },
    {
      accessorKey: "grantCount",
      header: "Approved Grants",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">{row.original.grantCount}</span>
      ),
    },
    {
      id: "createdAt",
      header: "Created",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {new Date(row.original.createdAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      id: "access",
      header: "",
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSubject((s) => (s?.id === row.original.id ? null : row.original))}
        >
          {subject?.id === row.original.id ? "Hide access" : "Access"}
        </Button>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 rounded-lg border bg-muted/30 p-3 text-sm">
        <p className="text-muted-foreground">
          <strong>admin</strong> manages collections, identity and imports ·{" "}
          <strong>manager</strong> approves grants · <strong>member</strong> requests and queries.
          New SSO users are provisioned as <strong>member</strong>.
        </p>
      </div>
      <DataTable
        columns={columns}
        data={users}
        loading={loading}
        empty={
          <EmptyState
            icon={Users}
            title="No users yet"
            description="Users will appear here as they sign in."
          />
        }
      />
      {subject && collection && (
        <div className="mt-6 space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">Effective access for {subject.email}</p>
            <select
              className="rounded border bg-background px-2 py-1 text-xs"
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
            >
              {collections.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <AccessExplainer collection={collection} subject={subject.id} />
        </div>
      )}
    </div>
  );
}
