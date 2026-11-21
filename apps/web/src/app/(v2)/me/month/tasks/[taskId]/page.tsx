import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";
import { TaskPage } from "@/components/board/TaskPage";

export const metadata: Metadata = { title: "Task · 天枢" };

export default async function Page({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  await requireMember(`/me/month/tasks/${encodeURIComponent(taskId)}`);
  return <TaskPage taskId={taskId} />;
}
