import { cookies } from "next/headers";
import { HomeShell } from "@/components/home/HomeShell";
import { readSession } from "@/lib/api/server";
import { workEnabledFor } from "@/lib/work/gate";

/**
 * 新首页（新首页_伙伴总管线与Task管线_2026-11-07）：左栏伙伴和 Task 树、中间展示区、右边后台任务，按人打开。
 * 不套老工作台，也不套 V2 的图标栏，所以单放一个路由组；老首页 /me 不动。展示区的五种内容由地址决定，页面本身不画东西。
 * 没登录、没走完引导、没打开开关时由页面带去登录、引导或老首页。
 */
export default async function WorkLayout({ children }: { children: React.ReactNode }) {
  const session = await readSession((await cookies()).toString());
  if (session?.role !== "member" || !session.onboarded || !workEnabledFor(session.personId)) return children;
  return <>{children}<HomeShell account={{ personId: session.personId, displayName: session.displayName, loginId: session.loginId, role: "member" }} /></>;
}
