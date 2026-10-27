import { TaskQualityWorkbench } from "@/components/task-quality/TaskQualityWorkbench";
import { requireCeo } from "@/lib/api/server";

export default async function TaskQualityPage() {
  await requireCeo("/task-quality");
  return <TaskQualityWorkbench viewerRole="ceo" />;
}
