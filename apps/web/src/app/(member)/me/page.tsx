import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readSession, requireMember } from "@/lib/api/server";

export const metadata: Metadata = { title: "我的工作台 · 天枢" };

/** ?planTask= 是飞书「请 X 看」带的链接：成员在首页定位到这个 Task（HomePlan），CEO 转到自己工作台里同一个面板。 */
export default async function MemberHomePage({ searchParams }: { searchParams: Promise<{ planTask?: string }> }) {
  const { planTask } = await searchParams;
  if (planTask && (await readSession((await cookies()).toString()))?.role === "ceo") redirect(`/plan-tasks/${encodeURIComponent(planTask)}`);
  await requireMember(planTask ? `/me?planTask=${encodeURIComponent(planTask)}` : "/me");
  return null;
}
