import { CreateTaskScreen } from "@/components/tasks/CreateTaskScreen";
import { requireMember } from "@/lib/api/server";

/** 从某个 Task 的「我的事项」点进来时带 missionId、taskId：预先选好所属 Mission 和 Task。 */
export default async function NewTaskPage({ searchParams }: { searchParams: Promise<{ missionId?: string; taskId?: string }> }) {
  await requireMember("/me/tasks/new");
  const { missionId, taskId } = await searchParams;
  // 换了一个 Task 再点进来时重新开一张，不沿用上一张的选择。
  return <CreateTaskScreen key={`${missionId ?? ""}:${taskId ?? ""}`} missionId={missionId || undefined} taskId={taskId || undefined} />;
}
