import type { TActionDescriptor, TCollectionView, TScheduleItem } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";
import { REQUESTS_CHANGED, RequestApiError } from "@/components/requests/requestApi";

/** ③ 信息收集的浏览器端调用：失败统一抛 RequestApiError，文案用服务端给的那句；改动后提醒通知栏重读。 */
async function settle<T>(promise: Promise<{ data?: T; response: Response; error?: unknown }>, fallback: string): Promise<T> {
  const result = await promise;
  if (result.response.status === 401) { window.location.assign("/access"); throw new RequestApiError("登录已过期", 401); }
  if (!result.response.ok || !result.data) {
    const failure = result.error as { message?: string; code?: string } | undefined;
    const message = failure?.code === "VERSION_CONFLICT" ? "内容刚更新过，已换成最新的，请再看一遍" : failure?.message ?? fallback;
    throw new RequestApiError(message, result.response.status, failure?.code);
  }
  return result.data;
}

export async function readCollection(id: string): Promise<TCollectionView> {
  return (await settle(browserApi.GET("/api/collections/{id}", { params: { path: { id } } }), "没有读到这次收集")).collection;
}

export async function readCollectionRound(requestId: string): Promise<TCollectionView> {
  return (await settle(browserApi.GET("/api/requests/{id}/collection", { params: { path: { id: requestId } } }), "没有读到这次收集")).collection;
}

export async function runCollectionAction(action: TActionDescriptor, input?: unknown): Promise<TCollectionView> {
  const result = await settle(browserApi.POST("/api/collections/actions/execute", { body: { actionId: action.actionId, ...(input === undefined ? {} : { input }) } }), "没有成功，请重试");
  window.dispatchEvent(new Event(REQUESTS_CHANGED));
  return result.collection;
}

export async function readSchedules(): Promise<TScheduleItem[]> {
  return (await settle(browserApi.GET("/api/me/schedules"), "没有读到定时任务")).items;
}

/** ISO → 日期时间选择器的值「2026-10-24T18:00」（公司时区）。 */
export function toPickerValue(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString("sv-SE", { timeZone: COMPANY_TIMEZONE })}T${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: COMPANY_TIMEZONE })}`;
}
/** 日期时间选择器的值（公司时区）→ ISO。 */
export const fromPickerValue = (value: string) => new Date(`${value}:00+08:00`).toISOString();

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
/** 「10/24 周五 18:00」。 */
export function deadlineText(iso: string | null | undefined): string {
  if (!iso) return "";
  const value = toPickerValue(iso);
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`).getUTCDay();
  return `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))} 周${WEEKDAYS[day]} ${value.slice(11)}`;
}

/** 收集一轮的页面在哪：成员工作台在 /me 下面。 */
export const requestsBase = () => (window.location.pathname === "/me" || window.location.pathname.startsWith("/me/") ? "/me/requests" : "/requests");
