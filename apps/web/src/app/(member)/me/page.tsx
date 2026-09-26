import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";

export const metadata: Metadata = { title: "我的工作台 · 天枢" };

export default async function MemberHomePage() {
  await requireMember("/me");
  return null;
}
