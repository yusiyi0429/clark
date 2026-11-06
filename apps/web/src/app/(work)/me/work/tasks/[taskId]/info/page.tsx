import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireMember } from "@/lib/api/server";
import { workEnabledFor } from "@/lib/work/gate";

export const metadata: Metadata = { title: "天枢" };

/** Task 详情：画在布局里（HomeShell 按地址选），页面只管登录和开关。 */
export default async function Page({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const { session } = await requireMember(`/me/work/tasks/${encodeURIComponent(taskId)}/info`);
  if (!workEnabledFor(session.personId)) redirect("/me");
  return null;
}
