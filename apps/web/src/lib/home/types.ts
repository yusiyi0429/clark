/**
 * 新首页（伙伴总管线 + Task 管线 + 子会话）的数据形状：B 的契约（packages/contracts/src/workHome.ts）。
 * 这里只留网页自己加的部分：等你里多两种通知（会后分给你、群消息——云端不算要拿主意的事，老左栏的提醒不能丢），右栏的范围。
 */
import type {
  TBackgroundItem, THomeMission, THomeTask, TRouteResponse, TSubSession, TTaskFeedItem, TWaitingItem, TWaitingTarget, TWorkHomeResponse,
} from "@warmap/contracts";

export type SubSession = TSubSession;
export type HomeTask = THomeTask;
export type HomeMission = THomeMission;
export type BackgroundItem = TBackgroundItem;
export type FeedItem = TTaskFeedItem;

/**
 * 等你一行（契约 WaitingItem，设计 9.6：要你拿主意、不拿就有事卡住的才进；群消息、会后分给你这类只是让你知道的不进）。
 * 回退路径（B 的接口没上）由网页拼时，找不到契约里的目标的 open 直接给地址；notificationId 是会后确认标已读用的。
 */
export type WaitingItem = Omit<TWaitingItem, "open"> & {
  open: TWaitingTarget | { kind: "href"; href: string };
  notificationId?: string;
};

export type WorkHomeData = Omit<TWorkHomeResponse, "waiting"> & { waiting: WaitingItem[] };

/**
 * 右栏跟着展示区走：看哪条对话就列哪条开出去的后台任务。
 * main：首页和总管线（本人全部）；task:<id>：Task 管线和 Task 详情；card:<id> / topic:<id>：子会话；resources：二级页和月份页（只要资源块）。
 */
export type BackgroundScope = "main" | "resources" | `task:${string}` | `card:${string}` | `topic:${string}`;

/** 首页输入框发给谁：伙伴（总管线）或某件 Task 的管线。 */
export type RouteTarget = TRouteResponse["target"];
