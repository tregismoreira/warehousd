import { PageHeader } from "@/components/common/PageHeader";
import { UsersTable } from "./UsersTable";

export const metadata = {
  title: "Users & roles",
  description: "Manage user roles and permissions",
};

export default function AdminUsersPage() {
  return (
    <div>
      <PageHeader
        title="Users & roles"
        description="Manage user roles and access levels across your workspace."
      />
      <UsersTable />
    </div>
  );
}
