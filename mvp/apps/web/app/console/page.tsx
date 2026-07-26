import { PageHeader } from "@/components/common/PageHeader";
import { Chat } from "../components/Chat";

export default function ConsolePage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Chat console"
        description="A local MCP test bench. Every tool call runs through the broker and is audited like any other client."
      />
      <div className="min-h-0 flex-1"><Chat /></div>
    </div>
  );
}
