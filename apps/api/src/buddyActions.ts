import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  BuddyActionParams, BUDDY_ACTION_NAMES, MAIN_ONLY_ACTIONS, PROJECT_ONLY_ACTIONS, type BuddyActionName, type TBudget, type TBuddyActionSpec, type TBuddyAskQuestion, type TBuddyAuditEntry, type TBuddyAuthority,
  type TBuddyMessageDraft, type TBuddyPlan, type TBuddyUiEffect, type TConversationCard, type TSessionCommand, type TSessionCommandView,
  type TSessionStopView, type TTrashItem, type TWorkHomeResponse, type TTeamDelivery,
} from "@warmap/contracts";
import type { Static } from "@sinclair/typebox";
import { BUDDY_FORWARD_PREFIX } from "./chatService.js";
import { currentSessionVersion } from "./memberAccess.js";
import { UUID_PATTERN, type Query } from "./meetingStore.js";
import { CLAIM_TTL, cancelStart, requestStarts } from "./sessionStarts.js";
import { SESSION_COOKIE, createSessionToken } from "./session.js";
import { ACTIVE } from "./workers.js";
import { subByLetter } from "./subSessionLetters.js";
import { autoRelayStep } from "./autoRelay.js";
import type { RunAsk } from "./localDevices.js";
import { agreementRow, writeAgreement } from "./cardAgreements.js";
import { CardError } from "./taskCards.js";
import { companyPeriod } from "./monthlyPlans.js";
import { checkedWords, recentOwnerWords, type ProjectHistory } from "./sourceWords.js";
import { addBuddyReaction } from "./conversationReactions.js";
import { logEvent } from "./observability.js";
import { dispatchCards, findDispatch, recordDispatch, type DispatchCard } from "./buddyDispatches.js";
import { ensureScratchProject } from "./projects.js";
import { projectPaused } from "./projectTransfers.js";
import { taskDueDates } from "./taskDueDates.js";

/**
 * 伙伴代本人做事（新首页 17.4，契约 buddyActions.ts）。Chat 每轮读动作清单（actionList），模型调哪个就按名字执行（runAction）。
 * - 能照网页接口做的，以本人身份在进程内调那个接口（同 homeTurn.ts 的做法：本人当前凭据版本签一个几分钟的会话，Origin 是正式地址），
 *   权限检查、校验、错误全照网页那一份；网页没有的（开工、停掉、归档卡、删进回收站、转达、计划清单）在这里照同样的归属检查做。
 * - 写动作要本人完全授权，每个记一条审计（buddy_actions），能撤的存下撤销要用的东西。
 * - 界面效果、卡、计划清单经 stream 插进这一轮的对话事件流（chatService.inject）。
 */

export class BuddyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

// 参数里的 uuid：TypeBox 的 Value.Check 要先登记格式（Fastify 那边用的是 Ajv 自己的）。
if (!FormatRegistry.Has("uuid")) FormatRegistry.Set("uuid", (value) => UUID_PATTERN.test(value));

type Kind = TBuddyActionSpec["kind"];
const KIND: Record<BuddyActionName, Kind> = {
  read_work_home: "read", read_project: "read", find_people: "read", open_page: "ui", update_plan: "plan", ask_user: "ui",
  read_partner_inbox: "read", read_partner_item: "read",
  set_appearance: "write", set_feishu_push: "write", start_sub_session: "write", stop_sub_session: "write", archive_sub_session: "write",
  delete_sub_session: "write", create_project: "write", rename_project: "write", archive_project: "write", link_task_to_project: "write",
  transfer_project: "write", split_cards: "write", set_budget: "write", set_task_due_date: "write", message_project: "write", open_session: "write", tell_session: "write", send_message: "write",
  sub_session_tell: "write", sub_session_stop: "write", sub_session_rename: "write", sub_session_link: "write", sub_session_restart: "write", sub_session_answer: "write", sub_session_approve: "write",
  update_card: "write",
};
/**
 * 不可逆的几个动作说明末尾加这一句（主循环第 63 条的回话规矩）：「撤不回」只在要本人点头时说一次，别的回话里不念。
 * 管说话方式的另两条跟着项目页的页面说明走（pageGuides.ts 的 PIPELINE_RULES）。
 */
const IRREVERSIBLE = "这一步撤不回：只在动手前请本人点头时说一次，做完以后和别的回话里不再提。";
/** 本人 11/16：界面上不再显示子会话的字母，读到的 letter 只用来调动作。 */
const SAY_NAMES = "子会话的 letter 只是调动作用的编号，界面上不显示；跟本人说话时叫子会话的名字，不说字母。";
/** 本人 11/19：本人点名要跑的照做，上限只管伙伴自己开新的。 */
const OWNER_NAMED = "本人点名要跑、要续上的会话照做，不受同项目在跑的上限，超了就在回话里顺带说一句这个项目现在有几个在跑。";
/** 本人 11/16（少开子会话）：只写进规矩，不做硬限制。 */
const RUNNING_LIMIT = "同一个项目同时在跑的子会话不超过 2 个（本机最多同时跑 3 个，留一个给本人）；这条只管你自己开新会话、拆新卡，已经有 2 个在跑就等一个停下再开。"
  + OWNER_NAMED;
/** 本人 11/18：简单的自己做，项目级的进项目（.scratch/buddy-duet-20261117/借鉴dots开会话.md 第 2 节）。属于以后要迁进 harness 的规矩，收在这一处。 */
const DISPATCH_RULES = "先分清是哪一种："
  + "①某个项目手上的活——要改它的文件，或者要改它某个会话的约定（做成什么样算完）——交给那个项目，再小也是；只是问进度、卡在哪，自己读了再答。"
  + "②这一轮里自己能做完的——查几下、读几份贴进来的材料、写一段话就能交，交出来的是对话里的话，不用碰本人电脑上的文件和代码——自己做，不开会话。"
  + "③做不完的才是项目级：要读写本人电脑上的文件或代码；要做出一件留下来、以后还会改的东西；估计要跑几分钟以上，或要本人看了再改；或者本人明说「开个会话」「派出去做」。"
  + "默认自己做。拿不准够不够大：先自己答个短版，末尾用一句话问要不要开会话做完整的；这句不用 ask_user。开会话这件事上，ask_user 只用来问放进哪个项目（对得上多个或一个都对不上时）。不为了保险先开会话。"
  + "项目级的放哪：按项目名、项目挂着的 Task 名、项目里已有的会话来对。只对得上一个项目就直接开，回话里说一声放在哪了；"
  + "对得上好几个，或者一个都对不上、又像是一条以后还会接着做的线，用 ask_user 问（放进哪个项目 / 新建一个项目）；"
  + "一次性的、哪个项目都不沾的活，带 scratch 放进「随手」项目，不为它新建项目。"
  + "已有的会话不改约定的——接着做、重跑、在约定里改一点——用 tell_session；起新活照旧走 open_session / message_project。";
