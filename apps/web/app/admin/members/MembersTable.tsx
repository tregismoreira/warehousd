"use client";
import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";
import { UsersRound } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { requestJson } from "@/lib/client-api";
import { DataTable } from "@/components/common/DataTable";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export type Member = {
  userId: string;
  email: string;
  name: string;
  role: "admin" | "manager" | "member";
  createdAt: string;
};

const roleLabels = { admin: "Admin", manager: "Manager", member: "Member" };

function RoleSelect({
  member,
  isSelf,
  onChanged,
}: {
  member: Member;
  isSelf: boolean;
  onChanged: () => void;
}) {
  const [updating, setUpdating] = useState(false);

  async function updateRole(newRole: string) {
    if (newRole === member.role) return;
    setUpdating(true);
    try {
      const res = await requestJson("/api/admin/members", {
        method: "POST",
        body: JSON.stringify({ email: member.email, role: newRole }),
      });
      if (!res.ok) {
        toast.error(`Failed to update role: ${res.error}`);
        return;
      }
      toast.success(`${member.email} is now ${roleLabels[newRole as keyof typeof roleLabels]}`);
      onChanged();
    } finally {
      setUpdating(false);
    }
  }

  const trigger = (
    <SelectTrigger disabled={isSelf || updating} className="w-32">
      <SelectValue placeholder={roleLabels[member.role]} />
    </SelectTrigger>
  );

  if (isSelf) {
    return (
      <Select value={member.role} disabled>
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
    <Select value={member.role} onValueChange={updateRole} disabled={updating}>
      {trigger}
      <SelectContent>
        <SelectItem value="admin">Admin</SelectItem>
        <SelectItem value="manager">Manager</SelectItem>
        <SelectItem value="member">Member</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function MembersTable({
  members,
  loading,
  onRefresh,
}: {
  members: Member[];
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [removingId, setRemovingId] = useState<string | null>(null);
  const session = authClient.useSession();
  const currentUserId = session.data?.user?.id;

  async function remove(userId: string, email: string) {
    setRemovingId(userId);
    try {
      const res = await requestJson(`/api/admin/members?userId=${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        toast.error(`Failed to remove ${email}`, {
          description:
            res.error === "last_admin"
              ? "This is the last admin — promote someone else first."
              : res.error,
        });
        return;
      }
      toast.success(`Removed ${email}`);
      await onRefresh();
    } finally {
      setRemovingId(null);
    }
  }

  const columns: ColumnDef<Member, unknown>[] = [
    { accessorKey: "email", header: "Email" },
    { accessorKey: "name", header: "Name" },
    {
      id: "role",
      header: "Role",
      cell: ({ row }) => {
        const isSelf = currentUserId === row.original.userId;
        return (
          <RoleSelect member={row.original} isSelf={isSelf} onChanged={() => void onRefresh()} />
        );
      },
    },
    {
      id: "createdAt",
      header: "Member since",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {new Date(row.original.createdAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      id: "remove",
      header: "",
      cell: ({ row }) => {
        const isSelf = currentUserId === row.original.userId;
        return (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={removingId === row.original.userId}
                className="text-destructive"
              >
                {isSelf ? "Leave" : "Remove"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {isSelf
                    ? "Leave this workspace?"
                    : `Remove ${row.original.email} from this workspace?`}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {isSelf
                    ? "You lose access to this workspace immediately, including this page. The server refuses if you are its last admin."
                    : "They lose access to this workspace immediately. Their account and any other workspace they belong to are unaffected."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => void remove(row.original.userId, row.original.email)}
                >
                  {isSelf ? "Leave" : "Remove"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        );
      },
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={members}
      loading={loading}
      empty={
        <EmptyState
          icon={UsersRound}
          title="No members yet"
          description="Add an existing user by email to give them access to this workspace."
        />
      }
    />
  );
}
