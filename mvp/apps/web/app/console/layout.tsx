import { headers, cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import type { Role } from "@/lib/authz";
import { consoleEnabled } from "@/lib/console-gate";
import { AppShell } from "@/components/shell/AppShell";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  if (!consoleEnabled(process.env)) notFound();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");
  const role = (session.user as { role?: Role }).role ?? "member";
  const env = (await cookies()).get("wh_env")?.value === "live" ? "live" : "dev";
  const surface: Role = role === "admin" ? "admin" : role === "manager" ? "manager" : "member";
  return (
    <AppShell surface={surface} role={role} email={session.user.email} env={env} showConsole>
      {children}
    </AppShell>
  );
}
