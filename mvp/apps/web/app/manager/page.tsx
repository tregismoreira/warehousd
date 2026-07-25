import { PageHeader } from "@/components/common/PageHeader";
import { Inbox } from "./Inbox";

export default function ManagerPage() {
  return (
    <>
      <PageHeader title="Grant inbox" description="Requests waiting on your decision." />
      <Inbox />
    </>
  );
}