const DESCRIPTION: Record<BuddyActionName, string> = {
  read_partner_inbox: "读本人伙伴的会议 meetings、同事来件 received、发件进度 sent 或关键工作事件 events。每页默认20条，nextOffset 可取下一页；按需打开原文。",
  read_partner_item: "以本人身份读会议正文 meeting、本人待整理的妙记 minute、团队请求及答复 delivery、请求附件文字 attachment。id 取自收件列表。会议有多个来源时可选 source（feishu 或 tianshu）；附件须带 attachmentId。没有内容或权限时如实说明。",
  read_work_home: "读本人的首页：项目、每个项目的子会话（卡、专题）和状态、等你、本月的 Mission 和 Task。要找项目 id、子会话 id、Task id 时先读它。" + SAY_NAMES,
  read_project: "读一个项目的详情（目标、挂着的 Task）、当前子会话状态 subSessions 和最近的动态（含子会话停下的报告：做成了什么、卡在哪、交了什么）。"
    + "subSessions 为 null 表示当前首页未列出该项目，不能当成没有子会话。state=waiting 且 waiting=null 只表示停下一轮，不是完成；waiting/merge 是等合回，done 才是已完成，failed 是验收没过。"
    + "子会话停了不会再叫你；本人问到近况、或你要说某个子会话的结果，先读它再说，没读过的不评论。" + SAY_NAMES,
  find_people: "按名字在人员目录里找同事，拿到人员 id（转达、转交要的是 id）。回最多 10 个：personId、name、self（是不是本人自己）。",
  open_page: "让本人的网页打开某一处：home 首页、preferences 偏好，或某个项目、子会话（同「等你」的 open）。只动界面。",
  set_appearance: "切外观：system 跟随系统、light 浅色、dark 深色。",
  set_feishu_push: "打开或关掉飞书推送（feishu: true 开）。",
  start_sub_session: "让一个卡或专题开工：登记要开工，本人电脑上开着的网页接下后交给本机。已经在跑的不用再开。" + RUNNING_LIMIT,
  stop_sub_session: `停掉一个子会话：还没被电脑接下的撤掉开工登记；在跑的请它所在的那台电脑停掉。${IRREVERSIBLE}`,
  archive_sub_session: "归档一个子会话（卡或专题），从首页收起。在跑的要先停掉。",
  delete_sub_session: "删掉一个子会话：先进回收站，30 天内能恢复。在跑的要先停掉。",
  create_project: "新建一个项目，可以顺带挂上一件本人负责的 Task（taskId）。一个工作文件夹加一条长期的线是一个项目，功能是挂在项目下的每月 Task，不另立项目。"
    + "建之前先用 ask_user 问清现实：本机有没有现成的文件夹、要不要新建；是不是从别处（比如 Codex）迁过来的；在哪个目录开工；要不要连 GitHub 仓库；"
    + "做下去会做成什么样、和本人要的是不是一回事。这个文件夹已经有项目了还要再建，先问本人。问不清就不建。"
    + "只有三条都满足才新建：现有项目没有一个对得上、它有自己的文件夹、以后还会接着做。（伙伴主线）一次性的活不建项目，用 open_session 带 scratch。",
  rename_project: "给项目改名。",
  archive_project: "归档一个项目。",
  link_task_to_project: "把本人负责的一件 Task 挂到某个项目上（原来挂在别的项目上就移过来）。",
  transfer_project: "把项目转交给同事：发起转交，交接说明由云端写好后直接发出。toPersonId 是同事的人员 id。",
  split_cards: "（项目对话里用）登记拆卡：给一件 Task（taskId）或一个没挂 Task 的项目（projectId）拆执行卡，二选一。这个月挂了 Task 的项目按 Task 拆：每件 Task 拆一次（taskId 看 read_work_home 里这个项目的 goals），和哪件都不沾边的活放在最相关的那件下面；按项目拆只给这个月没挂 Task 的项目。words 只能原样摘本人在项目对话里说过的话，不改写、不加自己的交代，摘几段用空行隔开；"
    + "拿不准就不带，云端取本人最近说的话。"
    + "modelWords 只放本人关于用哪个来源、哪个模型、思考开到多少的原话（比如「用 Opus」「思考开到最高」），原样摘那一截，不翻译成型号；"
    + "本人没说这些就不带。拆哪几张、范围、怎么做的话放 words，不放 modelWords。"
    + "拆之前先用 ask_user 问清现实：在哪个文件夹、哪个目录开工，本机有没有、要不要新建，是不是从别处（比如 Codex）迁过来的，要不要连 GitHub，拆完做成的样子和本人要的是不是一回事。"
    + "这几件没问清，不拆、不开工，拆了只会更糟。"
    + "拆之前还要先想总管线自己能不能办完：回答问题、看进度、改约定、给子会话转话、整理计划都自己做，不拆。这件 Task 已经有能接着用的子会话，就接着用它（项目对话里用 sub_session_tell 或 sub_session_restart），不另拆。"
    + "要动文件的新活才拆，一件 Task 默认拆一张卡，大的活由执行方在会话里并行。" + RUNNING_LIMIT,
  set_task_due_date: "给一件 Task 存验收截止日，不用挂项目（YYYY-MM-DD；null 不存了，退回记下的原验收时间点）。本人说了哪天交、或者 Task 的截止和 Mission 节点对不上时用。",
  set_budget: "改预算：带 taskId 改这件 Task 的，不带改本人新 Task 的缺省预算。",
  message_project: "用在两种时候：要改某个项目里已有会话的约定（做成什么样算完）；对着这个项目本月 Task 验收标准的正式交付（由项目对话去拆卡）。（伙伴主线）别的新活用 open_session 直接开会话。"
    + "把本人关于某个项目的话转给这个项目的对话，由项目对话去派活、问子会话（改约定的都用它；不改约定的，比如接着做、重跑、在约定里改一点，用 tell_session 直接对那个会话说）。"
    + "立即返回，不等项目对话回完；之后的进展在那个项目的对话里，要本人出手的会进「等你」。不要许诺你自己会再来汇报。",
  open_session: "在某个项目里新开一个会话并开工。title 是会话的名字：一个短的动宾短语，十来个字。brief 是给执行方的交代：写清本人要什么、做成什么样、交什么，带上本人说过的关键原话，不加本人没说过的要求。projectId 和 scratch 带且只带一个。"
    + "要改已有会话的约定（做成什么样算完），或者是对着项目本月 Task 验收标准的正式交付，不用它，用 message_project 转给项目对话。"
    + "伙伴主线里起新活只走两条路：用 open_session 放进项目（一次性的放「随手」），或用 message_project 交给项目对话去拆卡；主线里起新活不直接用 split_cards、start_sub_session。已经拆好的卡或专题要开工，照旧用 start_sub_session。"
    + DISPATCH_RULES + RUNNING_LIMIT
    + "回话里用同一个名字叫这个会话，说一声放在哪个项目。会话做完一轮主线里会自动出一行，不要许诺你自己会再来汇报。",
  tell_session: "对一个已有的会话说一句话：本人让你转的，比如「再试一次」「把按钮改成蓝的」，或者你安排它接下来怎么做。会话停着就续上，在跑就在下一步前送到。" + OWNER_NAMED + "kind 和 id 见 read_work_home。"
    + "这句话要是改了约定（做成什么样算完），不用它，转给项目对话（message_project）。",
  send_message: "给同事转达一句话（toPersonIds 是人员目录里的 id）。不会直接发：先出一张卡给本人看，本人点「发出」才由天枢机器人发，开头是「本人名字请我转达：」。",
  update_plan: "计划清单：要做两步以上的事时，先列出步骤（每次交整张清单，status 为 pending / in_progress / completed），做的过程中更新。少于两步不用列。最后一步做完、回答收尾前，把清单全部标好状态再交一次。",
  ask_user: "出一个选项框问本人。开工前要本人拍板、或者有几种做法可选时用它，不要把问题写成一段话让本人自己组织回答。"
    + "建项目、拆卡之前一定先用它把现实问清楚（文件夹、目录、是否迁移、GitHub、做成什么样）；该问就问，不怕得罪本人。"
    + "每个问题：header 是两到六个字的短标题（如「部署方式」），question 是题干，给 2–4 个选项，每个选项一个短标签加一行说明（代价、含义）；"
    + "你推荐的那个放第一个、标 recommended（每题最多一个，没有推荐就都不标）；本人能多选的题标 multiSelect。「自己填」界面会另给，不用写进选项。"
    + "一次最多 4 个问题，只问真要本人定的；只有一种合理做法、或者只是确认能不能动手时不用它，直接说或直接做。问要不要开会话做完整版不用选项框。"
    + "调完这一轮就结束：回答里最多再说一句，不要接着往下做，等本人回答。本人的回答会作为下一条消息发来（点选的会拼成「短标题：选项」）；本人也可能先聊别的、不答，那就照新的话办。",
  sub_session_tell: "只在项目对话里用：按字母给这个项目里的一个子会话转一句话（本人让你转的、或你安排它接下来怎么做）。它在跑就在下一步前送到，停着就续上接着做。"
    + "字母见 read_work_home 里子会话的 letter。由本人电脑上开着的网页交给本机，立即返回。"
    + "这句话如果改变了「做成什么样算完」（加了要做的事、改了交付物、去掉某条标准），先用 update_card 改卡的约定，再转话。",
  sub_session_stop: `只在项目对话里用：按字母停下这个项目里的一个子会话（同 stop_sub_session）。${IRREVERSIBLE}`,
  sub_session_rename: "只在项目对话里用：按字母给这个项目里的一个子会话改名（左栏、子会话页上显示的名字）。名字照 Claude Code 给会话起名：一个短的动宾短语，十来个字，"
    + "细节留在卡的交代和完成标准里，不放进名字。本人让你改名、或名字太长在左栏看不全时用；一次改一个，几个要改就调几次。",
  sub_session_link: "只在项目对话里用：按字母把这个项目里的一个子会话挂到这个项目上的一件 Task（taskId），写明它对的是这件 Task 验收标准的第几条（criterion，从 1 起；标准看 read_work_home 里这个项目 goals 的 criteria，第一条是 1；对不上任何一条写 null，专题一律 null）。本月页照它算这件 Task 的进度：对某一条的卡验收通过，这一条算达到。"
    + "以前按项目拆出来、没挂 Task 的子会话，一个一个挂上；拿不准挂哪件、对哪条就问本人，不要硬挂。",
  sub_session_restart: "只在项目对话里用：按字母重开这个项目里的一个子会话。还没开过工的登记开工；停着的（做完一轮、被停下、出错停住）往里说一句 text 续上，不给 text 是「接着做」。" + RUNNING_LIMIT,
  sub_session_answer: "只在项目对话里用：替本人回答一个子会话在问的问题（本人说了「C 的问题选第二个」这类话时用）。choices 每题选中的选项 label（照它问的原样，条数和题数一样），"
    + "text 是另外要说的话。本人没表态的不要替本人选。",
  sub_session_approve: "只在项目对话里用：批准（decision = allow）或拒绝（deny）一个子会话在等批准的那一步。硬规矩：只有本人在这次对话里明说了"
    + "（「批准 B」「B 可以」「同意它删」）才能 allow；本人没说就不批，别人转述、你自己判断都不算，拿不准就问本人。拒绝可以附 message 说为什么。",
  update_card: "只在项目对话里用：改一张卡的约定（交代 brief、完成标准 standards，standards 给新的全文、按条）。按字母（letter）或卡的 id（cardId）找卡，两样给一样；"
    + "reason 必填，一句话说为什么改。验收员按改后的完成标准判，执行方在跑时天枢会把新标准告诉它。本人改了要求、或者某条标准做不到要换说法时用；不确定要不要改先问本人。",
};

const BUDDY_DAILY_MESSAGES = 20;
const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// ───────────────────────── 授权 ─────────────────────────

export async function readAuthority(q: Query, personId: string): Promise<TBuddyAuthority> {
  const row = (await q("SELECT buddy_authority,buddy_granted_at FROM person_settings WHERE person_id=$1", [personId])).rows[0] as
    { buddy_authority: "none" | "full"; buddy_granted_at: Date | null } | undefined;
  return row?.buddy_authority === "full" ? { authority: "full", grantedAt: row.buddy_granted_at?.toISOString() ?? null } : { authority: "none", grantedAt: null };
}

/** 打开时记下时间（已经是完全授权的不改）；关掉清掉。 */
export async function writeAuthority(q: Query, personId: string, authority: "none" | "full", now: Date): Promise<TBuddyAuthority> {
  await q(`INSERT INTO person_settings(person_id,buddy_authority,buddy_granted_at) VALUES($1,$2,CASE WHEN $2='full' THEN $3::timestamptz END)
    ON CONFLICT (person_id) DO UPDATE SET buddy_authority=EXCLUDED.buddy_authority,
      buddy_granted_at=CASE WHEN EXCLUDED.buddy_authority='none' THEN NULL ELSE COALESCE(person_settings.buddy_granted_at,EXCLUDED.buddy_granted_at) END`,
  [personId, authority, now]);
  return readAuthority(q, personId);
}

const PROJECT_ONLY = new Set<BuddyActionName>(PROJECT_ONLY_ACTIONS);
const MAIN_ONLY = new Set<BuddyActionName>(MAIN_ONLY_ACTIONS);
/**
 * 本人现在能用的动作：没授权时只有读、界面和计划清单。inProject 为 false（知道这一轮不在项目对话里）时不列只给项目对话的那几个；
 * 为 true（知道在项目对话里）时不列只在伙伴主线用的那几个。
 */
export function actionList(authority: TBuddyAuthority, inProject?: boolean): TBuddyActionSpec[] {
  return BUDDY_ACTION_NAMES.filter((name) => authority.authority === "full" || KIND[name] !== "write").filter((name) => inProject !== false || !PROJECT_ONLY.has(name))
    .filter((name) => inProject !== true || !MAIN_ONLY.has(name))
    .map((name) => ({ name, description: DESCRIPTION[name], kind: KIND[name], parameters: BuddyActionParams[name] }));
}

// ───────────────────────── 执行 ─────────────────────────

export type BuddyStream = (runId: string, event: { type: string; [key: string]: unknown }) => boolean;
export type BuddyDeps = {
  app: FastifyInstance;
  q: Query;
  env: { sessionSecret: string; publicOrigin: string };
  now: () => Date;
  /** 人员目录：id → 名字。 */
  names: () => Map<string, string>;
  /** 往这一轮的对话事件流里插一帧（接了 Chat 才有）。 */
  stream?: BuddyStream;
  /** 读本人那段项目对话（登记拆卡取本人原话用，sourceWords.ts）。 */
  history: ProjectHistory;
};
type Call = { personId: string; conversationId: string | null; runId: string | null };
type Outcome = { summary: string; result?: unknown; undo?: Undo | null; ui?: TBuddyUiEffect[]; card?: TConversationCard };
type SubKind = "card" | "topic";
/** 子会话挂在哪件 Task、对第几条（sub_session_link，本人 11/16 方案 A）；专题只有 Task，条目恒为 null。 */
type SubLink = { planTaskId: string | null; criterionIndex: number | null; criterionText: string | null };
type Undo =
  | { kind: "appearance"; previous: string; set: string }
  | { kind: "feishu"; previous: boolean; set: boolean }
  | { kind: "start"; sub: SubKind; id: string }
  | { kind: "unarchive_sub"; sub: SubKind; id: string }
  | { kind: "restore"; sub: SubKind; id: string }
  | { kind: "project_archived"; projectId: string; archived: boolean }
  | { kind: "project_name"; projectId: string; previous: string; set: string }
  | { kind: "sub_title"; sub: SubKind; id: string; previous: string; set: string }
  | { kind: "sub_link"; sub: SubKind; id: string; previous: SubLink; set: SubLink }
  | { kind: "goal"; projectId: string; taskId: string; previousProjectId: string | null }
  | { kind: "transfer"; transferId: string }
  | { kind: "split"; requestId: string }
  | { kind: "budget"; taskId: string | null; previous: TBudget | null }
  | { kind: "due_date"; projectId?: string; taskId: string; previous: string | null };

