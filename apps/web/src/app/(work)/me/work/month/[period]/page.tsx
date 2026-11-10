import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireMember } from "@/lib/api/server";

export const metadata: Metadata = { title: "天枢" };

/** 月份页（复盘、敲定、延续，设计第 10 节）：画在布局里（HomeShell 按地址选），页面只管登录和开关。 */
export default async function Page({ params }: { params: Promise<{ period: string }> }) {
  const { period } = await params;
  if (!/^\d{4}-\d{2}$/.test(period)) notFound();
  await requireMember(`/me/work/month/${period}`);
  return null;
}
