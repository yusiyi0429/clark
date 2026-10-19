import { AdminScreen } from "@/components/admin/AdminScreen";
import { loadAdminOverview } from "@/components/admin/loadAdminOverview";
import { requireCeo } from "@/lib/api/server";

export default async function AdminPage() {
  const cookie = await requireCeo("/admin");
  return <AdminScreen initial={await loadAdminOverview(cookie)} />;
}
