import type { Metadata } from "next";
import { MemberWorkspace } from "@/components/member/MemberWorkspace";
import { requireMember } from "@/lib/api/server";

export const metadata: Metadata = { title: "我的工作台 · 天枢" };

export default async function MemberHomePage() {
  const { session } = await requireMember("/me");
  return <MemberWorkspace displayName={session.displayName} loginId={session.loginId} />;
}
