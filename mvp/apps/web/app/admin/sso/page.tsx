import { PageHeader } from "@/components/common/PageHeader";
import { SsoProviders } from "./SsoProviders";

export const metadata = {
  title: "SSO",
  description: "Manage SSO providers and configuration",
};

export default function AdminSsoPage() {
  return (
    <div>
      <PageHeader
        title="SSO"
        description="Connect your identity provider. First sign-in provisions a member; you promote roles here."
      />
      <SsoProviders />
    </div>
  );
}
