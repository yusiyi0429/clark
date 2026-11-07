import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { PersonRef, ProjectTransfer } from "./projectTransfers.js";
import { TaskFeedItem } from "./workHome.js";

/**
 * 项目常驻，每月目标挂在项目上（设计《新首页》第 16 节，11/07 晚用户批准）。
 *
 * - 项目：一件会一直做下去的事，没有「完成」，不做了就归档。本人建（伙伴可以帮着建），名字随时改。存在天枢里，不进本体；这次只做个人项目。
 *   绑定这台电脑上的文件夹是本机程序的事（按设备分别绑），云端不存。
 * - 每月目标：就是本体里的 Task。一件 Task 只挂一个项目（project_goals：task、project、period），一个项目一个月可以挂 0、1 或几件。
 * - 项目对话：一个项目一条，scope 是 project:<projectId>（conversations.ts 的 ConversationScope），从建项目那天一直延续；原来的 Task 管线并进来了。
 *   每挂上一件 Task，项目的动态（GET /api/me/projects/:projectId/feed）里有一行 goal_linked，网页按时间画成居中的分隔线「11 月目标：{Task 名}」。
 * - 自动挂接：新月份的 Task 进天枢后（从本体载入或敲定生效），按延续关系（task_continuations）或「和上月同名、同 Mission」挂到上一件所在的项目；
 *   只挂到 Task 负责人自己的项目。挂不上的留给本人在首页「本月」里选（HomeMonthTask.project 为 null 时画「挂到…」）。
 * - 上线迁移：本人第一次读首页时，按「看得见的 Mission」每张建一个同名项目，下面本人负责的 Task 都挂上去；原来的 Task 管线对话按时间并进项目对话。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Period = Type.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])$" });

export const ProjectName = Type.String({ minLength: 1, maxLength: 60 });

/**
 * 一个项目。archivedAt 不为 null 是归档了（左栏收进「已归档 N」）；lastActivityAt 是最近一次动静（子会话、事项、挂接），没有为 null。
 * transfer（16.7）：正在转交的那一份（preparing、sent），或本人交出去了的那一份（accepted：本人是原负责人，项目在本人这边算归档、只读，
 * archivedAt 是接手的时间）；都没有为 null。
 */
export const Project = Type.Object({
  projectId: Type.String({ format: "uuid" }),
  name: ProjectName,
  archivedAt: Nullable(Instant),
  createdAt: Instant,
  lastActivityAt: Nullable(Instant),
  transfer: Nullable(ProjectTransfer),
}, strict);

/** GET /api/me/projects（DRI 工作台）：本人全部项目（含交出去了的，算归档），没归档的在前，各自按最近动静从近到远。 */
export const ProjectListResponse = Type.Object({ projects: Type.Array(Project) }, strict);

/**
 * POST /api/me/projects（201）：建一个项目。带 taskId 时顺手把这件 Task 挂上来（「本月」里「挂到… → 新建」、月初敲定时「新建」），
 * Task 要是本人负责的；它原来挂在别的项目上就移过来。
 */
export const CreateProjectRequest = Type.Object({ name: ProjectName, taskId: Type.Optional(Type.String({ minLength: 1 })) }, strict);

/** PATCH /api/me/projects/:projectId：改名、归档（archived: true）、恢复（archived: false）。至少带一样。 */
export const UpdateProjectRequest = Type.Object({ name: Type.Optional(ProjectName), archived: Type.Optional(Type.Boolean()) }, { ...strict, minProperties: 1 });

/**
 * 一件挂着的 Task 的判定（目标历史那一行）：completed 本人确认完成；stopped 定了到此为止；continued 延续成了下个月的一件；open 还没了结。
 * 月底给 M2 的判定以后接进来，现在只看天枢里有的。
 */
export const ProjectGoalVerdict = Type.Union([Type.Literal("open"), Type.Literal("completed"), Type.Literal("stopped"), Type.Literal("continued")]);

/**
 * 一条挂接：哪个月的哪件 Task。taskName、missionTitle 是挂上时的快照（本体读不到时历史照样能写）。
 * source：auto 自动挂的（延续、同名同 Mission）、owner 本人挂的、migration 上线迁移挂的。linkedAt 是挂上的时间（项目对话里分隔线的位置）。
 */
export const ProjectGoal = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  taskName: Type.String(),
  missionId: Type.String({ minLength: 1 }),
  missionTitle: Nullable(Type.String()),
  period: Period,
  verdict: ProjectGoalVerdict,
  source: Type.Union([Type.Literal("auto"), Type.Literal("owner"), Type.Literal("migration")]),
  linkedAt: Instant,
}, strict);

