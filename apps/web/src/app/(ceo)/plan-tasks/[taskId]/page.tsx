import { PlanTaskScreen } from "@/components/member/home/deliverable/PlanTaskScreen";
import { requireCeo } from "@/lib/api/server";

/** CEO 从飞书链接（/me?planTask=…）进来时落到这里：只读地看这个 Task 的约定、对表和交付物。 */
export default async function CeoPlanTaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId: segment } = await params;
  await requireCeo(`/plan-tasks/${segment}`);
  const taskId = decodeURIComponent(segment);
  return <PlanTaskScreen key={taskId} taskId={taskId} />;
}
