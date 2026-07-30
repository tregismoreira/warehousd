"use client";
import { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { DataTable } from "@/components/common/DataTable";
import { EmptyState } from "@/components/common/EmptyState";
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
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update role");
      }
      toast.success(`Updated ${user.email} to ${roleLabels[newRole as keyof typeof roleLabels]}`);
      window.location.reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Error: ${msg}`);
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
    </div>
  );
}
