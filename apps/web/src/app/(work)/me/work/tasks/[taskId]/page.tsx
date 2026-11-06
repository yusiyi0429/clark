import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireMember } from "@/lib/api/server";
import { workEnabledFor } from "@/lib/work/gate";

export const metadata: Metadata = { title: "天枢" };

/** 对话锚到一个 Task：页面还是新首页（布局里画），地址带着 Task，发消息时 pagePath 就是它。 */
export default async function Page({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const { session } = await requireMember(`/me/work/tasks/${encodeURIComponent(taskId)}`);
  if (!workEnabledFor(session.personId)) redirect("/me");
  return null;
}
