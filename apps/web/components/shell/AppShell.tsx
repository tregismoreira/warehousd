"use client";
// Load-bearing: NAV items carry a lucide `icon` component, and a component reference cannot
// be serialized across a server→client boundary. Without this the shell renders on the server
// and every authenticated surface dies on `<SidebarNav items={items} />`. Children still
// arrive pre-rendered from the server layouts, so nothing else moves to the client.
import { NAV } from "@/lib/nav";
import type { Role } from "@/lib/authz";
import type { WorkspaceShellData } from "@/lib/workspace-shell";
import { Badge } from "@/components/ui/badge";
import { SidebarNav } from "./SidebarNav";
import { EnvSwitcher } from "./EnvSwitcher";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { UserMenu } from "./UserMenu";

export function AppShell({
  surface,
  role,
  email,
  env,
  workspace,
  children,
}: {
  surface: Role;
  role: Role;
  email: string;
  env: "dev" | "live";
  workspace: WorkspaceShellData;
  children: React.ReactNode;
}) {
  const items = NAV[surface].filter(
    (item) => !item.workspacesOnly || workspace.workspacesFeatureEnabled,
  );
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-60 shrink-0 flex-col border-r">
        {/* Stacked rather than one row: the release-candidate badge does not fit beside both the
            name and the subtitle in a 15rem sidebar, and the badge is the part that must not be
            the one that wraps or truncates. */}
        <div className="flex h-14 flex-col justify-center px-5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            warehousd
            <Badge
              variant="outline"
              className="px-1.5 py-0 font-mono text-[9px] font-normal text-muted-foreground"
              title="Release candidate — not for production. Unaudited; evaluate before pointing it at real data."
            >
              release candidate
            </Badge>
          </div>
          <span className="font-mono text-[10px] font-normal text-muted-foreground">
            security console
          </span>
        </div>
        <SidebarNav items={items} />
      </aside>
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-end gap-3 border-b px-6">
          {/* Always names the active workspace, switcher or not — a switcher is an affordance
              for changing it, not the only place it is legible. */}
          {workspace.switcherEnabled ? (
            <WorkspaceSwitcher
              activeWorkspaceId={workspace.activeWorkspaceId}
              memberships={workspace.memberships}
            />
          ) : (
            <span
              className="rounded-md border px-2.5 py-1 font-mono text-xs text-muted-foreground"
              title="Active workspace"
            >
              {workspace.activeWorkspaceName}
            </span>
          )}
          <EnvSwitcher initial={env} />
          <UserMenu email={email} role={role} />
        </header>
        {/* Keyed on env AND the active workspace. Either switcher writes its own server state
            and calls router.refresh(), which re-renders the server tree but deliberately
            preserves client state — so a page that fetched its data in an effect would go on
            showing the other environment's or workspace's documents, counts and terms with the
            switch reading as already having happened. Remounting on either change is what makes
            the switcher switch anything. */}
        <main key={`${env}:${workspace.activeWorkspaceId}`} className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
