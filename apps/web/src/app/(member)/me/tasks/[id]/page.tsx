import { notFound, redirect } from "next/navigation";
import { TaskScreen } from "@/components/tasks/TaskScreen";
import { serverApi } from "@/lib/api/client";
import { requireMember } from "@/lib/api/server";

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { cookie } = await requireMember(`/me/tasks/${id}`);
  const { data, response } = await serverApi.GET("/api/me/tasks/{id}", { params: { path: { id } }, headers: { cookie } });
  if (response.status === 401) redirect("/access");
  if (response.status === 404) notFound();
  if (!data) throw new Error(`Task query failed with ${response.status}`);
  return <TaskScreen key={data.task.id} initialDetail={data} />;
}
