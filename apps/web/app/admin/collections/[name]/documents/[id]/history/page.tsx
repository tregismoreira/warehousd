import { PageHeader } from "@/components/common/PageHeader";
import { RevisionTimeline } from "./RevisionTimeline";

// No role check here: apps/web/app/admin/layout.tsx already guards every /admin route at
// `admin`, so a second check on this page would only repeat what the layout already refused.
export default async function Page({ params }: { params: Promise<{ name: string; id: string }> }) {
  const { name, id } = await params;
  return (
    <div className="space-y-6">
      <PageHeader title="Revision history" description={`${name} · ${id}`} />
      <RevisionTimeline collection={name} id={id} />
    </div>
  );
}
