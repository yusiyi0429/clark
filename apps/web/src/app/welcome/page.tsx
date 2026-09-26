import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readSession } from "@/lib/api/server";
import { serverApi } from "@/lib/api/client";
import { homePath, validNextPath } from "@/lib/access-paths";
import { WelcomeFlow } from "@/components/onboarding/WelcomeFlow";

export const metadata: Metadata = { title: "你好 · 天枢", robots: { index: false, follow: false } };

export default async function WelcomePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const cookie = (await cookies()).toString();
  const session = await readSession(cookie);
  if (!session) redirect("/access?next=/welcome");
  const params = await searchParams;
  const next = typeof params.next === "string" ? validNextPath(session.role, params.next) : null;
  if (session.onboarded) redirect(next ?? homePath(session.role));
  const { data, response } = await serverApi.GET("/api/me/onboarding", { headers: { cookie } });
  if (response.status === 401) redirect("/access?next=/welcome");
  if (!response.ok || !data) throw new Error("暂时无法读取引导，请重试。");
  return <WelcomeFlow data={data} nextPath={next ?? undefined} />;
}
