import { notFound, redirect } from "next/navigation";
import { serverApi } from "@/lib/api/client";

const access = (path: string) => `/access?next=${encodeURIComponent(path)}`;

/** 本人雷达设置与最近一次扫描；服务失败不能伪装成「没开」。 */
export async function loadMyRadar(cookie: string) {
  const { data, response } = await serverApi.GET("/api/me/radar", { headers: { cookie } });
  if (response.status === 401) redirect(access("/me/radar"));
  if (!response.ok || !data) throw new Error(`My radar query failed with ${response.status}`);
  return data;
}

/** 本人的个人信号（不含已隐藏），新到旧；服务失败不能伪装成「没有信号」。 */
export async function loadMyRadarSignals(cookie: string) {
  const { data, response } = await serverApi.GET("/api/me/radar/signals", { headers: { cookie } });
  if (response.status === 401) redirect(access("/me/radar"));
  if (!response.ok || !data) throw new Error(`My radar signals query failed with ${response.status}`);
  return data.signals;
}

/** 一条个人信号：不存在、属于别人与不是 UUID 都走同一个 404。 */
export async function loadMyRadarSignal(cookie: string, id: string) {
  const { data, response } = await serverApi.GET("/api/me/radar/signals/{id}", { params: { path: { id } }, headers: { cookie } });
  if (response.status === 401) redirect(access(`/me/radar/signals/${id}`));
  if (response.status === 403 || response.status === 404) notFound();
  if (!response.ok || !data) throw new Error(`My radar signal query failed with ${response.status}`);
  return data;
}
