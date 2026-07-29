import { PageHeader } from "@/components/common/PageHeader";
import { TrustedIssuers } from "./TrustedIssuers";

export const metadata = {
  title: "Trusted issuers",
  description: "Identity providers whose tokens may be exchanged for warehousd tokens",
};

export default function AdminTrustedIssuersPage() {
  return (
    <div>
      <PageHeader
        title="Trusted issuers"
        description="An issuer registered here may have its JWTs exchanged for a warehousd token at /v1/token. The token's subject becomes the acting user, so grants are still checked per person — not per service account."
      />
      <TrustedIssuers />
    </div>
  );
}
