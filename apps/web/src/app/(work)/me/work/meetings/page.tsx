import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";

export const metadata: Metadata = { title: "天枢" };

/** 会议页（接下来、已开完，11/16 重新设计第 5 节）：画在布局里（HomeShell 按地址选），页面只管登录。 */
export default async function Page() {
  await requireMember("/me/work/meetings");
  return null;
}
