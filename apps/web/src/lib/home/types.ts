/**
 * 新首页（伙伴总管线 + Task 管线 + 子会话）的数据形状：B 的契约（packages/contracts/src/workHome.ts）。
 * 这里只留网页自己加的部分：等你里多两种通知（会后分给你、群消息——云端不算要拿主意的事，老左栏的提醒不能丢），右栏的范围。
 */
import type {
  TBackgroundItem, THomeMission, THomeTask, TRouteResponse, TSubSession, TTaskFeedItem, TWaitingItem, TWaitingKind, TWaitingTarget, TWorkHomeResponse,
} from "@warmap/contracts";

export type SubSession = TSubSession;
export type HomeTask = THomeTask;
export type HomeMission = THomeMission;
export type BackgroundItem = TBackgroundItem;
export type FeedItem = TTaskFeedItem;

/**
 * 等你一行。云端的七种照契约（open 是去哪儿看）；网页从通知拼的两种 assigned（会后分给你）、thread（群里的新消息）
 * 没有契约里的目标，open 直接给地址，notificationId 是标已读用的。
 */
export type WaitingItem = Omit<TWaitingItem, "kind" | "open"> & {
  kind: TWaitingKind | "assigned" | "thread";
  open: TWaitingTarget | { kind: "href"; href: string };
  notificationId?: string;
};

export type WorkHomeData = Omit<TWorkHomeResponse, "waiting"> & { waiting: WaitingItem[] };

/**
 * 右栏跟着展示区走：看哪条对话就列哪条开出去的后台任务。
 * main：首页和总管线（本人全部）；task:<id>：Task 管线和 Task 详情；card:<id> / topic:<id>：子会话。
 */
export type BackgroundScope = "main" | `task:${string}` | `card:${string}` | `topic:${string}`;

/** 首页输入框发给谁：伙伴（总管线）或某件 Task 的管线。 */
export type RouteTarget = TRouteResponse["target"];
