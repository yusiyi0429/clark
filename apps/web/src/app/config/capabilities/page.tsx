import { CapabilityScreen } from "./CapabilityScreen";
import { loadBattlefieldManagement, loadCapabilityManagement, requireCeo } from "@/lib/api/server";

export default async function CapabilityManagementPage() {
  const cookie = await requireCeo("/config/capabilities");
  const [{ capabilities }, { battlefields }] = await Promise.all([loadCapabilityManagement(cookie), loadBattlefieldManagement(cookie)]);
  return <CapabilityScreen capabilities={capabilities} battlefields={battlefields} />;
}
