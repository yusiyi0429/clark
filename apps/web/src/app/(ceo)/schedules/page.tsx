import { SchedulesScreen } from "@/components/collections/SchedulesScreen";
import { requireCeo } from "@/lib/api/server";

export default async function SchedulesPage() {
  await requireCeo("/schedules");
  return <SchedulesScreen />;
}
