import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";

export const metadata: Metadata = { title: "天枢" };

/** 别人交给你的项目（设计 16.7，只读预览）：画在布局里（HomeShell 按地址选），页面只管登录。 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireMember(`/me/work/transfers/${encodeURIComponent(id)}`);
  return null;
}
