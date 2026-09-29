import type { Metadata } from "next";
import { AccessScreen } from "./AccessScreen";
import { serverApi } from "@/lib/api/client";

export const metadata: Metadata = {
  title: "进入天枢 · TKOS",
  robots: { index: false, follow: false },
};

export default async function AccessPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // 演示入口只在时间机器里存在；正式环境这个接口是 404，按钮不出现。
  const demo = await serverApi.GET("/api/auth/demo").then(({ data }) => data?.displayName ?? null).catch(() => null);
  return <AccessScreen nextPath={typeof next === "string" ? next : undefined} demoName={demo} />;
}
