import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readSession, requireMember } from "@/lib/api/server";
import { workEnabledFor } from "@/lib/work/gate";

export const metadata: Metadata = { title: "我的工作台 · 天枢" };

/**
 * ?planTask= 是飞书、MCP「请 X 看」带的链接：成员在首页定位到这个 Task（HomePlan），CEO 转到自己工作台里同一个面板。
 * 进出口（新首页设计 9.8）：试点名单里的人（TIANSHU_WORK_PEOPLE）进 /me 直接到新首页，带 planTask 的到新首页里那件 Task 的管线；
 * 老页面的「返回首页」都指向 /me，也就跟着回到新首页。老首页留给名单外的人。
 */
export default async function MemberHomePage({ searchParams }: { searchParams: Promise<{ planTask?: string }> }) {
  const { planTask } = await searchParams;
  if (planTask && (await readSession((await cookies()).toString()))?.role === "ceo") redirect(`/plan-tasks/${encodeURIComponent(planTask)}`);
  const { session } = await requireMember(planTask ? `/me?planTask=${encodeURIComponent(planTask)}` : "/me");
  if (workEnabledFor(session.personId)) redirect(planTask ? `/me/work/tasks/${encodeURIComponent(planTask)}` : "/me/work");
  return null;
}
