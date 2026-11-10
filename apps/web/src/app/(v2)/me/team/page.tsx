import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";
import { TeamPage } from "@/components/team/TeamPage";

export const metadata: Metadata = { title: "技能 · 天枢" };

export default async function Page() {
  await requireMember("/me/team");
  return <TeamPage />;
}
