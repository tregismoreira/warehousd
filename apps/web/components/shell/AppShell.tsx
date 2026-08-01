"use client";
// Load-bearing: NAV items carry a lucide `icon` component, and a component reference cannot
// be serialized across a server→client boundary. Without this the shell renders on the server
// and every authenticated surface dies on `<SidebarNav items={items} />`. Children still
// arrive pre-rendered from the server layouts, so nothing else moves to the client.
import { NAV } from "@/lib/nav";
import type { Role } from "@/lib/authz";
import { SidebarNav } from "./SidebarNav";
import { EnvSwitcher } from "./EnvSwitcher";
import { UserMenu } from "./UserMenu";

export function AppShell({
  surface,
  role,
  email,
  env,
  children,
}: {
  surface: Role;
  role: Role;
  email: string;
  env: "dev" | "live";
  children: React.ReactNode;
}) {
  const items = NAV[surface];
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-60 shrink-0 flex-col border-r">
        <div className="flex h-14 items-center px-5 text-sm font-semibold">
          warehousd
          <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground">
            security console
          </span>
        </div>
        <SidebarNav items={items} />
      </aside>
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-end gap-3 border-b px-6">
          <EnvSwitcher initial={env} />
          <UserMenu email={email} role={role} />
        </header>
        {/* Keyed on env. The switcher writes the cookie and calls router.refresh(), which
            re-renders the server tree but deliberately preserves client state — so a page that
            fetched its data in an effect would go on showing the other environment's documents,
            counts and terms with the toggle reading `live`. Remounting on the change is what
            makes the switcher switch anything. */}
        <main key={env} className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
