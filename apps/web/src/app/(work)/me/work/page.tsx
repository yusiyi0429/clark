import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";

export const metadata: Metadata = { title: "天枢" };

export default async function Page() {
  await requireMember("/me/work");
  return null;
}
