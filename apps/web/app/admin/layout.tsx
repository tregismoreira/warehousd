import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { atLeast, type Role } from "@/lib/authz";
import { AppShell } from "@/components/shell/AppShell";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");
  const role = (session.user as { role?: Role }).role ?? "member";
  // UX guard only — every /api/admin/* route repeats this check with requireRole.
  if (!atLeast(role, "admin")) redirect("/403");
  const env = (await cookies()).get("wh_env")?.value === "live" ? "live" : "dev";
  return (
    <AppShell
      surface="admin" role={role} email={session.user.email} env={env}
      showConsole={process.env.NODE_ENV !== "production" || process.env.WAREHOUSD_DEMO === "true"}
    >
      {children}
    </AppShell>
  );
}
