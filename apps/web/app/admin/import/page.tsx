import { Info } from "lucide-react";
import { PageHeader } from "@/components/common/PageHeader";
import { Mono } from "@/components/common/Mono";
import { ImportForm } from "./ImportForm";

export default function ImportPage() {
  return (
    <>
      <PageHeader
        title="Import live data"
        description="The only write path into data_live. Rows are validated against warehousd.yml, written by a role that cannot read them back, and audited."
      />
      {/* The environment switcher is in the header of this page like every other, and here it
          decides nothing: import writes data_live by definition, and there is no parameter that
          could point it anywhere else (see api/admin/import/route.ts). Saying so beats letting
          somebody flip to dev and believe they are loading a sandbox. */}
      <div className="mb-6 flex gap-3 rounded-lg border border-pending/30 bg-pending/5 p-4">
        <Info className="size-5 shrink-0 text-pending" />
        <div className="text-sm">
          <p className="font-medium">This always writes live, whatever the switcher says</p>
          <p className="mt-1 text-muted-foreground">
            Import is the only write path into <Mono>data_live</Mono>, and the environment switcher
            does not apply to it. Synthetic <Mono>dev</Mono> data is generated, never imported —
            regenerate it from the overview page instead.
          </p>
        </div>
      </div>
      <ImportForm />
    </>
  );
}
