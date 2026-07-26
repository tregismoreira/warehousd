import { AdminClientsHome } from "./AdminClientsHome";

export const metadata = {
  title: "OAuth clients",
  description: "Manage manually-created OAuth clients and their access scopes",
};

export default function AdminClientsPage() {
  return <AdminClientsHome />;
}
