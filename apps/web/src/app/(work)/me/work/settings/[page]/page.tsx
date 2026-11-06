import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireMember } from "@/lib/api/server";
import { workEnabledFor } from "@/lib/work/gate";
import { PAGE_KEYS } from "@/components/home/view";

export const metadata: Metadata = { title: "天枢" };

/** 二级页（头像和资料、伙伴、连接、偏好）：画在布局里（HomeShell 按地址选），页面只管登录和开关。 */
export default async function Page({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  if (!(PAGE_KEYS as readonly string[]).includes(page)) notFound();
  const { session } = await requireMember(`/me/work/settings/${page}`);
  if (!workEnabledFor(session.personId)) redirect("/me");
  return null;
}
