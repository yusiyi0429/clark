import { cookies } from "next/headers";
import { MemberWorkspace } from "@/components/member/MemberWorkspace";
import { readSession } from "@/lib/api/server";

/** 与 CEO 同样保留首页和通知；页面守卫负责携带各自 next 的登录与引导跳转。 */
export default async function MemberLayout({ children }: { children: React.ReactNode }) {
  const session = await readSession((await cookies()).toString());
  if (session?.role !== "member" || !session.onboarded) return children;
  return <MemberWorkspace displayName={session.displayName} loginId={session.loginId} viewerId={session.personId}>{children}</MemberWorkspace>;
}
