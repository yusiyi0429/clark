import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";
import { MonthPage } from "@/components/board/MonthPage";

export const metadata: Metadata = { title: "本月 · 天枢" };

export default async function Page() {
  await requireMember("/me/month");
  return <MonthPage />;
}
