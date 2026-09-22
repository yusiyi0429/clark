import { CapabilityScreen } from "./CapabilityScreen";
import { loadCapabilityManagement, requireCeo } from "@/lib/api/server";

export default async function CapabilityManagementPage() {
  const cookie = await requireCeo("/config/capabilities");
  const { capabilities } = await loadCapabilityManagement(cookie);
  return <CapabilityScreen capabilities={capabilities} />;
}
