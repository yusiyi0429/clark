import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";

export const metadata: Metadata = { title: "天枢" };

/** Mission 详情（设计 14.2）：画在布局里（HomeShell 按地址选），页面只管登录。 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireMember(`/me/work/missions/${encodeURIComponent(id)}`);
  return null;
}
