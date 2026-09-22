import { ConfigScreen } from "./ConfigScreen";
import { loadBattlefieldOptions, loadPeople, loadStrategyConfig, requireCeo } from "@/lib/api/server";

export default async function ConfigPage() {
  const cookie = await requireCeo("/config");
  const [people, battlefields, strategy] = await Promise.all([loadPeople(cookie), loadBattlefieldOptions(cookie), loadStrategyConfig(cookie)]);
  return <ConfigScreen people={people} battlefields={battlefields} strategy={strategy} />;
}
