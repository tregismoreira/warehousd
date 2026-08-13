"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { WorkspaceMembershipView } from "@/lib/workspace-shell";

// Only rendered when the caller has more than one membership — AppShell shows the active
// workspace's name as plain text otherwise. Mirrors EnvSwitcher's optimistic-update-then-refresh
// shape, but posts to /api/me/workspace instead of /api/env: switching workspace changes which
// session row's activeWorkspaceId is read on the next request, not a cookie.
export function WorkspaceSwitcher({
  activeWorkspaceId,
  memberships,
}: {
  activeWorkspaceId: string;
  memberships: WorkspaceMembershipView[];
}) {
  const [current, setCurrent] = useState(activeWorkspaceId);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function pick(workspaceId: string) {
    if (workspaceId === current) return;
    const prev = current;
    setCurrent(workspaceId); // optimistic
    const res = await fetch("/api/me/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    if (!res.ok) {
      setCurrent(prev);
      toast.error("Could not switch workspace");
      return;
    }
    startTransition(() => router.refresh());
  }

  const name = memberships.find((m) => m.workspaceId === current)?.name ?? current;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          className="gap-1.5 font-mono text-xs"
        >
          {name}
          <ChevronsUpDown size={12} className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {memberships.map((m) => (
          <DropdownMenuItem key={m.workspaceId} onClick={() => pick(m.workspaceId)}>
            {m.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
