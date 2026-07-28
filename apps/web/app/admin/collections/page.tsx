import { PageHeader } from "@/components/common/PageHeader";
import { CollectionsView } from "./CollectionsView";

export default function CollectionsPage() {
  return (
    <div>
      <PageHeader
        title="Collections"
        description="The governed surface, as defined in warehousd.yml. Read-only — postures live in git."
      />
      <CollectionsView />
    </div>
  );
}
