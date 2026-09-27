import type { Metadata } from "next";
import { MemberRadarScreen } from "@/components/radar/MemberRadarScreen";
import { loadMyRadar, loadMyRadarSignals } from "@/components/radar/loadMyRadar";
import { requireMember } from "@/lib/api/server";

export const metadata: Metadata = { title: "我的雷达 · 天枢" };

/** 成员的个人雷达：在成员外壳的展开区里打开，不挂对话右列（个人信号只给本人看，成员只有全局对话）。 */
export default async function MyRadarPage() {
  const { cookie } = await requireMember("/me/radar");
  const [radar, signals] = await Promise.all([loadMyRadar(cookie), loadMyRadarSignals(cookie)]);
  return <MemberRadarScreen radar={radar} signals={signals} />;
}
