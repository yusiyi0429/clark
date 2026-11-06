import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireMember } from "@/lib/api/server";
import { workEnabledFor } from "@/lib/work/gate";

export const metadata: Metadata = { title: "天枢" };

export default async function Page() {
  const { session } = await requireMember("/me/work");
  if (!workEnabledFor(session.personId)) redirect("/me");
  return null;
}
