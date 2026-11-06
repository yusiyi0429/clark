import { cookies } from "next/headers";
import { WorkHome } from "@/components/work/WorkHome";
import { readSession } from "@/lib/api/server";
import { workEnabledFor } from "@/lib/work/gate";

/**
 * 新首页（V2 设计第 20.4 节）：三栏，按人打开。不套老工作台，也不套 V2 的图标栏，所以单放一个路由组；老首页 /me 不动。
 * 没登录、没走完引导、没打开开关时由页面带去登录、引导或老首页。
 */
export default async function WorkLayout({ children }: { children: React.ReactNode }) {
  const session = await readSession((await cookies()).toString());
  if (session?.role !== "member" || !session.onboarded || !workEnabledFor(session.personId)) return children;
  return <WorkHome account={{ personId: session.personId, displayName: session.displayName, loginId: session.loginId, role: "member" }}>{children}</WorkHome>;
}
