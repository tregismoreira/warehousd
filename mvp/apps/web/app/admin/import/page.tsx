import { PageHeader } from "@/components/common/PageHeader";
import { ImportForm } from "./ImportForm";

export default function ImportPage() {
  return (
    <>
      <PageHeader
        title="Import live data"
        description="The only write path into data_live. Rows are validated against warehousd.yml, written by a role that cannot read them back, and audited."
      />
      <ImportForm />
    </>
  );
}
