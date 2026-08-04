import { cookies } from "next/headers";
import { PageHeader } from "@/components/common/PageHeader";
import { Mono } from "@/components/common/Mono";
import { UploadQueue } from "./UploadQueue";

export default async function DocumentsPage() {
  // The environment switcher decides where these land, exactly as it decides what every other
  // admin surface shows. Deliberately not a second selector on the page: the vocabulary terms
  // the form offers are loaded for one environment, and a page where you could pick a different
  // one to write to would offer dev's terms while uploading into live.
  const env = (await cookies()).get("wh_env")?.value === "live" ? "live" : "dev";

  return (
    <>
      <PageHeader
        title="Upload documents"
        description="Put files into a file collection from here instead of from disk. Text is extracted, chunked, embedded and indexed by the same path warehousd index uses."
      />
      <div className="mb-6 rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
        <p>
          The alternative is still there: copy files into the collection&rsquo;s <Mono>source</Mono>{" "}
          directory and run <Mono>warehousd index &lt;collection&gt;</Mono>. That path mirrors the
          directory — a file removed from it is removed from the collection. Uploads are not
          mirrored, so indexing later will not delete them.
        </p>
      </div>
      <UploadQueue env={env} />
    </>
  );
}
