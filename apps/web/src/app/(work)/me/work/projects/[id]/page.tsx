import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";

export const metadata: Metadata = { title: "天枢" };

/** 项目页（设计 16.3）：画在布局里（HomeShell 按地址选），页面只管登录。 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireMember(`/me/work/projects/${encodeURIComponent(id)}`);
  return null;
}
