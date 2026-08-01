import { cookies } from "next/headers";
import { PageHeader } from "@/components/common/PageHeader";
import { AuditBrowser } from "./AuditBrowser";

export const metadata = {
  title: "Audit",
  description: "Every broker decision in this deployment, allowed or refused",
};

export default async function AdminAuditPage() {
  // The env cookie is HttpOnly, so the browser cannot read it — the server hands it down as the
  // filter's first-load default. Same rule the layout uses to light the environment switcher.
  const env = (await cookies()).get("wh_env")?.value === "live" ? "live" : "dev";
  return (
    <div>
      <PageHeader
        title="Audit"
        description="Every broker decision in this deployment, allowed or refused. Append-only — nothing here can be edited or removed."
      />
      <AuditBrowser defaultEnv={env} />
    </div>
  );
}
