import { PageHeader } from "@/components/common/PageHeader";
import { AuditBrowser } from "./AuditBrowser";

export const metadata = {
  title: "Audit",
  description: "Every broker decision in this deployment, allowed or refused",
};

export default function AdminAuditPage() {
  return (
    <div>
      <PageHeader
        title="Audit"
        description="Every broker decision in this deployment, allowed or refused. Append-only — nothing here can be edited or removed."
      />
      <AuditBrowser />
    </div>
  );
}
