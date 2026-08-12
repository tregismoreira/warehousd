import { AdminMembersHome } from "./AdminMembersHome";

export const metadata = {
  title: "Members",
  description: "Manage who belongs to this workspace, and their role in it",
};

export default function AdminMembersPage() {
  return <AdminMembersHome />;
}
