import {
  BadgeCheck,
  Boxes,
  FilePlus,
  FileUp,
  Key,
  KeyRound,
  ScrollText,
  ShieldCheck,
  Tags,
  Users,
  UsersRound,
  Inbox,
  ListChecks,
  Plug,
  LayoutDashboard,
  ClipboardCheck,
} from "lucide-react";
import type { Role } from "./authz";

export type NavItem = {
  href: string;
  label: string;
  icon: typeof Boxes;
  // Present only when workspaces.enabled must be on for the item to lead anywhere real —
  // AppShell filters these out otherwise, matching the 404 the route itself gives.
  workspacesOnly?: boolean;
};

// One nav list per role. A role's list contains ONLY routes that role may reach —
// the layout guards enforce it, this just avoids showing dead links.
export const NAV: Record<Role, NavItem[]> = {
  admin: [
    { href: "/admin", label: "Overview", icon: LayoutDashboard },
    { href: "/admin/collections", label: "Collections", icon: Boxes },
    { href: "/admin/taxonomies", label: "Taxonomies", icon: Tags },
    { href: "/admin/users", label: "Users & roles", icon: Users },
    { href: "/admin/members", label: "Members", icon: UsersRound, workspacesOnly: true },
    { href: "/admin/clients", label: "Clients", icon: KeyRound },
    { href: "/admin/api-keys", label: "API keys", icon: Key },
    { href: "/admin/trusted-issuers", label: "Trusted issuers", icon: BadgeCheck },
    { href: "/admin/sso", label: "SSO", icon: ShieldCheck },
    { href: "/admin/audit", label: "Audit", icon: ScrollText },
    { href: "/admin/import", label: "Import", icon: FileUp },
    { href: "/admin/documents", label: "Documents", icon: FilePlus },
  ],
  manager: [
    { href: "/manager", label: "Grant inbox", icon: Inbox },
    { href: "/manager/review", label: "Proposal review", icon: ClipboardCheck },
    { href: "/manager/grants", label: "Active grants", icon: ListChecks },
    { href: "/manager/review-access", label: "Access review", icon: ShieldCheck },
  ],
  member: [
    { href: "/member", label: "My grants", icon: ListChecks },
    { href: "/member/connect", label: "How to connect", icon: Plug },
  ],
};
