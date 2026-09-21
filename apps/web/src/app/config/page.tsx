import { ConfigScreen } from "./ConfigScreen";
import { loadBattlefieldOptions, loadPeople, requireCeo } from "@/lib/api/server";

export default async function ConfigPage() {
  const cookie = await requireCeo("/config");
  const [people, battlefields] = await Promise.all([loadPeople(cookie), loadBattlefieldOptions(cookie)]);
  return <ConfigScreen people={people} battlefields={battlefields} />;
}
