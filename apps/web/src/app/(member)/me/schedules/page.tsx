import { SchedulesScreen } from "@/components/collections/SchedulesScreen";
import { requireMember } from "@/lib/api/server";

export default async function MySchedulesPage() {
  await requireMember("/me/schedules");
  return <SchedulesScreen />;
}
