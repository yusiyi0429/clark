import { cookies } from "next/headers";
import { V2Shell } from "@/components/rail/V2Shell";
import { readSession } from "@/lib/api/server";

/**
 * 新骨架（V2）：对话、本月、Task、卡和专题的子会话、插件。路径仍在 /me 下，但不套老工作台（MemberWorkspace），
 * 所以单放一个路由组；老首页 /me 和它的二级页不动。没登录、没走完引导时由各页的 requireMember 带去登录或引导。
 */
export default async function V2Layout({ children }: { children: React.ReactNode }) {
  const session = await readSession((await cookies()).toString());
  if (session?.role !== "member" || !session.onboarded) return children;
  return <V2Shell account={{ personId: session.personId, displayName: session.displayName, loginId: session.loginId, role: "member" }}>{children}</V2Shell>;
}
