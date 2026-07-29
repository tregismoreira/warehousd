import { AdminApiKeysHome } from "./AdminApiKeysHome";

export const metadata = {
  title: "API keys",
  description: "Manage REST API credentials for automated access",
};

export default function AdminApiKeysPage() {
  return <AdminApiKeysHome />;
}
