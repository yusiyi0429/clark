import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";

export const metadata: Metadata = { title: "天枢" };

/** 同事对话（/me/work/chats/with/<id>、/from/<id>）：画在布局里（HomeShell 按地址选），页面只管登录。 */
export default async function Page({ params }: { params: Promise<{ rest: string[] }> }) {
  const { rest } = await params;
  await requireMember(`/me/work/chats/${rest.map(encodeURIComponent).join("/")}`);
  return null;
}
