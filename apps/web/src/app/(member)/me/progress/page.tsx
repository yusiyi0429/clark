import { BattlefieldProgressScreen } from "@/components/progress/BattlefieldProgressScreen";
import { requireMember } from "@/lib/api/server";

export default async function MyProgressPage() {
  await requireMember("/me/progress");
  return <BattlefieldProgressScreen />;
}
