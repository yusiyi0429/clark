/**
 * 新首页展示区的内容，由地址决定：
 * /me/work 首页 · /me/work/buddy 总管线 · /me/work/tasks/<id> Task 管线 · /me/work/tasks/<id>/info Task 详情 ·
 * /me/work/cards/<id>、/me/work/topics/<id> 子会话 ·
 * /me/work/settings/<页> 二级页（头像和资料、伙伴、连接、偏好，设计 9.4）· /me/work/month/<YYYY-MM> 月份页（第 10 节）。
 */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { BackgroundScope } from "@/lib/home/types";
import { isPage, type PageKey } from "./pageKeys";

export type View =
  | { kind: "home" }
  | { kind: "buddy" }
  | { kind: "task"; taskId: string }
  | { kind: "info"; taskId: string }
  | { kind: "card"; id: string }
  | { kind: "topic"; id: string }
  | { kind: "page"; page: PageKey }
  | { kind: "month"; period: string };

export { PAGE_KEYS, PAGE_TITLE, monthHref, pageHref, type PageKey } from "./pageKeys";

export function viewOf(pathname: string): View {
  const parts = pathname.replace(/\/+$/, "").split("/").slice(3).map((part) => decodeURIComponent(part));
  if (parts[0] === "buddy") return { kind: "buddy" };
  if (parts[0] === "tasks" && parts[1]) return parts[2] === "info" ? { kind: "info", taskId: parts[1] } : { kind: "task", taskId: parts[1] };
  if (parts[0] === "cards" && parts[1]) return { kind: "card", id: parts[1] };
  if (parts[0] === "topics" && parts[1]) return { kind: "topic", id: parts[1] };
  if (parts[0] === "settings" && isPage(parts[1])) return { kind: "page", page: parts[1] };
  if (parts[0] === "month" && parts[1] && /^d{4}-d{2}$/.test(parts[1])) return { kind: "month", period: parts[1] };
  return { kind: "home" };
}

/** 右栏跟着展示区走：首页和总管线列本人全部（B 的契约 scope=main），Task 管线和详情列这件 Task 的，子会话列它自己的；二级页、月份页只显示资源块。 */
export function scopeOf(view: View): BackgroundScope | null {
  switch (view.kind) {
    case "home": case "buddy": return "main";
    case "task": case "info": return `task:${view.taskId}`;
    case "card": return `card:${view.id}`;
    case "topic": return `topic:${view.id}`;
    case "page": case "month": return null;
  }
}

/**
 * 展示区页头两端的小件：手机上是返回（回到左栏）和后台任务（底部抽屉），桌面上没有。
 * 页头由各内容自己画（总管线是伙伴形象，Task 管线是 Task 名，子会话是会话名），这样手机上不多一行。
 */
export const ViewChrome = createContext<{ lead: ReactNode; trail: ReactNode }>({ lead: null, trail: null });
export const useViewChrome = () => useContext(ViewChrome);

/** 系统是不是深色。新首页的颜色跟着系统走（home.module.css 末尾）；对话列的正文和输入条有自己的浅/深两套，要按这个选。 */
const DARK_QUERY = "(prefers-color-scheme: dark)";
const subscribeDark = (notify: () => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
const darkSnapshot = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
export const useDarkScheme = () => useSyncExternalStore(subscribeDark, darkSnapshot, () => false);
