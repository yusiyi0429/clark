import { BattlefieldScreen } from "./BattlefieldScreen";
import { loadBattlefieldManagement, loadPeople, requireCeo } from "@/lib/api/server";

export default async function BattlefieldManagementPage() {
  const cookie = await requireCeo("/config/battlefields");
  const [{ battlefields, issues }, people] = await Promise.all([loadBattlefieldManagement(cookie), loadPeople(cookie)]);
  return <BattlefieldScreen battlefields={battlefields} issues={issues} people={people} />;
}
