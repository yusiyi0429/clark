/**
 * 新首页展示区的内容，由地址决定：
 * /me/work 首页 · /me/work/buddy 总管线 · /me/work/tasks/<id> Task 管线 · /me/work/tasks/<id>/info Task 详情 ·
 * /me/work/cards/<id>、/me/work/topics/<id> 子会话 · /me/work/missions/<id> Mission 详情（只读，14.2）·
 * /me/work/projects/<id> 项目页 · /me/work/projects/<id>/info 项目详情（第 16 节）· /me/work/projects/<id>/new 在项目里开一个子会话（第 68 条）· /me/work/transfers/<id> 别人交给你的项目（只读预览，16.7）·
 * /me/work/settings/<页> 二级页（头像和资料、伙伴、连接、偏好，设计 9.4）· /me/work/month/<YYYY-MM> 月份页（第 10 节）·
 * /me/work/meetings 会议页（接下来、已开完，11/16）· /me/work/meetings/<id> 会议详情（老界面的会议屏幕，只换外壳）。
 */
import { createContext, useContext, type ReactNode } from "react";
import type { BackgroundScope } from "@/lib/home/types";
import { isPage, type PageKey } from "./pageKeys";

export type View =
  | { kind: "home" }
  | { kind: "buddy" }
  | { kind: "task"; taskId: string }
  | { kind: "info"; taskId: string }
  | { kind: "mission"; id: string }
  | { kind: "project"; id: string }
  | { kind: "projectInfo"; id: string }
  | { kind: "newSub"; projectId: string }
  | { kind: "transfer"; id: string }
  | { kind: "meetings" }
  | { kind: "meeting"; id: string }
  | { kind: "card"; id: string }
  | { kind: "topic"; id: string }
  | { kind: "page"; page: PageKey }
  | { kind: "month"; period: string };

export { PAGE_KEYS, PAGE_TITLE, monthHref, pageHref, type PageKey } from "./pageKeys";

export function viewOf(pathname: string): View {
  const parts = pathname.replace(/\/+$/, "").split("/").slice(3).map((part) => decodeURIComponent(part));
  if (parts[0] === "buddy") return { kind: "buddy" };
  if (parts[0] === "tasks" && parts[1]) return parts[2] === "info" ? { kind: "info", taskId: parts[1] } : { kind: "task", taskId: parts[1] };
  if (parts[0] === "missions" && parts[1]) return { kind: "mission", id: parts[1] };
  if (parts[0] === "projects" && parts[1]) return parts[2] === "info" ? { kind: "projectInfo", id: parts[1] } : parts[2] === "new" ? { kind: "newSub", projectId: parts[1] } : { kind: "project", id: parts[1] };
  if (parts[0] === "transfers" && parts[1]) return { kind: "transfer", id: parts[1] };
  if (parts[0] === "meetings") return parts[1] ? { kind: "meeting", id: parts[1] } : { kind: "meetings" };
  if (parts[0] === "cards" && parts[1]) return { kind: "card", id: parts[1] };
  if (parts[0] === "topics" && parts[1]) return { kind: "topic", id: parts[1] };
  if (parts[0] === "settings" && isPage(parts[1])) return { kind: "page", page: parts[1] };
  if (parts[0] === "month" && parts[1] && /^\d{4}-\d{2}$/.test(parts[1])) return { kind: "month", period: parts[1] };
  return { kind: "home" };
}

/** 右栏跟着展示区走：首页和总管线列本人全部（B 的契约 scope=main），项目对话和详情列这个项目的，Task 详情列这件 Task 的，子会话列它自己的；二级页、月份页只显示资源块（resources）。 */
export function scopeOf(view: View): BackgroundScope {
  switch (view.kind) {
    case "home": case "buddy": case "mission": case "transfer": case "meeting": case "meetings": return "main";
    case "project": case "projectInfo": return `project:${view.id}`;
    case "newSub": return `project:${view.projectId}`;
    case "task": case "info": return `task:${view.taskId}`;
    case "card": return `card:${view.id}`;
    case "topic": return `topic:${view.id}`;
    case "page": case "month": return "resources";
  }
}

/**
 * 展示区页头的小件（设计 5.4.3「页头」）：手机上两端是返回和后台任务按钮（桌面上没有）；
 * parent 是子会话标题前面那一段上一级「Task 名 / 」（12 淡色，点了回到 Task 管线），层级一眼看得出；letter 是标题前面的字母方块（18.10）。
 * 页头由各内容自己画（标题就是左栏当前那一行的字），这样手机上不多一行。
 */
export const ViewChrome = createContext<{ lead: ReactNode; trail: ReactNode; parent?: ReactNode; letter?: ReactNode }>({ lead: null, trail: null });
export const useViewChrome = () => useContext(ViewChrome);
