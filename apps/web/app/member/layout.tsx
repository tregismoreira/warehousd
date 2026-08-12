import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { atLeast, type Role } from "@/lib/authz";
import { activeWorkspaceIdFromSession } from "@/lib/session";
import { workspaceShellData } from "@/lib/workspace-shell";
import { AppShell } from "@/components/shell/AppShell";

export default async function MemberLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");
  const role = (session.user as { role?: Role }).role ?? "member";
  if (!atLeast(role, "member")) redirect("/403");
  const env = (await cookies()).get("wh_env")?.value === "live" ? "live" : "dev";
  const workspace = await workspaceShellData(
    session.user.id,
    activeWorkspaceIdFromSession(session),
  );
  return (
    <AppShell
      surface="member"
      role={role}
      email={session.user.email}
      env={env}
      workspace={workspace}
    >
      {children}
    </AppShell>
  );
}
