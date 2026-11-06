/**
 * 新首页展示区的五种内容（设计第 3 节），由地址决定：
 * /me/work 首页 · /me/work/buddy 总管线 · /me/work/tasks/<id> Task 管线 · /me/work/tasks/<id>/info Task 详情 ·
 * /me/work/cards/<id>、/me/work/topics/<id> 子会话。
 */
import { createContext, useContext, type ReactNode } from "react";
import type { BackgroundScope } from "@/lib/home/types";

export type View =
  | { kind: "home" }
  | { kind: "buddy" }
  | { kind: "task"; taskId: string }
  | { kind: "info"; taskId: string }
  | { kind: "card"; id: string }
  | { kind: "topic"; id: string };

export function viewOf(pathname: string): View {
  const parts = pathname.replace(/\/+$/, "").split("/").slice(3).map((part) => decodeURIComponent(part));
  if (parts[0] === "buddy") return { kind: "buddy" };
  if (parts[0] === "tasks" && parts[1]) return parts[2] === "info" ? { kind: "info", taskId: parts[1] } : { kind: "task", taskId: parts[1] };
  if (parts[0] === "cards" && parts[1]) return { kind: "card", id: parts[1] };
  if (parts[0] === "topics" && parts[1]) return { kind: "topic", id: parts[1] };
  return { kind: "home" };
}

/** 右栏跟着展示区走：首页和总管线列本人全部（B 的契约 scope=main），Task 管线和详情列这件 Task 的，子会话列它自己的。 */
export function scopeOf(view: View): BackgroundScope {
  switch (view.kind) {
    case "home": case "buddy": return "main";
    case "task": case "info": return `task:${view.taskId}`;
    case "card": return `card:${view.id}`;
    case "topic": return `topic:${view.id}`;
  }
}

/**
 * 展示区页头两端的小件：手机上是返回（回到左栏）和后台任务（底部抽屉），桌面上没有。
 * 页头由各内容自己画（总管线是伙伴形象，Task 管线是 Task 名，子会话是会话名），这样手机上不多一行。
 */
export const ViewChrome = createContext<{ lead: ReactNode; trail: ReactNode }>({ lead: null, trail: null });
export const useViewChrome = () => useContext(ViewChrome);
