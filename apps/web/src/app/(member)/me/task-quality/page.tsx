import { TaskQualityWorkbench } from "@/components/task-quality/TaskQualityWorkbench";
import { requireMember } from "@/lib/api/server";

export default async function MyTaskQualityPage() {
  await requireMember("/me/task-quality");
  return <TaskQualityWorkbench viewerRole="member" />;
}
