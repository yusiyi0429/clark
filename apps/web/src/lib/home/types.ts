/**
 * 新首页（伙伴总管线 + Task 管线 + 子会话，设计 新首页_伙伴总管线与Task管线_2026-11-07 第 7 节）的数据形状。
 * 照 B 的接口草案写：GET /api/me/work-home、GET /api/me/background、POST /api/me/tasks/:taskId/pipeline、POST /api/me/route。
 * B 的契约到了以后换成生成的类型，这里只留网页自己用的部分。
 */

/** 子会话：本机程序里能对话的会话，执行（卡）或探索（专题）。规划员、验收员不算子会话，是后台任务。 */
export type SubSessionKind = "card" | "topic";
export type SubSessionState = "queued" | "running" | "waiting" | "done" | "failed";
/** 等你什么：批准、回答提问、验收结果（受阻）。已暂停也是等你（说一句「继续」），不带这一项。 */
export type SubSessionWait = "approval" | "question" | "verdict";

export type SubSession = {
  id: string;
  kind: SubSessionKind;
  title: string;
  state: SubSessionState;
  waiting?: SubSessionWait;
  updatedAt: string;
};

export type TaskSummary = { running: number; waiting: number; queued: number; done: number };

export type HomeTask = {
  taskId: string;
  name: string;
  /** 标题下一行小字：一句话或到期日。 */
  subtitle: string | null;
  summary: TaskSummary;
  /** 这件 Task 的管线对话；还没开过为 null（第一次打开时建）。 */
  pipeline: { conversationId: string | null };
  /** 规划员在拆（左栏和首页写「拆卡中」）。 */
  planning: boolean;
  /** 本人交付了（Task 行打勾，子会话全部收起）。 */
  delivered: boolean;
  subSessions: SubSession[];
};

export type HomeMission = { missionId: string; title: string; tasks: HomeTask[] };

/**
 * 等你：所有要本人拿主意的事，一件一行。
 * approval / question / verdict：子会话（或规划员）的批准、提问、验收没过或受阻（B 的契约：受阻也是 verdict）；
 * meeting：会议记录待确认；mission_card：Mission Card 要你做的事；assigned：会后分给你的事；thread：群里的新消息；
 * role：岗位修改建议；merge：卡合不回主文件夹。
 */
export type WaitingKind = "approval" | "question" | "verdict" | "meeting" | "mission_card" | "assigned" | "thread" | "role" | "merge";

export type WaitingItem = {
  id: string;
  kind: WaitingKind;
  title: string;
  /** 小字：出自哪件 Task、哪个子会话或哪场会。 */
  source: string | null;
  /** 去哪儿看：新首页里的地址（/me/work/…），或老页面。 */
  href: string;
  at: string | null;
  /** 就地答要用的：哪个 worker、哪条岗位建议、哪条通知、哪个合不回的会话。 */
  ref: { workerKey?: string; proposalId?: string; notificationId?: string; sessionId?: string };
};

export type WorkHomeData = {
  missions: HomeMission[];
  /** 不归任何 Task 的子会话（左栏最下面一组「其他」）。 */
  other: { subSessions: SubSession[] };
  waiting: WaitingItem[];
};

/** 后台任务：不用对话的那些——规划员拆卡、验收员验收、合回；子会话里 Claude Code 开的子 agent、后台命令。 */
export type BackgroundKind = "plan" | "verify" | "merge" | "subagent" | "command";
export type BackgroundState = "queued" | "running" | "done" | "failed";

export type BackgroundItem = {
  id: string;
  title: string;
  kind: BackgroundKind;
  state: BackgroundState;
  startedAt: string | null;
  finishedAt: string | null;
  /** 这台电脑上能停（本机会话在这里，不是手机）。 */
  stoppable: boolean;
  /** 停哪个本机会话。 */
  sessionId?: string;
};

/**
 * 右栏跟着展示区走：看哪条对话就列哪条开出去的后台任务。
 * main：首页和总管线（本人全部，B 的契约这么定）；task:<id>：Task 管线和 Task 详情；card:<id> / topic:<id>：子会话。
 */
export type BackgroundScope = "main" | `task:${string}` | `card:${string}` | `topic:${string}`;

/** 首页输入框发给谁：伙伴（总管线）或某件 Task 的管线。 */
export type RouteTarget = "main" | { taskId: string };
