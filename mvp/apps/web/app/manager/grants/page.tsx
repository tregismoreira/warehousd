import { PageHeader } from "@/components/common/PageHeader";
import { ActiveGrants } from "./ActiveGrants";

export default function ActiveGrantsPage() {
  return (
    <>
      <PageHeader
        title="Active grants"
        description="Every approved grant in this deployment. Revocation takes effect on the next query."
      />
      <ActiveGrants />
    </>
  );
}
