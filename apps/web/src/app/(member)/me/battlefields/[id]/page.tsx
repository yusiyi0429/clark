import { MemberBattlefieldScreen } from "@/components/member/MemberBattlefieldScreen";
import { loadMemberBattlefield } from "@/components/member/loadMemberBattlefield";
import { requireMember } from "@/lib/api/server";

export default async function MemberBattlefieldPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { cookie } = await requireMember(`/me/battlefields/${id}`);
  const data = await loadMemberBattlefield(cookie, id);
  return <MemberBattlefieldScreen key={data.id} initialData={data} />;
}
