import { PageHeader } from "@/components/common/PageHeader";
import { TaxonomiesView } from "./TaxonomiesView";

export const metadata = {
  title: "Taxonomies",
  description: "The vocabularies grants are scoped to",
};

export default function AdminTaxonomiesPage() {
  return (
    <div>
      <PageHeader
        title="Taxonomies"
        description="The vocabularies a grant's document filter narrows on. A grant scoped to a term makes every other term's documents silently absent — so this is the list of scopes an approver can hand out."
      />
      <TaxonomiesView />
    </div>
  );
}
