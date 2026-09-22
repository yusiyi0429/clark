import { BattlefieldScreen } from "./BattlefieldScreen";
import { loadBattlefieldManagement, requireCeo } from "@/lib/api/server";

export default async function BattlefieldManagementPage() {
  const cookie = await requireCeo("/config/battlefields");
  const { battlefields, issues } = await loadBattlefieldManagement(cookie);
  return <BattlefieldScreen battlefields={battlefields} issues={issues} />;
}