/**
 * GET /api/me/projects/:projectId（项目的「详情」）：goals 是目标历史，月份从近到远（同一个月按挂上的先后）。
 * 当前 Task（period 是这个月的那几件）的完成标准、约定、交付物，网页照原来 Task 详情的接口按 taskId 读（/api/plan-tasks/:taskId/agreement 等）。
 * period 是现在是哪个月（公司时区）。
 */
export const ProjectDetailResponse = Type.Object({ project: Project, period: Period, goals: Type.Array(ProjectGoal) }, strict);

/**
 * PUT /api/me/projects/:projectId/goals/:taskId（200，回这一条）：把一件本人负责的 Task 挂到这个项目（本月「挂到…」选了现有项目）；
 * 原来挂在别的项目上就移过来。归档了的项目不能挂（409）。
 * DELETE /api/me/projects/:projectId/goals/:taskId（204）：取下来，这件 Task 回到「本月」里没挂的状态。
 */
export const ProjectGoalResponse = ProjectGoal;

/**
 * POST /api/me/projects/:projectId/pipeline（本人）：这个项目的对话，第一次打开时建，以后都返回同一条（201 新建、200 已有）。
 * 收发消息、接上、停止都走现有的对话接口，scope 用这里给的 project:<projectId>。conversationId 只作标识（接了 Chat 时是 Chat 里那段的 id）。
 */
export const ProjectPipelineResponse = Type.Object({
  projectId: Type.String({ format: "uuid" }),
  conversationId: Type.String({ minLength: 1 }),
  scope: Type.String({ minLength: 1 }),
}, strict);

/**
 * 项目对话里网页按时间插的一行：TaskFeedItem 那几种（这个项目里的卡：挂着的 Task 下的、和直接挂在项目上的；交接以后也含以前负责人的卡），
 * 加 goal_linked：一件 Task 挂上来了（at 是 linkedAt），网页画居中的分隔线「{period 的月} 月目标：{taskName}」；
 * 加转交那几行（16.7）：
 * - handover：换人的分隔线「{日期} {from} → {to}」（at 是接手的时间），两边都有；
 * - handover_summary：接手人那边，紧跟分隔线的第一条消息，管线发的项目总结（就是交接说明，note），后面把「没做完的事」做成选项由网页画；
 * - transfer_declined：原负责人那边一行「{by}没接」。
 */
export const ProjectGoalLinkedItem = Type.Object({
  kind: Type.Literal("goal_linked"),
  id: Type.String({ minLength: 1 }),
  at: Instant,
  period: Period,
  taskId: Type.String({ minLength: 1 }),
  taskName: Type.String(),
}, strict);
export const ProjectHandoverItem = Type.Object({ kind: Type.Literal("handover"), id: Type.String({ minLength: 1 }), at: Instant, transferId: Type.String({ format: "uuid" }),
  from: PersonRef, to: PersonRef }, strict);
export const ProjectHandoverSummaryItem = Type.Object({ kind: Type.Literal("handover_summary"), id: Type.String({ minLength: 1 }), at: Instant,
  transferId: Type.String({ format: "uuid" }), from: PersonRef, note: Type.Array(Type.Object({ title: Type.String(), lines: Type.Array(Type.String()) }, strict)) }, strict);
export const ProjectTransferDeclinedItem = Type.Object({ kind: Type.Literal("transfer_declined"), id: Type.String({ minLength: 1 }), at: Instant,
  transferId: Type.String({ format: "uuid" }), by: PersonRef }, strict);
export const ProjectFeedItem = Type.Union([TaskFeedItem, ProjectGoalLinkedItem, ProjectHandoverItem, ProjectHandoverSummaryItem, ProjectTransferDeclinedItem]);
/** GET /api/me/projects/:projectId/feed：从旧到新。 */
export const ProjectFeedResponse = Type.Object({ items: Type.Array(ProjectFeedItem) }, strict);

export type TProject = Static<typeof Project>;
export type TProjectListResponse = Static<typeof ProjectListResponse>;
export type TCreateProjectRequest = Static<typeof CreateProjectRequest>;
export type TUpdateProjectRequest = Static<typeof UpdateProjectRequest>;
export type TProjectGoalVerdict = Static<typeof ProjectGoalVerdict>;
export type TProjectGoal = Static<typeof ProjectGoal>;
export type TProjectDetailResponse = Static<typeof ProjectDetailResponse>;
export type TProjectPipelineResponse = Static<typeof ProjectPipelineResponse>;
export type TProjectGoalLinkedItem = Static<typeof ProjectGoalLinkedItem>;
export type TProjectFeedItem = Static<typeof ProjectFeedItem>;
export type TProjectFeedResponse = Static<typeof ProjectFeedResponse>;
