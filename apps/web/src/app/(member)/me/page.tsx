import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readSession, requireMember } from "@/lib/api/server";

export const metadata: Metadata = { title: "我的工作台 · 天枢" };

/**
 * ?planTask= 是飞书、MCP「请 X 看」带的链接：成员在首页定位到这个 Task（HomePlan），CEO 转到自己工作台里同一个面板。
 * 进出口（新首页设计 9.8，第 15 节改）：成员进 /me 一律到新首页，带 planTask 的到新首页里那件 Task（别人的是只读详情）；
 * 老页面的「返回首页」都指向 /me，也就跟着回到新首页。
 */
export default async function MemberHomePage({ searchParams }: { searchParams: Promise<{ planTask?: string; _entry?: string }> }) {
  const { planTask, _entry } = await searchParams;
  if (planTask && (await readSession((await cookies()).toString()))?.role === "ceo") redirect(`/plan-tasks/${encodeURIComponent(planTask)}`);
  await requireMember(planTask ? `/me?planTask=${encodeURIComponent(planTask)}` : "/me");
  // 从登录页进来的 ?_entry=unlock 带过去，新首页据此淡入（19.4）。
  redirect(planTask ? `/me/work/tasks/${encodeURIComponent(planTask)}` : _entry === "unlock" ? "/me/work?_entry=unlock" : "/me/work");
}
