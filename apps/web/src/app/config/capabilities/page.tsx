import { CapabilityScreen } from "./CapabilityScreen";
import { loadBattlefieldManagement, loadCapabilityManagement, loadPeople, requireCeo } from "@/lib/api/server";

export default async function CapabilityManagementPage() {
  const cookie = await requireCeo("/config/capabilities");
  const [{ capabilities }, { battlefields }, people] = await Promise.all([loadCapabilityManagement(cookie), loadBattlefieldManagement(cookie), loadPeople(cookie)]);
  return <CapabilityScreen capabilities={capabilities} battlefields={battlefields} people={people} />;
}
