import { PageHeader } from "@/components/common/PageHeader";
import { ConnectGuide } from "./ConnectGuide";

export default function ConnectPage() {
  return (
    <>
      <PageHeader
        title="How to connect"
        description="Point an MCP client at this deployment. Your grants travel with your identity, not with the client."
      />
      <ConnectGuide />
    </>
  );
}
