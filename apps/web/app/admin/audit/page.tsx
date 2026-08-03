import { cookies } from "next/headers";
import { auditEnabled } from "@warehousd/broker";
import { PageHeader } from "@/components/common/PageHeader";
import { getConfig } from "../../lib/broker";
import { AuditBrowser } from "./AuditBrowser";

export const metadata = {
  title: "Audit",
  description: "Every broker decision in this deployment, allowed or refused",
};

export default async function AdminAuditPage() {
  // The env cookie is HttpOnly, so the browser cannot read it — the server hands it down as the
  // filter's first-load default. Same rule the layout uses to light the environment switcher.
  const env = (await cookies()).get("wh_env")?.value === "live" ? "live" : "dev";
  // With `audit.enabled: false` the table below is empty and stays empty. An empty audit browser
  // under a heading promising "every broker decision" reads as data loss, which is a worse thing
  // for an admin to believe than the truth.
  const enabled = auditEnabled(getConfig());
  return (
    <div>
      <PageHeader
        title="Audit"
        description={
          enabled
            ? "Every broker decision in this deployment, allowed or refused. Append-only — nothing here can be edited or removed."
            : "Audit logging is turned off for this deployment (audit.enabled: false). No new decisions are being recorded; anything below predates the change."
        }
      />
      <AuditBrowser defaultEnv={env} />
    </div>
  );
}
