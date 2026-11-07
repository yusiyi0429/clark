import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";

export const metadata: Metadata = { title: "天枢" };

/** 总管线：画在布局里（HomeShell 按地址选），页面只管登录和开关。 */
export default async function Page() {
  await requireMember("/me/work/buddy");
  return null;
}
