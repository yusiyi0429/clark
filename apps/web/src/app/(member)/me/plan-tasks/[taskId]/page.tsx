import { PlanTaskScreen } from "@/components/member/home/deliverable/PlanTaskScreen";
import { requireMember } from "@/lib/api/server";

/** 不在本人首页计划里的 Task（认可人、战场负责人从飞书链接进来）：二级页里只读地看约定、对表和交付物。 */
export default async function MemberPlanTaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId: segment } = await params;
  await requireMember(`/me/plan-tasks/${segment}`);
  const taskId = decodeURIComponent(segment);
  return <PlanTaskScreen key={taskId} taskId={taskId} />;
}
