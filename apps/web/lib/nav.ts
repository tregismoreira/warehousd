import {
  Boxes, FileUp, KeyRound, ScrollText, ShieldCheck, Users,
  Inbox, ListChecks, Plug, MessagesSquare, LayoutDashboard,
} from "lucide-react";
import type { Role } from "./authz";

export type NavItem = { href: string; label: string; icon: typeof Boxes };

// One nav list per role. A role's list contains ONLY routes that role may reach —
// the layout guards enforce it, this just avoids showing dead links.
export const NAV: Record<Role, NavItem[]> = {
  admin: [
    { href: "/admin", label: "Overview", icon: LayoutDashboard },
    { href: "/admin/collections", label: "Collections", icon: Boxes },
    { href: "/admin/users", label: "Users & roles", icon: Users },
    { href: "/admin/clients", label: "Clients", icon: KeyRound },
    { href: "/admin/sso", label: "SSO", icon: ShieldCheck },
    { href: "/admin/audit", label: "Audit", icon: ScrollText },
    { href: "/admin/import", label: "Import", icon: FileUp },
  ],
  manager: [
    { href: "/manager", label: "Grant inbox", icon: Inbox },
    { href: "/manager/grants", label: "Active grants", icon: ListChecks },
  ],
  member: [
    { href: "/member", label: "My grants", icon: ListChecks },
    { href: "/member/connect", label: "How to connect", icon: Plug },
  ],
};

// The chat console is a dev bench, not a product surface.
export const CONSOLE_ITEM: NavItem = { href: "/console", label: "Chat console", icon: MessagesSquare };
