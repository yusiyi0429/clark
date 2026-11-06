import type { Metadata } from "next";
import { requireMember } from "@/lib/api/server";
import { PluginsPage } from "@/components/local/PluginsPage";

export const metadata: Metadata = { title: "插件 · 天枢" };

export default async function Page() {
  const { session } = await requireMember("/me/plugins");
  return <PluginsPage account={{ personId: session.personId, displayName: session.displayName, loginId: session.loginId, role: "member" }} />;
}