/** 本人身份的会话（进程内用，几分钟有效，不出这台机器）。 */
async function sessionCookie(deps: BuddyDeps, personId: string): Promise<string> {
  const version = await currentSessionVersion(deps.q, personId);
  if (version === null) throw new BuddyError(403, "BUDDY_NOT_AUTHORIZED", "本人的账号现在用不了天枢");
  return `${SESSION_COOKIE}=${createSessionToken(deps.env.sessionSecret, 5 * 60, { pid: personId, v: version, view: "member" })}`;
}

/** 以本人身份调网页的接口（进程内，不出这台机器）：出错照网页的码和中文抛出。 */
async function web<T = unknown>(deps: BuddyDeps, personId: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const cookie = await sessionCookie(deps, personId);
  const response = await deps.app.inject({ method, url, headers: { cookie, origin: deps.env.publicOrigin,
    ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  const parsed = (() => { try { return response.body ? JSON.parse(response.body) as unknown : null; } catch { return null; } })();
  if (response.statusCode >= 400) {
    const error = parsed as { code?: string; message?: string } | null;
    if (response.statusCode === 401) throw new BuddyError(403, "BUDDY_NOT_AUTHORIZED", "本人现在用不了 DRI 工作台");
    throw new BuddyError(response.statusCode, error?.code ?? "FAILED", error?.message ?? "没做成");
  }
  return parsed as T;
}

/** 以本人身份调网页的接口（项目对话在本机跑时取项目情况用，projectLocalTurns.ts）。 */
export const callAsPerson = web;

type SubRow = { title: string; plan_task_id: string | null; status: string; trashed_at: Date | null; archived_at: Date | null };
/** 本人的一个子会话（带岗位或交给 Claude Code 的卡、专题）；不是本人的、没有的 404。 */
async function ownSub(q: Query, ownerId: string, kind: SubKind, id: string): Promise<SubRow> {
  const row = !UUID_PATTERN.test(id) ? undefined : kind === "card"
    ? (await q(`SELECT title,plan_task_id,status,trashed_at,archived_at FROM tasks WHERE id=$1 AND owner_id=$2
        AND (role_id IS NOT NULL OR executor='claude_code')`, [id, ownerId])).rows[0]
    : (await q("SELECT title,plan_task_id,status,trashed_at,NULL::timestamptz AS archived_at FROM research_topics WHERE id=$1 AND owner_id=$2", [id, ownerId])).rows[0];
  if (!row) throw new BuddyError(404, "NOT_FOUND", "没有这个子会话");
  return row as SubRow;
}
const column = (kind: SubKind) => (kind === "card" ? "card_id" : "topic_id");
/** 最近一次本机执行，还在跑（含排队、停着等回话）的。 */
async function activeRun(q: Query, kind: SubKind, id: string): Promise<{ id: string; device_id: string; state: string } | null> {
  const row = (await q(`SELECT id::text,device_id::text,state FROM local_runs WHERE ${kind === "card" ? "task_id" : "topic_id"}=$1 ORDER BY started_at DESC,id LIMIT 1`,
    [id])).rows[0] as { id: string; device_id: string; state: string } | undefined;
  return row && ACTIVE.has(row.state) ? row : null;
}
async function closeStarts(q: Query, kind: SubKind, id: string, now: Date) {
  await q(`UPDATE session_starts SET closed_at=$2 WHERE ${column(kind)}=$1 AND closed_at IS NULL`, [id, now]);
}
async function notRunning(q: Query, kind: SubKind, id: string, title: string) {
  if (await activeRun(q, kind, id)) throw new BuddyError(409, "SUB_SESSION_RUNNING", `「${title}」还在跑，先停掉`);
}
const subTable = (kind: SubKind) => (kind === "card" ? "tasks" : "research_topics");
const subRefresh = (id: string, extra: ("trash" | "project")[] = []): TBuddyUiEffect => ({ kind: "refresh", what: ["work_home", "sub_session", ...extra], id });
const projectRefresh = (projectId: string): TBuddyUiEffect => ({ kind: "refresh", what: ["work_home", "project"], id: projectId });
const projectName = async (deps: BuddyDeps, personId: string, projectId: string) =>
  (await web<{ project: { name: string } }>(deps, personId, "GET", `/api/me/projects/${encodeURIComponent(projectId)}`)).project.name;

/** 最近一次本机执行（不论还在不在跑）；没开过为 null。 */
async function lastRun(q: Query, kind: SubKind, id: string): Promise<{ id: string; device_id: string; state: string; ask: RunAsk | null } | null> {
  return ((await q(`SELECT id::text,device_id::text,state,ask FROM local_runs WHERE ${kind === "card" ? "task_id" : "topic_id"}=$1 ORDER BY started_at DESC,id LIMIT 1`,
    [id])).rows[0] ?? null) as { id: string; device_id: string; state: string; ask: RunAsk | null } | null;
}
/** 这一轮所在的项目对话是哪个项目；不在项目对话里 409。 */
async function callProject(deps: BuddyDeps, call: Call): Promise<string> {
  const scope = await conversationScope(deps.q, call.personId, call.conversationId);
  if (!scope.startsWith("project:")) throw new BuddyError(409, "PROJECT_ONLY", "这个动作只在项目对话里用；在伙伴台请用 message_project 把话转给项目对话");
  return scope.slice("project:".length);
}
/** 这个项目对话里这个字母是哪个子会话（本人的）。 */
/** 写子会话挂的 Task 和条目，回原来的样子；带 expect 时现在的不是它就不写、回 null（撤回时用）。 */
async function writeSubLink(q: Query, kind: SubKind, id: string, set: SubLink, expect?: SubLink): Promise<SubLink | null> {
  const row = (kind === "card"
    ? (await q("SELECT plan_task_id,criterion_index,criterion_text FROM tasks WHERE id=$1", [id])).rows[0]
    : (await q("SELECT plan_task_id FROM research_topics WHERE id=$1", [id])).rows[0]) as
    { plan_task_id: string | null; criterion_index?: number | null; criterion_text?: string | null };
  const now: SubLink = { planTaskId: row.plan_task_id, criterionIndex: row.criterion_index ?? null, criterionText: row.criterion_text ?? null };
  // 撤回存在审计里（jsonb 不保键的顺序），逐项比。
  if (expect && (now.planTaskId !== expect.planTaskId || now.criterionIndex !== expect.criterionIndex || now.criterionText !== expect.criterionText)) return null;
  // 只写 Task 和条目，不动 mission_id（卡上 mission_id 和步骤序号要么都有要么都没有，tasks_step_with_mission）。
  if (kind === "card") await q("UPDATE tasks SET plan_task_id=$2,criterion_index=$3,criterion_text=$4 WHERE id=$1", [id, set.planTaskId, set.criterionIndex, set.criterionText]);
  else await q("UPDATE research_topics SET plan_task_id=$2 WHERE id=$1", [id, set.planTaskId]);
  return now;
}
async function lettered(deps: BuddyDeps, call: Call, letter: string): Promise<{ kind: SubKind; id: string; title: string; label: string; projectId: string }> {
  const projectId = await callProject(deps, call);
  const sub = await subByLetter(deps.q, projectId, letter);
  if (!sub) throw new BuddyError(404, "LETTER_NOT_FOUND", `这个项目里没有 ${letter}`);
  const row = await ownSub(deps.q, call.personId, sub.kind, sub.id);
  if (row.trashed_at) throw new BuddyError(404, "LETTER_NOT_FOUND", `${letter} 已经删进回收站了`);
  // 跟本人说的话里只写名字，不写字母（本人 11/16：界面上不再显示字母，字母只是调动作用的编号）。
  return { ...sub, title: row.title, label: `「${row.title}」`, projectId };
}
/** 主管线代本人的转话、重开算一步自动接力（18 节第 12 条）；到上限停着时不做。 */
async function relayStep(deps: BuddyDeps, projectId: string) {
  if (!(await autoRelayStep(deps.q, projectId, deps.now())))
    throw new BuddyError(409, "AUTO_RELAY_PAUSED", "这个项目的自动接力已经连续到上限，停着等本人：本人说一句话、或在「等你」里点「继续」以后再接着转");
}
/** 登记一条「请这台电脑对子会话做一件事」，由本人电脑上开着的网页认领后交给本机。 */
async function queueCommand(deps: BuddyDeps, call: Call, sub: { kind: SubKind; id: string }, run: { id: string; device_id: string }, command: TSessionCommand) {
  const id = randomUUID();
  await deps.q(`INSERT INTO session_commands(id,owner_id,kind,card_id,topic_id,run_id,device_id,command,requested_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
    [id, call.personId, sub.kind, sub.kind === "card" ? sub.id : null, sub.kind === "topic" ? sub.id : null, run.id, run.device_id, JSON.stringify(command), deps.now()]);
  return id;
}
const LATER = "（本人电脑上开着天枢网页时马上交给它）";

type Args<N extends BuddyActionName> = Static<(typeof BuddyActionParams)[N]>;
type Handlers = { [N in BuddyActionName]: (deps: BuddyDeps, call: Call, args: Args<N>) => Promise<Outcome> };

const handlers: Handlers = {
  read_partner_inbox: async (deps, call, { section, offset = 0, limit = 20 }) => {
    const path = section === "meetings" ? "/api/me/partner-meetings" : section === "events" ? "/api/me/partner-work-events" : "/api/me/team-deliveries?box=" + section;
    const result = await web<{ items: unknown[] }>(deps, call.personId, "GET", path);
    let items = result.items.slice(offset, offset + limit);
    if (section === "received" || section === "sent") {
      items = (items as TTeamDelivery[]).map(item => ({ id: item.id, kind: item.kind, createdAt: item.createdAt, sender: item.sender, dueAt: item.dueAt,
        text: item.text.slice(0, 250), attachments: item.attachments.length,
        recipients: item.recipients.map(person => ({ personId: person.personId, name: person.displayName, status: person.status, replies: person.replies.length })) }));
    }
    return { summary: "读了本人的伙伴收件记录", result: { items, total: result.items.length, nextOffset: offset + limit < result.items.length ? offset + limit : null } };
  },
  read_partner_item: async (deps,call,{kind,id,attachmentId,source}) => {
    if ((kind === "attachment") !== Boolean(attachmentId)) throw new BuddyError(400,"INVALID_ARGS","读取附件时请提供该请求里的附件标识");
    if (source && kind !== "meeting") throw new BuddyError(400, "INVALID_ARGS", "只有会议记录可以选择正文来源");
    const prefix = kind === "meeting" ? "meeting:" : kind === "minute" ? "feishu-minute:" : null;
    const key = encodeURIComponent(prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id);
    const path = kind === "meeting" ? `/api/me/partner-meetings/${key}/record${source ? "?source=" + source : ""}` : kind === "minute" ? `/api/me/partner-meetings/minutes/${key}`
      : "/api/me/team-deliveries/" + key + (attachmentId ? "/attachments/"+encodeURIComponent(attachmentId)+"/text" : "");
    return {summary:"读取了本人有权打开的内容",result:await web(deps,call.personId,"GET",path)};
  },
  read_work_home: async (deps, call) => ({ summary: "读了首页", result: await web(deps, call.personId, "GET", "/api/me/work-home") }),
  read_project: async (deps, call, args) => {
    const path = `/api/me/projects/${encodeURIComponent(args.projectId)}`;
    const project = await web(deps, call.personId, "GET", path);
    const [feed, home] = await Promise.all([
      web(deps, call.personId, "GET", `${path}/feed`),
      web<TWorkHomeResponse>(deps, call.personId, "GET", "/api/me/work-home"),
    ]);
    const current = home.projects.find((entry) => entry.projectId === args.projectId);
    return { summary: "读了这个项目", result: { ...(project as object), feed, subSessions: current?.subSessions ?? null } };
  },
  find_people: async (deps, call, args) => {
    const query = args.query.trim().toLowerCase();
    const people = [...deps.names()].filter(([personId, name]) => name.toLowerCase().includes(query) || personId.toLowerCase().includes(query)).slice(0, 10)
      .map(([personId, name]) => ({ personId, name, self: personId === call.personId }));
    return { summary: people.length ? `找到 ${people.length} 个` : "人员目录里没有这个名字", result: { people } };
  },
  open_page: async (_deps, _call, args) => ({ summary: "打开了", ui: [{ kind: "open", target: args.target }] }),
  set_appearance: async (deps, call, args) => {
    const previous = (await web<{ appearance: string }>(deps, call.personId, "GET", "/api/me/appearance")).appearance;
    await web(deps, call.personId, "PUT", "/api/me/appearance", args);
    const label = { system: "跟随系统", light: "浅色", dark: "深色" }[args.appearance];
    return { summary: `外观换成了${label}`, undo: previous === args.appearance ? null : { kind: "appearance", previous, set: args.appearance },
      ui: [{ kind: "appearance", appearance: args.appearance }] };
  },
  set_feishu_push: async (deps, call, args) => {
    const previous = (await web<{ feishu: boolean }>(deps, call.personId, "GET", "/api/me/notification-settings")).feishu;
    await web(deps, call.personId, "PUT", "/api/me/notification-settings", { feishu: args.feishu });
    return { summary: args.feishu ? "飞书推送打开了" : "飞书推送关掉了", undo: previous === args.feishu ? null : { kind: "feishu", previous, set: args.feishu },
      ui: [{ kind: "refresh", what: ["settings"] }] };
  },
  start_sub_session: async (deps, call, args) => {
    const { q } = deps;
    const sub = await ownSub(q, call.personId, args.kind, args.id);
    if (sub.trashed_at || sub.archived_at || (args.kind === "card" ? ["done", "returned"].includes(sub.status) : sub.status !== "active"))
      throw new BuddyError(409, "NOT_STARTABLE", `「${sub.title}」已经完成、归档或删掉了，不能开工`);
    const run = await activeRun(q, args.kind, args.id);
    if (run && run.state !== "idle") throw new BuddyError(409, "ALREADY_RUNNING", `「${sub.title}」已经在跑了`);
    // 停着的会话不再开一次，说一句就续上：主线用 tell_session，项目对话（本机项目会话也是）里只有按字母的 sub_session_tell。
    if (run) throw new BuddyError(409, "ALREADY_RUNNING", (await conversationScope(q, call.personId, call.conversationId)).startsWith("project:")
      ? `「${sub.title}」停着等下一句，用 sub_session_tell 按字母对它说一句就能续上。` : `「${sub.title}」停着等下一句，用 tell_session 对它说一句就能续上。`);
    const open = (await q(`SELECT 1 FROM session_starts WHERE ${column(args.kind)}=$1 AND closed_at IS NULL`, [args.id])).rowCount;
    if (open) return { summary: `「${sub.title}」已经登记过开工了，等电脑接下`, undo: null };
    await requestStarts(q, { ownerId: call.personId, origin: "buddy", now: deps.now(), items: [args.kind === "card"
      ? { kind: "card", cardId: args.id, planTaskId: sub.plan_task_id } : { kind: "topic", topicId: args.id, planTaskId: sub.plan_task_id }] });
    return { summary: `让「${sub.title}」开工了，本人电脑上开着的网页接下后就开始`, undo: { kind: "start", sub: args.kind, id: args.id }, ui: [subRefresh(args.id)] };
  },
  stop_sub_session: async (deps, call, args) => {
    const { q } = deps;
    const now = deps.now();
    const sub = await ownSub(q, call.personId, args.kind, args.id);
    if (await cancelStart(q, call.personId, args.kind, args.id, now)) return { summary: `撤掉了「${sub.title}」的开工登记`, ui: [subRefresh(args.id)] };
    const run = await activeRun(q, args.kind, args.id);
    if (!run) throw new BuddyError(409, "NOT_RUNNING", `「${sub.title}」没在跑`);
    await q(`INSERT INTO session_stops(id,owner_id,kind,${column(args.kind)},run_id,device_id,requested_at) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING`, [randomUUID(), call.personId, args.kind, args.id, run.id, run.device_id, now]);
    // 排着的停掉是从队列撤下（本机不再等空位、前面的卡做完也不开工）
    const done = run.state === "queued" ? `已请那台电脑把「${sub.title}」从队列撤下` : `已请那台电脑停掉「${sub.title}」`;
    return { summary: `${done}（本人电脑上开着天枢网页时马上停）`, ui: [subRefresh(args.id)] };
  },
  archive_sub_session: async (deps, call, args) => {
    const { q } = deps;
    const sub = await ownSub(q, call.personId, args.kind, args.id);
    if (sub.trashed_at) throw new BuddyError(404, "NOT_FOUND", "没有这个子会话");
    await notRunning(q, args.kind, args.id, sub.title);
    if (args.kind === "topic") {
      if (sub.status !== "active") return { summary: `「${sub.title}」已经归档了`, undo: null };
      await web(deps, call.personId, "PATCH", `/api/me/topics/${args.id}`, { status: "archived" });
    } else {
      if (sub.archived_at) return { summary: `「${sub.title}」已经归档了`, undo: null };
      await q("UPDATE tasks SET archived_at=$2 WHERE id=$1", [args.id, deps.now()]);
    }
    await closeStarts(q, args.kind, args.id, deps.now());
    return { summary: `把「${sub.title}」归档了`, undo: { kind: "unarchive_sub", sub: args.kind, id: args.id }, ui: [subRefresh(args.id)] };
  },
  delete_sub_session: async (deps, call, args) => {
    const { q } = deps;
    const sub = await ownSub(q, call.personId, args.kind, args.id);
    if (sub.trashed_at) return { summary: `「${sub.title}」已经在回收站里了`, undo: null };
    await notRunning(q, args.kind, args.id, sub.title);
    await q(`UPDATE ${subTable(args.kind)} SET trashed_at=$2 WHERE id=$1`, [args.id, deps.now()]);
    await closeStarts(q, args.kind, args.id, deps.now());
    return { summary: `把「${sub.title}」删进了回收站，${TRASH_DAYS} 天内能恢复`, undo: { kind: "restore", sub: args.kind, id: args.id }, ui: [subRefresh(args.id, ["trash"])] };
  },
  create_project: async (deps, call, args) => {
    const project = await web<{ projectId: string; name: string }>(deps, call.personId, "POST", "/api/me/projects", args);
    return { summary: `新建了项目「${project.name}」`, result: { projectId: project.projectId },
      undo: { kind: "project_archived", projectId: project.projectId, archived: false }, ui: [projectRefresh(project.projectId)] };
  },
  rename_project: async (deps, call, args) => {
    const previous = await projectName(deps, call.personId, args.projectId);
    await web(deps, call.personId, "PATCH", `/api/me/projects/${encodeURIComponent(args.projectId)}`, { name: args.name });
    return { summary: `把项目「${previous}」改名为「${args.name}」`,
      undo: previous === args.name ? null : { kind: "project_name", projectId: args.projectId, previous, set: args.name }, ui: [projectRefresh(args.projectId)] };
  },
  archive_project: async (deps, call, args) => {
    const name = await projectName(deps, call.personId, args.projectId);
    await web(deps, call.personId, "PATCH", `/api/me/projects/${encodeURIComponent(args.projectId)}`, { archived: true });
    return { summary: `把项目「${name}」归档了`, undo: { kind: "project_archived", projectId: args.projectId, archived: true }, ui: [projectRefresh(args.projectId)] };
  },
  link_task_to_project: async (deps, call, args) => {
    const previousProjectId = ((await deps.q("SELECT project_id::text FROM project_goals WHERE owner_id=$1 AND task_id=$2", [call.personId, args.taskId])).rows[0]
      ?.project_id ?? null) as string | null;
    const goal = await web<{ taskName: string }>(deps, call.personId, "PUT", `/api/me/projects/${encodeURIComponent(args.projectId)}/goals/${encodeURIComponent(args.taskId)}`);
    const name = await projectName(deps, call.personId, args.projectId);
    return { summary: `把 Task「${goal.taskName}」挂到了项目「${name}」`, result: goal,
      undo: previousProjectId === args.projectId ? null : { kind: "goal", projectId: args.projectId, taskId: args.taskId, previousProjectId },
      ui: [projectRefresh(args.projectId)] };
  },
  transfer_project: async (deps, call, args) => {
    const path = `/api/me/projects/${encodeURIComponent(args.projectId)}/transfers`;
    const transfer = await web<{ id: string }>(deps, call.personId, "POST", path, { toPersonId: args.toPersonId });
    // 先标上「写好就发」，再看说明是不是已经写好了：两边谁晚谁发，不会漏。
    await deps.q("UPDATE project_transfers SET send_when_ready=true WHERE id=$1", [transfer.id]);
    const sent = await sendIfReady(deps, call.personId, transfer.id);
    const name = await projectName(deps, call.personId, args.projectId);
    const to = deps.names().get(args.toPersonId) ?? args.toPersonId;
    return { summary: sent === "sent" ? `已把项目「${name}」转交给${to}，等对方接手`
      : sent === "secrets" ? `发起了把项目「${name}」转交给${to}，交接说明里有疑似凭据，本人在转交页改完再发`
        : `发起了把项目「${name}」转交给${to}，交接说明写好就发出`,
    result: { transferId: transfer.id }, undo: { kind: "transfer", transferId: transfer.id }, ui: [projectRefresh(args.projectId)] };
  },
  split_cards: async (deps, call, args) => {
    if (Boolean(args.taskId) === Boolean(args.projectId)) throw new BuddyError(400, "INVALID_ARGS", "taskId 和 projectId 要带且只带一个");
    // 本人 11/16 方案 A：这个月挂了 Task 的项目按 Task 拆，拆出来的卡才知道对的是哪件 Task 的第几条（本月页照它算进度）。
    if (args.projectId) {
      const goals = (await deps.q("SELECT task_id,task_name FROM project_goals WHERE project_id=$1 AND owner_id=$2 AND period=$3 ORDER BY linked_at,task_id",
        [args.projectId, call.personId, companyPeriod(deps.now())])).rows as { task_id: string; task_name: string }[];
      if (goals.length) throw new BuddyError(409, "PROJECT_HAS_TASKS", `这个项目这个月挂了 Task，按 Task 拆（每件带 taskId 拆一次）：${goals.map((goal) => `「${goal.task_name}」（taskId ${goal.task_id}）`).join("、")}`);
    }
    // 原话只认本人真说的（16.8）：伙伴带的每段都得是本人最近在项目对话里说的话的原样子串才用，不然改用本人最近说的那几条（同内部登记）。
    // 要在登记之前读：本人最近说的话从上一次登记之后算。
    const said = await recentOwnerWords(deps.q, deps.history, call.personId, { taskId: args.taskId ?? null, projectId: args.projectId ?? null }, call.runId ?? randomUUID());
    const words = checkedWords(said, args.words?.trim() ? args.words.trim().split(/\n\s*\n/) : undefined);
    const body = args.modelWords?.trim() ? { modelWords: args.modelWords.trim() } : {};
    // 登记之前就有一条没开的：那条不是这次登记的，不给撤。
    const before = new Set(((await deps.q("SELECT id::text FROM card_split_requests WHERE owner_id=$1 AND closed_at IS NULL", [call.personId])).rows as
      { id: string }[]).map((row) => row.id));
    const request = await web<{ id: string }>(deps, call.personId, "POST", args.taskId
      ? `/api/plan-tasks/${encodeURIComponent(args.taskId)}/card-splits` : `/api/me/projects/${encodeURIComponent(args.projectId!)}/card-splits`, body);
    const created = !before.has(request.id);
    // 网页那条路只存按钮输入框的一段话，原话在这里写；没有可存的就不动已有那条的。
    if (words.length) await deps.q("UPDATE card_split_requests SET source_words=$2::jsonb WHERE id=$1", [request.id, JSON.stringify(words)]);
    return { summary: "登记了拆卡，本人电脑上开着的网页接下后就开始拆", result: { requestId: request.id },
      undo: created ? { kind: "split", requestId: request.id } : null,
      ui: [args.projectId ? projectRefresh(args.projectId) : { kind: "refresh", what: ["work_home"] }] };
  },
  set_budget: async (deps, call, args) => {
    if (args.taskId) {
      const path = `/api/me/tasks/${encodeURIComponent(args.taskId)}/budget`;
      const before = await web<{ budget: TBudget; inherited: boolean }>(deps, call.personId, "GET", path);
      await web(deps, call.personId, "PUT", path, args.budget);
      return { summary: "改了这件 Task 的预算", undo: { kind: "budget", taskId: args.taskId, previous: before.inherited ? null : before.budget },
        ui: [{ kind: "refresh", what: ["work_home"] }] };
    }
    const before = await web<TBudget>(deps, call.personId, "GET", "/api/me/budget-default");
    await web(deps, call.personId, "PUT", "/api/me/budget-default", args.budget);
    return { summary: "改了新 Task 的缺省预算", undo: { kind: "budget", taskId: null, previous: before }, ui: [{ kind: "refresh", what: ["settings"] }] };
  },
  set_task_due_date: async (deps, call, args) => {
    const previous = (await taskDueDates(deps.q, [args.taskId])).get(args.taskId) ?? null;
    // 按 Task 存的那一份（PUT /api/me/tasks/:taskId/due-date），不要求挂项目；projectId 带了只用来刷新那个项目。
    const saved = await web<{ name: string }>(deps, call.personId, "PUT", `/api/me/tasks/${encodeURIComponent(args.taskId)}/due-date`, { dueDate: args.dueDate });
    return { summary: args.dueDate ? `把「${saved.name}」的验收截止日定成 ${args.dueDate}` : `「${saved.name}」不再单独存截止日，按 Mission 的节点算`,
      undo: previous === args.dueDate ? null : { kind: "due_date", ...(args.projectId ? { projectId: args.projectId } : {}), taskId: args.taskId, previous },
      ui: [args.projectId ? projectRefresh(args.projectId) : { kind: "refresh", what: ["work_home"] }] };
  },
  message_project: async (deps, call, args) => {
    // 只从伙伴台往项目对话转（18 节第 8 条）。项目对话自己也拿到这张动作清单，它再转一次会把同一句转回自己、一轮接一轮转下去。
    if (call.conversationId && (await deps.q("SELECT 1 FROM project_pipelines WHERE owner_id=$1 AND conversation_id=$2", [call.personId, call.conversationId])).rowCount)
      throw new BuddyError(409, "ALREADY_IN_PROJECT", "这里已经是项目对话，直接在这里安排，不用再转");
    const path = `/api/me/projects/${encodeURIComponent(args.projectId)}`;
    const name = await projectName(deps, call.personId, args.projectId);
    // 项目对话还没开过就开（归档的、别人的照网页接口回错）。
    await web(deps, call.personId, "POST", `${path}/pipeline`);
    const requestId = call.runId ? forwardedInputId(call.runId, call.personId, args.projectId, args.text) : randomUUID();
    // 同一轮同一句重放：排队那条是同一条（同一个 id），派活卡也不再出。
    const earlier = await findDispatch(deps.q, call.personId, requestId);
    const item = await web(deps, call.personId, "POST", "/api/me/work-intake", { id: requestId, scope: `project:${args.projectId}`,
      message: BUDDY_FORWARD_PREFIX + args.text, attachments: [] });
    const card = earlier ? null : await recordDispatch(deps.q, { ownerId: call.personId, requestKey: requestId, runId: call.runId, conversationId: call.conversationId,
      projectId: args.projectId, projectName: name, topic: null, now: deps.now() });
    return { summary: `已把这条要求排进项目「${name}」的对话`, result: item, undo: null, ui: [projectRefresh(args.projectId)], ...(card ? { card } : {}) };
  },
  open_session: async (deps, call, args) => {
    if (Boolean(args.projectId) === Boolean(args.scratch)) throw new BuddyError(400, "INVALID_ARGS", "projectId 和 scratch 带且只带一个");
    const title = args.title.trim();
    if (!title) throw new BuddyError(400, "INVALID_ARGS", "title 不能全是空白");
    if ((await conversationScope(deps.q, call.personId, call.conversationId)).startsWith("project:"))
      throw new BuddyError(409, "MAIN_ONLY", "这个动作只在伙伴主线用");
    // 归档了的项目不另拦：建会话的接口照旧回 404「找不到这个项目」。
    const project = args.scratch ? await ensureScratchProject(deps.q, call.personId, deps.now()) : null;
    const projectId = project?.id ?? args.projectId!;
    const name = project?.name ?? await projectName(deps, call.personId, projectId);
    if (await projectPaused(deps.q, projectId)) throw new BuddyError(409, "PROJECT_PAUSED", "这个项目在交接，先等负责人开口");
    // 同一轮同一句交代重放（模型重试、工具重放）只开一个，也不再出卡；换一轮是本人又要了一次。
    const requestKey = call.runId
      ? createHash("sha256").update(JSON.stringify([call.runId, call.personId, "open_session", projectId, args.brief])).digest("hex") : randomUUID();
    const opened = (card: DispatchCard, replay: boolean): Outcome => {
      const sub = card.sub!;
      return { summary: `在项目「${card.projectName}」里开了「${sub.title}」，本人电脑上开着的网页接下后就开始`,
        result: { dispatchId: card.dispatchId, projectId: card.projectId, projectName: card.projectName, kind: "topic", id: sub.id, title: sub.title },
        undo: null, ui: sub.id ? [subRefresh(sub.id, ["project"])] : [], ...(replay ? {} : { card }) };
    };
    const earlier = await findDispatch(deps.q, call.personId, requestKey);
    if (earlier) return opened(earlier, true);
    const topic = await web<{ id: string }>(deps, call.personId, "POST", "/api/me/topics", { free: true, projectId, firstMessage: args.brief });
    await web(deps, call.personId, "PATCH", `/api/me/sub-sessions/topic/${encodeURIComponent(topic.id)}`, { title });
    const card = await recordDispatch(deps.q, { ownerId: call.personId, requestKey, runId: call.runId, conversationId: call.conversationId,
      projectId, projectName: name, topic: { id: topic.id, title }, now: deps.now() });
    return opened(card, false);
  },
  send_message: async (deps, call, args) => {
    const names = deps.names();
    const to = [...new Set(args.toPersonIds)];
    const unknown = to.filter((id) => !names.has(id) || id === call.personId);
    if (unknown.length) throw new BuddyError(404, "PERSON_NOT_FOUND", `人员目录里没有：${unknown.join("、")}（也不能转达给自己）`);
    if ((await sentToday(deps.q, call.personId, deps.now())) >= BUDDY_DAILY_MESSAGES)
      throw new BuddyError(429, "DAILY_LIMIT", `今天已经转达了 ${BUDDY_DAILY_MESSAGES} 条，明天再发`);
    const id = randomUUID();
    await deps.q(`INSERT INTO buddy_messages(id,owner_id,to_ids,text,status,conversation_id,run_id,created_at) VALUES($1,$2,$3,$4,'draft',$5,$6,$7)`,
      [id, call.personId, to, args.text, call.conversationId, call.runId, deps.now()]);
    const list = to.map((personId) => names.get(personId)!).join("、");
    return { summary: `给${list}的话写好了，等本人在卡上点「发出」`, result: { draftId: id }, undo: null, card: { kind: "buddy_message", draftId: id } };
  },
  ask_user: async (deps, call, args) => {
    const misplaced = args.questions.find((question) => question.options.some((option, index) => option.recommended && index > 0));
    if (misplaced) throw new BuddyError(400, "INVALID_ARGS", `参数不对：「${misplaced.header}」推荐的选项要放在第一个，每题最多推荐一个`);
    if (!call.runId) throw new BuddyError(409, "NO_TURN", "这一轮没带 runId，选项框出不来，请把问题直接写在回答里");
    const id = randomUUID();
    await deps.q(`INSERT INTO buddy_questions(id,owner_id,scope,conversation_id,run_id,questions,status,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,'open',$7)`,
      [id, call.personId, await conversationScope(deps.q, call.personId, call.conversationId), call.conversationId, call.runId, JSON.stringify(args.questions), deps.now()]);
    return { summary: "选项框出给本人了。这一轮到这里结束，等本人回答（下一条消息）；本人先聊别的就照新的话办。", result: { questionId: id },
      card: { kind: "buddy_question", questionId: id, questions: args.questions, status: "open" } };
  },
  update_card: async (deps, call, args) => {
    if (Boolean(args.letter) === Boolean(args.cardId)) throw new BuddyError(400, "INVALID_ARGS", "letter 和 cardId 给一样");
    if (args.brief === undefined && !args.standards) throw new BuddyError(400, "INVALID_ARGS", "brief 和 standards 至少给一样");
    let card: { id: string; label: string };
    if (args.letter) {
      const sub = await lettered(deps, call, args.letter);
      if (sub.kind !== "card") throw new BuddyError(400, "NOT_A_CARD", `${sub.label}是专题，没有完成标准`);
      card = { id: sub.id, label: sub.label };
    } else {
      await callProject(deps, call);
      card = { id: args.cardId!, label: `「${(await ownSub(deps.q, call.personId, "card", args.cardId!)).title}」` };
    }
    try {
      const revision = await writeAgreement(deps.q, await agreementRow(deps.q, call.personId, card.id), { brief: args.brief, standards: args.standards },
        { kind: "pipeline", name: "管线" }, args.reason.trim(), deps.now());
      return { summary: revision === null ? `${card.label}的约定和原来一样，没改` : `改了${card.label}的约定（第 ${revision} 版）`,
        result: { id: card.id, revision }, ui: [subRefresh(card.id)] };
    } catch (cause) {
      if (cause instanceof CardError) throw new BuddyError(cause.status, cause.code, cause.message);
      throw cause;
    }
  },
  sub_session_tell: async (deps, call, args) => {
    const sub = await lettered(deps, call, args.letter);
    const run = await lastRun(deps.q, sub.kind, sub.id);
    if (!run) throw new BuddyError(409, "NOT_STARTED", `${sub.label}还没开过工，先用 sub_session_restart 开工`);
    await relayStep(deps, sub.projectId);
    const commandId = await queueCommand(deps, call, sub, run, { type: "message", text: args.text });
    return { summary: `把话转给了${sub.label}${LATER}`, result: { letter: args.letter, kind: sub.kind, id: sub.id, title: sub.title, commandId }, ui: [subRefresh(sub.id)] };
  },
  tell_session: async (deps, call, args) => {
    if ((await conversationScope(deps.q, call.personId, call.conversationId)).startsWith("project:"))
      throw new BuddyError(409, "MAIN_ONLY", "这个动作只在伙伴主线用");
    const row = await ownSub(deps.q, call.personId, args.kind, args.id);
    if (row.trashed_at || row.archived_at || row.status === "archived") throw new BuddyError(404, "NOT_FOUND", "没有这个子会话");
    const run = await lastRun(deps.q, args.kind, args.id);
    if (!run) throw new BuddyError(409, "NOT_STARTED", `「${row.title}」还没开过工，先用 start_sub_session 开工`);
    // 主线的转话是本人当轮让转的，不算自动接力（不调 relayStep）。
    const commandId = await queueCommand(deps, call, args, run, { type: "message", text: args.text });
    return { summary: `把话转给了「${row.title}」${LATER}`, result: { kind: args.kind, id: args.id, title: row.title, commandId }, ui: [subRefresh(args.id)] };
  },
  sub_session_stop: async (deps, call, args) => {
    const sub = await lettered(deps, call, args.letter);
    const outcome = await handlers.stop_sub_session(deps, call, { kind: sub.kind, id: sub.id });
    return { ...outcome, result: { letter: args.letter, kind: sub.kind, id: sub.id, title: sub.title } };
  },
  sub_session_rename: async (deps, call, args) => {
    const sub = await lettered(deps, call, args.letter);
    const title = args.title.trim();
    await web(deps, call.personId, "PATCH", `/api/me/sub-sessions/${sub.kind}/${encodeURIComponent(sub.id)}`, { title });
    return { summary: `把${sub.label}改名为「${title}」`, result: { letter: args.letter, kind: sub.kind, id: sub.id, title },
      undo: sub.title === title ? null : { kind: "sub_title", sub: sub.kind, id: sub.id, previous: sub.title, set: title }, ui: [subRefresh(sub.id)] };
  },
  sub_session_link: async (deps, call, args) => {
    const sub = await lettered(deps, call, args.letter);
    const goal = (await deps.q("SELECT task_name FROM project_goals WHERE project_id=$1 AND task_id=$2 LIMIT 1", [sub.projectId, args.taskId])).rows[0] as
      { task_name: string } | undefined;
    if (!goal) throw new BuddyError(404, "TASK_NOT_IN_PROJECT", "这件 Task 没挂在这个项目上，先读 read_work_home 看这个项目的 goals");
    if (sub.kind === "topic" && args.criterion !== null) throw new BuddyError(400, "NOT_A_CARD", `${sub.label}是专题，只挂 Task，criterion 写 null`);
    let text: string | null = null;
    if (args.criterion !== null) {
      const agreement = await web<{ criteria: { index: number; text: string }[] }>(deps, call.personId, "GET", `/api/plan-tasks/${encodeURIComponent(args.taskId)}/agreement`);
      text = agreement.criteria.find((item) => item.index === args.criterion)?.text ?? null;
      if (!text) throw new BuddyError(400, "CRITERION_NOT_FOUND", `「${goal.task_name}」只有 ${agreement.criteria.length} 条验收标准`);
    }
    const set: SubLink = { planTaskId: args.taskId, criterionIndex: args.criterion, criterionText: text };
    const previous = (await writeSubLink(deps.q, sub.kind, sub.id, set))!;
    return { summary: `把${sub.label}挂到「${goal.task_name}」${args.criterion ? `第 ${args.criterion} 条` : ""}`,
      result: { letter: args.letter, kind: sub.kind, id: sub.id, title: sub.title, taskId: args.taskId, criterion: args.criterion },
      undo: { kind: "sub_link", sub: sub.kind, id: sub.id, previous, set }, ui: [subRefresh(sub.id), { kind: "refresh", what: ["work_home"] }] };
  },
  sub_session_restart: async (deps, call, args) => {
    const sub = await lettered(deps, call, args.letter);
    const run = await lastRun(deps.q, sub.kind, sub.id);
    const result = { letter: args.letter, kind: sub.kind, id: sub.id, title: sub.title };
    if (!run) {
      await relayStep(deps, sub.projectId);
      const outcome = await handlers.start_sub_session(deps, call, { kind: sub.kind, id: sub.id });
      return { ...outcome, result: { ...result, start: true } };
    }
    if (["queued", "starting", "running"].includes(run.state)) throw new BuddyError(409, "ALREADY_RUNNING", `${sub.label}正在跑，不用重开`);
    if (run.state === "waiting_permission") throw new BuddyError(409, "WAITING_PERMISSION", `${sub.label}在等批准，先批准或拒绝`);
    if (run.state === "idle" && run.ask?.kind === "question") throw new BuddyError(409, "ASKING", `${sub.label}在问问题，先回答`);
    await relayStep(deps, sub.projectId);
    const commandId = await queueCommand(deps, call, sub, run, { type: "message", text: args.text ?? "接着做" });
    return { summary: `让${sub.label}接着做了${LATER}`, result: { ...result, commandId }, ui: [subRefresh(sub.id)] };
  },
  sub_session_answer: async (deps, call, args) => {
    const sub = await lettered(deps, call, args.letter);
    const run = await lastRun(deps.q, sub.kind, sub.id);
    if (!run || run.state !== "idle" || run.ask?.kind !== "question") throw new BuddyError(409, "NOT_ASKING", `${sub.label}现在没在问问题`);
    const asked = run.ask.request.questions.length;
    if (args.choices.length !== asked) throw new BuddyError(400, "INVALID_ARGS", `参数不对：${sub.label}问了 ${asked} 题，choices 要 ${asked} 条`);
    const commandId = await queueCommand(deps, call, sub, run, { type: "answer", requestId: run.ask.request.requestId,
      answer: { choices: args.choices, ...(args.text ? { text: args.text } : {}) } });
    return { summary: `替本人回答了${sub.label}的问题${LATER}`, result: { letter: args.letter, kind: sub.kind, id: sub.id, title: sub.title, commandId }, ui: [subRefresh(sub.id)] };
  },
  sub_session_approve: async (deps, call, args) => {
    const sub = await lettered(deps, call, args.letter);
    const run = await lastRun(deps.q, sub.kind, sub.id);
    if (!run || run.state !== "waiting_permission" || run.ask?.kind !== "permission") throw new BuddyError(409, "NOT_WAITING_PERMISSION", `${sub.label}现在没在等批准`);
    const { decision, message, allowForSession } = args;
    const commandId = await queueCommand(deps, call, sub, run, { type: "permission", requestId: run.ask.request.requestId,
      decision: { decision, ...(message ? { message } : {}), ...(allowForSession !== undefined ? { allowForSession } : {}) } });
    return { summary: `${decision === "allow" ? "批准" : "拒绝"}了${sub.label}的「${run.ask.request.title}」${LATER}`,
      result: { letter: args.letter, kind: sub.kind, id: sub.id, title: sub.title, commandId }, ui: [subRefresh(sub.id)] };
  },
  update_plan: async (deps, call, args) => {
    if (args.entries.length < 2) return { summary: "少于两步，不出清单" };
    if (!call.runId) return { summary: "清单记下了（这一轮没带 runId，界面上看不到）" };
    await deps.q(`INSERT INTO buddy_plans(run_id,owner_id,entries,collapsed,updated_at) VALUES($1,$2,$3::jsonb,false,$4)
      ON CONFLICT (run_id) DO UPDATE SET entries=EXCLUDED.entries,collapsed=false,updated_at=EXCLUDED.updated_at`,
    [call.runId, call.personId, JSON.stringify(args.entries), deps.now()]);
    deps.stream?.(call.runId, { type: "plan", plan: { entries: args.entries, collapsed: false } });
    return { summary: "清单更新了" };
  },
};

/** 同一轮工具调用重放时引用原队列项；本人在以后的对话里可再次提出相同要求。 */
function forwardedInputId(run: string, person: string, project: string, message: string): string {
  const id = createHash("sha256").update(JSON.stringify([run, person, project, message])).digest("hex");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-8${id.slice(13, 16)}-a${id.slice(17, 20)}-${id.slice(20, 32)}`;
}

/** 转交的说明写好了、还在准备中、没有疑似凭据：发出。说明还没写好时等后台写好再发（projectTransfers.ts 的 writeLater）。 */
async function sendIfReady(deps: BuddyDeps, personId: string, transferId: string): Promise<"sent" | "waiting" | "secrets"> {
  const row = (await deps.q("SELECT status,note FROM project_transfers WHERE id=$1", [transferId])).rows[0] as { status: string; note: unknown } | undefined;
  if (row?.status === "sent") return "sent";
  if (!row || row.status !== "preparing" || row.note === null) return "waiting";
  try {
    await web(deps, personId, "POST", `/api/me/project-transfers/${transferId}/send`);
    return "sent";
  } catch (cause) {
    if (cause instanceof BuddyError && cause.code === "SECRET_IN_NOTE") return "secrets";
    // 后台刚好先发出了。
    if (cause instanceof BuddyError && cause.status === 409) return "sent";
    throw cause;
  }
}

/** 今天（公司时区）发出去的转达条数。 */
async function sentToday(q: Query, ownerId: string, now: Date): Promise<number> {
  return Number((await q(`SELECT count(*) AS n FROM buddy_messages WHERE owner_id=$1 AND status='sent'
    AND date_trunc('day',sent_at AT TIME ZONE 'Asia/Shanghai')=date_trunc('day',$2::timestamptz AT TIME ZONE 'Asia/Shanghai')`, [ownerId, now])).rows[0].n);
}

type BuddyActionOutcome = { summary: string; result: unknown; auditId: string | null; undoable: boolean };

/** 按名字执行一个动作。没有这个动作 404，参数不对 400，写动作没授权 403；其余错误是对应接口的。 */
export async function runAction(deps: BuddyDeps, call: Call, name: string, args: unknown): Promise<BuddyActionOutcome> {
  if (!(BUDDY_ACTION_NAMES as string[]).includes(name)) throw new BuddyError(404, "UNKNOWN_ACTION", `没有 ${name} 这个动作`);
  const action = name as BuddyActionName;
  const schema = BuddyActionParams[action];
  const input = args ?? {};
  if (!Value.Check(schema, input)) {
    const first = Value.Errors(schema, input).First();
    throw new BuddyError(400, "INVALID_ARGS", `参数不对：${first ? `${first.path || "/"} ${first.message}` : "格式不符"}`);
  }
  const kind = KIND[action];
  if (kind === "write" && (await readAuthority(deps.q, call.personId)).authority !== "full")
    throw new BuddyError(403, "BUDDY_NOT_AUTHORIZED", "本人还没同意让伙伴代为操作，这件事请本人自己做，或先在偏好里打开");
  const outcome = await (handlers[action] as (deps: BuddyDeps, call: Call, args: unknown) => Promise<Outcome>)(deps, call, input);
  let auditId: string | null = null;
  if (kind === "write") {
    auditId = randomUUID();
    await deps.q(`INSERT INTO buddy_actions(id,owner_id,action,args,summary,undo,conversation_id,run_id,at) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8,$9)`,
      [auditId, call.personId, action, JSON.stringify(input), outcome.summary, outcome.undo ? JSON.stringify(outcome.undo) : null, call.conversationId, call.runId, deps.now()]);
  }
  if (call.runId && deps.stream) {
    for (const ui of outcome.ui ?? []) deps.stream(call.runId, { type: "ui", ui });
    if (outcome.card) deps.stream(call.runId, { type: "card", card: outcome.card });
    if (kind === "write") await tickPlan(deps, call.runId);
  }
  if (DISPATCH.has(action) && call.runId && call.conversationId) await thumbsUp(deps, call.personId, call.conversationId, call.runId);
  return { summary: outcome.summary, result: outcome.result ?? null, auditId, undoable: Boolean(outcome.undo) };
}

/** 派活的动作：做成了伙伴在本人这一轮那句话上点 👍。 */
const DISPATCH = new Set<BuddyActionName>(["split_cards", "start_sub_session", "sub_session_tell", "tell_session", "sub_session_restart", "message_project", "open_session"]);
/** 点 👍 并插进这一轮的流；失败只记日志，不让动作失败。 */
async function thumbsUp(deps: BuddyDeps, personId: string, conversationId: string, runId: string) {
  try {
    const scope = await conversationScope(deps.q, personId, conversationId);
    const emojis = await addBuddyReaction(deps.q, { personId, scope, runId, role: "user", emoji: "👍" });
    deps.stream?.(runId, { type: "buddy_reaction", role: "user", emojis });
  } catch (error) {
    logEvent({ event: "buddy_actions.reaction_failed", runId, error: (error as Error)?.message });
  }
}

/** 兜底：写动作做成了而伙伴没打勾，把清单上第一条进行中的标成完成。 */
async function tickPlan(deps: BuddyDeps, runId: string) {
  const row = (await deps.q("SELECT entries FROM buddy_plans WHERE run_id=$1", [runId])).rows[0] as { entries: TBuddyPlan["entries"] } | undefined;
  const index = row?.entries.findIndex((entry) => entry.status === "in_progress") ?? -1;
  if (!row || index < 0) return;
  const entries = row.entries.map((entry, at) => (at === index ? { ...entry, status: "completed" as const } : entry));
  await deps.q("UPDATE buddy_plans SET entries=$2::jsonb,updated_at=$3 WHERE run_id=$1", [runId, JSON.stringify(entries), deps.now()]);
  deps.stream?.(runId, { type: "plan", plan: { entries, collapsed: false } });
}

/** 这一轮结束（答完、出错停下，或本人在回答到一半时发来新消息）：那一轮的清单收起，条目不改。返回收起后的清单（没有清单为 null）。 */
export async function collapsePlan(q: Query, runId: string): Promise<TBuddyPlan | null> {
  const row = (await q("UPDATE buddy_plans SET collapsed=true WHERE run_id=$1 RETURNING entries", [runId])).rows[0] as { entries: TBuddyPlan["entries"] } | undefined;
  return row ? { entries: row.entries, collapsed: true } : null;
}

/** 这一轮在哪个对话里：项目对话是 project:<projectId>，其余是伙伴台（global）。 */
export async function conversationScope(q: Query, ownerId: string, conversationId: string | null): Promise<string> {
  if (!conversationId) return "global";
  const row = (await q("SELECT project_id::text FROM project_pipelines WHERE owner_id=$1 AND conversation_id=$2", [ownerId, conversationId])).rows[0] as
    { project_id: string } | undefined;
  return row ? `project:${row.project_id}` : "global";
}

/**
 * 本人在这个对话（scope）里发出了一条新消息（18 节第 9 条）：带 answered（回答的是哪个选项框）的那张标 answered，这个对话里其余还 open 的标 dismissed。
 * 在这一句交给 Chat 之前做，这一轮伙伴新出的框不受影响。
 */
export async function closeQuestions(q: Query, ownerId: string, scope: string, answered: string | undefined, now: Date): Promise<void> {
  if (answered) await q("UPDATE buddy_questions SET status='answered',closed_at=$4 WHERE id=$1 AND owner_id=$2 AND scope=$3 AND status='open'",
    [answered, ownerId, scope, now]);
  await q("UPDATE buddy_questions SET status='dismissed',closed_at=$3 WHERE owner_id=$1 AND scope=$2 AND status='open'", [ownerId, scope, now]);
}

/** 读回历史时接到回答上的：每一轮的清单和伙伴出的卡。 */
export async function runExtras(q: Query, ownerId: string, runIds: string[]): Promise<Map<string, { plan?: TBuddyPlan; cards?: TConversationCard[] }>> {
  const extras = new Map<string, { plan?: TBuddyPlan; cards?: TConversationCard[] }>();
  if (!runIds.length) return extras;
  for (const row of (await q("SELECT run_id,entries,collapsed FROM buddy_plans WHERE owner_id=$1 AND run_id=ANY($2::text[])", [ownerId, runIds])).rows as
    { run_id: string; entries: TBuddyPlan["entries"]; collapsed: boolean }[]) extras.set(row.run_id, { plan: { entries: row.entries, collapsed: row.collapsed } });
  // 转达草稿、选项框、派活卡按出的先后排。
  const cards = ((await q(`SELECT id::text,run_id,created_at,NULL::jsonb AS questions,NULL AS status FROM buddy_messages WHERE owner_id=$1 AND run_id=ANY($2::text[])
      UNION ALL SELECT id::text,run_id,created_at,questions,status FROM buddy_questions WHERE owner_id=$1 AND run_id=ANY($2::text[])`, [ownerId, runIds])).rows as
    { id: string; run_id: string; created_at: Date; questions: TBuddyAskQuestion[] | null; status: "open" | "answered" | "dismissed" | null }[])
    .map((row) => ({ id: row.id, runId: row.run_id, createdAt: row.created_at, card: (row.questions
      ? { kind: "buddy_question", questionId: row.id, questions: row.questions, status: row.status! } : { kind: "buddy_message", draftId: row.id }) as TConversationCard }))
    .concat((await dispatchCards(q, ownerId, runIds)).map((row) => ({ ...row, id: row.card.dispatchId })));
  cards.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  for (const row of cards) {
    const entry = extras.get(row.runId) ?? {};
    entry.cards = [...(entry.cards ?? []), row.card];
    extras.set(row.runId, entry);
  }
  return extras;
}

// ───────────────────────── 审计和撤销 ─────────────────────────

type AuditRow = { id: string; action: string; summary: string; at: Date; conversation_id: string | null; undo: Undo | null; undone_at: Date | null };
const auditView = (row: AuditRow): TBuddyAuditEntry => ({ id: row.id, action: row.action, summary: row.summary, at: row.at.toISOString(),
  conversationId: row.conversation_id, undoable: row.undo !== null && row.undone_at === null, undoneAt: row.undone_at?.toISOString() ?? null });

export async function listAudit(q: Query, ownerId: string): Promise<TBuddyAuditEntry[]> {
  return ((await q("SELECT id::text,action,summary,at,conversation_id,undo,undone_at FROM buddy_actions WHERE owner_id=$1 ORDER BY at DESC,seq DESC LIMIT 100",
    [ownerId])).rows as AuditRow[]).map(auditView);
}

const changed = (message: string) => new BuddyError(409, "NOT_UNDOABLE", message);

/** 撤销一条：本人在网页上点的，照本人的身份做。 */
export async function undoAction(deps: BuddyDeps, ownerId: string, id: string): Promise<TBuddyAuditEntry> {
  const { q } = deps;
  const row = UUID_PATTERN.test(id) ? (await q("SELECT id::text,action,summary,at,conversation_id,undo,undone_at FROM buddy_actions WHERE id=$1 AND owner_id=$2",
    [id, ownerId])).rows[0] as AuditRow | undefined : undefined;
  if (!row) throw new BuddyError(404, "NOT_FOUND", "没有这条记录");
  if (!row.undo) throw changed("这一条不能撤销");
  if (row.undone_at) throw changed("这一条已经撤销过了");
  const undo = row.undo;
  const now = deps.now();
  switch (undo.kind) {
    case "appearance": {
      const current = (await web<{ appearance: string }>(deps, ownerId, "GET", "/api/me/appearance")).appearance;
      if (current !== undo.set) throw changed("外观后来又换过了，照现在的样子撤不了");
      await web(deps, ownerId, "PUT", "/api/me/appearance", { appearance: undo.previous });
      break;
    }
    case "feishu": {
      const current = (await web<{ feishu: boolean }>(deps, ownerId, "GET", "/api/me/notification-settings")).feishu;
      if (current !== undo.set) throw changed("飞书推送后来又改过了，照现在的样子撤不了");
      await web(deps, ownerId, "PUT", "/api/me/notification-settings", { feishu: undo.previous });
      break;
    }
    case "start":
      if (!(await cancelStart(q, ownerId, undo.sub, undo.id, now))) throw changed("已经被电脑接下开始做了，撤不了；要停就让伙伴停掉");
      break;
    case "unarchive_sub":
      if (undo.sub === "topic") {
        const topic = await ownSub(q, ownerId, "topic", undo.id);
        if (topic.trashed_at || topic.status !== "archived") throw changed("这个专题已经不在归档里了");
        await web(deps, ownerId, "PATCH", `/api/me/topics/${undo.id}`, { status: "active" });
      } else if (!(await q("UPDATE tasks SET archived_at=NULL WHERE id=$1 AND owner_id=$2 AND archived_at IS NOT NULL AND trashed_at IS NULL", [undo.id, ownerId])).rowCount)
        throw changed("这张卡已经不在归档里了");
      break;
    case "restore":
      if (!(await restoreTrash(q, ownerId, undo.sub, undo.id, now))) throw changed("回收站里已经没有它了");
      break;
    case "project_archived":
      await web(deps, ownerId, "PATCH", `/api/me/projects/${encodeURIComponent(undo.projectId)}`, { archived: !undo.archived });
      break;
    case "project_name": {
      if ((await projectName(deps, ownerId, undo.projectId)) !== undo.set) throw changed("项目后来又改过名，照现在的样子撤不了");
      await web(deps, ownerId, "PATCH", `/api/me/projects/${encodeURIComponent(undo.projectId)}`, { name: undo.previous });
      break;
    }
    case "sub_link": {
      if ((await writeSubLink(q, undo.sub, undo.id, undo.previous, undo.set)) === null) throw changed("子会话后来又挂到别的 Task 或条目上了，照现在的样子撤不了");
      break;
    }
    case "sub_title": {
      const row = await ownSub(q, ownerId, undo.sub, undo.id);
      if (row.trashed_at || row.title !== undo.set) throw changed("子会话后来又改过名，照现在的样子撤不了");
      await web(deps, ownerId, "PATCH", `/api/me/sub-sessions/${undo.sub}/${encodeURIComponent(undo.id)}`, { title: undo.previous });
      break;
    }
    case "goal": {
      const now = ((await q("SELECT project_id::text FROM project_goals WHERE owner_id=$1 AND task_id=$2", [ownerId, undo.taskId])).rows[0]?.project_id ?? null) as string | null;
      if (now !== undo.projectId) throw changed("这件 Task 后来又挪过，照现在的样子撤不了");
      if (undo.previousProjectId) await web(deps, ownerId, "PUT", `/api/me/projects/${encodeURIComponent(undo.previousProjectId)}/goals/${encodeURIComponent(undo.taskId)}`);
      else await web(deps, ownerId, "DELETE", `/api/me/projects/${encodeURIComponent(undo.projectId)}/goals/${encodeURIComponent(undo.taskId)}`);
      break;
    }
    case "transfer":
      await web(deps, ownerId, "POST", `/api/me/project-transfers/${undo.transferId}/withdraw`);
      break;
    case "split":
      await web(deps, ownerId, "DELETE", `/api/me/card-splits/${undo.requestId}`);
      break;
    case "due_date":
      // 老的撤销记录带着 projectId，一样走按 Task 存的接口（同一份）。
      await web(deps, ownerId, "PUT", `/api/me/tasks/${encodeURIComponent(undo.taskId)}/due-date`, { dueDate: undo.previous });
      break;
    case "budget":
      if (!undo.taskId) await web(deps, ownerId, "PUT", "/api/me/budget-default", undo.previous);
      else if (undo.previous) await web(deps, ownerId, "PUT", `/api/me/tasks/${encodeURIComponent(undo.taskId)}/budget`, undo.previous);
      else await q("DELETE FROM task_budgets WHERE owner_id=$1 AND plan_task_id=$2", [ownerId, undo.taskId]);
      break;
  }
  const done = (await q("UPDATE buddy_actions SET undone_at=$2 WHERE id=$1 RETURNING id::text,action,summary,at,conversation_id,undo,undone_at", [id, now])).rows[0] as AuditRow;
  return auditView(done);
}

// ───────────────────────── 转达 ─────────────────────────

type MessageRow = { id: string; to_ids: string[]; text: string; status: TBuddyMessageDraft["status"]; failed_ids: string[]; created_at: Date; sent_at: Date | null };
const messageView = (row: MessageRow, names: Map<string, string>): TBuddyMessageDraft => {
  const ref = (personId: string) => ({ personId, name: names.get(personId) ?? personId });
  return { id: row.id, to: row.to_ids.map(ref), text: row.text, status: row.status, createdAt: row.created_at.toISOString(),
    sentAt: row.sent_at?.toISOString() ?? null, failed: row.failed_ids.map(ref) };
};
async function ownMessage(q: Query, ownerId: string, id: string): Promise<MessageRow> {
  const row = UUID_PATTERN.test(id) ? (await q("SELECT id::text,to_ids,text,status,failed_ids,created_at,sent_at FROM buddy_messages WHERE id=$1 AND owner_id=$2",
    [id, ownerId])).rows[0] as MessageRow | undefined : undefined;
  if (!row) throw new BuddyError(404, "NOT_FOUND", "没有这句话");
  return row;
}
export async function readMessage(q: Query, ownerId: string, id: string, names: Map<string, string>) {
  return messageView(await ownMessage(q, ownerId, id), names);
}
export async function cancelMessage(q: Query, ownerId: string, id: string, names: Map<string, string>) {
  await ownMessage(q, ownerId, id);
  const row = (await q("UPDATE buddy_messages SET status='cancelled' WHERE id=$1 AND status='draft' RETURNING id::text,to_ids,text,status,failed_ids,created_at,sent_at",
    [id])).rows[0] as MessageRow | undefined;
  if (!row) throw new BuddyError(409, "NOT_DRAFT", "这句话已经发出或不发了");
  return messageView(row, names);
}
/**
 * 发出：先把草稿改成已发（两处同时点只有一处发），再由天枢机器人逐个发；收不到的（没关联飞书、发送失败）记在 failed。
 * deliver 回 false 是这个人收不到。
 */
export async function sendMessage(q: Query, ownerId: string, id: string, names: Map<string, string>, now: Date,
  deliver: (personId: string, text: string) => Promise<boolean>): Promise<TBuddyMessageDraft> {
  const draft = await ownMessage(q, ownerId, id);
  if (draft.status !== "draft") throw new BuddyError(409, "NOT_DRAFT", "这句话已经发出或不发了");
  if ((await sentToday(q, ownerId, now)) >= BUDDY_DAILY_MESSAGES) throw new BuddyError(429, "DAILY_LIMIT", `今天已经转达了 ${BUDDY_DAILY_MESSAGES} 条，明天再发`);
  if (!(await q("UPDATE buddy_messages SET status='sent',sent_at=$2 WHERE id=$1 AND status='draft'", [id, now])).rowCount)
    throw new BuddyError(409, "NOT_DRAFT", "这句话已经发出或不发了");
  const text = `${names.get(ownerId) ?? ownerId}请我转达：${draft.text}`;
  const failed: string[] = [];
  for (const personId of draft.to_ids) if (!(await deliver(personId, text).catch(() => false))) failed.push(personId);
  await q("UPDATE buddy_messages SET failed_ids=$2 WHERE id=$1", [id, failed]);
  return messageView({ ...draft, status: "sent", sent_at: now, failed_ids: failed }, names);
}

// ───────────────────────── 回收站 ─────────────────────────

/** 进回收站满 30 天的真删（读回收站、恢复时顺手做）。 */
async function purgeTrash(q: Query, ownerId: string, now: Date) {
  const before = new Date(now.getTime() - TRASH_DAYS * DAY_MS);
  await q("DELETE FROM tasks WHERE owner_id=$1 AND trashed_at < $2", [ownerId, before]);
  await q("DELETE FROM research_topics WHERE owner_id=$1 AND trashed_at < $2", [ownerId, before]);
}
export async function listTrash(q: Query, ownerId: string, now: Date): Promise<TTrashItem[]> {
  await purgeTrash(q, ownerId, now);
  const rows = (await q(`SELECT 'card' AS kind,id::text,title,trashed_at FROM tasks WHERE owner_id=$1 AND trashed_at IS NOT NULL
    UNION ALL SELECT 'topic',id::text,title,trashed_at FROM research_topics WHERE owner_id=$1 AND trashed_at IS NOT NULL ORDER BY trashed_at DESC,id`, [ownerId])).rows as
    { kind: SubKind; id: string; title: string; trashed_at: Date }[];
  return rows.map((row) => ({ kind: row.kind, id: row.id, title: row.title, deletedAt: row.trashed_at.toISOString(),
    purgeAt: new Date(row.trashed_at.getTime() + TRASH_DAYS * DAY_MS).toISOString() }));
}
export async function restoreTrash(q: Query, ownerId: string, kind: SubKind, id: string, now: Date): Promise<boolean> {
  if (!UUID_PATTERN.test(id)) return false;
  await purgeTrash(q, ownerId, now);
  return Boolean((await q(`UPDATE ${subTable(kind)} SET trashed_at=NULL WHERE id=$1 AND owner_id=$2 AND trashed_at IS NOT NULL`, [id, ownerId])).rowCount);
}

// ───────────────────────── 请这台电脑停掉 ─────────────────────────

type StopRow = { id: string; kind: SubKind; card_id: string | null; topic_id: string | null; run_id: string; device_id: string; requested_at: Date };
const stopView = (row: StopRow): TSessionStopView => ({ id: row.id, kind: row.kind, subSessionId: (row.card_id ?? row.topic_id)!, sessionId: row.run_id,
  deviceId: row.device_id, requestedAt: row.requested_at.toISOString() });

/** 认领这台电脑上要停的（同开工的认领：两处同时认领只有一处拿到，认领 5 分钟没报结果可以重新认领）。设备不是本人的为 null。 */
export async function claimStops(q: Query, ownerId: string, deviceId: string, now: Date): Promise<TSessionStopView[] | null> {
  if (!UUID_PATTERN.test(deviceId) || !(await q("SELECT 1 FROM local_devices WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL", [ownerId, deviceId])).rowCount) return null;
  const rows = (await q(`UPDATE session_stops SET claimed_at=$3 WHERE owner_id=$1 AND device_id=$2 AND done_at IS NULL
    AND (claimed_at IS NULL OR claimed_at < $3::timestamptz - interval '${CLAIM_TTL}')
    RETURNING id::text,kind,card_id::text,topic_id::text,run_id::text,device_id::text,requested_at`, [ownerId, deviceId, now])).rows as StopRow[];
  return rows.sort((a, b) => a.requested_at.getTime() - b.requested_at.getTime() || a.id.localeCompare(b.id)).map(stopView);
}

// ───────────────────────── 请这台电脑对子会话做一件事（18 节第 10 条） ─────────────────────────

type CommandRow = { id: string; kind: SubKind; card_id: string | null; topic_id: string | null; run_id: string; device_id: string; requested_at: Date; command: TSessionCommand };
/** 认领这台电脑上要做的（同停掉的认领）。设备不是本人的为 null。 */
export async function claimCommands(q: Query, ownerId: string, deviceId: string, now: Date): Promise<TSessionCommandView[] | null> {
  if (!UUID_PATTERN.test(deviceId) || !(await q("SELECT 1 FROM local_devices WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL", [ownerId, deviceId])).rowCount) return null;
  const rows = (await q(`UPDATE session_commands SET claimed_at=$3 WHERE owner_id=$1 AND device_id=$2 AND done_at IS NULL
    AND (claimed_at IS NULL OR claimed_at < $3::timestamptz - interval '${CLAIM_TTL}')
    RETURNING id::text,kind,card_id::text,topic_id::text,run_id::text,device_id::text,requested_at,command`, [ownerId, deviceId, now])).rows as CommandRow[];
  return rows.sort((a, b) => a.requested_at.getTime() - b.requested_at.getTime() || a.id.localeCompare(b.id)).map((row) => ({ id: row.id, kind: row.kind,
    subSessionId: (row.card_id ?? row.topic_id)!, sessionId: row.run_id, deviceId: row.device_id, requestedAt: row.requested_at.toISOString(), command: row.command }));
}
/** 报做的结果：本人的、这台电脑的、还没报过的；否则 false。 */
export async function finishCommand(q: Query, ownerId: string, id: string, deviceId: string, result: "done" | "not_running" | "expired" | "failed",
  message: string | undefined, now: Date): Promise<boolean> {
  if (!UUID_PATTERN.test(id)) return false;
  const done = (await q(`UPDATE session_commands SET done_at=$4,result=$5,message=$6 WHERE id=$1 AND owner_id=$2 AND device_id=$3 AND done_at IS NULL
    RETURNING handback_id::text,relay`, [id, ownerId, deviceId, now, result, message ?? null])).rows[0] as { handback_id: string | null; relay: "return" | "supply" | null } | undefined;
  // 「再改一轮」「我来补」送到了（主循环第 62 条）：回写那次交回。
  if (done?.handback_id && result === "done")
    await q(`UPDATE card_handbacks SET ${done.relay === "return" ? "returned_at" : "supplied_at"}=COALESCE(${done.relay === "return" ? "returned_at" : "supplied_at"},$2) WHERE id=$1`,
      [done.handback_id, now]);
  return Boolean(done);
}

/** 报结果：本人的、这台电脑的、还没报过的；否则 false。 */
export async function finishStop(q: Query, ownerId: string, id: string, deviceId: string, result: "stopped" | "not_running", now: Date): Promise<boolean> {
  if (!UUID_PATTERN.test(id)) return false;
  return Boolean((await q("UPDATE session_stops SET done_at=$4,result=$5 WHERE id=$1 AND owner_id=$2 AND device_id=$3 AND done_at IS NULL",
    [id, ownerId, deviceId, now, result])).rowCount);
}
