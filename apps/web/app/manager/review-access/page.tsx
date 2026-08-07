import { PageHeader } from "@/components/common/PageHeader";
import { AccessReview } from "./AccessReview";

export default function AccessReviewPage() {
  return (
    <>
      <PageHeader
        title="Access review"
        description="Every approved grant older than the window, with when it was last exercised. A grant nobody has used is the easiest one to revoke."
      />
      <AccessReview />
    </>
  );
}
