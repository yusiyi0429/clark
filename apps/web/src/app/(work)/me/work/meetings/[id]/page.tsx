import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";

export const metadata: Metadata = { title: "天枢" };

/** 会议页（从老界面 /me/meetings/<id> 挪过来，只换外壳）：画在布局里（HomeShell 按地址选），页面只管登录。 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireMember(`/me/work/meetings/${encodeURIComponent(id)}`);
  return null;
}
