import { MemberBattlefieldScreen } from "@/components/member/MemberBattlefieldScreen";
import { loadMemberBattlefield } from "@/components/member/loadMemberBattlefield";
import { requireMember } from "@/lib/api/server";

export default async function MemberBattlefieldPage({ params }: { params: Promise<{ id: string }> }) {
  // 路由段是 percent-encoded 的原始 segment（战场 id 可能是中文），先解码再交给 openapi-fetch，避免双编码。
  const { id: segment } = await params;
  const { cookie } = await requireMember(`/me/battlefields/${segment}`);
  const data = await loadMemberBattlefield(cookie, decodeURIComponent(segment));
  return <MemberBattlefieldScreen key={data.id} initialData={data} />;
}
