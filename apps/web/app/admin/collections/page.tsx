import { PageHeader } from "@/components/common/PageHeader";
import { CollectionsList } from "./CollectionsList";

export default function CollectionsPage() {
  return (
    <div>
      <PageHeader
        title="Collections"
        description="The governed surface, as defined in warehousd.yml. Postures live in git — open a collection to see its fields, taxonomies, files and data."
      />
      <CollectionsList />
    </div>
  );
}
