import { unstable_rethrow } from "next/navigation";
import { MemberSignalScreen } from "@/components/radar/MemberSignalScreen";
import { loadMyRadarSignal, loadMyRadarSignals } from "@/components/radar/loadMyRadar";
import { requireMember } from "@/lib/api/server";

export default async function MyRadarSignalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { cookie } = await requireMember(`/me/radar/signals/${id}`);
  const signal = await loadMyRadarSignal(cookie, id);
  // 「继续浏览」用列表同一份信号；列表读不到时文章照常打开（登录失效等跳转照旧抛出）。
  const list = await loadMyRadarSignals(cookie).catch((error: unknown) => {
    unstable_rethrow(error);
    return [];
  });
  return <MemberSignalScreen key={signal.id} signal={signal} list={list} />;
}
