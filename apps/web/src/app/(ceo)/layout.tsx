import { cookies } from "next/headers";
import { CeoWorkspace } from "@/components/shell/CeoWorkspace";
import { loadHomeCards, readSession } from "@/lib/api/server";

/**
 * CEO 工作面：首页看板、通知栏与对话条常驻在这一层，对象页作为 children 在主区原地打开
 * （clark 同：总览 DOM 保留，关闭回到来源）。未登录或成员身份时交给各页面自己的 requireCeo 跳转（带上正确的 next）。
 */
export default async function CeoLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const cookie = jar.toString();
  const session = await readSession(cookie);
  if (session?.role !== "ceo" || !session.onboarded) return children;
  const { cards } = await loadHomeCards(cookie);
  return (
    <CeoWorkspace initialCards={cards} viewerId={session.personId} account={{ personId: session.personId, displayName: session.displayName, loginId: session.loginId, role: "ceo" }}>
      {children}
    </CeoWorkspace>
  );
}
