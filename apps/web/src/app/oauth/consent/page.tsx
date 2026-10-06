import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { readSession } from "@/lib/api/server";
import { serverApi } from "@/lib/api/client";
import { OAuthConsent } from "./OAuthConsent";
import s from "./consent.module.css";

export const metadata: Metadata = { title: "允许 AI 工具连接 · 天枢", robots: { index: false, follow: false } };
export default async function ConsentPage({ searchParams }: { searchParams: Promise<{ request?: string }> }) {
  const id = (await searchParams).request;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
    return <main className={s.page}><section className={s.sheet}><h1>连接请求无效</h1><p>请返回你的 AI 工具，重新发起登录。</p></section></main>;
  const path = `/oauth/consent?request=${id}`;
  const cookie = (await cookies()).toString();
  const session = await readSession(cookie);
  if (!session) redirect(`/access?next=${encodeURIComponent(path)}`);
  const { data, error } = await serverApi.GET("/api/mcp-oauth/requests/{id}", { params: { path: { id } }, headers: { cookie }, cache: "no-store" });
  if (!data) return <main className={s.page}><section className={s.sheet}><h1>暂时无法授权</h1><p>{error?.message ?? "连接请求已过期，请返回 AI 工具重新登录。"}</p></section></main>;
  return <OAuthConsent requestId={id} consent={data} displayName={session.displayName} />;
}
