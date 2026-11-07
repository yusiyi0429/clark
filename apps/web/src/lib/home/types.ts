/**
 * 新首页（伙伴总管线 + 项目 + 子会话）的数据形状：B 的契约（packages/contracts/src/workHome.ts、projects.ts，第 16 节的 v2）。
 * 这里只留网页自己加的部分：等你里多两种通知（会后分给你、群消息——云端不算要拿主意的事，老左栏的提醒不能丢），右栏的范围。
 */
import type {
  TBackgroundItem, THomeMonthMission, THomeProject, THomeProjectGoal, TProjectFeedItem, TRouteResponse, TSubSession, TTaskFeedItem, TWaitingItem, TWaitingTarget, TWorkHomeResponse,
} from "@warmap/contracts";

export type SubSession = TSubSession;
export type HomeProject = THomeProject;
export type HomeProjectGoal = THomeProjectGoal;
export type HomeMonthMission = THomeMonthMission;
export type BackgroundItem = TBackgroundItem;
export type FeedItem = TTaskFeedItem;
/** 项目对话里按时间插的一行：验收那几种，加 goal_linked（挂上一件 Task，画「{月} 月目标：{Task}」）。 */
export type ProjectFeedItem = TProjectFeedItem;

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
 * main：首页和总管线（本人全部）；project:<id>：项目对话和项目详情；task:<id>：Task 详情；card:<id> / topic:<id>：子会话；resources：二级页和月份页（只要资源块）。
 */
export type BackgroundScope = "main" | "resources" | `project:${string}` | `task:${string}` | `card:${string}` | `topic:${string}`;

/** 首页输入框发给谁：伙伴（总管线）或某个项目的对话（16.4）。 */
export type RouteTarget = TRouteResponse["target"];
