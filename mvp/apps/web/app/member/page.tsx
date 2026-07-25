import { PageHeader } from "@/components/common/PageHeader";
import { MyGrants } from "./MyGrants";

export default function MemberPage() {
  return (
    <>
      <PageHeader
        title="My grants"
        description="Access is deny-by-default: a collection is invisible until a grant covers it, and every grant is evaluated at query time."
      />
      <MyGrants />
    </>
  );
}
