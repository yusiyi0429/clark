import { AdminScreen } from "@/components/admin/AdminScreen";
import { loadAdminOverview } from "@/components/admin/loadAdminOverview";
import { requireMember } from "@/lib/api/server";

export default async function MyAdminPage() {
  const { cookie } = await requireMember("/me/admin");
  return <AdminScreen initial={await loadAdminOverview(cookie)} />;
}
