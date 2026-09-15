/**
 * The API client. **This is the backend contract.**
 *
 * Today every method reads and writes an in-memory copy of the seed. When the
 * real backend lands, only the bodies in this file change to `fetch` — the
 * exported `api` surface, and therefore every call site, stays identical.
 *
 * Three rules this file must keep:
 *  1. Every method awaits a realistic delay. Instant interactions hide missing
 *     pending states.
 *  2. Mutations genuinely mutate the store and return the full new object, so
 *     what you see in the issue board reflects what you just did on the digest.
 *  3. Nothing leaks a live reference to the store — every return is a clone,
 *     so a component cannot accidentally become the source of truth.
 *
 * 第四条：**屏幕上的每个数字都是算出来的。** 「从提出到定下来 5 天」「布控 2 条
 * 重开条件」都从对象算出来。写死一个漂亮的数字，产品就从「公司的判断」退回成
 * 「一张幻灯片」。
 *
 * 五个环节在这一层各有落点：待定事项 = listPending / listSensorTargets，
 * 三键处置 = disposeCard，议题研究 = getResearchDoc + advisor* 那一组，
 * 会前准备 = getBrief，会后确认 = confirmClosure(route) 写回翻版判断、
 * Re-open Trigger 布控回 listSensorTargets —— 回环闭合在数据层，不靠视图记得。
 */

/*
 * 经营本体来自 seed-tokenking.ts —— 它是从本体仓库的 .trig 生成的，也就是 agent
 * 运行时读的同一份事实。房懂懂那几份演示种子（seed-beike / seed-launch /
 * seed-ontology / seed-docs）已经删掉：这一版是给词元云集自己的一号位用的，本体里
 * 就是他真正在想的九个议题。要回看旧演示包，git 历史里有。
 *
 * seed.ts 只剩行为配置（TODAY、写回模板、研究时长），它那套演示内容一起删了。
 */
import * as tk from "./seed-tokenking";
import { boardReport, resolveReportTraces } from "./report-traces";
/*
 * 04 Agents 域的真实对象：五张 Mission Card、两份带正文的文档、两条在版判断，
 * 以及它们交叉出来的那个真实议题。手写的，因为还没进本体 —— 进了就删掉这个文件
 * 让生成器接管，见该文件头部。
 */
import * as ad from "./seed-agent-domain";
/*
 * Demo 内容包。八份 Word 里的原文，一个字都没改 —— 见该文件头部。
 */
import * as dm from "./seed-demo";
import * as seed from "./seed";
// 紧挨着 DEMO 用它的那一行放 —— import 会提升，但读的人不会。
import { isDemo } from "./mode";

/**
 * 运行模式。默认 `live`，为什么见 `./mode.ts`。
 *
 * 缝只在两个地方张开：
 *   1. 这里 —— 内容从哪份种子来（Word 包 vs 本体生成）。
 *   2. `ensureDeepResearch` / `startPreResearch` —— 报告已经预置好就不叫模型。
 *      这一条其实不需要开关：预置了就短路，是它们本来的行为。
 */
const DEMO = isDemo();

/**
 * 所有 Mission Card = 本体生成的 + 04 域手写的。
 *
 * 抽成一个常量而不是在五个调用点各拼一次：上一版 `allMissions` 有五处直接读，
 * 漏掉任何一处，屏幕上就会出现「这个域有 5 张卡」和「这个域有 3 张卡」两种说法，
 * 而两处都不报错。
 */
const allMissions = [...tk.missionCards, ...ad.missionCards];

/**
 * 所有业务域 = 本体里词元云集自己的八个域 + demo 那一层的三块生意。
 *
 * **屏幕上是前者**（`listDomains` 只返回 `tk.domains`）：这一版的读者是词元云集的
 * CEO 刘明华，他的业务域就是本体里那八个（D-01…D-08）。BIZ-AIDC / BIZ-TK / BIZ-FDD
 * 是王总那一层的三块集团生意 —— 他是那些公司的掌控者，不是这块屏幕的读者。
 *
 * 后者仍然留在这里：demo 内容包（`seed-demo`）里的卡片还挂着 BIZ-* 的 id，
 * `findDomain` 得两边都解得开，不然演示那一场会整页红「找不到业务域」。
 */
const allDomains = [...tk.domains, ...ad.bizDomains];
import type {
  ActionItem,
  AdvisorMessage,
  AdvisorPreset,
  AgentRunRecord,
  Brief,
  Card,
  CardAgentVerdict,
  CardDisposition,
  Closure,
  ClosureDraft,
  ClosureItem,
  ClosureItemField,
  ClosureItemKind,
  ClosureReceipt,
  CodeRef,
  Commitment,
  CompanyOutcome,
  CrawledSignalInput,
  CommandBriefApproval,
  CommandBriefEdits,
  DecisionEntry,
  DecisionOrder,
  BoardJudgement,
  ConfirmChannel,
  DecisionQuestion,
  Divergence,
  InitialJudgment,
  JudgementBoard,
  DecisionRoute,
  Doc,
  Domain,
  DriOption,
  DeploymentDetail,
  DomainSummary,
  DraftReport,
  DriReportedSignal,
  HandoffStatus,
  InboxDisposition,
  InboxSignal,
  InboxSignalMeta,
  Issue,
  IssueCounsel,
  IssueFraming,
  IssueKnowledge,
  IssueLogEntry,
  IssueReport,
  IssueResearchStatus,
  IssueState,
  IssueSummary,
  Judgment,
  JudgmentChange,
  JudgmentDetail,
  Meeting,
  IssueMeeting,
  MeetingClosure,
  MeetingDebrief,
  MeetingPrep,
  MeetingPrepItem,
  MeetingSlot,
  SlotIntakeState,
  IssueSlot,
  DayHalf,
  MonitorFocus,
  MonitorStrategy,
  OutcomeEntry,
  OutcomeScreen,
  OutcomeWeek,
  Period,
  Person,
  PreResearchDoc,
  ProbeEdge,
  ProbeMap,
  ProbeNode,
  ProbeRoute,
  QuickDecision,
  ReportedSignalInput,
  ResearchDoc,
  ScanRound,
  ScanState,
  SensorTarget,
  SignalDetail,
  SignalLogEntry,
  Statement,
  TimelineEvent,
  TimelineEventKind,
  Trace,
  UnfinishedResearchRound,
  WithheldItem,
  WriteBackResult,
  WriteBackTarget,
} from "./types";
/*
 * 运行时那几个（不是类型）。`types.ts` 里那一小撮纯函数是**两侧共用**的判据 ——
 * 「这一份能不能下达」这一句话必须只有一个出处：服务端拿它拒，屏幕拿同一句话把按钮置灰
 * 并写出原因。各判一次的话，屏幕上说得通的那一下会在服务端被拒，而他看不出为什么。
 */
import { dispatchBlockReason, dueLabel, readReportDelivery, splitDue } from "./types";

import {
  ApiError,
  PROBE_ROUTE_LABEL,
  ROUTE_LABEL,
  evidenceActionLabel,
  evidenceActionsFor,
} from "./shared";
import {
  bySlotTime,
  debriefKeyOf,
  rankOf,
  readClock,
  slotIdOf,
  slotIndexOf,
  slotLabel,
  slotPast,
  slotTimeError,
} from "./agenda";
import { seededCases } from "./seed-cases";
import { resolveTodoAssignee } from "./todo-assignee";
import { fingerprintOf, loadSnapshot, scheduleSave } from "./persist";
import { readPin, writePin } from "@/lib/dev-pin";
import { bumpRevision } from "./revision";
import { inboxEvictees } from "./inbox";
import * as rec from "@/lib/recording/registry";
import {
  deleteTranscript,
  readTranscript,
  renameSpeaker,
} from "@/lib/recording/transcript";
import type {
  Recording,
  RecordingDetail,
  RecordingSummary,
} from "@/lib/recording/types";
import {
  MATERIAL_FOR_PRE_RESEARCH,
  readOwnIssueInput,
} from "./own-issue-input";
import { currentActor } from "./actor";
import {
  submitDraft,
  adjudicate,
  makeEffective,
  convergenceRounds,
  disagreementNote,
} from "./commitment";
import { formatDuration, formatStamp } from "@/lib/format";
import { normalizeUrl } from "@/lib/scan/normalize-url";
import { scanCadence, type ScanCadence } from "@/lib/scan/cadence";
import { createHash } from "node:crypto";
import type { Actor } from "./actor";
import { readIssueFraming } from "@/lib/agent/a1a/framing";
import { mockDeployment } from "./mock-deployment";
import { declareDelta } from "@/lib/agent/a1a/delta";
import { bigramOverlap } from "@/lib/agent/overlap";
import { runFrame } from "@/lib/agent/a2/run";
import { extractTurn, type BoardRef } from "@/lib/agent/a6/extract";
import { extractDebrief, resolveLabel, resolvePrincipal } from "@/lib/agent/a7/debrief";
import { judgeIntake } from "@/lib/agent/a7/intake";
import { runPreResearch } from "@/lib/agent/a3/run";
import type {
  PreResearchStages,
  TargetRef,
  TriggerProposal,
} from "@/lib/agent/a3/stages";
import { buildLiteIndex } from "@/lib/agent/a3/evidence-lite";
import { expireTriggers } from "@/lib/agent/a3/trigger";
import { runDeepResearch } from "@/lib/agent/a4/run";
import { runJudgements } from "@/lib/agent/a5/run";
import { AgentRunFailed, Harness, newRunId } from "@/lib/agent/harness";
import { runWriteBack } from "@/lib/agent/a10/run";
import {
  TASK_TABLE_ID,
  clearTask,
  onTaskReports,
  runTask,
  taskState,
  taskStep,
  type TaskState,
} from "@/lib/agent/tasks";
import {
  BASIS_LABEL,
  buildLedgerIndex,
  buildReportBody,
  indexEntries,
  REOPEN_LABEL,
  renderDecisionMemories,
} from "@/lib/agent/talk/prefix";
import {
  pickDecisionMemories,
  packUserCard,
  hitOverturn,
} from "@/lib/agent/talk/memory";
import { runMicroResearch } from "@/lib/agent/talk/micro";
import { answerFromCheck, notFoundReply } from "@/lib/agent/talk/check";
import { checkEscalation, tellHim } from "@/lib/agent/talk/tools";
import { landMicroEvidence, planLanding } from "@/lib/agent/talk/land";
import { settleTalkTurn } from "@/lib/agent/talk/settle";
import { providers, describe as describeSearch } from "@/lib/research/search";
/*
 * 这一处是循环引用的一条边：扫描那一侧要把收下来的信号写进库（`inboxSignalsPut`
 * 与 `persistSoon`）。两边都只在函数体里用对方，模块求值期谁都不碰对方的导出，
 * 所以这条边是安全的 —— 也正是那两个函数写成 `function` 声明的原因。
 */
import { scanState, startScan } from "@/lib/scan/run";
import { scanStrategy } from "@/lib/scan/strategy";

/*
 * 这个模块持有整个对象库，只能在服务端跑。误 import 进客户端组件会把全部种子
 * 数据打进浏览器 bundle，而且 API key 之类的东西迟早会跟着漏出去。
 * 这里手写守卫而不是装 server-only 包 —— 少一个依赖，报错信息还能说人话。
 */
if (typeof window !== "undefined") {
  throw new Error(
    "lib/data/store.ts 是 server-only —— 客户端请用 lib/data/client.ts（它走 /api/data）。",
  );
}

/** Failures surface to the user as Chinese prose plus a retry. */

const clone = <T>(value: T): T => structuredClone(value);

const omit = <T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> => {
  const rest: Omit<T, K> & Partial<Pick<T, K>> = { ...value };
  delete rest[key];
  return rest;
};

/*
 * 原来每个方法都 await 一个假延迟，理由是「瞬时交互会掩盖缺失的 pending 态」。
 * 搬到服务端之后真实 HTTP 自带往返，再叠一层假延迟就是白白浪费真实时间。
 * 默认关闭；演示想要那种从容感时设 TKOS_FAKE_LATENCY=1。
 */
const FAKE_LATENCY = process.env.TKOS_FAKE_LATENCY === "1";

const sleep = (min = 200, max = 600) =>
  FAKE_LATENCY
    ? new Promise<void>((resolve) =>
        setTimeout(resolve, min + Math.random() * (max - min)),
      )
    : Promise.resolve();

// ---------------------------------------------------------------------------
// In-memory store. Cloned from the seed at module load so the seed files stay a
// pristine description of the starting state and a page reload resets cleanly.
// ---------------------------------------------------------------------------

/**
 * 预载的那一套案例。**起来的时候算一次，不是每次读都算。**
 *
 * 它是**示例数据**，不是真实运行产生的东西 —— 每一条的措辞、出处和「还没查」都照
 * `seed-cases.ts` 里那套规矩写。放进初始状态而不是塞在某个读口里，是因为它必须能被
 * 后面的快照**整个盖掉**：一台真的跑过一阵的机器，库里是他自己的东西，不该在重启之后
 * 混进一批示例。`Object.assign(store, restored)` 那一句就是这条规则的落点。
 */
const CASES = seededCases(seed.TODAY);

/**
 * 运行态的**形状**，以及这台机器上第一次起来时它是什么样子。
 *
 * 它不一定就是下面几千行读写的那个对象：开发期热重载之后，那个对象是上一程钉住的
 * 那一份（见下面 `store` 那一段）。这一份从此只有两个用处 —— 取种子指纹、留一份纯净
 * 种子态。所以**这一段之后不要再直接写它**。
 */
const seedShape = {
  /*
   * 议题、判断、文档来自本体。其余集合是**运行态** —— 对话、判断链路图上的
   * Point、研究报告、闭环单，都由 agent 在运行时产生，不该预置。
   *
   * 所以刚起来时点进一个议题是空的，直到 A3 预研跑完。这是对的：一号位看到的
   * 第一份报告应该是系统真的替他研究出来的，不是有人提前写好的剧本。
   */
  /*
   * **上线第一天这三个集合是空的：一件议题、一张卡、一批都没有。**
   *
   * 一切的起点是潜在议题那一屏，而那一屏第一天也是空的 —— 进来的每一件事都得有一条
   * 真实的来路：雷达按公司布下的靶点抓回来的、DRI 押上名字递上来的、或者他自己提的
   * （那一屏上的「+ 我自己有一件事」）。预置几条「已经摊在提请台上」的卡，等于替这
   * 三条来路各编了一次来历，而屏幕上分不出哪一条是编的。
   *
   * 本体那九条战略议题仍然生成在 `seed-tokenking.ts` 里、DRI 那一条仍然在
   * `seed-agent-domain.ts` 里（生成器照本体如实生成，那是它的职责），只是这里不装
   * 进来。等雷达接上、或者 A1a 的立案写回接通（`agent/a1a/apply.ts` 现在只接了
   * 「判为噪音」那一条），它们该由那条路一件件进来，各自带着自己的来路。
   *
   * demo 那一档照旧全给：王总那一场要的就是一屏摊满的内容。
   */
  /*
   * 上线第一天这三个集合原来是空的，理由是「进来的每一件事都得有一条真实的来路」。
   * 那条理由今天仍然成立，而 `CASES` 不违反它：那一套案例每一条都写明了自己是**示例**、
   * 照的是哪两份真实材料、以及哪几个数还没查（见 `seed-cases.ts` 文件头）。空着一屏
   * 换来的不是诚实，是没法验收 —— 而它想防的那件事（屏幕上分不出编的和真的）由那套
   * 案例自己的写法防住了。
   */
  issues: (DEMO ? clone(dm.issues) : clone(CASES.issues)) as Issue[],
  cards: (DEMO ? clone(dm.cards) : clone(CASES.cards)) as Card[],
  digests: (DEMO
    ? clone(dm.digests)
    : [{ date: seed.TODAY, cardIds: [...CASES.todayCardIds] }]) as {
    date: string;
    cardIds: string[];
  }[],
  withheld: [] as { date: string; items: WithheldItem[] }[],
  timelines: (DEMO ? {} : clone(CASES.timelines)) as Record<
    string,
    TimelineEvent[]
  >,
  researchDocs: (DEMO ? {} : clone(CASES.researchDocs)) as Record<
    string,
    ResearchDoc
  >,
  /**
   * 还没落库的那几轮深研：在跑的那一轮边跑边存，没跑成的那一轮连着收场原话留着
   * （见 `UnfinishedResearchRound`）。
   *
   * 和 `researchDocs` 是两张表，不是同一张里的一档：那张表里有一份就等于「这件议题的深研
   * 已经就绪」—— 议题状态、首页那一栏、判断板起不起、要不要再开一轮，四处都按它判。半份
   * 塞进去，屏幕上会说这件议题的深研做完了。
   */
  unfinishedResearch: {} as Record<string, UnfinishedResearchRound>,
  preResearch: {} as Record<string, PreResearchDoc>,
  /**
   * 统一触发器表。**运行时产物，不进 `SEED_FINGERPRINT`** ——
   * 它不是种子的一部分，指纹里多一个键会让每次预研都判成「种子变了」。
   *
   * 旧快照里没有这个键，而 `Object.assign(store, restored)` 只覆盖存在的键，
   * 所以加它对已有快照是安全的。
   */
  triggers: [] as TriggerProposal[],
  /**
   * 上一轮预研的各段产物，按议题号存。**这一格要跟触发器表一起加**，因为
   * `ensurePreResearch` 那个 `prevStages` 入参读的就是它。
   *
   * 为什么不读 `preResearch[issueId]?.stages`：`ensurePreResearch` 第一句就是
   * `if (store.preResearch[issueId]) return { status: "done" }` —— 走到下面那行
   * `runPreResearch(...)` 时，`store.preResearch[issueId]` 必然不在，所以按它取
   * 恒为 `undefined`，那个入参永远喂不进去。
   *
   * 谁往这一格里写：Task 15 的 `attachSignalToCard` —— 同一件事又来一条信号时，
   * 它把上一份 `stages` 搬到这里、再 `delete store.preResearch[issueId]`，
   * 于是下一轮跑得起来，而且手上有上一轮可比。
   *
   * **但生产上今天没有一处调那个函数，所以这一格实际一直是空的，增量卡在生产上
   * 出不来。** 入库那一处只做「可能是同一件事」的标注，真的合卡要他按一下，
   * 而那个入口还没有。这里照旧读它、不写死成 `undefined`，是因为那个入口做出来时
   * 改的应该只有一处调用，不是这一路的取值。
   *
   * 同样是运行时产物，不进 `SEED_FINGERPRINT`。
   */
  preResearchPrev: {} as Record<string, PreResearchStages>,
  /**
   * 运行时立起来的议题自带的「范围与背景」——深研（A4）那一栏的原文。
   *
   * 种子里的议题各有一份（`tk.issueScopes` / `dm.issueScopes`），运行时进来的没有：
   * 而他粘一段话进来立成议题时，那一段就是这件事的范围本身。只留标题的话，标题是
   * 小模型起的一行十几个字，深研就只能照着那一行去查 —— 他粘进来的其余部分全丢了。
   *
   * **不进 `SEED_FINGERPRINT`**（同 `inboxSignals` 上那段）。
   */
  issueScopes: {} as Record<string, string>,
  /*
   * 判断板。每个议题一串，上下两层由 `confirmed` 在不在决定。
   *
   * 和 `probeNodes` 分开存：probe 那套是「报告里划下来的句子 + 它们在图上的位置」，
   * 服务的是报告溯源；判断板是「这个议题现在有哪些判断、哪些经过他了」，服务的是
   * 公司口径。两件事共用一张表的话，一条「他划下来但还没解读」的句子会混进
   * 「待确认的判断」里 —— 而那两样东西的份量差得远。
   */
  board: {} as Record<string, BoardJudgement[]>,
  advisorPresets: {} as Record<string, AdvisorPreset>,
  decisionQuestions: {} as Record<string, DecisionQuestion>,
  briefs: {} as Record<string, Brief>,
  closureDrafts: {} as Record<string, ClosureDraft>,
  probeNodes: {} as Record<string, ProbeNode[]>,
  probeEdges: {} as Record<string, ProbeEdge[]>,

  /*
   * agent 运行记录。每次 A1a/A3/A4 跑完落一条，供评分与复现。
   *
   * 有上限：`persistSoon()` 是把整个 store 序列化重写一遍，Run 记录里带
   * trace 和整段输出，不封顶的话每存一次盘都会重写一份越来越大的 JSON。
   */
  agentRuns: [] as AgentRunRecord[],
  /*
   * 待挑的信号：抓取作业（tkos-lab 的 `scripts/catch.py`）投进来的过线信号。
   *
   * 初值必须是空的，**不进种子** —— 塞了示例信号就得进 `SEED_FINGERPRINT`，
   * 而进了指纹就等于「谁改一条示例文案，下一次重启会把线上真实数据抹掉」
   * （见 persist.ts 里 `seedFrozen` 上那段）。
   *
   * 有上限，理由同 `agentRuns`：落盘是把整个 store 序列化重写一遍。
   */
  inboxSignals: [] as InboxSignal[],
  /**
   * 每一轮扫描本身的账（`ScanRound`）。**和上面那份信号分开存。**
   *
   * 合不了：一轮什么都没过线的扫描在 `inboxSignals` 里没有任何痕迹，而那一轮恰恰
   * 是最需要留下时间的（理由写在 `ScanRound` 上）。收件柜封顶挤掉老信号时这份账
   * 也不跟着走。
   *
   * 初值必须是空的、**不进 `SEED_FINGERPRINT`**（同 `inboxSignals` 上那段）。
   */
  scanRounds: [] as ScanRound[],
  /**
   * 一号位给下一轮扫描的交代（`MonitorFocus`）。**只有一条**，不是一份历史。
   *
   * 攒成一列的话，「现在到底按哪句话扫」就得有一套优先级 —— 而他心里只有一句：
   * 最后说的那句。说了新的就盖掉旧的，清掉就是回到全域扫。
   *
   * 初值 null，**不进 `SEED_FINGERPRINT`**（同 `inboxSignals` 上那段）。
   */
  monitorFocus: null as MonitorFocus | null,
  /**
   * 本期承诺。跟着整库快照走，不单独落盘。
   *
   * **初值必须是空的，不进种子**（同 `inboxSignals` 上那段）：塞了示例承诺就得进
   * `SEED_FINGERPRINT`，而进了指纹就等于「谁改一条示例文案，下一次重启会把一个月
   * 的真实回传抹掉」。
   */
  commitments: [] as Commitment[],
  /**
   * 周期与公司 Outcome 从种子拷进 store —— 因为**它们现在会被写**：真实的 9 月
   * 周期由纲领灌进来（`/api/om/intake`），而种子里只有 8 月那一期。
   *
   * 旧快照里没有这两个键，`Object.assign(store, restored)` 只覆盖存在的键，
   * 所以恢复旧快照时它们保持种子值 —— 那正是对的。
   *
   * **不进 `SEED_FINGERPRINT`**：进了的话，灌一次纲领就等于换了一套数据集。
   */
  periods: clone(tk.periods) as Period[],
  companyOutcomes: clone(tk.companyOutcomes) as CompanyOutcome[],
  /*
   * GraphKnowledge 上下文快照。键是内容哈希（`ctx-<sha256 前 16 位>`）。
   *
   * 放进 store 而不是模块级 Map：Next.js 里不同路由可能拿到不同的模块实例，
   * 而 store 已经是解决这件事的那个单例。类型故意留成 unknown ——
   * `ContextBundle` 的定义在 graphknowledge 层，数据层不该认识它。
   */
  contextSnapshots: {} as Record<string, unknown>,
  driReports: {} as Record<string, ResearchDoc>,
  quickDecisions: [] as QuickDecision[],
  /**
   * 下达出去的命令。批准一份决断包时由 `proposedOrders` 逐条落成（`approveCommandBrief`）。
   *
   * 数组而不是 `Record<issueId, ...>`：命令板要读的是**跨议题的一张表**（谁欠着什么、
   * 哪几条到期了），按议题分桶的话每次都得先摊平；而按议题查只是一次 `filter`。
   * 跟着整库快照走，不单独落盘。
   *
   * **不进 `SEED_FINGERPRINT`**：这张表里一条种子数据都没有，全是运行态（同 `commitments`
   * 上那一段的理由）。
   */
  decisionOrders: [] as DecisionOrder[],
  meetings: [] as Meeting[],
  closures: {} as Record<string, MeetingClosure>,
  /*
   * 他自己排出来的那些会。和上面 `meetings` 不是一张表（理由写在 `MeetingSlot` 上）。
   *
   * 这三张新表都不进 `SEED_FINGERPRINT`：它们里面一条种子数据都没有，全部由他在排会
   * 面板上按出来。进指纹的是「数据集身份」，而这三张表属于运行态。
   */
  meetingSlots: (DEMO ? [] : clone(CASES.meetingSlots)) as MeetingSlot[],
  /**
   * 录音与逐字稿的**元数据**。正文（一场会一两千条句子）不在这里，落
   * `.data/recordings/<id>.json`，见 `lib/recording/transcript.ts` 的文件头。
   *
   * 不进 `SEED_FINGERPRINT`：这张表里一条种子数据都没有，全是运行态。
   */
  recordings: [] as Recording[],
  /** 会后提炼。键是 `${slotId}::${issueId}` —— 一场会一件议题一份。 */
  debriefs: (DEMO ? {} : clone(CASES.debriefs)) as Record<
    string,
    MeetingDebrief
  >,
  /**
   * 排会面板上他拖出来的顺序，一串议题号。
   *
   * 存顺序而不是给每件议题存一个序号：拖一次动的是整份清单的相对次序，写回一串是一次
   * 写，写回 N 个序号是 N 次写，而中间任何一次没落盘，屏幕上的顺序就和库里的对不上。
   * 已经不在清单上的议题号留在里面无所谓（下面算 rank 时按 indexOf 取，找不到就是没拖过）。
   */
  agendaOrder: [] as string[],
  advisorThreads: {} as Record<string, AdvisorMessage[]>,
  talkPoints: {} as Record<string, import("@/lib/agent/talk/point").TalkPoint>,
  deliberationLog: {} as Record<
    string,
    import("@/lib/agent/talk/point").DeliberationEntry[]
  >,
  /** 决策记忆。跨议题，`pickDecisionMemories` 按标签重合从这一份里挑。 */
  decisionMemories: [] as import("@/lib/agent/talk/memory").DecisionMemory[],
  /** 一号位本人的用户模型卡。全局一份 —— 这个产品只有一个一号位。 */
  userCard: null as import("@/lib/agent/talk/memory").UserCard | null,
  framed: {} as Record<string, DecisionQuestion>,
  judgments: [...clone(tk.judgments), ...clone(ad.judgments)] as Judgment[],
  changes: clone(tk.judgmentChanges) as JudgmentChange[],
  /*
   * 资料库。**它只喂屏幕，不喂 agent。**
   *
   * 这里的几十份是搭产品时铺进来的样例。它们曾经整批进 prompt（`pickDocs`：按有没有
   * 正文排序取前几份，跟议题相不相干一概不问），后果写在 `a4/prompt.ts` 的 `A4Input`
   * 上 —— 那一栏现在没有了，公司内部材料只从本体来。所以这一份现在只有两个读者：
   * 文档库那一页，和议题详情里「关联文档」那一格。
   *
   * demo 包那五份仍然跟着档走：live 内容里没有一处引用 `/docs/DOC-D*`（grep 过），
   * 摘掉不会留断链。
   */
  docs: [
    ...clone(tk.docs),
    ...clone(ad.docs),
    ...(DEMO ? clone(dm.docs) : []),
  ] as Doc[],
  ratings: [] as {
    targetId: string;
    quality: number;
    experience: number;
    note?: string;
  }[],
};

/*
 * 种子指纹。**只哈希数据集的身份，不哈希整个 store。**
 *
 * 原来是 fingerprintOf(store)，而 store 里的 digests 是按 TODAY 建的 ——
 * TODAY 改成动态之后，指纹每天零点都会变一次，快照被判定为「种子已变」然后丢弃。
 * 结果就是一号位周一用完，周二回来发现对话、报告、写回草案全没了，
 * 而日志里只有一句「种子已变」——查起来极难，因为种子确实没人动过。
 *
 * 该失效的情况是数据集本身换了：议题变了、判断的陈述改了、人和域动了。
 * 那几样进指纹，日期和正文不进。
 *
 * **取自 `seedShape` 而不是 `store`**，而且摆在钉住那一段之前：往下走 `store` 里会有
 * 运行时立起来的议题和卡，拿它们算指纹等于「一号位每提一件事，快照就作废一次」——
 * 下一次重启，他自己录进去的东西全部被种子换掉。
 */
const SEED_FINGERPRINT = fingerprintOf({
  // 模式本身进指纹：demo ↔ live 切一次，快照必须作废，否则会拿着另一套内容的
  // 对话和报告去覆盖这一套的对象。
  mode: DEMO ? "demo" : "live",
  issues: seedShape.issues.map((i) => `${i.id}:${i.title}`),
  judgments: [...tk.judgments, ...ad.judgments].map(
    (j) => `${j.id}:${j.statement}`,
  ),
  cards: seedShape.cards.map((c) => c.id),
  docs: seedShape.docs.map((d) => d.id),
  people: tk.people.map((p) => p.id),
  domains: allDomains.map((d) => d.id),
  /*
   * 内容包里**预置了哪几支对谈、哪几份会前报告**也算数据集身份。
   *
   * 少了这两行，往包里新加一段对谈之后，旧快照的指纹照样对得上 —— 于是快照被恢复、
   * 新加的那段被盖掉，屏幕上什么也没有。而排查时看不出任何异常：种子文件里明明写着，
   * 页面上就是不出现。加进来之后，加一支对谈就等于换了一套数据集，快照自动作废。
   */
  demoThreads: DEMO ? Object.keys(dm.threads).sort() : [],
  demoBriefs: DEMO ? Object.keys(dm.briefs).sort() : [],
  /*
   * 预载的那套案例也算数据集身份。少了这一行，往里加一件案例之后旧快照的指纹照样对得上 ——
   * 于是快照被恢复、新案例一个字都不出现，而排查时看不出任何异常：文件里明明写着，
   * 屏幕上就是没有。同 `demoThreads` 那两行的理由。
   */
  cases: DEMO ? [] : CASES.issues.map((i) => `${i.id}:${i.title}`),
});

/**
 * 这份库**钉在进程上**，不跟着模块重新求值一起换新（见 `lib/dev-pin.ts`）。
 *
 * `next dev` 改一个服务端文件就重编译，而重编译**不保证**整张模块图一起换新 —— 这个
 * 文件被换掉、任务表（`agent/tasks.ts`）留着，是真实发生过的一种组合。那时会发生这样
 * 一串事：
 *
 *   1. 上一份模块里那一轮深研**照旧在跑**（换掉的是模块，不是那个 `await`）；
 *   2. 它跑完，把报告写进**上一份**这个对象 —— 新的这一份看不见它；
 *   3. 任务表是留着的那一份，于是它翻成 `done`，而这一份库里没有报告；
 *   4. `ensureDeepResearch` 只拦 `failed`，`done` 一路走到 `runTask`，那条已经不是
 *      `running` 了 —— **又起一轮真花钱的深研**。
 *
 * 2026-09-01 的 ISS-222 就是这么跑了两轮：第一轮 18 分钟走到最后一步，报告落在被换掉
 * 的那份对象上，第二轮在那一刻当场从第一步重新开始。一号位看到的是「深研到最后一步
 * 又重新跑了」，而那份写完的报告一个字都没留下。
 *
 * 钉住之后那一轮写进的就是这一份：报告不丢，也没有第二轮。**按种子指纹认账** ——
 * 谁改了 `seed-cases.ts` 这类文件就当成另一套数据集，重新起一份，否则开发期改种子会
 * 看不到变化。生产上没有热重载，这一段是空转。
 *
 * 认出「这一程是不是头一程」的写法是**比对象身份**（`store === seedShape`）：钉住的
 * 那一份永远不可能是这一程刚造出来的那个对象，所以这一句不会说错。
 */
type StorePin = {
  fingerprint: string;
  state: typeof seedShape;
  /** 纯净种子态也要钉住：下面那两段（demo 铺底、判断反向填）只在头一程跑。 */
  seedState: typeof seedShape;
};
const storePin =
  readPin<StorePin>("store")?.fingerprint === SEED_FINGERPRINT
    ? readPin<StorePin>("store")
    : null;

/**
 * 运行态的对象库。**下面几千行读写的就是它。**
 *
 * 就地 `Object.assign` 而不是重新赋值 —— store 是 const，而且下面两千多行全都闭包
 * 引用着这一个对象，换引用会让它们全部指向旧的那份。
 */
const store: typeof seedShape = storePin?.state ?? seedShape;

/** 这一程是不是头一程：要铺 demo、要反向填判断、要读快照、要收场上一程留下的那几轮。 */
const FIRST_PROGRAM = store === seedShape;

/*
 * Demo 模式：把 Word 包里已经打磨好的产物直接摆进运行态。
 *
 * 预研、深研报告、判断板、对谈、快捷条 —— 这五样在 MVP 里是 agent 跑出来的，
 * 在 demo 里是包里的原文。**摆进来这件事本身就是「不叫模型」**：
 * `ensureDeepResearch` 和 `startPreResearch` 头一行都是「已经有了就直接返回」，
 * 所以这里放好之后，那两条路径连一次调用都不会发出去。
 *
 * 不放进 `store` 的初始化列表而是在这里补：那份列表描述的是**运行态的形状**
 * （每个集合是什么、初始为空），把内容混进去之后，「哪些东西是预置的」这个问题
 * 就得读完两百行才答得出来。
 */
if (DEMO && FIRST_PROGRAM) {
  Object.assign(store.preResearch, clone(dm.preResearch));
  Object.assign(store.researchDocs, clone(dm.researchDocs));
  Object.assign(store.board, clone(dm.boards));
  Object.assign(store.advisorThreads, clone(dm.threads));
  Object.assign(store.advisorPresets, clone(dm.presets));
  Object.assign(store.briefs, clone(dm.briefs));
  Object.assign(store.closures, clone(dm.closures));
  store.meetings.push(...clone(dm.meetings));
}

/**
 * 将议题链接到它动摇的判断们：把 issue.id 推进 j.shakenBy，且提级 standing。
 *
 * 这必须是一个函数而不是原地再写一遍：原来只有种子那一处，所以那段逻辑写在
 * 循环体里；现在运行期也要用（issueFromSignal），两份实现迟早会分叉（一边
 * 提级一边不提级，屏幕上就是「有议题在晃它、但它还是未验证」）。
 *
 * 不在这个函数里 persistSoon() —— 调用方各自决定：种子那一处在求值期，那时候
 * persist 还没准备好；issueFromSignal 结尾本来就有一次。
 */
function linkIssueToJudgments(issue: Issue) {
  for (const jid of issue.judgmentRefs) {
    const j = store.judgments.find((x) => x.id === jid);
    // 解析不到的 id 在这个仓库里一律当没有（见 Task 19 立的规矩）。
    if (!j) continue;
    // shakenBy 里还没有 issue.id 就 push。
    if (!j.shakenBy.includes(issue.id)) j.shakenBy.push(issue.id);
    // 被议题晃着的判断，standing 从 unverified 变成 shaking —— 这是产品的核心
    // 回路：议题存在的意义就是动摇某条判断。
    if (j.standing === "unverified") j.standing = "shaking";
  }
}

/*
 * 议题动摇了哪条判断，反向填回 judgment.shakenBy —— 屏幕上「这条判断正在被什么
 * 晃」靠它。关联本身来自 seed-tokenking 的 judgmentRefs（模型提案、待人确认）。
 */
if (FIRST_PROGRAM) {
  for (const issue of store.issues) {
    linkIssueToJudgments(issue);
  }
}

/**
 * 当前周期 = 包含今天的那一期；都不包含就取最后一期。
 *
 * 原来 `getOutcomes` 与 `buildCompanyContext` 直接取 `tk.periods[0]`，那在只有
 * 一期的时候是对的。9 月周期灌进来之后必须现算 —— 否则 9 月 1 日一号位打开
 * 目标与任务，看到的还是 8 月。
 */
const activePeriod = (): Period => {
  const today = seed.TODAY;
  const inRange = store.periods.find(
    (p) => p.startsOn <= today && today <= p.endsOn,
  );
  return inRange ?? store.periods[store.periods.length - 1];
};

// ---------------------------------------------------------------------------
// 落盘与恢复
//
// 种子构造完之后立刻取指纹，再尝试用快照覆盖。就地 Object.assign 而不是重新
// 赋值 —— store 是 const，而且下面两千多行全都闭包引用着这一个对象，换引用会
// 让它们全部指向旧的那份。
// ---------------------------------------------------------------------------

/**
 * member id → 短码的反向表，留给短码溯源。**当前没有调用方** —— 原来用它把
 * [member:xxx] 换成可点短码的压缩器随 `src/lib/ontology/` 一起删了。
 */
export const ONTOLOGY_CODE_OF: Record<string, string> = Object.fromEntries(
  Object.entries(tk.ontologyRefs).map(([code, member]) => [member, code]),
);

/**
 * 覆盖之前留一份纯净种子态。演示前重置要用，代价是多存一份（几百 KB）。
 *
 * 它也跟着钉住：这一程不是头一程的话，上面那两段（demo 铺底、判断反向填）没跑，
 * 现算一份会少掉那两样 —— 而「重置」重置成一份缺了内容包的种子，是一次没有报错的
 * 数据事故。
 */
const SEED_STATE = storePin?.seedState ?? clone(store);

if (FIRST_PROGRAM) {
  const restored = loadSnapshot(SEED_FINGERPRINT);
  if (restored) Object.assign(store, restored);
  /*
   * 恢复出来的那几轮深研里，**没有收场原话的那几条是被上一个进程带走的**
   * （见 `UnfinishedResearchRound.error`）：那一轮当时正在跑，而任务表只活在进程里，
   * 所以进程一没，那一轮就再没有人在跑了。
   *
   * 这一句在这里补上，是因为屏幕上和这里以外的任何地方都答不出那件事：任务表里是空的，
   * 而「空」在 `ensureDeepResearch` 眼里等于「没人跑过，起一轮吧」—— 2026-08-26 的
   * ISS-110 就是这么被自动重开的（改一个服务端文件 → 热重载 → 下一次轮询起了一轮真花钱
   * 的深研，上一轮那份 1.6 万字符的报告一起没了）。补上这句话之后那一轮算「没跑成」：
   * 已经写完的原件照旧能读，而要不要再花一轮由他自己按（`startDeepResearch`）。
   */
  for (const round of Object.values(store.unfinishedResearch)) {
    if (round.error) continue;
    round.at = new Date().toISOString();
    round.error =
      "上一轮深研没跑完 —— 服务重启（或改代码触发的热重载）把它掐断了，" +
      "所以它没跑到落库那一步。运营台上那条记录标着「被中断」。";
  }
  /*
   * 台账上那一头。上面改的是屏幕上那句话，这一句改的是运营台里那条运行记录 ——
   * 还停在「在跑」的那几条，跑它们的进程已经没了（`markInterruptedRuns`）。
   *
   * 两处分开是因为它们答的不是同一个问题：`unfinishedResearch` 只有深研有、而且一件议题
   * 只留最后一轮；台账是所有链路的，一轮不落。
   */
  markInterruptedRuns();

  /*
   * 铺完这一程才钉。钉早了的话，中间任何一句抛出去（快照读坏、种子对不上）都会把一份
   * 只铺了一半的库钉在进程上，而之后每一次重编译都从那一半接着跑 —— 只有重启进程才
   * 出得来，而屏幕上没有任何一处说得出为什么。
   */
  writePin("store", {
    fingerprint: SEED_FINGERPRINT,
    state: store,
    seedState: SEED_STATE,
  });
}

/**
 * 写完了：排进落盘队列，并且**说一声库改过了**。
 *
 * 这两件事绑在一起是有意的。「哪里算是真的写了东西」这个问题在这份文件里已经有一个
 * 答案 —— 就是叫过这个函数的那四十来处。再列第二份「要通知的写操作」清单，两份早晚
 * 会对不上，而对不上的表现是屏幕上某处一直显示旧值（`lib/data/revision.ts` 开头
 * 讲了那条路为什么必须存在）。
 *
 * 所以：**新加的写操作只要照旧叫 `persistSoon()`，推送就自动带上了。**
 */
export function persistSoon(): void {
  bumpRevision();
  persistOnly();
}

/**
 * 只排落盘，不报「库改过了」。
 *
 * `/api/data` 每次调用结束都兜底排一次落盘（理由在那条路由里），包括纯读。那一处
 * 不能报改动：报了之后「重问」自己就成了「又改了」，屏幕会无限重问下去。
 */
export function persistOnly(): void {
  scheduleSave(() => ({
    fingerprint: SEED_FINGERPRINT,
    savedAt: new Date().toISOString(),
    state: store as unknown as Record<string, unknown>,
  }));
}

/**
 * 录音那张表本身。**只给流水线用**（`lib/recording/pipeline.ts`）。
 *
 * 为什么要开这个口子：流水线是后台跑的，它要在转码完成、上传完成、转写完成这几个
 * 时刻改状态，而那几个时刻不在任何一次请求里 —— 走不了 `api` 那条路（那些方法都
 * 有 `sleep` 和 actor 上下文，是给请求用的）。
 *
 * 反过来 import 不行：`store.ts` 一旦 import 流水线，而流水线 import `store.ts`，
 * 两个模块就互相 import 了 —— 那种循环最常见的表现不是报错，是某个 const 在求值时
 * 还是 undefined，然后在很远的地方炸成一句和真实原因无关的话。
 *
 * 拿到的是**活的数组**，改了要自己叫 `persistSoon()`。
 */
export const recordingsTable = (): Recording[] => store.recordings;

/** 一号位。他那把共享口令不指向某个人，所以这里给出他是谁。 */
export const CEO_ACTOR: Actor = { personId: tk.VIEWER_ID, role: "ceo" };

/**
 * cookie 里解出来的 personId → actor。**解不出 dri 就返回 null**（spec §2：
 * 名册在对象库里躺着，不另开一份环境变量）。
 *
 * 只认 `role === "dri"`：一号位有他自己那道门，不该也能拿签名链接进来 ——
 * 那会让「这条链接是谁的」在日志里变成两种可能。
 */
export function resolveDriActor(personId: string): Actor | null {
  const person = tk.people.find((p) => p.id === personId && p.role === "dri");
  return person ? { personId: person.id, role: "dri" } : null;
}

/**
 * 留多少条 Run 记录。见 `store.agentRuns` 上的注释。
 *
 * **这个数字和下面的 `MAX_CONTEXT_SNAPSHOTS` 是一对**：每条记录都存着 `snapshotId`，
 * 而快照只留 64 份（那边的注释写了为什么故意留这么少）。两者不相等是有意的 ——
 * 窗口里较老的那些锚定记录，快照确实取不回来了；「取不回来」由 `snapshotEvicted`
 * 现判着报出来，不许让它长得像「坏了」。改动任何一个数字前先读另一个。
 */
export const MAX_AGENT_RUNS = 200;

/**
 * 待挑的信号留多少条。理由同 `MAX_AGENT_RUNS`（落盘是整份重写），数字也一样：
 * 每天一轮、每轮过线上限 8 条，200 条是不到一个月的量 —— 抓取改成每天之后这份账
 * 短了不少，但满了先丢的是已处置的，所以缩短掉的是「他已经看过并处置过」那一段。
 *
 * 满了先丢**已处置**的（`inboxEvictees` 定的顺序），已处置的丢完才动未处置的，
 * 而且那时要 warn —— 见下面 `inboxSignalsPut` 里那段。
 */
export const MAX_INBOX_SIGNALS = 200;

/**
 * 扫描记录留多少轮。一条记录只有四个字段（`ScanRound`），200 轮按每天一轮是半年多
 * 的量 —— 比信号那份撑得久，因为这份账才是「雷达到底有没有在转」的凭据。
 */
export const MAX_SCAN_ROUNDS = 200;

/*
 * Run 记录的写入口**不进 `api` 对象**。
 *
 * `api` 上的每个方法都在 `POST /api/data` 的白名单里，浏览器能直接打。
 * 读记录没问题，写记录不该对浏览器开放 —— 那等于允许前端往评分队列里塞任意
 * 内容。和上半的 `contextSnapshotPut` 同一处理。
 *
 * ## 这里必须是 `function` 声明
 *
 * 本模块和 harness 那一侧**互相 import**（`store → a3/run → harness →
 * graphknowledge/index → snapshot → store`，见文件头那批 import）。函数声明会被提升，
 * 所以环里谁先加载都取得到它；改成 `export const agentRunPut = () => {}` 之后，
 * 先加载的那一侧拿到的是尚未初始化的绑定，**模块初始化期就炸**。
 * 编译器不管这件事 —— 类型完全合法，只有运行时才看得见。
 * 下面 `markCardAgentVerdict`、`contextSnapshotPut`、`contextSnapshotGet` 同理：
 * 这四个是跨环那条边上的出口，形式不能改。
 */
export function agentRunPut(rec: AgentRunRecord): void {
  store.agentRuns.push(clone(rec));
  while (store.agentRuns.length > MAX_AGENT_RUNS) store.agentRuns.shift();
  persistSoon();
}

/**
 * 开跑了：先在台账上立一条 `running`，返回它的记录号。跑完拿这个号去
 * `agentRunSettle` 原地换成落定的那一条。
 *
 * ## 为什么不是跑完再写一条
 *
 * 2026-08-25 那天的 Bedrock 账单上有一笔 57 万输入 token 的深研，而运营台上一条记录
 * 都没有 —— 那一轮跑到中途进程就没了（改服务端代码触发热重载），而记账只在链路
 * **跑完**之后发生。于是三件事同时成立：钱花掉了、议题那一行一直写着「深度研究
 * 进行中」、而「今天跑了几轮、哪几轮白烧了」只能靠翻云上的账单反推。一轮深研是
 * 十几分钟真钱，这段时间里台账上不能是空的。
 *
 * 记录号在这里就发（`newRunId`），而 harness 在收尾时会发它自己的那一个 —— 换上去的
 * 是**后者**（`r.run.id`）：卡上那条标注、trace 里那些引用记的都是 harness 那个号，
 * 为了让两个号一致而去改写落定记录的 id，会让台账上的号和别处引用的号对不上。
 */
/**
 * 在跑的那几轮：记录号 → 它是谁、什么时候开跑的。
 *
 * 台账上那条记录已经写着这些了，这一份是为了**它被挤掉之后仍然答得出来**
 * （`MAX_AGENT_RUNS`，见 `agentRunSettle`）—— 少了它，那种情况下只能往记录里填一个猜的
 * agent。进程一没这份就空了，而那时那几轮也确实没有人在跑了（`markInterruptedRuns`
 * 读的是台账，不是这里）。
 */
const openRuns = new Map<
  string,
  { agent: AgentRunRecord["agent"]; input: string; createdAt: string }
>();

export function agentRunOpen(init: {
  agent: AgentRunRecord["agent"];
  input: string;
}): string {
  const id = newRunId(init.agent);
  const createdAt = new Date().toISOString();
  openRuns.set(id, { agent: init.agent, input: init.input, createdAt });
  agentRunPut({
    ...emptyRunFields(),
    id,
    agent: init.agent,
    status: "running",
    input: init.input,
    // 收尾那两个字段留空（`emptyRunFields`）。填一个当下的时刻等于台账上写着它已经跑完了。
    createdAt,
  });
  return id;
}

/**
 * 落定：把 `agentRunOpen` 立的那条换成真的。
 *
 * 两种收场。`AgentRunRecord` 是链路自己收的尾（`ok` / `ignored` / `failed`），整条换上去。
 * `{ error }` 是**没走到收尾**那一类 —— 抛出来的是普通 `Error`，手上没有记录：深研压
 * 四节那一步被 `max_tokens` 截断就是这一种（ISS-111）。原来那一版 `if (e instanceof
 * AgentRunFailed)` 一句把它挡掉，于是这类失败在台账上同样一条不留。
 *
 * 这一类换上去的记录里 `usage` 是零：token 数只活在那个 harness 实例上，异常没带出来。
 * 这一条查不出「这次烧了多少」，但至少查得出「这次跑过、挂了、原话是什么」。
 *
 * 开跑那条被上限挤掉了（`MAX_AGENT_RUNS`）就当新的一条追加 —— 那是一轮跑了很久、
 * 期间又跑了两百次别的运行，不该因此在台账上消失。
 */
export function agentRunSettle(
  openId: string,
  outcome: AgentRunRecord | { error: string },
): void {
  const i = store.agentRuns.findIndex((r) => r.id === openId);
  // 开跑那一下记下来的身份，台账上那条还在就以它为准。这两个值在这条路上无从重算 ——
  // 异常里只有一句原话。
  const open = openRuns.get(openId) ?? (i >= 0 ? store.agentRuns[i] : null);
  openRuns.delete(openId);
  const settled: AgentRunRecord =
    "id" in outcome
      ? outcome
      : {
          ...emptyRunFields(),
          id: openId,
          agent: open?.agent ?? "A4",
          input: open?.input ?? "",
          status: "failed",
          error: outcome.error,
          createdAt: open?.createdAt ?? new Date().toISOString(),
          latencyMs: open
            ? Math.max(0, Date.now() - Date.parse(open.createdAt))
            : 0,
          finishedAt: new Date().toISOString(),
        };
  if (i < 0) {
    agentRunPut(settled);
    return;
  }
  store.agentRuns[i] = clone(settled);
  persistSoon();
}

/** 一条记录上除身份和收场之外那些字段的空值。`agentRunSettle` 拼那条没走到收尾的记录要用。 */
function emptyRunFields(): Omit<
  AgentRunRecord,
  "id" | "agent" | "input" | "status"
> {
  return {
    output: null,
    contextMode: "",
    trace: [],
    checks: [],
    checkSummary: { passed: 0, total: 0, allPassed: true, failed: [] },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    },
    slot: "",
    modelAlias: "",
    providerModelId: "",
    depth: "",
    snapshotId: "",
    contextRecipe: "",
    contextAnchor: "",
    contextViewer: "",
    contextAsOf: "",
    graphknowledgeBaseUrl: "",
    warnings: [],
    createdAt: "",
    finishedAt: "",
    latencyMs: 0,
  };
}

/**
 * 进程起来时扫一遍台账：还停在 `running` 的那几条，是上一个进程带走的。返回标了几条。
 *
 * 任务表只活在进程里，所以那几轮已经没有人在跑了 —— 而记录上写着「在跑」会让运营台
 * 一直显示一轮不存在的运行。`interrupted` 不是 `failed`：那一轮没有任何东西弄挂它，
 * 是进程没了，而钱已经花掉（理由同 `AgentRunRecord.status` 上那段）。
 *
 * 只动 `running` 那几条，所以扫第二遍是空操作 —— 否则每次启动都把同一条的收尾时刻
 * 往后推一次，而那个时刻本来是用来算「这一轮跑了多久才断的」。
 */
export function markInterruptedRuns(): number {
  let n = 0;
  for (const r of store.agentRuns) {
    if (r.status !== "running") continue;
    r.status = "interrupted";
    r.error =
      "这一轮没跑完 —— 服务重启（或改代码触发的热重载）把它掐断了，" +
      "所以它既没跑到落库那一步，也没留下这一轮到底烧了多少 token。";
    r.finishedAt = new Date().toISOString();
    r.latencyMs = r.createdAt
      ? Math.max(0, Date.now() - Date.parse(r.createdAt))
      : 0;
    n += 1;
  }
  if (n) persistSoon();
  return n;
}

/** 给信号卡挂上「调研后判为噪音」的标注。卡不因此消失。找不到卡返回 false。
 *  **必须保持 `function` 声明**（跨模块环那条边上的出口，见 `agentRunPut` 上的注释）。 */
export function markCardAgentVerdict(
  cardId: string,
  verdict: CardAgentVerdict,
): boolean {
  const card = store.cards.find((x) => x.id === cardId);
  if (!card) return false;
  card.agentVerdict = { ...verdict };
  persistSoon();
  return true;
}

/**
 * A1a 的输入。返回活对象的**副本** —— agent 那一侧只读，不该拿到能改 store
 * 的引用（那种改动绕过 `persistSoon()`，重启之后凭空消失）。
 */
export function agentSignalInput(
  cardId: string,
): { card: Card; issue: Issue } | null {
  const card = store.cards.find((x) => x.id === cardId);
  if (!card) return null;
  const issue = store.issues.find((i) => i.id === card.issueId);
  if (!issue) return null;
  return { card: clone(card), issue: clone(issue) };
}

/*
 * 收件入口。**不进 `api` 对象** —— `api` 的每个键都在 `POST /api/data` 的白名单里，
 * 浏览器能直接打；上了就等于允许前端往一号位的列表里塞任意信号。同 `agentRunPut`。
 *
 * 下面四个都**必须保持 `function` 声明**（跨模块环那条边上的出口，
 * 见 `agentRunPut` 上的注释）。
 */
/**
 * 一号位给下一轮扫描的那句交代，起 run 的时候读（`scan/run.ts`）。没给就是空串。
 *
 * 和上面几个一样是 `function` 声明：它在跨模块环那条边的出口上。
 */
export function monitorFocusText(): string {
  return store.monitorFocus?.text ?? "";
}

/**
 * 待挑列表上现有的那些幂等键。扫描那一步拿它避开已经端上去过的东西。
 *
 * **这是省钱的那一道筛**：研判按条收费，上一轮已经在列表里的再判一遍，花的是真钱，
 * 换回来的是同一条。返回 `Set` 而不是数组 —— 调用处是在一个几十条的循环里逐条问
 * 「见过没有」。
 *
 * 返回的是一份新的集合，不是握着库里的活引用（同这一层别的读法）。
 *
 * 和上面几个一样是 `function` 声明：它在跨模块环那条边的出口上。
 */
export function listInboxDedupeKeys(): Set<string> {
  return new Set(store.inboxSignals.map((s) => s.dedupeKey));
}

/**
 * **只收抓取那一支。** 人报的那一条走 `reportSignal`：两支的更新语义不一样 ——
 * 抓取是「同一次研判的全部产物一起更新」，人报的东西没有第二次研判。
 */
export function inboxSignalsPut(incoming: CrawledSignalInput[]): {
  inserted: number;
  updated: number;
} {
  const at = nowIso();
  let inserted = 0;
  let updated = 0;

  for (const sig of incoming) {
    const cur = store.inboxSignals.find((s) => s.dedupeKey === sig.dedupeKey);
    if (cur) {
      /*
       * 同一条 URL 又扫到一次。`time_window_hours = 72` 而扫描每天一轮，
       * 窗口是三倍重叠的 —— 这是常态，不是异常，而且比原来更常见。
       *
       * 更新的是**同一次研判的全部产物**（分数和理由要一起读，只更一半会让屏幕上
       * 分数是新的、理由是旧的）；**不动** `receivedAt` 与三个处置字段：一号位
       * 已经挑过的东西不能因为下一轮扫描又冒回列表里。
       *
       * 撞上一条人报的同 key（同一个 URL，人先报了、作业后来也扫到了）：**保留
       * 人报的那一条**，只把作业算出来的理由补进 `why`。谁先押上名字，那条来路
       * 就是他的。
       */
      if (cur.kind === "reported") {
        cur.why = cur.why || sig.why;
        updated += 1;
        continue;
      }
      cur.title = sig.title;
      cur.url = sig.url;
      cur.text = sig.text;
      cur.publishedAt = sig.publishedAt;
      cur.source = sig.source;
      cur.origin = sig.origin;
      cur.score = sig.score;
      cur.dimensions = { ...sig.dimensions };
      cur.kiq = sig.kiq;
      cur.why = sig.why;
      cur.suggestedIssue = sig.suggestedIssue;
      cur.runId = sig.runId;
      cur.scannedAt = sig.scannedAt;
      updated += 1;
      continue;
    }
    store.inboxSignals.push({
      ...sig,
      dimensions: { ...sig.dimensions },
      receivedAt: at,
    });
    inserted += 1;
  }

  const doomed = inboxEvictees(store.inboxSignals, MAX_INBOX_SIGNALS);
  if (doomed.length > 0) {
    for (const s of doomed) {
      // 未处置的被挤掉要喊出来：它是这条链路唯一的产出，而屏幕上看不出少了一条。
      if (!s.disposedAs) {
        console.warn(
          `[tkos:inbox] 上限 ${MAX_INBOX_SIGNALS} 满了，挤掉一条**还没有人挑过**的信号：` +
            `${s.title}（${s.url}）。要么调大上限，要么这一页积压太久了。`,
        );
      }
    }
    const keys = new Set(doomed.map((s) => s.dedupeKey));
    store.inboxSignals = store.inboxSignals.filter(
      (s) => !keys.has(s.dedupeKey),
    );
  }

  persistSoon();
  return { inserted, updated };
}

/**
 * 记一轮扫描。**扫完就记，过线零条也记** —— 为什么必须记，写在 `ScanRound` 上。
 *
 * 两条收件路各调一次：一号位按「主动开始扫描」那条（`scan/run.ts` 的 `ingest`）、
 * 抓取作业定时推过来那条（`api/signals/inbox`）。**只记跑到底的那些**：一轮起不来
 * 或者中途报错不是「扫过一遍，外面没有东西」，那种情形屏幕上另有一句原话照登的错。
 *
 * 同一个 `runId` 再来一次就地更新（作业重投是幂等的，靠的就是这个）——
 * 追加一条会让屏幕上同一轮扫描出现两次。
 *
 * 和 `inboxSignalsPut` 一样是 `function` 声明：它在跨模块环那条边的出口上
 * （见 `agentRunPut` 上的注释）。
 */
export function scanRoundPut(round: {
  runId: string;
  scannedAt: string;
  nominated: number;
  /** 谁起的这一轮。两条写入路各自如实填 —— 算节奏只数自动的（见 `ScanRound.trigger`）。 */
  trigger: "auto" | "manual";
}): void {
  const at = nowIso();
  const cur = store.scanRounds.find((r) => r.runId === round.runId);
  if (cur) {
    cur.scannedAt = round.scannedAt;
    cur.nominated = round.nominated;
    cur.trigger = round.trigger;
    cur.at = at;
  } else {
    store.scanRounds.push({ ...round, at });
  }
  // 上限同 `MAX_INBOX_SIGNALS`（落盘是整份重写）。老的先走 —— 这份账只往前看。
  while (store.scanRounds.length > MAX_SCAN_ROUNDS) store.scanRounds.shift();
  persistSoon();
}

/** 取一条（副本）。给「开成议题」那条 route 用 —— 它不该拿到能改 store 的引用。 */
export function inboxSignalGet(dedupeKey: string): InboxSignal | null {
  const sig = store.inboxSignals.find((s) => s.dedupeKey === dedupeKey);
  return sig ? clone(sig) : null;
}

/**
 * 灌纲领。**幂等，而且只覆盖还没人动过的那些。**
 *
 * 同一期同一个域重复灌：`drafted`（DRI 还没标注）就整条换掉 —— 纲领改了一版，
 * 重灌一次是正常操作。已经 `submitted`/`adjudicated`/`effective` 的**跳过并报出来**：
 * 那意味着有人已经在上面写了东西，静默覆盖等于把一个人半天的回传抹掉。
 */
export function commitmentsIntake(payload: import("./om-intake").OmIntake): {
  periodCreated: boolean;
  drafted: number;
  skipped: string[];
} {
  let periodCreated = false;
  if (!store.periods.some((p) => p.id === payload.period.id)) {
    store.periods.push({ ...payload.period, projectId: tk.projects[0].id });
    periodCreated = true;
  }
  if (!store.companyOutcomes.some((o) => o.periodId === payload.period.id)) {
    store.companyOutcomes.push({
      id: `CO-${payload.period.id}`,
      periodId: payload.period.id,
      statement: payload.companyOutcome.statement,
      dueOn: payload.companyOutcome.dueOn,
    });
  }

  let drafted = 0;
  const skipped: string[] = [];
  for (const d of payload.domains) {
    if (!allDomains.some((x) => x.id === d.domainId)) {
      skipped.push(`${d.domainId}（本体里没有这个域）`);
      continue;
    }
    const id = `${d.domainId}:${payload.period.id}`;
    const cur = store.commitments.find((c) => c.id === id);
    if (cur && cur.status !== "drafted") {
      skipped.push(`${d.domainId}（已经是 ${cur.status}，没动）`);
      continue;
    }
    const made: Commitment = {
      id,
      domainId: d.domainId,
      periodId: payload.period.id,
      version: 1,
      status: "drafted",
      northStar: d.northStar,
      items: d.items.map((it, n) => ({
        id: `${id}-m${n + 1}`,
        proposed: it.proposed,
        /* 初值是 accept：纲领刚下来的时候没有分歧，分歧是 DRI 标出来的。 */
        verdict: "accept",
        evidence: [],
        milestone: {},
        tier: it.tier,
      })),
      assumptions: [],
      preconditions: [],
      questions: [],
      revisions: [],
    };
    if (cur) store.commitments[store.commitments.indexOf(cur)] = made;
    else store.commitments.push(made);
    drafted += 1;
  }

  persistSoon();
  return { periodCreated, drafted, skipped };
}

/**
 * **单测专用。** 把一件议题摆到「深研报告已到、题已定」那个起点上。
 *
 * 为什么需要它：这两格在产品里只有真模型写得出来（A4 深研、A2 定题），而单测里一次
 * 模型调用都不许打（`vitest.config.ts` 文件头）。守着「`escalate` 不再替 DRI 回话」
 * 的那条断言必须从这个起点出发 —— 没有深研报告，旧代码同样走不进那段模拟，测试就
 * 锁不住任何东西。
 *
 * 为什么不是 `export { store }`：这个文件的约定是**所有写都经过 `api`**（`scope.ts`
 * 的角色门、`touch`、`pushEvent`、`persistSoon` 都挂在那一层）。导出可变引用等于给
 * 每个模块开一道「改了库不留痕」的门，而这类坏法没有症状。这里只开需要的两格，
 * 名字自带警告：产品代码里出现它，review 一眼看得见。
 */
export function __seedResearchedIssueForTest(
  issueId: string,
  doc: ResearchDoc,
  question: DecisionQuestion,
): void {
  store.researchDocs[issueId] = clone(doc);
  store.decisionQuestions[issueId] = clone(question);
}

/**
 * **单测专用。** 往 closureDrafts 里填一份草案，跳过 ensureWriteBack 要跑的 Agent A10。
 *
 * 为什么需要它：草案在产品里只有真模型写得出来（A10），而单测里一次模型调用都不许打
 * （`vitest.config.ts` 文件头；`mock.ts` 的 `CANNED` 里只有七个罐头，没有 a10 的）。
 * 测 `confirmClosure` 走真路径 → 它调 `clearShakenBy` → 断言 standing 回落，必须从
 * 「草案已经在」这个起点出发 —— 没有草案，`confirmClosure` 第一句就抛 ApiError。
 *
 * 为什么不是导出 `clearShakenBy`：那会绕过真调用方（`confirmClosure` / `confirmCandidate`），
 * 测试就锁不住真实路径。这里只填 `store.closureDrafts` 这一格，名字自带警告。
 */
export function __seedClosureDraftForTest(
  issueId: string,
  draft: ClosureDraft,
): void {
  store.closureDrafts[issueId] = clone(draft);
}

/**
 * **单测专用。** 把一场已经排好的会挪到某一天。
 *
 * 为什么需要它：「这一格过去了没有」现在由墙上的时钟判（见 `slotPast`），而
 * `scheduleIssue` 不让往过去排 —— 于是「排完之后时间走了过去」这个状态在测试里**造不
 * 出来**，而那恰好是会后那一整条链路的入口。只改日期，`endedAt` 一个字不碰：那两条判据
 * 是「或」的关系，把日期挪到昨天正是用来验「没人按过也算结束」的那一半。
 *
 * 名字自带警告，理由同 `__seedResearchedIssueForTest`。
 */
export function __backdateSlotForTest(slotId: string, date: string): void {
  const slot = store.meetingSlots.find((s) => s.id === slotId);
  if (!slot) throw new Error(`没有这一场会：${slotId}`);
  slot.date = date;
}

/**
 * **单测专用。** 塞一条判断进 `store.judgments`，供 `buildTargetIndex()` 命中。
 *
 * 为什么需要它：判断在产品里只有真实的立案与研判流程能产出，而那条测试要在
 * `addIssue` **之前**把靶点摆好 —— `addIssue` 落卡之后当场就叫 `ensurePreResearch`，
 * 靶点库是那一刻 map 出来的，晚一步就赶不上这一轮。这里只开 `judgments` 这一格。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __seedJudgmentForTest(judgment: Judgment): void {
  store.judgments.push(clone(judgment));
}

/**
 * **单测专用。** 塞一条触发器提案进 `store.triggers`，可以带任意 `status` / `expiresAt`。
 *
 * 为什么需要它：测到期清扫（`listTriggers` 读表时把过期项判成 `expired`）与测
 * `disposeCard` 的转正 / 作废分支，都要从一条「已经在表里、状态和到期时间摆好」的
 * 提案起步。产品里没有能摆出任意状态的写入口 —— 提案只从预研那一轮自然产出，
 * 起手必是 `proposed`，`expiresAt` 也不是任由调用方定的 —— 只能从这里进。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __seedTriggerForTest(trigger: TriggerProposal): void {
  store.triggers.push(clone(trigger));
}

/**
 * **单测专用。** 取种子里第 n 张提请卡与它所属的议题（demo 档种子按下标稳定，
 * 几条用例各取不同的一张，互不干扰）。
 *
 * 为什么需要它：那几条用例要的是**种子里既有的**议题与卡（卡上有原文、
 * `judgmentRefs` 上挂着判断），不是现造一条 —— 现造一条得把这些字段都补齐，
 * 等于在测试里重写一遍种子。只读，不改任何一格。
 *
 * 为什么按卡下标而不是按议题下标：种子里议题比卡多（带卡的只有前几条），
 * 按议题下标取会取到没有卡的那几条。卡这一头才是「既有议题 + 既有卡」都成立的那一份。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __nthDemoCardForTest(n: number): { issue: Issue; card: Card } {
  const card = store.cards[n]!;
  const issue = store.issues.find((i) => i.id === card.issueId)!;
  return { issue: clone(issue), card: clone(card) };
}

/**
 * **单测专用。** 数一下眼下所有判断上 `armed: true` 的重开条件一共有几条。
 *
 * 为什么需要它：那一条要证明的是「按待定这一下**不**布控」——`ReopenTrigger.armed`
 * 只由 `confirmCandidate` / `confirmClosure` / `signClosure` 写，`disposeCard`
 * 不许碰这一格。断言只要一个数，不需要谁能拿到 `judgments` 整张表去改它，所以
 * 只交出这一个派生出来的数。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __countArmedReopenTriggersForTest(): number {
  return store.judgments.flatMap((j) => j.reopenTriggers.filter((t) => t.armed))
    .length;
}

/**
 * **单测专用。** 把一个议题这一轮的 `stages` 搬到 `preResearchPrev`、删掉
 * `preResearch[issueId]`，也就是 `attachSignalToCard` 的那两步手动动作，
 * 并把搬走前的 `stages` 原样返回给调用方断言。
 *
 * 为什么需要它：这两步在生产上只有 `attachSignalToCard` 会做，而它今天在生产上
 * 没有任何调用方。要测「第二轮读 `prevStages` 出增量卡」，得先有个入口把第一轮的
 * 产物摆到第二轮该在的起点上 —— 不这样做就只测得到「有没有传参」，测不到
 * `prevStages` 这条线真的通。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __advancePreResearchRoundForTest(
  issueId: string,
): PreResearchStages | undefined {
  const stages = store.preResearch[issueId]?.stages;
  if (stages) {
    store.preResearchPrev[issueId] = clone(stages);
    delete store.preResearch[issueId];
  }
  return stages;
}

/**
 * **单测专用。** 塞一条议题和它的卡，供那几条用例从「库里已经有这一条」这个起点出发。
 *
 * 为什么需要它：那几条要的是「卡上的原文逐字可比」，而且每条得有一条**只属于自己的**
 * 议题（`__nthDemoCardForTest` 取的是种子里既有的那几张，同文件几组用例会互相踩）。
 * 走 `api.addIssue` 那条真入口不行：它落卡之后当场就叫 `ensurePreResearch`，会往
 * `store.preResearch[issueId]` 写一份，正好压掉那几条自己摆的那一份；卡上的字段也是
 * A1a 那一路写的，跟要比的原文对不上。这里只开 `issues` / `cards` 这两格，不交出任何引用。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __seedIssueWithCardForTest(issue: Issue, card: Card): void {
  store.issues.push(clone(issue));
  store.cards.push(clone(card));
}

/**
 * **单测专用。** 按议题号取那张卡，**返回克隆**。
 *
 * **为什么返回克隆而不是那张卡本身**：交出活引用，调用方就只能断言「那个对象被原地改了」——
 * 哪天实现改成**替换**卡对象（`store.cards[i] = { ...card, what }`），活引用指向的还是旧那个，
 * 断言要么假绿要么红得莫名其妙。交克隆逼着调用方在动作之后**重新读一次**，断的是可观察状态，
 * 那才是屏幕和下游真正依赖的东西。这不是窄口的退让，是更严的测法。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __getCardForTest(issueId: string): Card | undefined {
  const card = store.cards.find((c) => c.issueId === issueId);
  return card ? clone(card) : undefined;
}

/**
 * **单测专用。** 数一下眼下 `store.cards` 里一共几张卡。
 *
 * 为什么需要它：「有增量就挂到老卡上，**不新建卡**」这条断言只要一个数 —— 不需要
 * 谁能拿到 `cards` 整张表，所以只交出这一个派生出来的数。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __countCardsForTest(): number {
  return store.cards.length;
}

/**
 * **单测专用。** 往 `store.preResearch` 里填一份预研文档（`PreResearchDoc`，就是那张表的类型）。
 *
 * 为什么需要它：这份文档在产品里只有真模型写得出来（A3 预研那一轮），而单测里一次模型
 * 调用都不许打（`vitest.config.ts` 文件头）。测「挂完信号之后上一轮产物搬进
 * `preResearchPrev`」得从「这一轮的产物已经在库里」这个起点出发。姿态与
 * `__seedClosureDraftForTest` 一模一样：只填这一格。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __seedPreResearchDocForTest(
  issueId: string,
  doc: PreResearchDoc,
): void {
  store.preResearch[issueId] = clone(doc);
}

/**
 * **单测专用。** 读一个议题的「这一轮」与「上一轮」两格，**都是克隆**。
 *
 * 为什么需要它、为什么是这两格一起：`attachSignalToCard` 干的就是**把这一轮搬到上一轮**
 * 这一个动作，断言它成没成必须同时看两格（`cur` 空了、`prev` 有了）——分成两个钩子反而
 * 让调用方拼出这层意思。`preResearchPrev` 这一格在产品侧**没有任何读出口**（它只被
 * `ensurePreResearch` 当入参读一次，不上 `api`），所以这一格只能从这里读。
 *
 * 和上面 `__advancePreResearchRoundForTest` 不重：那一个是**手动做**搬这两步（给还没有
 * `attachSignalToCard` 的那条用例摆起点用），这一个只**读**，不动任何一格。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __getPreResearchRoundForTest(issueId: string): {
  cur: PreResearchDoc | undefined;
  prev: PreResearchStages | undefined;
} {
  const cur = store.preResearch[issueId];
  const prev = store.preResearchPrev[issueId];
  return {
    cur: cur ? clone(cur) : undefined,
    prev: prev ? clone(prev) : undefined,
  };
}

/** 测试辅助：访问决策记忆（Task 13） */
export function __getDecisionMemoriesForTest(): import("@/lib/agent/talk/memory").DecisionMemory[] {
  return clone(store.decisionMemories);
}

/**
 * **单测专用。** 往 `store.userCard` 里填一张用户卡（或用 `null` 收回去）。
 *
 * 为什么需要它：这张卡在产品里的写者是「session 结束时批量抽取」那一档抽取器，而按
 * 裁定 3 那一档是欠账 —— 全仓**现在没有任何写者**，`store.userCard` 永远是 `null`。
 * 于是 `buildAdvisorContext` 里消费它的那一块（`if (store.userCard)`）在生产里走不到，
 * 删掉整段也没有任何测试会红。抽取器可以先欠着，但「消费侧真的接上了」这件事得有
 * 一条测试证明，否则等抽取器接上那天才发现前缀里根本没这一块。
 *
 * 为什么不是导出 `store`：这个文件的约定是**所有写都经过 `api`**（`scope.ts` 的角色门、
 * `touch`、`pushEvent`、`persistSoon` 都挂在那一层）。导出可变引用等于给每个模块开一道
 * 「改了库不留痕」的门，而这类坏法没有症状。这里只开 `store.userCard` 这一格，
 * 名字自带警告：产品代码里出现它，review 一眼看得见。
 */
export function __setUserCardForTest(
  card: import("@/lib/agent/talk/memory").UserCard | null,
): void {
  store.userCard = card ? clone(card) : null;
}

/**
 * 记下处置。找不到返回 null，不抛 —— 调用方（route / api）自己决定怎么说这句话。
 *
 * `api.disposeInboxSignal` 是它的壳。两个入口共用同一个原语，不各写一份：处置字段
 * 有两个写者（一号位点三键、「开成议题」那条 route 先记后跑），逻辑分两处会漂。
 */
export function inboxSignalDispose(
  dedupeKey: string,
  action: InboxDisposition,
): InboxSignal | null {
  const sig = store.inboxSignals.find((s) => s.dedupeKey === dedupeKey);
  if (!sig) return null;
  sig.disposedAs = action;
  sig.disposedAt = nowIso();
  persistSoon();
  return clone(sig);
}

/** A1a 跑完之后把结论记在这条信号上。找不到返回 false，不抛。 */
export function inboxSignalJudged(
  dedupeKey: string,
  judged: NonNullable<InboxSignal["judged"]>,
): boolean {
  const sig = store.inboxSignals.find((s) => s.dedupeKey === dedupeKey);
  if (!sig) return false;
  sig.judged = { ...judged };
  persistSoon();
  return true;
}

/**
 * 一条信号在池子里落成议题的那一套对象。**两条路共用这一份建法。**
 *
 * 两条路是：A1a 判为值得（`issueFromSignal`），和参谋判不值得、一号位仍然要开
 * （`api.openIssueAnyway`）。它们只差三样 —— 标题谁给的、有没有那四块框架、时间线上
 * 那一条怎么写。其余（一条 `Candidate` 议题、一张摊在今天这一批里的卡、一轮预研、
 * 锚哪条判断）必须一字不差；抄成两份的话，屏幕上迟早出现「有的潜在议题没有卡」
 * 这类只在一条路上出现的洞。
 *
 * **时间线那一条不在这里推。** 两条路要记的事实不一样（一条追的是那次模型调用，
 * 一条要记下参谋与一号位的分歧），这个函数无从判断该说哪一句。它把 `at` 和预研这一轮
 * 的状态交出去，账由调用方自己写。
 */
function landSignalIssue(
  sig: InboxSignal,
  opts: {
    /** 卡面和清单上那一行。两条路都只有一个来源，所以由调用方给死。 */
    title: string;
    /** S01 那四块。**没有就是没有** —— 判不值得那条路上模型根本没产出它们。 */
    framing: IssueFraming | null;
    /** 那次运行的产出。他自己开的那条没有产出，传 `{}`。 */
    out: Record<string, unknown>;
  },
): {
  issue: Issue;
  card: Card;
  at: string;
  pre: TaskState;
  replaced: Issue | undefined;
} {
  const { title, framing, out } = opts;

  /* 同一次立案的四个对象只盖一次「现在」：两个不同的时间戳是这个产品最不该有的细节。 */
  const at = nowIso();

  const issue: Issue = {
    id: nextIssueId(),
    title,
    state: "Candidate",
    origin: "signal",
    /*
     * `domainId` 不给：归域是之后的事，这里不猜（照 `Issue.domainId` 的注释）。
     * 人报那一支知道的是**上报人**的域，不是这条议题的域。
     */
    judgmentRefs: [],
    nextActionForUser: null,
    raisedAt: at,
    updatedAt: at,
  };
  store.issues.push(issue);

  /*
   * 「影响哪条判断」这一格只认真的 `Judgment.id`。三档：人自己答的、模型写的、空。
   *
   * **人答的排在模型前面**：谁押上名字，那条来路就是他的（同 Task 7 那条「抓取撞上
   * 人报同 key 时保留人报」的理由）。这不是不信模型，是这条信息本来就有一个更近的
   * 来源。`shakes` 虽然来自一个下拉框，但那是前端，服务端不能假设它一定真 ——
   * 解析不到就当没有，绝不把未验证的字符串当 id 填进去（Task 19 立的规矩）。
   *
   * **模型写的那一档实跑上可能走不到**：`cited_member_ids` 是 GraphKnowledge 上下文里的
   * member id（`checks.ts:57-63` 拿 `h.memberIds` 校它真不真，实跑里那一层的候选是
   * `CARD-*`），而 `store.judgments` 的 id 形如 `04-J1`：**两个命名空间不是一套**，
   * 那条分支实跑上基本走不到。所以它留着是对的（诚实的空、且将来命名空间统一了就
   * 自动生效），但**真正接得上的那一档是人答的 `shakes`**。
   *
   * **必须在起预研之前**：`ensurePreResearch` 同步地就把 `issue.judgmentRefs` 读走
   * 装进那一轮的 context（`runTask` 立刻执行到第一个 await），晚一行这条判断就进不了
   * 那份预研 —— 而它是这条议题唯一的战略锚点，缺了那一轮就是在真空里查。
   */
  let hit: Judgment | undefined;
  /* 第一档：人报那一支，他自己答的「动摇哪条判断」。 */
  if (sig.kind === "reported" && sig.shakes) {
    hit = store.judgments.find((j) => j.id === sig.shakes);
  }
  /* 第二档：模型写的 `cited_member_ids`。 */
  if (!hit) {
    const cited = Array.isArray(out.cited_member_ids)
      ? out.cited_member_ids
      : [];
    hit = cited
      .map((id) =>
        typeof id === "string"
          ? store.judgments.find((j) => j.id === id)
          : undefined,
      )
      .find((j): j is Judgment => Boolean(j));
  }
  if (hit) issue.judgmentRefs.push(hit.id);

  /* 回填 judgment.shakenBy —— 让判断页能看到「有议题在晃它」。必须在起预研之前。 */
  linkIssueToJudgments(issue);

  /* 预研现在就起（同 `addIssue`）。卡上那句「参谋在查」照它的真实状态写。 */
  const pre = ensurePreResearch(issue.id);

  const ref: Trace | null =
    sig.source || sig.url
      ? {
          kind: "ext",
          source: sig.source || sig.url,
          ...(sig.url ? { href: sig.url } : {}),
        }
      : null;

  const card: Card = {
    id: issue.id.replace("ISS-", "CARD-"),
    issueId: issue.id,
    /* 卡面最响的一行就是这条议题本身，不另编一句（同 `addIssue`）。 */
    headline: title,
    /* 这张卡可信度的全部来源：机器在外面盯着 vs 一个具体的人押上了名字。 */
    source:
      sig.kind === "reported" ? { kind: "dri", by: sig.by } : { kind: "radar" },
    /*
     * S01 那四块**原样存着**，摊在详情页上（卡面仍然是三拍）。存内容不存版面 ——
     * 小标题和拼法在 `framingBlocks()` 里，渲染时才拼（见那个文件的注释）。
     *
     * **模型没产出这四块时这一格是 `undefined`**，屏幕上整段不渲染
     * （`framingBlocks(undefined)` 返回空）。编一份比没有更坏：这四块的份量全在
     * 「参谋真的读过材料之后这么说」，编出来的话它就是一条查不出来路的正文。
     */
    framing: framing ?? undefined,
    /* 信号原文，这边不加工。原文为空时 `what: []` —— 空数组是诚实的空。 */
    what: sig.text
      ? [
          {
            text: sig.text,
            traces: [
              {
                kind: "ext",
                source: sig.source || "外部来源",
                ...(sig.url ? { href: sig.url } : {}),
              },
            ],
          } satisfies Statement,
        ]
      : [],
    /*
     * 卡面第二拍取 Implication 的 business consequence —— 这一格问的正是「如果这条
     * 张力成立，哪一个当前重要判断可能需要重新审视」。
     *
     * 上一版这里只读 `why_it_qualifies`（纯外部路才给的字段），而锚定的 new/update
     * 两条路给的是 `why_now` —— 于是那两条路上这一格**永远**走回落，卡面上写着
     * 「系统还没查过」而其实 A1a 刚查过。三个字段名的兼容在 `readIssueFraming()` 里。
     *
     * 取不到才照实说系统还没有这一段，两句都取自 `addIssue`，按预研的**真实状态**分
     * （同那边）。唯一的删改是掐掉了「您自己提的」那半句：这条议题不是他提的，是一条
     * 信号开出来的。照抄整句会让每一张雷达卡上写着一件没发生过的事。
     */
    why:
      framing?.businessConsequence ||
      (pre.status === "running"
        ? "参谋已经在查了 —— 一到两分钟后这张卡上会多一段判断。"
        : "系统还没查过。"),
    strategyRef: hit
      ? { id: hit.id, statement: hit.statement }
      : {
          id: "",
          statement: "这一条还不知道动摇哪条判断 —— 图谱里没有它的锚点。",
        },
    /* 与 `addIssue` 一字不差：同一件事只有一种说法。 */
    suggestion: { text: "先只决定一件事：值不值得占您的时间。", traces: [] },
    refs: ref ? [ref] : [],
    /*
     * 这张卡碰的是哪个域，由「议题动摇哪条判断（上面那个 hit）→ 判断属于哪个域」两跳
     * 接出来 —— 跟 disposeCard 和种子生成器（gen-seed-from-ontology.mjs:371）说的是同
     * 一条路。一条判断都锚不上时才是空数组，**那才是**诚实的空。
     *
     * 不从上报人的域推：上报人的域是他自己的域，不是这条议题的域。
     */
    domainIds: hit?.domainId ? [hit.domainId] : [],
    createdAt: at,
  };
  store.cards.push(card);
  todayDigest().cardIds.unshift(card.id);

  const target =
    typeof out.target_issue_code === "string"
      ? out.target_issue_code.trim()
      : "";
  const replaced = target
    ? store.issues.find((i) => i.id === target)
    : undefined;

  return { issue, card, at, pre, replaced };
}

/**
 * 这条信号开出来的议题是哪一条。**两处都要看。**
 *
 * 两条路各记各的（理由写在 `InboxSignalMeta.issueId` 上）：一号位确认升级那一下记
 * `sig.issueId`，A1a 自己判为值得开出来的记 `sig.judged.issueId`。只看一处会漏掉另一
 * 条路，而漏掉的表现是「这条信号明明升级过，系统却说它没有议题」——于是同一条信号
 * 会被立第二次案。
 */
export function issueOfSignal(sig: InboxSignal): string | undefined {
  return sig.issueId ?? sig.judged?.issueId;
}

/**
 * 把 A1a 这一轮写出来的正文补到**已经建好的**那条议题上。
 *
 * 为什么会有「已经建好」这种情形：一号位在待挑页上确认升级的那一下，议题和卡当场就
 * 建出来了（`api.upgradeSignal`）—— 他确认的是「这件事值得占我的时间」，那句话不该
 * 等一两分钟的模型调用。A1a 随后照跑，但它此刻的职责只剩一样：**把四块框架写出来**。
 * 选路那一步的结论仍然记着（`judged.route`），只是它不再决定这条议题的生死。
 *
 * 只补两格：`framing` 和卡面第二拍那句 `why`。**标题一个字不动** —— 那是他确认过的
 * 那句话，模型的版本不许覆盖它（这正是确认那一步存在的意义）。
 *
 * 返回是否真的补上了。产出里没有议题正文（判为噪音那条路一个对象都不建）时返回
 * false，卡上那两格保持原样：宁可让它空着写「参谋没给出这一段」，也不编一份。
 */
export function patchSignalIssueFraming(issueId: string, out: Record<string, unknown>): boolean {
  const framing = readIssueFraming(out);
  if (!framing) return false;
  const card = store.cards.find((c) => c.issueId === issueId);
  if (!card) return false;
  card.framing = framing;
  if (framing.businessConsequence) card.why = framing.businessConsequence;
  persistSoon();
  return true;
}

/**
 * 一条待挑的信号被 A1a 判为值得之后，真的在池子里开出一条潜在议题。
 *
 * ## 为什么是机器侧函数（不进 `api`、不进 `scope.ts`、不走 `/api/data`）
 *
 * 点它的是 `/api/agent/a1a/inbox` 那条已经过了访问 cookie 那道门的 route，输入是一次
 * 模型运行的产出，不是屏幕上某个人的动作。`api` 那一层的门是**按看的人**开的（谁能
 * 看见什么、谁能改什么），而这里没有「谁」—— 同 `inboxSignalJudged` / `commitmentsIntake`。
 *
 * ## 四个对象，一个不多一个不少
 *
 * 建法照 `api.addIssue`：一条 `Candidate` 议题 + 一张摊在今天这一批里的卡 + 一轮预研
 * + 一条时间线事件。前三样在 `landSignalIssue` 里（参谋判不值得、他仍然要开的那条路
 * 共用同一份），这里只补上时间线那一条。
 *
 * 差别只在**来路**：`origin: "signal"`、卡上的 `source` 取信号那一支的来路、
 * `what` 是信号原文而不是他自己打的那句话。
 *
 * 返回 `null` = 一个对象都没建（产出里没有议题正文）。调用方照实说这一句。
 */
export function issueFromSignal(
  sig: InboxSignal,
  out: Record<string, unknown>,
  runId: string,
): Issue | null {
  /*
   * S01 那四块，交给格式层去读（`a1a/framing.ts`）—— 这里不认字段名、不拼字。
   *
   * 议题正文是 A1a 这一步唯一必须有的产出。读不到说明这次跑出来的东西不成立 ——
   * 建一条没有标题的议题等于在池子里放一条编的，而池子可信的前提是每条都答得出
   * 自己怎么进来的。
   */
  const framing = readIssueFraming(out);
  if (!framing) return null;

  /* 卡面和清单上那一行是 Sharp Title（短问句）；模型没给时它回落成了议题正文。 */
  const { issue, at, pre, replaced } = landSignalIssue(sig, {
    title: framing.title,
    framing,
    out,
  });

  /*
   * 这条议题的来路，必须能一路追回那次模型调用。
   *
   * runId 落在 `detail` 而不是 `headline` 末尾：`detail` 是时间线上现成的展开段
   * （`components/timeline.tsx` 渲染它），headline 是那一行要被扫过去的话，
   * 把一串 Run 编号缀在它末尾只会让那一行读不动。
   */
  pushEvent(issue.id, {
    id: `E-${issue.id}-raised`,
    // 立案是这件议题的第一次状态落定（落到「待处置」），把它归成「对谈」从来不成立 ——
    // 那一刻没有任何对谈发生。改成 state 之后 `/issues-log` 那句「每件议题的每一步」才是真的。
    kind: "state",
    at,
    headline:
      sig.kind === "reported"
        ? `议题提出（${sig.by} 上报的信号，A1a 判为值得）· 待处置`
        : "议题提出（抓取到的信号，A1a 判为值得）· 待处置",
    actor: sig.kind === "reported" ? sig.by : sig.source || "抓取作业",
    detail: [
      `A1a 运行 ${runId}。这条议题的正文出自那一次调研。`,
      replaced ? `它要取代的是 ${replaced.id}：${replaced.title}` : "",
      pre.status === "running" ? "预研已经在跑了。" : "",
    ]
      .filter(Boolean)
      .join("\n"),
    defaultOpen: true,
  });

  persistSoon();
  return hydrateIssue(issue);
}

/**
 * 池子里还有这一条议题吗。**机器侧，只读一个布尔值。**
 *
 * 为什么需要它：`applyA1aInbox` 要挡「同一条信号立两次案」，判据是那条信号上记着的
 * `judged.issueId` 此刻是否还指向一条真的议题。这个文件不导出 `store`（理由见
 * `__seedResearchedIssueForTest` 的注释），所以那道闸只能问这里。返回对象会让调用方
 * 拿到一条没经过 `hydrateIssue` 的活引用 —— 它要的也只是「在不在」。
 */
export function issueExists(id: string): boolean {
  return store.issues.some((i) => i.id === id);
}

/**
 * 人报那一条的幂等键。
 *
 * 有 URL 就用归一化 URL —— 两个人看到同一篇文章各报一次，那是同一条线索，
 * 不该在待挑页上出现两遍。没有 URL（「客户在电话里说的」）就取
 * 「姓名 + 一句话 + 日期」的哈希：同一个人同一天把同一句话再提一次是手滑，
 * 换个人提或者隔一天再提是新的信息。
 */
export function reportedKey(by: string, title: string, day: string): string {
  return `dri-${createHash("sha1").update(`${by}|${title}|${day}`).digest("hex").slice(0, 16)}`;
}

/**
 * 一条人报的信号落库。**同一个池子**（`store.inboxSignals`）——
 * `CardSource` 上 `{kind:"dri", by}` 那一档早就在了，这里补上的是它的来路。
 *
 * 第二次报同一条：什么都不改，把原来那条原样返回。**尤其不改 `receivedAt`**，
 * 也不复活已处置的那些 —— 理由同 `inboxSignalsPut`。
 */
export function reportSignal(input: ReportedSignalInput): InboxSignal {
  const cur = store.inboxSignals.find((s) => s.dedupeKey === input.dedupeKey);
  if (cur) return clone(cur);

  const put: InboxSignal = { ...input, receivedAt: nowIso() };
  store.inboxSignals.push(put);

  const doomed = inboxEvictees(store.inboxSignals, MAX_INBOX_SIGNALS);
  if (doomed.length > 0) {
    const keys = new Set(doomed.map((s) => s.dedupeKey));
    for (const s of doomed) {
      if (!s.disposedAs) {
        console.warn(
          `[tkos:inbox] 上限 ${MAX_INBOX_SIGNALS} 满了，挤掉一条**还没有人挑过**的信号：${s.title}。`,
        );
      }
    }
    store.inboxSignals = store.inboxSignals.filter(
      (s) => !keys.has(s.dedupeKey),
    );
  }

  persistSoon();
  return clone(put);
}

/** 把对象库恢复到种子状态并落盘。演示前重置用，不需要重启进程。 */
export function resetToSeed(): void {
  Object.assign(store, clone(SEED_STATE));
  persistSoon();
}

/*
 * 上下文快照的上限。故意比 `MAX_AGENT_RUNS`（200）小得多：一份上下文最大 16,000 字，而落盘是**整个
 * store 一起重写**，200 份就是每次写盘都搬 3MB 上下文。留 64 份是拿「较老的记录复现
 * 不了」换「跑得越久写盘越钝」不发生 —— 两个数字是一对，见 `MAX_AGENT_RUNS` 上的注释。
 */
const MAX_CONTEXT_SNAPSHOTS = 64;

/**
 * 上下文快照的读写。给 `graphknowledge/snapshot.ts` 用，**不进 `api` 对象** ——
 * 前端不需要它，而进了 `api` 就等于进了 `/api/data` 的方法白名单。
 *
 * 这两个（连同下面的 `contextSnapshotGet`）**必须保持 `function` 声明**：`snapshot.ts`
 * 正在这个模块环的另一头，见 `agentRunPut` 上的注释。
 */
export function contextSnapshotPut(id: string, value: unknown): void {
  store.contextSnapshots[id] = value;
  /*
   * 加个上限：一份上下文最大 16,000 字，而落盘是整个 store 一起重写。不封顶的
   * 表现是跑得越久每次写盘越慢 —— 没有任何报错，只是越来越钝。
   * 键的插入序就是写入序（都是 ctx- 前缀的字符串键），先进先出。
   */
  const keys = Object.keys(store.contextSnapshots);
  for (const stale of keys.slice(
    0,
    Math.max(0, keys.length - MAX_CONTEXT_SNAPSHOTS),
  )) {
    delete store.contextSnapshots[stale];
  }
  persistSoon();
}

export function contextSnapshotGet(id: string): unknown | null {
  return store.contextSnapshots[id] ?? null;
}

/**
 * 读 Run 记录时补上 `snapshotEvicted`。
 *
 * 为什么现判、而不是淘汰时记一份「被删 id」的名单：名单不落盘，重启之后同样分不出
 * 来；而快照是内容寻址的（`ctx-<sha256 前 16 位>`），同样内容的后一次运行会把这个
 * id 原样写回来 —— 那时候它确实又取得回来了，名单反而会说谎。存在性就是答案。
 */
function withSnapshotState(r: AgentRunRecord): AgentRunRecord {
  if (!r.snapshotId || contextSnapshotGet(r.snapshotId) !== null) return r;
  return { ...r, snapshotEvicted: true };
}

// ---------------------------------------------------------------------------
// 时间与算数
// ---------------------------------------------------------------------------

const TZ = "Asia/Shanghai";

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `2026-08-10`。北京时间的日期，不是浏览器所在时区的日期。 */
const dayOf = (iso: string) => dayFmt.format(new Date(iso));

/** 一个时刻写成这份数据统一的形状：`2026-08-10T16:33:00+08:00`。 */
const stampAt = (ms: number) =>
  `${dayFmt.format(ms)}T${timeFmt.format(ms)}+08:00`;

/** 种子里今天最后发生的那件事，几点几分 —— 新时间戳的下限。 */
const seedLatest = (() => {
  const prefix = `${seed.TODAY}T`;
  let latest = "00:00:00";
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (v.startsWith(prefix) && v.slice(11, 19) > latest)
        latest = v.slice(11, 19);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object")
      Object.values(v).forEach(walk);
  };
  walk(store);
  return latest;
})();

/** 现在几点，只是看一眼 —— 日期锁在 `seed.TODAY`，时分秒走真实时钟。 */
const clockNow = () => `${seed.TODAY}T${timeFmt.format(new Date())}+08:00`;

let stamped = `${seed.TODAY}T${seedLatest}+08:00`;

/**
 * 往这份数据上盖一个「现在」。只在写的时候叫它。日期锁在 `seed.TODAY`，时分秒
 * 走真实时钟但必须晚于已发生的每一件事；同一秒连写两下也分得出先后。
 * 后端接上之后这个函数消失：时间戳由服务端盖。
 */
const nowIso = () => {
  const iso = clockNow();
  stamped = iso > stamped ? iso : stampAt(Date.parse(stamped) + 1000);
  return stamped;
};

/* `withinPeriod`（判断某个时间点落不落在本期内）随旧版 Outcome 周视图一起删了。 */

const daysBetweenDays = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to}T00:00:00+08:00`) -
      Date.parse(`${from}T00:00:00+08:00`)) /
      86_400_000,
  );

const hoursBetween = (from: string, to: string) =>
  (Date.parse(to) - Date.parse(from)) / 3_600_000;

const addDays = (day: string, n: number) =>
  dayOf(
    new Date(
      Date.parse(`${day}T00:00:00+08:00`) + n * 86_400_000,
    ).toISOString(),
  );

/** 一个周期里的每一周，周一起算。头尾两周被周期边界切短，不凑整。 */
const weeksOf = (startsOn: string, endsOn: string) => {
  const weeks: { startsOn: string; endsOn: string; label: string }[] = [];
  const dow = (Date.parse(`${startsOn}T00:00:00+08:00`) / 86_400_000 + 3) % 7;
  let cursor = startsOn;
  let end = addDays(startsOn, 6 - dow);
  while (cursor <= endsOn) {
    const stop = end > endsOn ? endsOn : end;
    weeks.push({
      startsOn: cursor,
      endsOn: stop,
      label: spanLabel(cursor, stop),
    });
    cursor = addDays(stop, 1);
    end = addDays(cursor, 6);
  }
  return weeks;
};

/** 「8 月 3 日 – 8 月 9 日」。同月不重复写月份。 */
const spanLabel = (from: string, to: string) => {
  const [, fm, fd] = from.split("-");
  const [, tm, td] = to.split("-");
  const head = `${+fm} 月 ${+fd} 日`;
  if (from === to) return head;
  return `${head} – ${fm === tm ? `${+td} 日` : `${+tm} 月 ${+td} 日`}`;
};

/** 「26 分钟」/「6 小时」/「2 天」。一个口径，不给同一段时间两种说法。 */
const elapsedLabel = (hours: number): string => {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟`;
  if (hours < 24) return `${Math.round(hours)} 小时`;
  return `${Math.round(hours / 24)} 天`;
};

// ---------------------------------------------------------------------------
// 查找
// ---------------------------------------------------------------------------

const findIssue = (id: string): Issue => {
  const issue = store.issues.find((i) => i.id === id);
  if (!issue) throw new ApiError(`找不到议题 ${id}。`);
  return issue;
};

const findJudgment = (id: string): Judgment => {
  const judgment = store.judgments.find((j) => j.id === id);
  if (!judgment) throw new ApiError(`找不到判断 ${id}。`);
  return judgment;
};

const findPerson = (id: string): Person => {
  const person = tk.people.find((p) => p.id === id);
  if (!person) throw new ApiError(`找不到 ${id}。`);
  return person;
};

const agentOf = (personId: string) => {
  const agent = tk.agents.find((a) => a.personId === personId);
  if (!agent) throw new ApiError(`${personId} 还没有配 Agent。`);
  return agent;
};

const findDomain = (id: string): Domain => {
  const domain = allDomains.find((d) => d.id === id);
  if (!domain) throw new ApiError(`找不到业务域 ${id}。`);
  return domain;
};

/**
 * 这个人自己管哪个域。找不到就是 `undefined` —— 不是每个承接人都是某个域的 DRI。
 *
 * 只在 `tk.domains`（首页那八个域）里找，不用 `allDomains`：接出一个不在首页域列表里
 * 的域，等于把这件议题归到一个他点不开的格子上，屏幕上它就只剩总览里那一行了。
 */
const domainOfDri = (personId: string): Domain | undefined =>
  tk.domains.find((d) => d.driIds.includes(personId));

const findCommitment = (id: string): Commitment => {
  const c = store.commitments.find((x) => x.id === id);
  if (!c) throw new ApiError(`找不到承诺 ${id}。`);
  return clone(c);
};

/**
 * Commitment → CommitmentScreen：基础字段 + 域信息 + 派生量。
 *
 * `rounds` 与 `note` 都是算出来的，不存字段。
 */
const screenOf = (c: Commitment): import("./types").CommitmentScreen => {
  const domain = findDomain(c.domainId);
  return {
    ...clone(c),
    domainCode: domain.code,
    domainName: domain.name,
    domainOutcome: domain.outcome,
    rounds: convergenceRounds(c),
    note: disagreementNote(c),
  };
};

/**
 * 「谁在操作」。
 *
 * 原来是常量（一号位）。DRI 侧进来之后，署名必须是真的 —— 交接包回传上写着
 * 一号位的名字，那份回传就作废了。身份由 `/api/data` 从 cookie 解出来塞进
 * 请求作用域（`actor.ts`），这里只读。
 *
 * **回落仍是一号位**，理由是回落的场合全都是他：vitest、`scripts/*`、以及
 * 结算类后台函数（`settleResearch`）。解不出人也回落 —— 名册变了不该让整个
 * 数据层抛异常。
 */
const viewer = (): Person => {
  const id = currentActor()?.personId;
  const found = id ? tk.people.find((p) => p.id === id) : undefined;
  return found ? found : findPerson(tk.VIEWER_ID);
};

const touch = (issue: Issue, at: string) => {
  issue.updatedAt = at;
};

/**
 * 往一件议题的去向记录里记一笔。**同一个 id 只留一条，后来的那条覆盖前面的。**
 *
 * 事件 id 分两族：`E-<议题>-writeback-draft` 这种固定后缀的，一件议题上只该有一条；
 * `E-<议题>-rework-<时刻>` 这种把时刻编进去的，每次发生都是新的一条。**固定后缀那一族
 * 的 id 就是「这件事只发生一次」这个声明本身** —— 而起草那一步是可以重来的（上一轮
 * 挂了、或者草案被丢掉重起），原来这里无条件 push，于是账上出现两条一模一样的
 * 「写回提案已起草」，只有时刻不同。
 *
 * 两个后果，第二个更坏：
 *
 *   · `Timeline` 用 `key={event.id}` 渲染这份账（`components/timeline.tsx`）。两条同 id
 *     的行 = 两个相同的 React key，React 会警告，而且更新时哪一行留在屏幕上是不定的。
 *   · 每次重来都多一条的话，一份声称「每一步都在这儿」的账会被同一句话灌满，
 *     真正发生过的那几步反而找不着。
 *
 * 覆盖时把旧那条摘掉、新那条接到末尾，而不是原地改：这份账按数组顺序渲染，新的
 * 时刻接在末尾才和顺序一致。
 */
const pushEvent = (issueId: string, event: TimelineEvent) => {
  const list = (store.timelines[issueId] ??= []);
  const at = list.findIndex((e) => e.id === event.id);
  if (at >= 0) list.splice(at, 1);
  list.push(event);
};

/**
 * 议题去向记录的排序口径：按真实时刻倒序（最新在前）。
 *
 * 字符串比较只在「全表同一种偏移量」这个不变量成立时才对，而这条不变量
 * 刚刚被破过一次（A3 预研那条事件的时间戳是 Z 格式），破的时候屏幕上不
 * 报错、只是顺序错了 —— 一份声称「每件议题的每一步都在这儿」的账，静默
 * 乱序比缺一条更坏。按时刻比就不依赖格式统一。
 *
 * 导出供测试使用。
 */
export const compareIssueLogByTime = (
  a: { at: string },
  b: { at: string },
): number => Date.parse(b.at) - Date.parse(a.at);

/**
 * Brief 的纯文本形式，用于交接包正文。
 *
 * 段落空行分隔，`## ` 开头是小标题 —— 与 `Doc.body` 同一套约定。
 * `stanceRedacted` 决定是否带一号位的倾向：false 时 `divergences` 进正文，
 * true 时（默认脱敏）不带。
 *
 * 导出供测试使用。
 */
export const briefText = (brief: Brief): string => {
  const sections: string[] = [];

  sections.push(brief.coreJudgment);
  sections.push(`## 要回答的问题\n${brief.problem}`);
  sections.push(`## 这一份的推荐\n${brief.driRecommendation.text}`);

  if (brief.keyEvidence.length > 0) {
    sections.push(
      `## 关键证据\n${brief.keyEvidence.map((e) => `- ${e.text}`).join("\n")}`,
    );
  }

  /*
   * strongestCounter 在装配时有兜底（store.ts:1861-1864）：没有反证时写「这一轮
   * 深研没有找到能动摇上面判断的反证」。text 保证非空，不需要条件判断。
   */
  sections.push(`## 最强反证\n${brief.strongestCounter.text}`);

  /*
   * divergences 只在 stanceRedacted === false 时进正文 —— 一号位在 assignIssue
   * 时显式选过「这一份要不要带我的倾向」（store.ts:3500），默认脱敏。
   */
  if (!brief.stanceRedacted && brief.divergences.length > 0) {
    sections.push(
      `## 开放分歧\n${brief.divergences.map((d) => `- ${d.text}（${d.note}）`).join("\n")}`,
    );
  }

  if (brief.suggestedQuestions.length > 0) {
    sections.push(
      `## 他会问的\n${brief.suggestedQuestions.map((q) => `- ${q.q}（因为：${q.implication}）`).join("\n")}`,
    );
  }

  return sections.join("\n\n");
};

// ---------------------------------------------------------------------------
// 会后闭环单的装配
//
// **它是从会前带上会的那些拆分点装出来的，不是凭空写的。** 每条拆分点自己就带着
// 去向、要翻的判断、接受的风险、重开条件 —— 那正好是闭环单一个条目要的全部内容。
// 会上没说全的（期限、成功证据）标 `drafted`，等他核；从对象原样搬过来的标 `confirmed`。
//
// 这条设计能成立，是因为「带上会」在这个产品里是一次真实的状态迁移。如果上会靠的是
// 一份人写的议程，散会后就只能靠转写去猜会上定了什么 —— 那才需要一个会编造期限的模型。
// ---------------------------------------------------------------------------

const minutesSince = (iso: string) =>
  Math.max(0, Math.round((Date.parse(clockNow()) - Date.parse(iso)) / 60_000));

/** 一条战略方向判断的运行后果 → 闭环单的哪一区。 */
const CLOSURE_REGION: Record<ProbeRoute, ClosureItemKind> = {
  ontology: "writeback",
  strategy: "writeback",
  mission: "mission",
  evidence: "mission",
};

const buildClosure = (meeting: Meeting): MeetingClosure => {
  const domain = allDomains.find((d) => d.id === meeting.domainId);
  const driName = domain
    ? domainDriLabel(domain)
    : "未指派";
  const at = meeting.endedAt ?? nowIso();
  const items: ClosureItem[] = [];

  const issues = store.issues.filter((i) => i.domainId === meeting.domainId);
  for (const issue of issues) {
    const queued = (store.probeNodes[issue.id] ?? []).filter(
      (ir) => ir.standing === "direction",
    );
    for (const ir of queued) {
      const kind = CLOSURE_REGION[ir.route ?? "strategy"];
      const fields: ClosureItemField[] = [];
      const source = {
        label: `议题研究 · ${ir.id}`,
        href: `/issues/${issue.id}`,
      };

      if (ir.detail) {
        fields.push({
          label: kind === "decision" ? "接受的风险" : "说明",
          value: ir.detail,
          origin: "confirmed",
          source,
        });
      }
      if (ir.nextStatement) {
        fields.push({
          label: "新的表述",
          value: ir.nextStatement,
          origin: "confirmed",
          source,
        });
      }
      if (ir.revisionNote) {
        fields.push({
          label: "改了什么",
          value: ir.revisionNote,
          origin: "confirmed",
          source,
        });
      }
      (ir.arms ?? []).forEach((armText) => {
        fields.push({
          label: "重开条件",
          value: armText,
          origin: "confirmed",
          source,
        });
      });
      if (kind === "mission") {
        fields.push({
          label: "承接",
          value: issue.assigneeName ?? driName,
          origin: "confirmed",
          source,
        });
        fields.push({
          label: "期限",
          value: "30 天内交付 v0.1",
          origin: "drafted",
        });
        fields.push({
          label: "成功证据",
          value: "可核对的交付物 + 一次评审通过；未通过则本条自动重开。",
          origin: "drafted",
        });
      }
      if (kind === "decision") {
        fields.push({
          label: "不选什么",
          value: "不扩编、不改赛马节奏 —— 取舍只发生在既有资源之内。",
          origin: "drafted",
        });
      }

      const writeBack: WriteBackTarget[] = [];
      if (kind === "writeback" && ir.revisesJudgmentId) {
        const j = store.judgments.find((x) => x.id === ir.revisesJudgmentId);
        writeBack.push({
          kind: "judgment",
          label: `判断 ${ir.revisesJudgmentId} → v${(j?.version ?? 1) + 1}`,
          href: `/judgments/${ir.revisesJudgmentId}`,
        });
      }
      if (kind === "mission") {
        writeBack.push({ kind: "evidence", label: `派发 · ${ir.text}` });
      }
      if (kind === "decision") {
        writeBack.push({
          kind: "decision",
          label: `决策档案 · ${issue.id}`,
          href: "/decisions",
        });
      }
      (ir.arms ?? []).forEach((armText) =>
        writeBack.push({ kind: "trigger", label: `布控 · ${armText}` }),
      );

      items.push({
        id: ir.id,
        kind,
        issueRef: issue.id,
        issueTitle: issue.title,
        title: ir.text,
        fields,
        ...(ir.boundaryNote ? { boundary: ir.boundaryNote } : {}),
        writeBack,
        excluded: false,
      });
    }

    /*
     * 会前那份一页纸里**属于「事实不足」的分歧**，散会时一律变成任务。
     *
     * 这里以前是「未决」区。取消了：战略会只定方向 —— 答不了的那几条，答案不在屋里，
     * 所以它们从来不是「悬而未决」，而是**要派下去查的活**。摆成未决，等于允许一件事
     * 既没人接也没期限地留在单子上；摆成任务，它就有承接人和取证计划。
     */
    const brief = store.briefs[issue.id];
    (brief?.divergences ?? [])
      .filter((d) => d.kind === "fact")
      .forEach((d, i) => {
        items.push({
          id: `${issue.id}-open-${i + 1}`,
          kind: "mission",
          issueRef: issue.id,
          issueTitle: issue.title,
          title: d.text,
          fields: [
            {
              label: "定性",
              value: "事实不足 —— 可查证，不是价值取舍",
              origin: "confirmed",
            },
            { label: "为什么今天答不了", value: d.note, origin: "confirmed" },
            {
              label: "承接",
              value: issue.assigneeName ?? driName,
              origin: "confirmed",
            },
            {
              label: "取证计划",
              value: `${driName} 布控取证，证据返回即自动重开本议题`,
              origin: "drafted",
            },
          ],
          writeBack: [{ kind: "trigger", label: `布控 · ${d.text}` }],
          excluded: false,
        });
      });
  }

  return {
    meetingId: meeting.id,
    seq: meeting.seq,
    domainId: meeting.domainId,
    domainName: domain ? `${domain.code} ${domain.name}` : meeting.domainId,
    endedAt: at,
    minutesSince: 0,
    attendees: [viewer().name, driName],
    items,
  };
};

const recordChange = (change: JudgmentChange) => {
  store.changes.push(change);
  return change;
};

/**
 * 一个议题定下来之后，它不再动摇任何判断。留一个已决议题挂在 `shakenBy` 里，
 * 屏幕上就会出现「正在动摇它的议题」指向一件早就定完的事。
 *
 * 摘掉之后，standing === "shaking" 且 shakenBy.length === 0 → 回落到 unverified。
 * 理由：提级只从 unverified 出发（linkIssueToJudgments 里的闸），所以 shaking
 * 这个状态的来路只有一条，回落到来处是唯一说得通的对称。
 *
 * 另两处移除点（confirmCandidate、signClosure）不进这个函数 —— 那两处在 filter
 * 之前显式把 standing 设成了 "confirmed"（决策/战略会把这条判断直接改成在版口径），
 * 所以下面的 === "shaking" 闸本来就不会在那里开。把它们合并进来就等于让一次重构
 * 去碰公司口径的写路径，收益是零。
 */
const clearShakenBy = (issueId: string) => {
  store.judgments.forEach((j) => {
    j.shakenBy = j.shakenBy.filter((x) => x !== issueId);
    // 双闸：最后一个晃它的议题摘掉，且状态是 shaking → 回落到 unverified
    if (j.standing === "shaking" && j.shakenBy.length === 0) {
      j.standing = "unverified";
    }
  });
};

// ---------------------------------------------------------------------------
// 自动深研（议题级）
//
// 与追加调查（IR 级）同一套做法：任务存在模块级 map，**进度按真实时钟算**，视图只问
// 不计时。区别是这一层有交付物 —— 跑完要把报告装上去，议题才真的可以进。
//
// 只有 seed 里预备了报告的议题才带预估时间。本次会话里新立的议题（三键处置的自动深研、
// 从想法升级来的议题）没有交付物，屏幕上就只说「在跑」，不给一个走到 100% 之后什么也
// 不会发生的进度条。
// ---------------------------------------------------------------------------

const issueJobs: Record<string, { startedAtMs: number; etaSeconds: number }> =
  {};

Object.entries(seed.runningResearch).forEach(([id, job]) => {
  issueJobs[id] = {
    startedAtMs: Date.now() - job.elapsedAtLoad * 1000,
    etaSeconds: job.etaSeconds,
  };
});

/*
 * demo 内容包里那几件「在办」的议题：自动深研都开着。
 *
 * 它们没有预备好的报告，所以不给预估 —— 屏幕上只写「进行中」。给一条会走到 100%
 * 然后什么也不发生的进度条，比不给更糟：一号位会一直等它。
 */
if (DEMO) {
  Object.entries(dm.runningResearch).forEach(([id, job]) => {
    issueJobs[id] = {
      startedAtMs: Date.now() - job.elapsedAtLoad * 1000,
      etaSeconds: job.etaSeconds,
    };
  });
}

/** 本次会话里新开的一轮深研。没有预备报告，所以不给预估。 */
const openResearch = (issueId: string) => {
  if (!issueJobs[issueId])
    issueJobs[issueId] = { startedAtMs: Date.now(), etaSeconds: 0 };
};

/**
 * 把一条确认为同一件事的信号挂到既有那张卡上，并让下一轮预研出增量卡。
 *
 * **不新建议题、不新建卡** —— 这正是防卡片疲劳那一条：同一事件五天的信号流
 * 只该留下一张卡加若干次增量。挪走 `preResearch[issueId]` 是为了让
 * `ensurePreResearch` 能再跑一轮；挪之前把 `stages` 存到 `preResearchPrev`，
 * 那一份是增量卡要拿来比的东西。
 *
 * **这一轮生产上没有任何地方调它。** 入库那一处只做标注（`noteMaybeSameIssue`），
 * 因为「这两条是同一件事」这个判定要他按一下才成立；按下去的那个入口还没有。
 * 放在这里是为了把库这一侧的形状先钉住：挂哪几句、上一轮的产物挪到哪一格、
 * 时间线上留什么，都由测试锁着，等那个入口做出来时不用重新想一遍。
 * **不要因为它暂时没有调用方就把它删掉，也不要为了给它凑一个调用方而在入库处自动合卡。**
 */
export function attachSignalToCard(
  issueId: string,
  o: { delta: string[]; signalId: string },
): void {
  const card = store.cards.find((c) => c.issueId === issueId);
  if (!card || o.delta.length === 0) return;

  const at = nowIso();
  for (const text of o.delta) {
    card.what.push({ text, traces: [{ kind: "ext", source: o.signalId }] });
  }

  const prev = store.preResearch[issueId];
  if (prev?.stages) store.preResearchPrev[issueId] = prev.stages;
  delete store.preResearch[issueId];

  pushEvent(issueId, {
    id: `E-${issueId}-attach-${at}`,
    kind: "deep",
    at,
    headline: `同一件事又来了一条，多了 ${o.delta.length} 句`,
    actor: "您的 Agent",
    detail: o.delta.join("\n"),
    /*
     * `defaultOpen` 是**必填**的。按那个字段自己的口径：这一条是过程性内容 ——
     * 材料多了几句，没有任何决定发生 —— 所以折叠。
     */
    defaultOpen: false,
  });
  persistSoon();
}

/**
 * 这条刚入库的信号，可能和哪条既有议题说的是同一件事。
 *
 * 为什么算在 store 这一侧：要比的是 `store.issues` 的标题和卡上的原文，而那是库里的东西。
 * 为什么不让模型自填一个议题号：那要改 A1a 的提示词，而 A1a 的写回本身还挂着
 * `NotWiredYet` —— 提示词定稿是他的事。
 *
 * 机械判，不调模型：二元组重叠取最高分，**过阈值才算**。一条都不过就返回 null，
 * 那时候卡上那一格不写 —— 编一个「可能是同一件事」比不写更贵，他会去点开看，
 * 然后发现两件事没关系。
 *
 * 阈值不在这里定：取到最高分那一条之后交给 `declareDelta`，判成 `"separate"` 就是没有。
 * 这样阈值只有 `delta.ts` 里那一个数（`SEPARATE_MAX`），不会出现两处口径各调一次。
 *
 * **它不合卡、不撤卡、不改那条既有议题的任何字段**，只在新建的那张卡上标一格、
 * 在时间线上留一条。真正的合卡要他按一下，那是另一个入口，今天还没有。
 */
export function noteMaybeSameIssue(
  newIssueId: string,
  incoming: string,
): { issueId: string; delta: string[] } | null {
  const text = incoming.trim();
  if (!text) return null;

  let best: { issueId: string; existing: string; overlap: number } | null =
    null;
  for (const issue of store.issues) {
    if (issue.id === newIssueId) continue;
    const card = store.cards.find((c) => c.issueId === issue.id);
    // 比的是「标题 + 卡上原文」——单比标题会把同一事件的两条报道判成两件事
    // （标题各写各的），单比原文会漏掉卡上还没有原文的那些议题。
    const existing = [
      issue.title,
      ...(card?.what ?? []).map((w) => w.text),
    ].join("\n");
    const overlap = bigramOverlap(text, existing);
    if (!best || overlap > best.overlap)
      best = { issueId: issue.id, existing, overlap };
  }
  if (!best) return null;

  const d = declareDelta({ incoming: text, existing: best.existing });
  if (d.verdict === "separate") return null;

  const card = store.cards.find((c) => c.issueId === newIssueId);
  if (!card) return null;
  const out = { issueId: best.issueId, delta: d.delta };
  card.maybeSameIssue = out;

  const at = nowIso();
  pushEvent(newIssueId, {
    id: `E-${newIssueId}-same-${at}`,
    kind: "deep",
    at,
    // 措辞就是屏幕上那一句：**「可能是同一件事」，不是「已并入」**。
    headline: `这条和 ${best.issueId} 说的可能是同一件事`,
    actor: "您的 Agent",
    detail:
      d.delta.length > 0
        ? `相对那一条，这次多了：\n${d.delta.join("\n")}`
        : "相对那一条，这次一句新的都没有（纯转载）。",
    // 过程性内容，没有决定发生 —— 折叠（同 `attachSignalToCard` 那条）。
    defaultOpen: false,
  });
  persistSoon();
  return out;
}

/**
 * 保证这件议题有一份预研 —— 没有就现在起一轮 A3。
 *
 * ## 为什么不等他点进那张卡
 *
 * 原来这一轮是他点开潜在议题详情页时才起的（视图里一个 `useEffect`）。于是那一到两
 * 分钟整段落在他眼前：屏幕上写着「预研正在跑」，而他此刻要的恰恰是读完它再按三键。
 * 议题一被建出来就起，这段时间花在他还没看这张卡的时候 —— 这也是 `getSignal` 那段
 * 注释里一直写着的话（「他点进来时它已经在那儿了」），现在代码才真的这样。
 *
 * 预研是这条链上最便宜、也是**唯一自动全量跑**的一档（深研进了才跑，见
 * `ensureDeepResearch`）。成本要跟着注意力走，但预研便宜到不必等注意力。
 *
 * ## 立刻返回，不等
 *
 * 一轮预研一到两分钟（模型 60s 起，质量门打回还要再跑一轮）。同一个议题正在跑就直接
 * 返回 running，不排队 —— 前端是轮询的，排队会把一次误触变成十次真实的模型调用。
 */
const ensurePreResearch = (issueId: string): TaskState => {
  if (store.preResearch[issueId]) return { status: "done" };
  /*
   * Demo 模式**永远不叫模型**（同 `ensureDeepResearch`）。包里备了预研的卡，上面那
   * 一行已经返回；没备的就照实空着，而不是当场起一轮两分钟的真实调用。
   */
  if (DEMO) return { status: "idle" };
  const cur = taskState("preresearch", issueId);
  /*
   * 失败过就不自动重开。这一条原来没有，而这个入口是**被每五秒轮询一次**的：
   * 模型接不上的那一次于是变成每五秒一轮真实调用，而屏幕上什么都不显示。
   */
  if (cur.status === "failed") return cur;
  const issue = store.issues.find((i) => i.id === issueId);
  if (!issue) return { status: "idle" };

  return runTask("preresearch", issueId, async () => {
    // 开跑就记一条（同深研那处，理由见 `agentRunOpen`）。`input` 与 A3 收尾时那条一致。
    const openId = agentRunOpen({ agent: "A3", input: issue.title });
    const judgments = issue.judgmentRefs
      .map((id) => store.judgments.find((j) => j.id === id))
      .filter((j): j is Judgment => Boolean(j))
      .map((j) => ({ id: j.id, statement: j.statement, standing: j.standing }));

    /*
     * 卡上那段原文就是这一轮手上的材料。
     *
     * 在这之前，预研只拿到一个标题 —— 而他贴进来的那一整篇文章就躺在同一张卡上，
     * 参谋看不见。于是它只能凭一行标题去写「查到了什么」，而那正是它最容易开始编的
     * 时候。
     *
     * **不分来路**：雷达抓的和 DRI 上报的那两张卡上的原文，同样递进去。分来路要多一个
     * `if`，而那个 `if` 换来的是同一份材料在三条路上待遇不同 —— 同一段字，他自己贴的
     * 参谋读得到，DRI 递上来的读不到，没有一个说得通的理由。
     */
    const card = store.cards.find((c) => c.issueId === issueId);
    const material = (card?.what ?? [])
      .map((w) => w.text)
      .join("\n\n")
      .trim();

    let r: Awaited<ReturnType<typeof runPreResearch>>;
    try {
      r = await runPreResearch(
        {
          issueId,
          title: issue.title,
          /*
           * 和深研那一处取同一个值（见下面 `runDeepResearch` 那句）。
           *
           * 原来这里硬写 `null`，于是 `a3/prompt.ts` 里那句「范围与背景：」在生产上是条
           * 死分支 —— 而**预研比深研更需要它**：预研要答的是「这件事值不值得他现在花半天
           * 想清楚」，而值不值得，取决于我们为什么在看它。只有标题没有范围时，它只能对着
           * 一个名词写一份综述。
           *
           * 三档回落照抄深研那一行，一个字不改：两处取的必须是同一个值，分家的话同一件
           * 议题在预研和深研里的边界会不一样，而屏幕上看不出是哪一层收窄的。
           */
          scope:
            store.issueScopes[issueId] ??
            dm.issueScopes[issueId] ??
            tk.issueScopes[issueId] ??
            null,
          // 只给前面这一段。预研是轻量档，全文塞进去既超预算，也会诱使它写成综述 ——
          // 没读完的部分归 openQuestion，和内部文档那一支同一个口径。
          material: material.slice(0, MATERIAL_FOR_PRE_RESEARCH) || null,
          materialTruncated: material.length > MATERIAL_FOR_PRE_RESEARCH,
          judgments,
          /*
           * 靶点库、监测中的那几条、上一轮的各段产物 —— 这三格就是预研 v2 在生产上
           * 打开的那一下：`targets` 给了才走七段，不给还是原来那两段。
           */
          targets: buildTargetIndex(),
          watched: sensorTargets().map((t) => t.text),
          // 读的是搬开的那一份，不是 `store.preResearch[issueId]?.stages` —— 后者在这一行
          // 恒为 `undefined`（函数第一句已经把「这一份在」的那一档 return 掉了），
          // 写成那样等于留一个永不成立的三元。理由与谁来填这一格见那个字段上的注释。
          ...(store.preResearchPrev[issueId]
            ? { prevStages: store.preResearchPrev[issueId] }
            : {}),
        },
        {
          /*
           * 让 A3 一步一步往任务表上报。**kind/id 必须和上面那句 `runTask` 一模一样** ——
           * 所以这两个字符串写在这里，紧挨着开任务的那一行，而不是塞进 a3/run.ts 里另存
           * 一份。写成两份的话，改名时只会改到一处，而上报会静默落在一个不存在的任务上。
           */
          progress: { kind: "preresearch", id: issueId },
        },
      );
    } catch (e) {
      // 就地失败要把开跑那条换成失败的那条，然后原样再抛 —— 这次预研**没有**跑成，
      // 不落报告、不发「预研完成」。运营台上数得到这次失败才答得出「今天有
      // 几次运行因为图服务挂了没跑成」。链路没收尾的那一类只递一句原话（见 `agentRunSettle`）。
      agentRunSettle(
        openId,
        e instanceof AgentRunFailed
          ? e.run
          : { error: e instanceof Error ? e.message : String(e) },
      );
      throw e;
    }

    /*
     * 时间戳归这个 store 盖（日期锁 + 单调闸），agent 模块拿不到这两样。
     * A3 原来自己盖时间戳，导致它成了全表唯一一个 Z 格式、而且日期是前一天
     * —— 字符串排序会把它们甩到表尾。
     */
    const at = nowIso();
    /*
     * 用时取 harness 自己那块表（`AgentRunRecord.latencyMs`，`t0` → 收尾），**不用
     * `at` 减任务的 startedAt**：后者把队列里的等待、`ensurePreResearch` 前面那几句
     * 同步活儿也算进去，而屏幕上写的是「参谋查了多久」。同一件事两个数字，屏幕和
     * 运营台会对不上。
     */
    store.preResearch[issueId] = { ...r.doc, at, durationMs: r.run.latencyMs };
    /*
     * 收进表的是**提案**（`status: "proposed"`）。这里一条都不布控：
     * 转 active 只发生在他按下待定那一下（`disposeCard` 的 watch 分支），
     * 而 `ReopenTrigger.armed` 仍然只由 `confirmCandidate` / `confirmClosure` /
     * `signClosure` 三处写。
     */
    const proposed = r.doc.stages?.disposition.trigger;
    if (proposed && !store.triggers.some((t) => t.id === proposed.id)) {
      store.triggers.push(proposed);
    }
    agentRunSettle(openId, r.run);
    const p0 = r.violations.filter((v) => v.severity === "p0").length;
    /*
     * 台账标题跟着定性结论走。三档共用一个「预研完成」的后果是：判掉的和成立的
     * 在时间线上长得一模一样，而这条时间线正是他事后回看「这件事当时怎么处理的」
     * 的地方 —— 那一刻最要紧的信息恰好是参谋当时判了哪一档。
     */
    const headline =
      r.doc.status === "invalid"
        ? "预研完成 · 判为不值得继续"
        : r.doc.status === "reframing_needed"
          ? "预研完成 · 这条议题的说法要先改"
          : "预研完成";
    const how = p0
      ? `走完 ${r.attempts} 轮仍有 ${p0} 条质量门没过 —— 内容照常给您，问题记在运营台。`
      : r.run.contextMode === "external_only"
        ? `图谱里还没有这条议题，本轮只用了外部材料，${r.attempts} 轮成文，质量门全过。`
        : `装配公司上下文后 ${r.attempts} 轮成文，质量门全过。`;
    const reason = r.doc.statusReason.trim();
    pushEvent(issueId, {
      id: `E-${issueId}-pre`,
      kind: "deep",
      at,
      headline,
      actor: "您的 Agent",
      detail: reason ? `${reason}\n\n${how}` : how,
      // 判掉或要求改题的，默认展开 —— 它要一号位看一眼，不该藏在折叠里。
      defaultOpen:
        r.doc.status === "invalid" || r.doc.status === "reframing_needed",
    });
    if (p0) {
      // 不静默丢弃：产物照样落盘，但要能被看见。质量门反复不过说明 prompt
      // 或规则有问题，不是模型今天状态差。
      console.warn(
        `[tkos:a3] ${issueId} 走完重试仍有 p0：`,
        r.violations.map((v) => v.rule).join(","),
      );
    }
    // 落盘。原来这一步没有：一轮花了钱跑出来的预研，进程重启之后凭空消失，
    // 而下次读这张卡又会重新起一轮（深研那一支一直是落的，见 `ensureDeepResearch`）。
    persistSoon();
    return { attempts: r.attempts };
  });
};

/**
 * 一轮深研开跑：库里立一条「这一轮在跑」（见 `UnfinishedResearchRound`）。
 *
 * 连**跑它的那张任务表是哪一份**一起盖上（`runner`）。这一栏是那道「不自动重开」的闩
 * 真正拴住的地方：没有它，「在跑」这句话只对开跑那一份进程内的表成立，而下一份表读到
 * 同一条记录时会当成「没人跑过」（见 `TASK_TABLE_ID`）。
 */
const openResearchRound = (issueId: string): void => {
  store.unfinishedResearch[issueId] = {
    startedAt: nowIso(),
    runner: TASK_TABLE_ID,
    reports: [],
  };
  persistSoon();
};

/**
 * 一条链路写完了：把那一份原件**当场落盘**（见 `UnfinishedResearchRound`）。
 *
 * 由任务表那一侧叫（`onTaskReports`），也就是每次页签行的样子变一下就来一趟。原来这几份
 * 只活在任务表上，而那张表在进程里 —— `next dev` 改一个服务端文件就重编译一次，表随之
 * 清空，一份跑了十几分钟的报告凭空消失（2026-08-26 的 ISS-110）。
 *
 * 只落**有正文**的那几份：还在跑的那几栏是占位（步号、秒表、半份区块），它们的意义全在
 * 「此刻」上，落盘之后只会变成一排永远打不开的页签。
 *
 * 没有新写完的就不落盘：落一次是把整个 store 序列化重写一遍，而这个函数一轮要被叫几十次
 * （每条链路每走一步都报一遍）。按「哪几栏有多长的正文」比 —— 长度变了就是同一栏被重写过
 * （出口校验打回重修那一轮），那一份也要更新。
 */
const keepFinishedReport = (issueId: string, reports: DraftReport[]): void => {
  const round = store.unfinishedResearch[issueId];
  // 收场过的那一条不再动：这一刻上报的是别的什么（慢一步的收尾），而那一轮的账已经封了。
  if (!round || round.error) return;
  const done = reports.filter((d): d is DraftReport => Boolean(d.text?.trim()));
  const sign = (list: DraftReport[]) =>
    list.map((d) => `${d.key}:${d.text?.length ?? 0}`).join("|");
  if (sign(done) === sign(round.reports)) return;
  round.reports = clone(done);
  persistSoon();
};

/*
 * 挂上旁听席（`onTaskReports`）：一条链路写完就落一次盘。
 *
 * 挂在模块求值期，不是在起那一轮的时候挂 —— 那一轮是被轮询叫起来的，而轮询走的是
 * `/api/data`，也就是这个模块；模块在，席位就在。只认深研那一类：预研那一支不报原件。
 */
onTaskReports((kind, id, reports) => {
  if (kind === "deep") keepFinishedReport(id, reports);
});

/**
 * 一轮深研收场了，而且没跑成：把**已经写完的那几份报告原件**连着那句原话留下来。
 *
 * 原件优先取任务表上那几份进度稿（`TaskState.reports`，跑的时候页签行读的就是它）——
 * 趁这一刻取：任务翻成 `failed` 时那张表会连着进度稿一起重建，那之后就取不到了。取不到
 * 就用库里边跑边落的那几份（`keepFinishedReport`）。
 *
 * **一份都没写成时也要写这条记录**：它同时是那道「不自动重试」的闩（见
 * `deepRoundState`），而任务表上那道闩跟着进程走。报告页不会因此多出空页签 ——
 * 摆栏只认有正文的那几份。
 */
const closeResearchRound = (issueId: string, e: unknown): void => {
  const live = (taskState("deep", issueId).reports ?? []).filter(
    (d): d is DraftReport => Boolean(d.text?.trim()),
  );
  const round = store.unfinishedResearch[issueId];
  const reports = live.length ? clone(live) : (round?.reports ?? []);
  store.unfinishedResearch[issueId] = {
    startedAt: round?.startedAt ?? nowIso(),
    at: nowIso(),
    error: e instanceof Error ? e.message : String(e),
    reports,
  };
  console.warn(
    `[tkos:a4] ${issueId} 那一轮没跑完，留下 ${reports.length} 份报告原件。`,
  );
  persistSoon();
};

/**
 * 深研那一轮此刻的状态。**两道闩合成一句话给屏幕。**
 *
 * 任务表那份是主：在跑、跑完、挂了，都以它为准。它只答不出一件事 —— 进程重启之后它是空的，
 * 而空在屏幕上说的是「这件议题还没有深研，也没有一轮在跑」。库里那条没跑成的记录补的就是
 * 这一句（`UnfinishedResearchRound`）：那一轮真的收场了、真的没跑成，而且**不许自动重开**。
 */
const deepRoundState = (issueId: string): TaskState => {
  const cur = taskState("deep", issueId);
  /*
   * 任务表说这一轮**跑完了**，而这一份库里没有报告 —— 两句话同时成立时，跑完它的那一份
   * 库不是这一份：热重载可以只换掉库、留着任务表（`TASK_TABLE_ID` 上那段讲的是反过来的
   * 另一半）。那份报告写进了被换掉的那个对象，这一份够不着它。
   *
   * 不能把这个 `done` 原样递上去：`ensureDeepResearch` 只拦 `failed`，`done` 会一路走到
   * `runTask`，而任务表里那条已经不是 `running` 了 —— 于是它**在上一轮刚跑完那一刻又起
   * 一轮真花钱的深研**。2026-09-01 的 ISS-222 就是这么跑了两轮。
   *
   * 库钉住之后（见上面 `store` 那一段）这条路正常情况下走不到了，但它不是多余的：种子
   * 一改，钉子按指纹作废，这一份库又是新的一份，而任务表照旧是留着的那一份。**这是这
   * 条路上最后一道闩，而它守的是钱。**
   */
  if (cur.status === "done" && !store.researchDocs[issueId]) {
    return {
      ...cur,
      status: "failed",
      error:
        "上一轮深研跑完了，但报告没落到这一份库里 —— 改代码触发的热重载（服务重启同理）" +
        "把库换掉了，那一份写进了被换掉的那一份。不自动重开：再跑一轮是十几分钟和一轮真实" +
        "开销，要不要跑由你按。",
    };
  }
  if (cur.status !== "idle") return cur;
  const round = store.unfinishedResearch[issueId];
  if (!round) return cur;
  /*
   * 记录上写着「在跑」（没有收场原话），而这一份任务表里查不到它 —— 这两句同时成立时，
   * **跑它的那张表不是这一份**：`next dev` 一次重编译可以只换掉那张表、留着这份库
   * （见 `TASK_TABLE_ID`）。那一轮后来怎么样了这一份答不出来，所以就地把它收场，并且
   * 把这句话**写进库**：不写的话下一次轮询读到的还是「在跑」，而闩只认 `error`。
   *
   * 这是这条 `ensureDeepResearch` 自动重开的路上唯一的闩。2026-08-27 的 ISS-112 就是从
   * 这个缺口漏出去的：每次改代码重编译一次，就多起一轮真花钱的深研，一轮接一轮停不下来。
   *
   * 只在真收场一条的时候写盘。台账上那条运行记录**不在这里动**：它可能真的还在跑（换掉的
   * 是任务表，不是那个 `await`），而把一条正在跑的记录标成「被中断」是编的。进程真的没了
   * 那一次由恢复那一段的 `markInterruptedRuns` 兜。
   */
  if (!round.error) {
    round.at = nowIso();
    round.error =
      "上一轮深研没跑完 —— 改代码触发的热重载把跑它的那张任务表换掉了（服务重启同理），" +
      "所以这一份进程答不出它后来怎么样了。已经写完的那几份原件照旧能读。";
    console.warn(
      `[tkos:a4] ${issueId} 那一轮的任务表不是这一份（记录上是 ${round.runner ?? "旧快照，没盖身份"}，` +
        `这一份是 ${TASK_TABLE_ID}），按没跑完收场，不自动重开。`,
    );
    persistSoon();
  }
  return {
    status: "failed",
    startedAt: round.startedAt,
    ...(round.at ? { finishedAt: round.at } : {}),
    error: round.error,
  };
};

/**
 * 「他明确要求再来一轮」—— 把上一轮的东西清掉、把两道闩都打开、开一轮。
 *
 * 一个函数而不是两处各写一遍：入口有两个（手动重开、打回重研），而它们要清的东西
 * 已经是四样了。漏一样的样子不是报错 —— 2026-08-26 这一版加了库里那道闩之后，打回重研
 * 那条路只解了任务表那道，于是屏幕上写着「已打回」，而第二轮**一次也没起来**，卡上照旧
 * 是上一轮那句没跑成。
 *
 * 两道闩说清楚：`failed` 是**故意**不自动重开的（重试烧钱，而且会把失败藏起来），所以
 * 「再来一次」这个动作必须是唯一能解闩的地方。任务表那道跟着进程走（`clearTask`），
 * 库里那道跟着议题走（`deepRoundState` 读的就是它）。
 */
const reopenDeepResearch = (issueId: string): TaskState => {
  delete store.researchDocs[issueId];
  /*
   * 上一轮没跑完留下的那几份原件也一起清掉（`UnfinishedResearchRound`）。他明确要求再来
   * 一轮，那几份就是过去的东西了 —— 留着的话，这一轮万一在第一步就挂（一份原件都没
   * 写出来），报告页会摆出上一轮的原文和上一轮那句失败原话，而屏幕上没有任何地方
   * 说得清那是哪一轮。这一轮的几栏很快就报上来（链路一起跑就占位）。
   */
  delete store.unfinishedResearch[issueId];
  clearTask("deep", issueId);
  /*
   * `judge` 也要解 —— 2026-08-19 实跑撞到过：报告落库了，A5 那一轮因为 max_tokens 就地
   * 失败。这个议题从此挂着一份读不成判断的报告，重跑深研也没用，因为报告到位后级联去叫的
   * `ensureJudgements` 看到 `failed` 就返回。
   */
  clearTask("judge", issueId);
  return ensureDeepResearch(issueId);
};

/**
 * 保证这件议题有一份深研报告 —— 没有就现在开一轮 A4。
 *
 * 每次读议题之前叫一下：没有后台 worker，这就是那个 worker。
 *
 * ## 为什么是「按议题触发」，不是「全量后台跑」
 *
 * 上一版这里遍历所有有 job 的议题，把预置好的报告到点摆出来。真接上模型之后
 * 那个形状就不能要了：九个议题一起跑深研，是九次几分钟的模型调用，而一号位
 * 这一刻只在看其中一个。**成本要跟着注意力走**，这也是预研（自动全量、便宜）
 * 和深研（进了才跑、贵）分成两档的原因。
 *
 * ## 立刻返回，不等
 *
 * 深研带本体上下文要一到三分钟。挂在请求上等于让屏幕卡死。所以这里只负责
 * 「确保它在跑」，前端拿 `deepResearchStatus` 轮询。同一个议题正在跑就直接返回，
 * 不排队 —— 轮询触发重复调用是常态，排队会把一次点击变成十次真实的模型调用。
 */
const ensureDeepResearch = (issueId: string): TaskState => {
  if (store.researchDocs[issueId]) return { status: "done" };
  /*
   * Demo 模式**永远不叫模型**。
   *
   * 内容包里有报告的议题，上面那一行已经返回了；没有的，屏幕就该照实说「没有报告」，
   * 而不是当场起一轮两三分钟的深研。演示当中最贵的东西是那两分钟：一号位盯着一个
   * 转圈，而屏幕答不出它什么时候会停。
   */
  if (DEMO) return { status: "idle" };
  /*
   * 失败过就不自动重开：模型接不上时反复重试只会烧钱，并把失败藏起来。
   * 他要重试，走「打回重研」——那是一个明确的动作。
   *
   * 判的是 `deepRoundState` 而不是任务表：那张表在进程里，而这条口径不许跟着进程走 ——
   * 一次热重载之后任务表是空的，照它判等于「没人跑过，起一轮吧」（ISS-110 就是这么被
   * 自动重开的，见恢复那一段）。
   */
  const cur = deepRoundState(issueId);
  if (cur.status === "failed") return cur;

  const issue = store.issues.find((i) => i.id === issueId);
  if (!issue) return { status: "idle" };
  openResearch(issueId);

  /*
   * **深研是唯一一条排队的**（`lane: "deep"`，上限 `TKOS_DEEP_CONCURRENCY`，默认 1）。
   *
   * 依据是一次实测：ISS-236 与 237 相隔 85 秒起跑，取证从单跑的 5 分 43 秒各自拖到 13 分钟
   * —— 两轮抢的是同一批出口的同一份限额，而屏幕上两个都在转圈、都变慢，看不出为什么。排起来
   * 之后两轮的总时长几乎不变，但第二轮能说出「前面还有几轮」。
   *
   * 别的几条（预研、A5、对谈、写回）**不排**：它们要么几十秒，要么就是他此刻正在等的那一句
   * 话 —— 排在一轮十五分钟的深研后面等于把那句话冻住十五分钟。
   */
  return runTask("deep", issueId, async () => {
    // 库里立一条「这一轮在跑」。摆在任务体的第一行：`runTask` 只在真起了一轮时叫它，
    // 而外面那一句被轮询叫得很密（起过一轮就直接返回 running）。
    openResearchRound(issueId);
    // 运营台上也立一条。`input` 跟 A4 收尾时那条一样填标题（见 `a4/run.ts` 的 `finish`）——
    // 两条在台账上要看得出是同一轮。
    const openId = agentRunOpen({ agent: "A4", input: issue.title });
    const judgments = issue.judgmentRefs
      .map((id) => store.judgments.find((j) => j.id === id))
      .filter((j): j is Judgment => Boolean(j))
      .map((j) => ({ id: j.id, statement: j.statement, standing: j.standing }));
    const pre = store.preResearch[issueId] ?? null;

    let r: Awaited<ReturnType<typeof runDeepResearch>>;
    try {
      r = await runDeepResearch(
        {
          issueId,
          title: issue.title,
          // 运行时立起来的那一档优先：他粘进来的原文就是这件议题的范围（见 `store.issueScopes`）。
          scope:
            store.issueScopes[issueId] ??
            dm.issueScopes[issueId] ??
            tk.issueScopes[issueId] ??
            null,
          preTake: pre?.take ?? null,
          preOpenQuestions: (pre?.openQuestion ?? []).map((q) => q.text),
          // 一号位给定的前提，从预研那一轮原样带过去（ISS-239）。老预研没有这一栏就是空表。
          userPremises: pre?.premises ?? [],
          judgments,
        },
        {
          // kind/id 必须和上面那句 `runTask("deep", issueId, …)` 一模一样。理由同预研那处。
          progress: { kind: "deep", id: issueId },
        },
      );
    } catch (e) {
      /*
       * 把开跑那条换成失败的那条，再原样抛。不写四节、不上板、不推事件。
       *
       * 抛出来的不是 `AgentRunFailed` 时（压四节那一步被 `max_tokens` 截断就是这一种）
       * 手上没有记录，所以只递一句原话过去 —— 原来那一版只认 `AgentRunFailed`，于是
       * 这一类失败在台账上一条不留（见 `agentRunSettle`）。
       */
      agentRunSettle(
        openId,
        e instanceof AgentRunFailed
          ? e.run
          : { error: e instanceof Error ? e.message : String(e) },
      );
      // 但跑成了的那几份原件留下来 —— 一轮没跑完不等于那几份没写出来。
      closeResearchRound(issueId, e);
      throw e;
    }

    const at = nowIso();
    // 时间戳和用时的口径同预研那处（`ensurePreResearch`）：时刻由 store 盖，用时取
    // harness 自己那块表。这份文档在这之前一个时间戳都没有 —— 报告页答不出它有多新。
    store.researchDocs[issueId] = { ...r.doc, at, durationMs: r.run.latencyMs };
    /*
     * 上一轮没跑完留下的那几份原件让位给这一份。
     *
     * 不留着：这一轮的几份原件已经在这份文档里（主源在 `sourceText`、其余在 `altReports`），
     * 留着等于同一排页签上摆着两轮的报告 —— 而两轮的页签 key 是同一套（`agent` /
     * `agent:alt<n>`），屏幕上表现成同一栏的正文在两份之间跳。
     */
    delete store.unfinishedResearch[issueId];
    agentRunSettle(openId, r.run);

    /*
     * 报告到了，把这件议题往前推一档 —— **但只推已经在办的那几档**。
     *
     * 原来这一句是无条件的，于是一轮深研跑完就能把任何一件议题写成 `Exploring`。
     * 实测撞出来的那一次：一张还在提请台上的潜在议题（`Candidate`），只因为有人开过它
     * 那一页（`getResearchDoc` 会顺手起一轮，见 `disposeCard` 上那段注释），报告一到就
     * 自己升成了战略议题 —— **他一次「采信」都没按**。屏幕上的表现是同一件事同时挂在
     * 左上角那扇窗和中间那一栏里，而首页那一屏的整个排布靠的正是「四种样子各占一个位置，
     * 同一件事不在两处出现」。
     *
     * 采信是那道门，而且是唯一那道。所以这里拦两头：
     *
     *   `Candidate` / `Watching`  还没进门（在提请台、在待定区）—— 报告先放着，
     *                             他按下采信那一刻自然会走到 `Exploring`。
     *   `settled` 的那几档        已经出门了（定完、在观察、已关闭）—— 推回 `Exploring`
     *                             等于把一件已部署的事拽回在办清单，而拽它的是一轮
     *                             他可能根本没看见的后台任务。
     *
     * 报告本身照常留在 `store.researchDocs` 上：一份写出来的东西不因为议题在哪一档而作废，
     * 他采信之后进去就能看见。
     */
    const beforeTheDoor =
      issue.state === "Candidate" || issue.state === "Watching";
    const advances = !beforeTheDoor && !SETTLED_STATES.has(issue.state);
    if (advances) {
      issue.state = "Exploring";
      issue.nextActionForUser = "深研报告已就绪";
      // 「深度研究进行中」是采信那一下写上的（见 `disposeCard`）。报告到了它就不再是
      // 真的，而它会一直挂在首页那一栏上。
      issue.monitoringNote = undefined;
    }
    touch(issue, at);

    const p0 = r.violations.filter((v) => v.severity === "p0").length;
    /*
     * 取证那一段的账要上屏。
     *
     * 「深度研究完成」这四个字在两种运行下长得一模一样：一种真的抓了页、逐字核过引句、
     * 每个外部数字都挂着编号；另一种一个字节都没出网，外部来源全来自模型的既有知识。
     * 不写出来，他没有任何办法把这两份分开 —— 而后一种里的数字是**不能直接拿去用**的。
     *
     * 拒掉的条数也写：0 入账 + 拒掉 12 条（引句定位不上、口径缺件）和 0 入账 + 0 拒绝
     * （压根没搜到东西）是两件事，前者说明检索是通的、抽取那一层在出问题。
     */
    const ev = r.evidencing;
    /*
     * 同时用了几家时，每家各出了几条也写出来。
     *
     * 「同时参考多个来源」这句话本身不构成交叉验证 —— 两家搜到的是同一批页，那只是把
     * 同一份材料收了两遍。`unique` 就是分界：它低的那一家在这一轮里没有带来新东西，
     * 而这句话是「下一轮还留不留它」唯一的凭据。用中文台名（`label` 跟着数一起来的），
     * 不在这里维护一张代号对照表。
     */
    const per = Object.values(ev.hitsByProvider);
    const perLine =
      per.length > 1
        ? `同时用了 ${per.length} 家：` +
          per
            .map(
              (a) =>
                `${a.label}给了 ${a.returned} 条、其中 ${a.unique} 条是别家没给的`,
            )
            .join("；") +
          "。"
        : "";
    /*
     * 上面那几个数说的是**主源那一条链路**（三条各跑一套取证，「这一轮入账几条」已经不是
     * 一个数了）。三条各自的数在下面那行 —— 分开写而不是加起来，因为加起来的那个数答不出
     * 任何问题：判断板只从主源压出来，而「哪一条取回的东西少」正是要看的。
     */
    /*
     * 一条外部证据都没入账时那句声明（`a4/no-evidence.ts` 分的格）。
     *
     * 有值就改标题、并且**默认展开**。原来这条事件在两种运行下标题一模一样、明细还是折起来的
     * ——「入账 0 条」写在里面，等于要他先展开才知道有没有必要展开。
     */
    const noEv = r.doc.noExternalEvidence;
    const evidenceLine = !ev.propositions
      ? // 这一句 `noEv.why` 已经说了（没编命题必然带声明）。留着会在同一条明细里连说两遍。
        ""
      : [
          `检索走${ev.providerLabel}。判断板那一条链路编译了 ${ev.propositions} 条待查命题，`,
          `跑 ${ev.rounds.length} 轮，入账 ${ev.recorded} 条证据`,
          ev.rejected
            ? `，另有 ${ev.rejected} 条没过入账闸（引句定位不上或口径缺件）`
            : "",
          "。",
          perLine,
          ev.unresolved.length
            ? `其中 ${ev.unresolved.length} 条命题本轮没能闭合，报告的「未能核实的部分」写着差在哪。`
            : "它的命题都取到了可引用的来源。",
        ].join("");
    /*
     * 那几栏各自跑成什么样。
     *
     * 一条都不许省。某一条没跑成时，唯一的表现是报告区少一栏页签 —— 而那可能是这台机器
     * 没配那把钥匙（一直如此，没什么要做的），也可能是配了、今天那家限流（要看一眼）。
     * 两件事的下一步动作不一样，而页签的数目答不出是哪一件。
     *
     * 各自的用时也写：几条同时起跑、各自计时，屏幕上那几块表在这一轮结束之后就没了，
     * 而「哪一条慢得离谱」是下一轮要不要调它的唯一依据。
     *
     * **两种编排说的是两句不同的话，靠 `ev.lanesAreDimensions` 分**：
     *
     * - 一条链路 = 一个模型各跑一整套研究：各自写报告、各自过出口对账，判断板只认其中一份
     *   —— 所以要写清是哪一份，否则他每读一条判断都要先分辨来处。
     * - 一条 = 一批维度的取证方向（默认那条七步链）：命题和取证按方向分，但**报告只有一份、
     *   出口对账只过一遍**。这一支照上一句写就是在说这一轮做过四次独立确认，而它一次都没做。
     *   同理，判断板那句话在这里没有意义（只有一份报告），整句去掉；成稿和出口对账那两句
     *   全轮的数已经在上一行「N 轮成文，质量门…」里，逐栏再重复一遍只会读成几遍确认。
     */
    const lanes = ev.lanes;
    const byDimension = ev.lanesAreDimensions === true;
    const primaryLane = lanes.find((l) => l.primary);
    const laneWord = (l: (typeof lanes)[number]): string => {
      if (l.error) return `${l.label} 没跑成（${l.error}）`;
      const bits = [
        l.propositions
          ? `编 ${l.propositions} 条命题、跑 ${l.rounds} 轮、入账 ${l.recorded} 条`
          : "没联网",
      ];
      if (!byDimension) {
        bits.push(l.attempts > 1 ? "重写了一轮" : "一遍成文");
        bits.push(
          l.blocked ? `仍有 ${l.blocked} 条没过出口对账` : "过了出口对账",
        );
      }
      if (l.durationMs !== undefined)
        bits.push(`用了 ${formatDuration(l.durationMs / 1000)}`);
      return `${l.label} ${bits.join("、")}`;
    };
    const lanesLine = byDimension
      ? `这一轮把取证分到 ${lanes.length} 个方向上按维度跑（命题和联网取证按方向分，报告只有一份、出口对账只过一遍）：` +
        lanes.map(laneWord).join("；") +
        "。"
      : (lanes.length > 1
          ? `这一轮 ${lanes.length} 条链路各跑了一整套深研（各自编命题、各自联网取证、各自写报告、各自过出口对账），报告区分栏摆着：`
          : "这一轮只有一条链路在跑（另外那两把钥匙没配）：") +
        lanes.map(laneWord).join("；") +
        "。" +
        (primaryLane
          ? `判断板和上面那四节只从「${primaryLane.label}」那一份压出来。`
          : "");
    pushEvent(issueId, {
      id: `E-${issueId}-deep-done`,
      kind: "deep",
      at,
      headline: noEv
        ? `深度研究完成 · ${noEv.headline}`
        : "深度研究完成 · 报告已装配",
      actor: "您的 Agent",
      detail: [
        // 摆在第一行，在「几轮成文、质量门全过」前面：那两句在这一种运行下全是真的，
        // 而它们读起来像一份可以直接用的报告。
        noEv?.why,
        `${r.attempts} 轮成文，质量门${p0 ? `仍有 ${p0} 条没过（内容照常给您，问题记在运营台）` : "全过"}。`,
        evidenceLine,
        lanesLine,
        // 不写「独立第二源」：复核那一遍和主源是同一个模型（deepseek-v4-pro），只是
        // 只拿到结论、看不到论证过程。写成「独立」等于告诉他这几条经住了另一个家族
        // 的模型来冲，而那不是真的。
        r.challenged
          ? `反证复核又找到 ${r.challengeCount} 条反证，已并入「反证与风险」；复核用的是同一个模型，只换了干净的上下文。`
          : "这一份没有做反证复核 —— 报告里的反证只来自写它的那一遍。",
      ]
        .filter(Boolean)
        .join("\n"),
      // 过程性内容照常折起来（见 `TimelineEvent.defaultOpen`）；「这一份没有外部证据」不是
      // 过程，它直接决定这份报告能不能拿去用。
      defaultOpen: Boolean(noEv),
    });
    if (p0) {
      console.warn(
        `[tkos:a4] ${issueId} 走完重试仍有 p0：`,
        r.violations
          .filter((v) => v.severity === "p0")
          .map((v) => v.rule)
          .join(","),
      );
    }
    persistSoon();

    /*
     * 报告落库之后接着读成判断（A5）。
     *
     * 不 await —— 那会把这次深研的时长再拉长一轮模型调用，而屏幕上「报告已就绪」
     * 这句话此刻已经是真的了。判断板自己有一个状态可以轮询。
     *
     * 也不塞进这个任务里跑：A5 挂了不该把一份已经写成的深研标成 failed，而
     * `failed` 在这里意味着「不自动重开」—— 那一份报告就再也不会被读成判断了。
     */
    ensureJudgements(issueId);
    return { attempts: r.attempts };
  });
};

/**
 * 深研任务的状态在议题卡那一栏上怎么写。
 *
 * 收成一处而不是两处各抄一遍：写它的入口有两个（三键处置采信、粘进一件议题），
 * 以前是逐字相同的两段，改一次文案就会漏掉另一处。
 *
 * 这一栏跟着任务的真实状态写，不自己推断：done（包里已有报告）和 idle（demo 不叫
 * 模型）都是空的，failed 要照实说 —— 它不自动重试，藏起来他就会一直等。
 */
const deepResearchNote = (status: TaskState["status"]): string | undefined =>
  status === "running"
    ? "深度研究进行中"
    : status === "failed"
      ? "深度研究没跑成 · 不会自动重试"
      : undefined;

/**
 * 旧的「到点摆出预置报告」路径。
 *
 * 房懂懂那套种子退场后 `seed.pendingResearchDocs` 是空的，所以这个函数现在是
 * 空转 —— 保留它只是因为三处调用点的语义是「进这一页之前先结算一下」，
 * 而结算现在由 `ensureDeepResearch` 做。真删掉要同时改三处，收益是负的。
 */
const settleResearch = () => {
  Object.entries(issueJobs).forEach(([id, job]) => {
    if (job.etaSeconds <= 0 || store.researchDocs[id]) return;
    if (Date.now() - job.startedAtMs < job.etaSeconds * 1000) return;
    const doc = seed.pendingResearchDocs[id];
    const issue = store.issues.find((i) => i.id === id);
    if (!doc || !issue) return;
    store.researchDocs[id] = clone(doc);
    const at = nowIso();
    issue.state = "Exploring";
    issue.nextActionForUser = "深研报告已就绪";
    touch(issue, at);
    pushEvent(id, {
      id: `E-${id}-deep-done`,
      kind: "deep",
      at,
      headline: "自动深度研究完成 · 报告已装配",
      actor: "您的 Agent",
      detail: "本体关联对象 + online deep research 装配完毕，可进入议题研究。",
      defaultOpen: false,
    });
  }, { lane: "deep" });
};

const SETTLED_STATES = new Set([
  "Decided",
  "Monitoring",
  "Closed",
  "Dismissed",
]);

/**
 * 深研跑到哪了。
 *
 * 「没有报告」不等于「正在跑」。上一版这里在没有 job 时也返回 running，因为那时
 * 报告一定会到点出现。真接上模型之后这句话就成了假话 —— 一次失败的调用会让屏幕
 * 永远转圈，而转圈是这个产品最不能撒的谎：它让一号位一直等一件不会发生的事。
 *
 * 所以现在按真实任务状态答：没开始就说没开始，失败了就说失败了。
 */
const researchStatus = (issueId: string): IssueResearchStatus => {
  if (store.researchDocs[issueId]) return { state: "done" };
  const t = taskState("deep", issueId);
  /*
   * 排着队的那一轮照实说排队。**不能落到下面那句「有 job 就是有人在跑」**：`openResearch`
   * 在入队那一下就记了一笔 job，于是不拦的话首页那一格会呼吸着，代表一件还没开始的事，
   * 而秒表从按下去那一刻起走。
   */
  if (t.status === "queued") return { state: "queued", queuePosition: t.queuePosition ?? 1 };
  if (t.status === "running") {
    /*
     * 模型调用没有进度回传，给不出百分比 —— 与其编一个会走到 99% 卡住的进度条，
     * 不如只说在跑。假进度条比没有进度条更伤信任。
     *
     * **给得出的是步骤**：A4 那几段（装配上下文 / 编译命题 / 取证 / 写正式报告 /
     * 出口对账 / 压成四节 / 反证复核）在代码里就是那么排的，链路一步一步报上来
     * （见 `ResearchStep`）。步数不固定 —— 没配检索 key 的机器上没有中间那两段，
     * 分母跟着变（见 `a4/run.ts` 的 `STEP_TOTAL_*`）。它不折成百分比，也不喂给那个
     * 进度环 —— 理由写在 `IssueResearchStatus` 上。
     */
    return {
      state: "running",
      ...(t.step ? { step: t.step } : {}),
      ...(t.startedAt ? { startedAt: t.startedAt } : {}),
    };
  }
  /*
   * 跑挂了的那一轮到这里就收住。
   *
   * `openResearch` 在开跑那一下往 `issueJobs` 里记了一笔，而那一笔**不会因为这一轮
   * 挂掉而消失**。不在这儿拦住，下面那句「有 job 就是有人在跑」会把一次已经失败的
   * 调用读成 running：首页和议题清单上那一格从此永远呼吸着，代表一件没有任何人在做
   * 的事 —— 而失败之后是不自动重开的（见 `ensureDeepResearch`），他会一直等它。
   *
   * 落回 `idle` 是 `IssueResearchStatus.idle` 那段本来就写明的口径（「模型调用失败
   * 之后的议题」）：屏幕上那一行说的是「没人在做」，不是「快好了」。这一轮为什么挂的
   * 由 `deepResearchStatus` 答，报告页签和判断板照实写「这一轮深研没跑成」。
   */
  /*
   * `done` 和 `failed` 在这里是同一句话。走到这一行说明库里没有报告（上面第一句拦了有的
   * 那一种），而任务表说它跑完了 —— 那份报告写在够不着的地方（见 `deepRoundState`）。
   * 不并进上面那条 `running`：下面那句「有 job 就是有人在跑」会把它读成在跑，于是首页
   * 那一格永远呼吸着，代表一件没有任何人在做的事。
   */
  if (t.status === "failed" || t.status === "done") return { state: "idle" };
  const job = issueJobs[issueId];
  if (job) {
    /*
     * 有 job 就是**有人在跑**，哪怕给不出预估。
     *
     * 上一版把「没有预估」当成「没在跑」，于是一轮真开着的深研在屏幕上写着「未开始」——
     * 那是把一个已知为真的事实说成了假的。给不出百分比是另一回事，那种情况只说在跑，
     * 不编进度条。
     */
    if (job.etaSeconds <= 0) return { state: "running" };
    const elapsed = (Date.now() - job.startedAtMs) / 1000;
    return {
      state: "running",
      progress: Math.min(1, elapsed / job.etaSeconds),
      remainingSeconds: Math.max(0, Math.ceil(job.etaSeconds - elapsed)),
    };
  }
  // 没报告、没任务、没人开过 —— 那就是没人在做。见 `IssueResearchStatus.idle`。
  return { state: "idle" };
};

/**
 * 人那份回话了没。
 *
 * **只认显式点名。** 上一版在没人点名时回落到域 DRI，于是这个域下的每一件议题
 * 都长出一行「等 XXX 回传」—— 包括那些从来没交给过任何人的。屏幕上一个人同时
 * 「欠」着九件事，而他其实一件都没被要求过。
 */
const handoffStatus = (issue: Issue): HandoffStatus => {
  const name = issue.assigneeName;
  if (!name) return { state: "unassigned" };
  return store.driReports[issue.id]
    ? { state: "done", driName: name }
    : { state: "waiting", driName: name };
};

/**
 * 「从什么时候开始等」。第一条 handoff 事件的时刻，没有就回落到 `updatedAt`。
 *
 * 抽出来共用是因为这个事实有两个读者：DRI 那侧的 `DriHandoff.assignedAt`，和一号位
 * 那侧承接研究页签上的「从哪天起」。同一个事实在两个地方各算一遍，早晚会算出两个
 * 答案 —— 上一版那两处就是（一处按事件、一处按 headline 里有没有「交接包发出」这
 * 几个字），于是用「指派负责人」派的人在一侧有日期、在另一侧日期无声消失。
 */
const assignedAtOf = (issue: Issue): string =>
  (store.timelines[issue.id] ?? []).find((e) => e.kind === "handoff")?.at ??
  issue.updatedAt;

/**
 * 一个域的负责人姓名，按名单顺序。**可能是空的**（见 `Domain.driIds`）。
 *
 * 名字查不到的那几个 id 直接丢掉，不留占位：那种情况是数据坏了，而屏幕上多一个空名字
 * 只会让人以为那儿有个没名字的人。
 */
const domainDriNames = (domain: Domain | undefined): string[] =>
  (domain?.driIds ?? [])
    .map((id) => tk.people.find((p) => p.id === id)?.name)
    .filter((n): n is string => Boolean(n));

/**
 * 屏幕上那一句「这个域归谁」。**空名单写成「未指派」，不是写成空**。
 *
 * 全站只有这一处把名单折成一句话。散着写的话，同一个没有负责人的域会在一处显示成
 * 空白、在另一处显示成「未指派」，而那两种样子说的是不同的事（「加载中」和「真的没人」）。
 */
const domainDriLabel = (domain: Domain | undefined): string =>
  domainDriNames(domain).join("、") || "未指派";

/** 域的 DRI 姓名。指派人没点名时，承接这件事的默认就是域负责人。
 *  **只取第一个** —— 这条路要的是「默认落到谁头上」，那必须是一个人。 */
const findDomainDri = (domainId: string): string | undefined =>
  domainDriNames(allDomains.find((d) => d.id === domainId))[0];

const summarize = (issue: Issue): IssueSummary => {
  const irs = store.probeNodes[issue.id] ?? [];
  const timeline = store.timelines[issue.id] ?? [];
  return {
    id: issue.id,
    title: issue.title,
    state: issue.state,
    origin: issue.origin,
    nextActionForUser: issue.nextActionForUser,
    updatedAt: issue.updatedAt,
    domainId: issue.domainId,
    researchReady: Boolean(store.researchDocs[issue.id]),
    briefReady: Boolean(store.briefs[issue.id]),
    ...(issue.assigneeName ? { assigneeName: issue.assigneeName } : {}),

    ...(issue.monitoringNote ? { monitoringNote: issue.monitoringNote } : {}),

    research: researchStatus(issue.id),
    handoff: handoffStatus(issue),
    /*
     * 判断板上有东西也算「有得读」。
     *
     * 上一版只认两份报告。可是一件已经拍过板的议题往往**没有报告**（它的历史是七次
     * 会上的决定，不是一份研报），却有一整块判断板 —— 而那正是一号位回头要看的东西。
     * 只认报告的话，公司最重要的那几件事反而是进不去的。
     */
    canOpenResearch:
      Boolean(store.researchDocs[issue.id]) ||
      Boolean(store.driReports[issue.id]) ||
      (store.board[issue.id] ?? []).length > 0,
    settled: SETTLED_STATES.has(issue.state),

    ageDays: daysBetweenDays(dayOf(issue.raisedAt), seed.TODAY),
    /*
     * 「等他把关的」现在的定义变了：过去是 kind==="candidate" 的那一类卡；现在链路上
     * 没有两类节点，只有成色不同的判断陈述 —— 成熟到已经有去向、却还没被他放走的那几条，
     * 才是真的在等他。还在 `raw` 的不算：参谋自己都说那句没站住，把它计进「等您把关」
     * 只会让这个数字变成一个不用看的数字。
     */
    openCandidates: irs.filter(
      (ir) => Boolean(ir.route) && ir.standing === "firming",
    ).length,
    queuedForMeeting: irs.filter((ir) => ir.standing === "direction").length,
    meetingsHeld: timeline.filter((e) => e.kind === "decision").length,
    talkRounds: agentRounds(issue.id),

    /*
     * 「前期调研做完了没」= 机器那份或人那份，任意一份到手。口径写在 `IssueSummary`
     * 那个字段上：一页纸是**会议的产物**，要求它先有才准排会等于让因果倒过来跑。
     */
    readyForMeeting: isReadyForMeeting(issue.id),
    ...(slotIndex()[issue.id] ? { slot: slotIndex()[issue.id] } : {}),
    agendaRank: rankOf(store.agendaOrder, issue.id),
    /*
     * 只挂**还没确认**的那一份。确认过的不再是一件待办，而摘要上这一格喂的正是首页
     * 那一叠待处理的卡片（见 `MeetingDebrief`）。
     */
    ...(pendingDebriefOf(issue.id)
      ? { debrief: clone(pendingDebriefOf(issue.id)!) }
      : {}),
  };
};

/**
 * 每件议题排在哪一场会 —— 每次现算。
 *
 * 不缓存：这张索引在一次请求里最多被几十件议题问到，而它的输入（`meetingSlots`）在
 * 排会面板上是**每拖一下就变**的。缓存要配一把失效钥匙，而那把钥匙一旦漏掉一处写，
 * 屏幕上就会出现「拖完了颜色没跟着走」——一个查起来极慢、看起来像动画没播完的错。
 * 会的数量是个位数，现算的代价是几十次字符串比较。
 */
/*
 * 每次现算，**而且现读一次表**。缓存下来的话，跨过某一场会的结束时刻那一分钟，屏幕上
 * 那一栏不会自己变 —— 而它该变的正是那一刻（见 `slotPast`）。
 */
const slotIndex = (): Record<string, IssueSlot> =>
  slotIndexOf(store.meetingSlots, readClock());

/**
 * 前期调研做完了没有 —— **能不能排会的唯一判据，只有这一处。**
 *
 * 摘要上那一格读它，`scheduleIssue` 也读它。两条路（屏幕上那颗键、日程板上的拖拽）必须
 * 落在同一个判据上：分家之后会出现「键是灰的、但拖得进去」，而那种不一致没人看得出来是
 * 有意还是坏了。
 */
const isReadyForMeeting = (issueId: string): boolean =>
  Boolean(store.researchDocs[issueId]) || Boolean(store.briefs[issueId]);

/** 这件议题身上那份还没被确认的会后提炼。一件议题同时只可能有一份 —— 取最近的那场会。 */
const pendingDebriefOf = (issueId: string): MeetingDebrief | undefined =>
  Object.values(store.debriefs)
    .filter((d) => d.issueId === issueId && !d.confirmedAt && !d.reopenedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

/**
 * 把一件议题从它此刻那场会上摘下来。摘到了返回 true。
 *
 * **摘空了那场会就删掉**：一场没有议题的会在屏幕上是一块什么都不说的色块，而它还会
 * 占掉一个 `seq` —— 于是它后面每一场的颜色都往后串一位，看起来像颜色自己会变。
 *
 * 已经交过录音的那一场例外，不删：那上面挂着 `transcribedAt` 和那份录音的名字，
 * 而会后提炼是按 `slotId` 存的。删掉它，那几份提炼就指向一场不存在的会。
 */
function detachFromSlot(issueId: string): boolean {
  let hit = false;
  for (const slot of store.meetingSlots) {
    const i = slot.issueIds.indexOf(issueId);
    if (i < 0) continue;
    slot.issueIds.splice(i, 1);
    hit = true;
  }
  if (hit) {
    store.meetingSlots = store.meetingSlots.filter(
      (s) => s.issueIds.length > 0 || Boolean(s.transcribedAt),
    );
  }
  return hit;
}

/**
 * 一份**已经判过有用**的材料，按议题提炼并落库。`ingestMeetingNotes` 后台那一段的下半截。
 *
 * 拆成函数只有一个理由：它现在跑在一个任务体里（上半截是判材料那一次调用），两截连着写
 * 会让那个 `runTask` 的回调长到一屏读不完，而这两截的失败方式不一样 —— 上半截挂了是这一份
 * 判不了，下半截挂了是这一份提炼不出来。
 *
 * 收尾时才写 `transcribedAt`：它的含义是「转成文字并且提炼完了」（见 `MeetingSlot`），
 * 提前写的话，一轮跑挂的提炼在屏幕上和一轮跑完的长得一模一样。
 */
async function extractAndLandDebriefs(
  slot: MeetingSlot,
  issues: Issue[],
  text: string,
  label: string,
): Promise<void> {
  const slotId = slot.id;
  const openId = agentRunOpen({
    agent: "A7",
    input: `${label} · ${issues.length} 件议题`,
  });
  let out: Awaited<ReturnType<typeof extractDebrief>>;
  try {
    out = await extractDebrief({
      slotLabel: label,
      transcript: text,
      issues: issues.map((i) => ({
        id: i.id,
        title: i.title,
        /*
         * 板上那几条一起递进去。**它是给模型的对照，不是让它照抄** —— 会上真正
         * 谈的往往就是板上那几条判断，有对照它才分得清「这一句是在说这件议题」
         * 还是「只是顺口提了一下」。
         */
        judgements: (store.board[i.id] ?? [])
          .slice(0, 4)
          .map((b) => b.statement),
      })),
    });
  } catch (err) {
    agentRunSettle(
      openId,
      err instanceof AgentRunFailed
        ? err.run
        : { error: err instanceof Error ? err.message : String(err) },
    );
    throw err;
  }
  agentRunSettle(openId, out.run);

  const at = nowIso();
  let landed = 0;
  for (const d of out.debriefs) {
    const key = debriefKeyOf(slotId, d.issueId);
    const prev = store.debriefs[key];
    if (prev?.confirmedAt || prev?.reopenedAt) {
      // 他已经处置过这一件了（认了，或者判还需再议）。重跑不许盖 —— 盖掉的是他
      // 自己按下去的那一次。
      console.warn(`[tkos:store] ${key} 已经处置过，这一轮提炼不覆盖它。`);
      continue;
    }
    const rec: MeetingDebrief = {
      slotId,
      issueId: d.issueId,
      summary: d.summary,
      points: d.points.map((p, i) => ({
        id: `PT-${slotId}-${d.issueId}-${i + 1}`,
        text: p.text,
        ...(p.boundary ? { boundary: p.boundary } : {}),
      })),
      todos: d.todos.map((t, i) => {
        /*
         * 落库这一刻现算一次「这条是不是一号位自己的」，存进 `assignedTo`。
         *
         * 只算一次、不调两遍：`resolveTodoAssignee` 依赖的人表和这条原文在落库之后都不
         * 会再变，读的次数（每次开面板都要读）比写的次数（一场会一次）多得多，算好存
         * 起来比每次读都重判一遍更便宜，也让 `listActionItems()` 不用关心这条判断的细节。
         */
        const assignedTo = resolveTodoAssignee(t.owner);
        /*
         * 拍板判断跟着一起落库，而且**无条件写**：提炼那一步判出来的原样存，判不出来
         * 存兜底那一份（`resolvePrincipal`，判不出来就是「归他」）。
         *
         * 不写成 `...(t.principal ? {...} : {})` —— 那样写，「判过、不用他拍板」和
         * 「这一轮没判出来」在库里长得一模一样（都是没有这一格），而这两件事在屏幕上
         * 是相反的两个去处：前者进面板下层，后者必须进上层摆到他面前。缺字段这条路
         * 留给相三之前落的那些老记录，那是历史，不是新写进来的东西。
         */
        const principal = resolvePrincipal(t.principal);
        // 顶行标签同一条规矩：无条件写，判不出来按 principal 分岔的那句兜底（`resolveLabel`）。
        const label = resolveLabel(t.label, principal.needed);
        return {
          id: `TD-${slotId}-${d.issueId}-${i + 1}`,
          text: t.text,
          ...(t.owner ? { owner: t.owner } : {}),
          ...(assignedTo ? { assignedTo } : {}),
          principal,
          ...(t.due ? { due: t.due } : {}),
          label,
        };
      }),
      open: d.open,
      consensus: d.consensus,
      createdAt: at,
    };
    store.debriefs[key] = rec;
    landed += 1;
    pushEvent(d.issueId, {
      id: `E-${d.issueId}-debrief-${slotId}`,
      kind: "state",
      at,
      headline: rec.consensus.reached
        ? `会后提炼 · 本场已形成共识（要点 ${rec.points.length} 条、待办 ${rec.todos.length} 条）`
        : `会后提炼 · 本场尚未形成共识（未决 ${rec.open.length} 条）`,
      actor: "您的 Agent",
      detail: [rec.summary, "", ...rec.points.map((p) => `· ${p.text}`)].join(
        "\n",
      ),
      defaultOpen: true,
    });
  }

  slot.transcribedAt = at;
  persistSoon();
  console.warn(`[tkos:store] ${slotId} 会后提炼落了 ${landed} 件议题。`);
}

/** 在晃的最先，被放弃的最后。打开一屏想看的是「哪条在晃」，不是「哪条编号小」。 */
const STANDING_ORDER: Record<Judgment["standing"], number> = {
  shaking: 0,
  unverified: 1,
  confirmed: 2,
  dropped: 3,
};

const byStanding = (a: Judgment, b: Judgment) =>
  STANDING_ORDER[a.standing] - STANDING_ORDER[b.standing] ||
  a.id.localeCompare(b.id);

/* `isUnsettled`（这组判断里有没有还没坐实的）随旧版首屏判断台一起删了。 */

/**
 * 「这个域现在不安静」那一句，从判断算出来 —— 一号位刚把一条假设升级成已确认，
 * 这句话就必须同时消失。一段静态文字活得比它描述的事实久，是最致命的一种错。
 */
const shakingNote = (judgments: Judgment[]): string | null => {
  const parts = [
    ...judgments
      .filter((j) => j.standing === "shaking")
      .map((j) => `${j.id} 正被 ${j.shakenBy.join("、") || "议题"} 动摇`),
    ...judgments
      .filter((j) => j.standing === "unverified" && j.verifiedByTasks === 0)
      .map((j) => `${j.id} 至今 0 个真实任务验证过`),
  ];
  return parts.length > 0 ? parts.join("；") : null;
};

/** 判断更新只算这三种。布控和命中是监测，不是判断本身变了。 */
const REVISION_KINDS: JudgmentChange["kind"][] = [
  "version",
  "confirmed",
  "registered",
];

/**
 * 一个议题交给视图之前，把它咬住的那几条判断和它归属的域换成对象本身。
 *
 * 手动添加的议题刚进来时可以没有域也没有判断引用 —— 归域是 Agent 之后的事，
 * 这里不猜。没有域就没有 DRI，屏幕上照实写着。
 */
const hydrateIssue = (issue: Issue): Issue => {
  const next: Issue = {
    ...clone(issue),
    researchReady: Boolean(store.researchDocs[issue.id]),
    judgments: issue.judgmentRefs
      .map((id) => clone(findJudgment(id)))
      .sort(byStanding),
  };
  if (issue.domainId) {
    const domain = findDomain(issue.domainId);
    next.domain = clone(domain);
    /*
     * 名单空着的域（TokenOps 现在就是）这两栏不给 —— 给一个占位的人比不给更坏：
     * 屏幕上「DRI 数据负责人」和「DRI 刘人豪」长得一样，而前者说的其实是「没人」。
     */
    const dri = tk.people.find((p) => p.id === domain.driIds[0]);
    if (dri) {
      next.dri = clone(dri);
      next.driAgent = clone(agentOf(dri.id));
    }
  }
  return next;
};

/** 一条判断现在站得稳不稳，写成一句话。用词与 `StandingTag` 一致。 */
const standingSentence = (judgment: Judgment): string => {
  switch (judgment.standing) {
    case "confirmed":
      return `${judgment.id} 现在是 v${judgment.version} 的已确认判断，${judgment.verifiedByTasks} 个真实任务验证过。`;
    case "unverified":
      return `${judgment.id} 现在还是未验证的假设，${judgment.verifiedByTasks} 个真实任务验证过。`;
    case "shaking":
      return `${judgment.id} 正在动摇，${judgment.shakenBy.length} 个议题在晃它。`;
    case "dropped":
      return `${judgment.id} 已经被放弃 —— 它留在本体里，但公司不再赌它。`;
  }
};

/** 下一个议题编号：现有最大号加一，位宽跟现有的一致（`ISS-106`）。 */
const nextIssueId = (): string => {
  const max = store.issues.reduce((m, i) => {
    const n = Number(i.id.slice(4));
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 100);
  return `ISS-${max + 1}`;
};

/**
 * 提请台某一天摊开的那一批。当天没有就回落到最近一批（理由见 `listPending`）。
 *
 * 抽出来是因为「读这一批」和「往这一批里加一条」必须取到同一份：他自己提的那条要是
 * 落进一个读不出来的批次里，屏幕上看着就像没收下。
 */
const digestFor = (date: string) =>
  store.digests.find((d) => d.date === date) ??
  [...store.digests]
    .filter((d) => d.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date))[0];

/** 今天这一批。一批都没有时现开一批 —— 他提的那一条总得有地方摊。 */
const todayDigest = () => {
  const found = digestFor(seed.TODAY);
  if (found) return found;
  const fresh = { date: seed.TODAY, cardIds: [] as string[] };
  store.digests.push(fresh);
  return fresh;
};

/**
 * 下一个 Decision 编号：`D-<日期>`，同一天第二个起加 `-2`、`-3`。
 *
 * **「哪些编号已经发过了」是从账上算出来的，不另存一份注册表。** 原来那份是
 * `store.decisionIds = new Set()`，而这整个 store 要过一次 `JSON.stringify` 落盘
 * （见 persist.ts）—— Set 出来是 `{}`，于是：
 *
 *   · 重启之后 `Object.assign(store, restored)` 把它换成 `{}`，一号位在会后确认那一页
 *     按下「确认并写回」，服务端当场 `decisionIds.has is not a function`，屏幕上只剩
 *     一句「这一次写回没有成功」。（2026-08-20 实例走查撞到的就是这一下。）
 *   · 就算不崩，那份注册表每次重启都清空，同一天的第二个决定会拿到一个已经挂在
 *     别的决定上的编号 —— 而这个编号是判断修订史里指认「因哪个决定变的」那个键。
 *
 * 三条来源就是编号会落到的那三个地方：`quickDecisions`（议题研究里直接确认）、会后确认
 * 那份草案上的写回结果，以及判断修订/布控账 `changes`。**三条都要**：会后确认那四条路
 * 只在「这个议题咬着一条判断、而且草案里写了重开条件」时才往 `changes` 记一笔，
 * 少了草案那一条，一件没有判断锚点的议题定完之后，同一天的下一个决定就跟它重号。
 *
 * **再开一条发编号的路，就得在这里把它的落点加进来** —— 漏了不会崩，会安静地发出重号，
 * 而这个编号是判断修订史里指认「因哪个决定变的」那个键。
 */
const nextDecisionId = (at: string): string => {
  const taken = new Set<string>([
    ...store.quickDecisions.map((q) => q.decisionId),
    ...Object.values(store.closureDrafts)
      .map((d) => d.writeBack?.decisionId)
      .filter((id): id is string => Boolean(id)),
    ...store.changes
      .map((c) => c.decisionId)
      .filter((id): id is string => Boolean(id)),
  ]);
  const base = `D-${dayOf(at)}`;
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
};

/** 判断状态写成人话。屏幕上那几个词，递给模型的也是同一套。 */
const STANDING_TEXT: Record<Judgment["standing"], string> = {
  confirmed: "已确认",
  shaking: "正在动摇",
  unverified: "还是假设",
  dropped: "已放弃",
};

/** 四条分流在回执与时间线上的名字。顺序固定，没有第五条。 */

/** 这个议题的对谈里，参谋已经说过几轮。IR 的分幕（revealAfterRound）按它算。 */
const agentRounds = (issueId: string): number =>
  (store.advisorThreads[issueId] ?? []).filter((m) => m.role === "agent")
    .length;

/**
 * J₀ —— 从深研报告投影出来的第一个方向判断。**不调模型。**
 *
 * 为什么是投影不是生成，见 types.ts 的 InitialJudgment。一句话：J₀ 的内容全部
 * 已经在 ResearchDoc 里，再叫一次模型只会得到一份换了措辞的同源结论，而两份
 * 同源结论摆在一号位面前，他会以为那是两个独立判断。
 */
const initialJudgmentOf = (issueId: string): InitialJudgment | null => {
  const doc = store.researchDocs[issueId];
  if (!doc || !doc.judgment.length) return null;

  /*
   * 报告规模照实写。截图上是「48 页 · 已通读」——那是一份外部研究报告的页数。
   * 我们手上没有页数，有的是这一轮真的装了几份材料、外面真的取回来几条证据。
   * 它顺带回答了一个一号位真正会问的问题：这份判断底下压了多少东西。
   *
   * **原来数的是装配清单里那几份内部文档的正文字数。** 那一栏已经没有了 —— 公司内部
   * 材料只从本体来（理由在 `a4/prompt.ts` 的 `A4Input` 上），而本体叙述不是「几份文档」，
   * 它是一段。照原样留着的话这一行会变成「0 份材料 · 仅有标题 · 正文未入库」：一句
   * 既假又读不懂的话，而且它出现在判断头部最显眼的位置。
   *
   * 一条证据都没入账时整半句不说，不写「外部取证 0 条」—— 那是这一轮的一个真实结果
   * （报告里的「不确定性」会说它），不该在标题行上再喊一遍。
   */
  const parts = doc.assembledFrom.length;
  const evidence = doc.ledger?.length ?? 0;
  const scale = evidence
    ? `${parts} 份材料 · 外部取证 ${evidence} 条 · 已通读`
    : `${parts} 份材料 · 已通读`;

  return {
    issueId,
    reportTitle: `深研报告 · ${findIssue(issueId).title}`,
    reportScale: scale,
    statement: doc.judgment[0].text,
    // 三条原因就是关键 Evidence —— 它们本来就是「支撑上面那个答案的事实」。
    reasons: clone(doc.keyEvidence.slice(0, 3)),
    /*
     * 仍犹豫取第一条不确定性；一条都没有时**不编一条出来**，返回 null，
     * 屏幕上照实空着。一个读完报告没有任何犹豫的参谋不是想清楚了，是没在想 ——
     * 但那句话该由屏幕说，不该由这里造一句假的犹豫来掩盖。
     */
    hesitation: doc.unknowns.length ? clone(doc.unknowns[0]) : null,
    at: doc.assembledFrom.length ? nowIso() : nowIso(),
  };
};

/** 主链上最新的那一版。没有演进过就是 J₀。 */
const latestOnChain = (
  issueId: string,
): { version: number; statement: string } => {
  const chain = (store.probeNodes[issueId] ?? []).filter(
    (n) =>
      n.lane !== "aside" && typeof n.version === "number" && n.by === "agent",
  );
  const last = chain.sort((a, b) => (a.version ?? 0) - (b.version ?? 0)).at(-1);
  if (last) return { version: last.version ?? 0, statement: last.text };
  const j0 = initialJudgmentOf(issueId);
  return { version: 0, statement: j0?.statement ?? "" };
};

/**
 * 一轮对话结束后，把该沉淀的东西沉淀下去。
 *
 * **绝大多数轮次什么都不落。** 那是对的 —— 左栏那块判断板是想清楚了的几句话，
 * 不是聊天记录的副本。判定交给 `a6/extract.ts` 的模型，这里只负责把它的结论
 * 变成板上的行、以及链上的节点。
 *
 * 三件事分开落：
 *
 * - `formed`：这一轮长出来的判断上板，落在**上半层**（待他确认）。
 * - `confirms`：他这一轮明确认下来的，走 `applyConfirm` 落到下半层 —— 和板上
 *   那颗按钮走的是同一段代码，途径记 `dialogue`。
 * - `aside`：他开的新方向只落一支旁支，**不上板**。
 */
/**
 * 把赞/踩记到某一条上。两支对谈（裸 `issueId` / `${issueId}:signal`）共用这一份。
 *
 * 找不到那一条就抛：屏幕上那两枚拇指是照着这份列表画的，点得到就说明它在 —— 找不到
 * 意味着前端手上那份列表和库里这份对不上了，那时候悄悄不做事会让他一直点一枚不亮的拇指。
 */
const rateInThread = (
  key: string,
  label: string,
  messageId: string,
  verdict: "up" | "down",
): AdvisorMessage[] => {
  const list = store.advisorThreads[key];
  const one = list?.find((m) => m.id === messageId);
  if (!list || !one) throw new ApiError(`${label} 这一栏里没有 ${messageId} 这一轮。`);
  // 再点一次是收回 —— 三态里「没表过态」必须回得去。
  if (one.verdict === verdict) delete one.verdict;
  else one.verdict = verdict;
  /*
   * **不叫 `persistSoon()`** —— 同隔壁 `openAdvisorTurn` / `openSignalTurn` 那一段：
   * 落盘由 `/api/data` 每次调用结束那一次 `persistOnly()` 兜住，而 `persistSoon()` 会
   * 额外报一声「库改过了」，让屏幕上每一份资源重问一遍。为一枚拇指刷整屏是不成比例的。
   */
  return clone(list);
};

const settleTurn = (issueId: string): TaskState =>
  runTask("evolve", `${issueId}:${agentRounds(issueId)}`, async () => {
    const thread = store.advisorThreads[issueId] ?? [];
    const agentTurn = [...thread].reverse().find((m) => m.role === "agent");
    const ceoTurn = [...thread].reverse().find((m) => m.role === "user");
    if (!agentTurn || !ceoTurn) return {};
    const cur = latestOnChain(issueId);
    const refs = boardRefsFor(issueId);
    /*
     * 上一版这里有一道「报告还没好就不跑」的闸（`if (!cur.statement) return {}`）。
     * 这一版拆掉了：板可以先于报告有内容 —— 他在对谈里自己下的第一句判断就是这块板
     * 的第一条。留着那道闸，等于规定「参谋没先说话，他自己说的就不算」。
     */

    /*
     * 开跑就记一条（理由见 `agentRunOpen`）。**摆在上面那道 `return {}` 之后**：那一支
     * 一次模型都没叫，给它记一条等于台账上多出一轮不存在的运行。
     *
     * `input` 只填标题，A6 收尾时那条还会带上板上有几条 —— 那个格式不在这里再抄一份：
     * 抄了之后改措辞只会改到一处，而两处不一致的表现是台账上同一轮的两个名字。
     */
    /*
     * 轮外结算：判断状态与让步日志。挪到 A6 萃取之前，因为它读的是判断状态与让步日志
     * （`getTalkPoint` / `listDeliberationLog`），A6 萃取写的是板上那些东西，先后无关。
     * 挪到之前的理由：A6 萃取抛异常会 rethrow，如果结算在萃取之后，萃取一次抖动就丢掉
     * 那一轮的让步日志 —— 而让步日志是反谄媚闭环的账，不能因为萃取失败而不记。
     *
     * 和 A6 萃取、观测并列挂在这一段，不另起一条轮外链。
     *
     * 不 await：它跑不跑完不影响这一轮的板上产出（板还没开始萃取），而 `settleTurn` 本身
     * 已经是 `recordAdvisorReply` 里故意不 await 的那一下 —— 让他等这一段更没必要。
     *
     * 同一轮只落一条：`settleTalkTurn` 内部用模块级 Map 保证，调用方不必判重。
     *
     * H2：记账单位是「真的跑了一次结算」，判重命中那一次没跑，不该在台账上出现。
     * 记账挪到判重之后（在 doSettle 里），通过 accounting 端口传两个闭包进去。
     * 轮号只算一次（H2-3），open / settle / nowTurn / 日志措辞全用它。
     */
    const talkHarness = new Harness({ agent: "A5", slot: "pro" });
    const talkRound = agentRounds(issueId);
    const talkTitle = findIssue(issueId).title;
    void settleTalkTurn(talkHarness, issueId, {
      api: {
        getTalkPoint: (id) => api.getTalkPoint(id),
        recordDeliberationEntry: (id, e) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id) => api.listDeliberationLog(id),
        /*
         * 「进这一轮之前判断是什么样子」记在判断状态上。**这一格不走 `api`**：那上面的
         * 每个方法都是浏览器够得着的 RPC 口，而这一栏是反谄媚那本账的锚点（理由写在
         * `markTalkSettled` 上）。同 `accounting` 那两个闭包，从这里注入。
         */
        markTalkSettled: (id, judgement) => markTalkSettled(id, judgement),
        /*
         * 复核过了之后把候选落到板上与图上。**接头只有这一处** —— `settle.ts` 不能
         * import `store.ts`（那边已经 import 了 settle，反过来就是一条循环边），
         * 所以这一格是从这里注入的。落图之后一条重开条件都没布控，那一步等他按确认。
         */
        landTalkCandidate: (id) => api.landTalkCandidate(id),
      },
      ledger: (() => {
        const doc = store.researchDocs[issueId];
        if (!doc) return [];
        // F6：兜底要回来。`BlockEvidence` 有 `id` 与 `independenceGroup` 两栏，投影这两栏即可。
        if (doc.ledger) return doc.ledger;
        if (doc.blocks?.evidence) {
          return doc.blocks.evidence.map(
            (e) =>
              ({
                id: e.id,
                independenceGroup: e.independenceGroup,
              }) as import("@/lib/research/ledger").Evidence,
          );
        }
        return [];
      })(),
      nowTurn: talkRound,
      agentText: agentTurn.text,
      ceoText: ceoTurn.text,
      accounting: {
        open: () =>
          agentRunOpen({
            agent: "A5",
            input: `${talkTitle} · 第 ${talkRound} 轮结算`,
          }),
        /*
         * 台账上那一栏的措辞在这里补（J3）。`agentRunSettle` 是**整条替换**，而 settle
         * 那一层手上只有 `issueId`，它编出来的是 `bd7f…` 这种串；台账是给人读的，
         * 得是议题标题。开跑与落定用的是同一句，改措辞只改这一处。
         */
        settle: (runId, rec) =>
          agentRunSettle(runId, {
            ...rec,
            input: `${talkTitle} · 第 ${talkRound} 轮结算`,
          }),
      },
    }).catch((err) => {
      /*
       * 这一段是挂在 `recordAdvisorReply` 后面的轮外结算，`settleTalkTurn` 失败时是会
       * reject 的。没有这个 catch 就是一次 unhandled rejection —— Node 15 之后默认行为
       * 是终止进程，于是复核那一次模型调用抖一下就能把整个服务带走。
       *
       * **这里只吞掉、只记一行日志，不再调 `agentRunSettle`**：失败那条记录已经在
       * `doSettle` 自己的 catch 里落定过了，再落一次等于台账上同一次结算收两次场。
       */
      console.error(`[tkos:talk] ${issueId} 第 ${talkRound} 轮结算失败：`, err);
    });

    const openId = agentRunOpen({
      agent: "A6",
      input: findIssue(issueId).title,
    });
    let e: Awaited<ReturnType<typeof extractTurn>>["outcome"];
    let run: AgentRunRecord;
    try {
      ({ outcome: e, run } = await extractTurn({
        issueTitle: findIssue(issueId).title,
        currentStatement: cur.statement,
        currentVersion: cur.version,
        ceoTurn: ceoTurn.text,
        agentTurn: agentTurn.text,
        board: refs,
      }));
    } catch (err) {
      // 挂了也要留下这一轮 —— 原来这条路上一条记录都没有，而「聊了多少轮」是按台账数的。
      agentRunSettle(
        openId,
        err instanceof AgentRunFailed
          ? err.run
          : { error: err instanceof Error ? err.message : String(err) },
      );
      throw err;
    }
    // 每一轮都入账，包括判「什么都没发生」的那些（`status:"ignored"`）—— 只记落了
    // 东西的那几轮，台账上就只剩「板长了几条」，答不出「聊了多少轮才长这几条」。
    agentRunSettle(openId, run);
    for (const v of run.violations ?? [])
      console.log(`[tkos:a6x] ${issueId} ${v}`);

    const nodes = (store.probeNodes[issueId] ??= []);
    const edges = (store.probeEdges[issueId] ??= []);
    const at = nowIso();
    const round = agentRounds(issueId);
    let anchorId =
      nodes.filter((n) => n.lane !== "aside" && n.by === "agent").at(-1)?.id ??
      "ROOT";

    /*
     * 上板。这是这一轮的主要产出 —— 屏幕左栏就是这块板。
     *
     * `by` 决定署名：他自己下的那一句署他的名。这不是细节 —— 板上一条署着他名字的
     * 判断和一条参谋给的候选，他复核时要花的力气完全不同。
     */
    let landed = 0;
    for (const f of e.formed) {
      const made = boardPush(issueId, {
        statement: f.statement,
        label: f.label || undefined,
        basis: f.basis,
        boundary: f.boundary || undefined,
        reopenIf: f.reopenIf || undefined,
        origin: "dialogue",
        at,
        notes: [
          f.by === "ceo"
            ? { kind: "human", source: `${viewer().name} · 第 ${round} 轮` }
            : { kind: "agent", source: `您的 Agent · 第 ${round} 轮` },
        ],
        changeLabel: f.changeLabel || undefined,
        changeFrom: f.changeFrom || undefined,
        changeTo: f.changeTo || undefined,
      });
      if (!made) {
        console.log(
          `[tkos:a6x] ${issueId} 第 ${round} 轮这一条和板上已有的重复，没上板。`,
        );
        continue;
      }
      landed++;
      if (f.replaces) dropSuperseded(issueId, f.replaces, made);
      console.log(
        `[tkos:a6x] ${issueId} 第 ${round} 轮上板（${f.by === "ceo" ? "他自己下的" : "参谋给的"}）：${f.label || f.statement.slice(0, 20)}`,
      );
    }
    if (landed) {
      pushEvent(issueId, {
        id: `E-${issueId}-dialogue-judge-${round}`,
        kind: "judgment",
        at,
        headline: `对谈里长出 ${landed} 条待确认判断`,
        actor: e.formed[0].by === "ceo" ? viewer().name : "您的 Agent",
        detail: [
          ...e.formed.slice(0, landed).map((f) => f.statement),
          "还是候选。您逐条确认之后才是公司口径。",
        ].join("\n\n"),
        defaultOpen: false,
      });
    }

    /*
     * 确认。走的是板上那颗按钮同一段代码 —— 两条路记出来的东西必须一模一样，
     * 否则「在对谈里确认的」和「按按钮确认的」半年后长得不一样，而它们是同一件事。
     */
    let confirmed = 0;
    for (const c of e.confirms) {
      const done = applyConfirm(c.id, "dialogue", c.support);
      if (done) {
        confirmed++;
        console.log(
          `[tkos:a6x] ${issueId} 第 ${round} 轮在对谈里确认了：${done.label ?? done.id}`,
        );
      } else {
        // 萃取到落库之间板变了（另一条路刚把它确认掉）。不是错，只是没内容。
        console.log(
          `[tkos:a6x] ${issueId} 要确认的那一条已经不在上半层了（${c.id}）。`,
        );
      }
    }

    /*
     * 链上那两个节点。板是给他看的，链是这条对话怎么走过来的账。
     *
     * 只有在**参谋改写了板上某一条**的时候才推进版本号 —— 那才是「同一个判断的
     * 下一版」。他自己下的一句新判断上板就够了，硬塞进参谋的版本链会让台账把
     * 他的话记成参谋的产出。
     */
    const evolved = e.formed.find((f) => f.replaces && f.by === "agent");
    if (evolved) {
      // 一号位的那一下 —— 蓝节点。它不是判断，所以没有 version。
      const askId = `PN-${issueId}-ask-${round}`;
      nodes.push({
        id: askId,
        issueId,
        text: e.ceoChallenge || ceoTurn.text.slice(0, 40),
        by: "ceo",
        at,
        standing: "raw",
        anchor: { kind: "talk", round },
        knowledge: [
          { kind: "human", source: `${viewer().name} · 第 ${round} 轮` },
        ],
        lane: "main",
        revealAfterRound: 0,
      });
      edges.push({
        id: `PE-${askId}`,
        issueId,
        from: anchorId,
        to: askId,
        because: "一号位追问",
        by: "ceo",
        revealAfterRound: 0,
      });

      const verId = `PN-${issueId}-v${cur.version + 1}`;
      nodes.push({
        id: verId,
        issueId,
        text: evolved.statement,
        by: "agent",
        at,
        standing: "firming",
        anchor: { kind: "talk", round },
        knowledge: [
          { kind: "agent", source: `您的 Agent · 第 ${round} 轮调查后` },
        ],
        version: cur.version + 1,
        changeLabel: evolved.changeLabel,
        changeFrom: evolved.changeFrom,
        changeTo: evolved.changeTo,
        lane: "main",
        revealAfterRound: 0,
      });
      edges.push({
        id: `PE-${verId}`,
        issueId,
        from: askId,
        to: verId,
        because: evolved.changeLabel,
        by: "agent",
        revealAfterRound: 0,
      });
      anchorId = verId;
      console.log(
        `[tkos:a6x] ${issueId} J${cur.version} → J${cur.version + 1}：${evolved.changeFrom} → ${evolved.changeTo}`,
      );
    }

    if (e.aside) {
      const asId = `PN-${issueId}-aside-${round}`;
      nodes.push({
        id: asId,
        issueId,
        text: e.aside.text,
        by: "ceo",
        at,
        whyOnTopic: e.aside.why,
        standing: "raw",
        anchor: { kind: "talk", round },
        knowledge: [
          { kind: "human", source: `${viewer().name} · 第 ${round} 轮` },
        ],
        lane: "aside",
        asideOf: anchorId,
        revealAfterRound: 0,
      });
      console.log(
        `[tkos:a6x] ${issueId} 开了一支旁支：${e.aside.text.slice(0, 24)}`,
      );
    }

    if (!landed && !confirmed && !e.aside) {
      // 什么都没落。这是常态，值得记一笔 —— 否则「板怎么没动」会被当成 bug 查。
      console.log(
        `[tkos:a6x] ${issueId} 第 ${round} 轮：没有新判断、没有确认，板上不动。`,
      );
    } else {
      persistSoon();
    }

    return {};
  });

const findNode = (issueId: string, nodeId: string): ProbeNode => {
  const node = (store.probeNodes[issueId] ?? []).find((x) => x.id === nodeId);
  if (!node) throw new ApiError(`找不到这条判断陈述（${nodeId}）。`);
  return node;
};

/**
 * 定题的内核。`frameQuestion`（按钮）走的是这一段 —— 题不因入口不同而不同。
 */
/**
 * 定题。**同步等模型**，不做成后台任务。
 *
 * 定题是他按下去的一个按钮，按下去就在等一句话 —— 这跟深研（自动跑、几分钟）
 * 是两种交互。一句话十几秒，转圈可以接受；做成轮询反而更慢，还会出现
 * 「定完了但屏幕还没更新」的中间态。
 *
 * 模型接不上或写出来的题不合格时，回落到种子里预置的题；两者都没有才报错。
 * 顺序不能反 —— 有真模型就用真模型，这是它跟演示版的全部区别。
 */
const doFrame = async (issueId: string): Promise<DecisionQuestion> => {
  const issue = findIssue(issueId);
  const framed = store.framed[issueId];
  if (framed) return clone(framed);

  let question = store.decisionQuestions[issueId];
  let why = "";

  try {
    const doc = store.researchDocs[issueId];
    const thread = store.advisorThreads[issueId] ?? [];
    const candidates = tk.people
      .filter((p) => p.id !== tk.VIEWER_ID)
      .map((p) => ({ name: p.name, role: p.title ?? "" }));

    const r = await runFrame({
      issueId,
      title: issue.title,
      research: doc
        ? {
            judgment: doc.judgment.map((s) => s.text),
            counters: doc.counters.map((s) => s.text),
            unknowns: doc.unknowns.map((s) => s.text),
            routeSuggestion: doc.routeSuggestion,
          }
        : null,
      dialogue: thread.map((m) => ({ role: m.role, text: m.text })),
      candidates,
      deadlineHint: `今天是 ${seed.TODAY}。本月 Outcome 复盘在月末。`,
    });
    const p0 = r.violations.filter((v) => v.severity === "p0");
    if (p0.length) {
      // 不合格就不用它。一个「如何提升 X」式的题写上屏幕，比没有题更糟 ——
      // 他会拿着它去开会，会开完还是原地。
      console.warn(
        `[tkos:a2] ${issueId} 定题没过质量门，回落到预置题：`,
        p0.map((v) => v.rule).join(","),
      );
    } else {
      question = r.question;
      why = r.why;
    }
  } catch (e) {
    console.warn(
      `[tkos:a2] ${issueId} 定题调用失败，回落到预置题：`,
      e instanceof Error ? e.message : e,
    );
  }

  if (!question) {
    throw new ApiError("这个议题的探讨还没有收敛出可定的题 —— 再聊两轮。");
  }
  const at = nowIso();
  store.framed[issueId] = clone(question);
  if (issue.state === "Exploring") issue.state = "Researching";
  issue.nextActionForUser = "题已定";
  touch(issue, at);
  pushEvent(issueId, {
    id: `E-${issueId}-frame`,
    kind: "talk",
    at,
    headline: `定题：${question.text}`,
    actor: viewer().name,
    detail: [
      `建议 DRI：${question.suggestedDri} · 限时 ${question.deadline}`,
      why,
    ]
      .filter(Boolean)
      .join("\n"),
    defaultOpen: true,
  });
  persistSoon();
  return clone(question);
};

/**
 * 从深研报告装配一份会前 Brief。**没有模型调用** —— 全是搬运和分类。
 *
 * 为什么不给它配一个 agent：Brief 的每一栏都已经在深研四节里了。再叫一次模型
 * 只会得到一份「用不同措辞说同一件事」的东西，而两份措辞不同的同源结论摆在
 * 一号位面前，他会以为那是两个独立判断 —— 那是主动制造假的交叉验证。
 *
 * 唯一需要判断的是「分歧属于哪一类」，而这一类判断有确定性的依据：
 * 带反证复核标记的反证 = 判断分歧；不确定性 = 事实不足。价值取舍这一类
 * 装配不出来，也不该装配 —— 那正是只能他拍板的部分，编一条出来是越界。
 */
const synthBrief = (issueId: string): Brief | null => {
  const doc = store.researchDocs[issueId];
  const q = store.framed[issueId] ?? store.decisionQuestions[issueId];
  if (!doc) return null;

  const issue = findIssue(issueId);
  const driName =
    issue.assigneeName ??
    q?.suggestedDri ??
    (issue.domainId ? findDomainDri(issue.domainId) : undefined);
  const person = tk.people.find((p) => p.name === driName);
  const agentId =
    tk.agents.find((a) => a.personId === person?.id)?.id ??
    tk.agents[0]?.id ??
    "";

  /*
   * 复核那一遍补进来的反证。两个前缀都认：现在写的是「反证复核」，而已经落库的旧报告
   * 里是「独立第二源」（那一遍原来走 ALT 槽位）。只认新的，旧报告装出来的 Brief 会
   * 突然少掉「判断分歧」那一栏，而屏幕上看起来就像那份报告本来没有分歧。
   */
  const fromRecheck = (s: Statement) =>
    (s.traces ?? []).some(
      (t) =>
        t.source.startsWith("反证复核") || t.source.startsWith("独立第二源"),
    );

  const divergences: Divergence[] = [
    ...doc.counters.filter(fromRecheck).map((s) => ({
      kind: "hypothesis" as const,
      text: s.text,
      note: "判断分歧 · 可验证",
    })),
    ...doc.unknowns.slice(0, 2).map((s) => ({
      kind: "fact" as const,
      text: s.text,
      note: "事实不足 · 可查证",
    })),
  ];

  return {
    issueId,
    coreJudgment: doc.judgment[0]?.text ?? issue.title,
    problem: q?.text ?? issue.title,
    driRecommendation: {
      text: doc.routeSuggestion,
      traces: [{ kind: "agent", source: `${doc.byAgentLabel} · 深研建议分流` }],
    },
    keyEvidence: doc.keyEvidence.slice(0, 4),
    strongestCounter: doc.counters[0] ?? {
      text: "这一轮深研没有找到能动摇上面判断的反证 —— 这本身值得警惕，不代表风险低。",
      traces: [{ kind: "agent", source: "您的 Agent · 未找到反证" }],
    },
    divergences,
    suggestedQuestions: doc.unknowns.slice(0, 3).map((s) => ({
      q: s.text,
      implication: "答不上来就说明这个决定现在还缺一个事实。",
    })),
    byAgentId: agentId,
    stanceRedacted: true,
  };
};

/**
 * 这类议题过去的中位耗时。
 *
 * 真的去数已经定过的同类议题。数不出来（这是第一件）就说「首例 · 无历史中位」——
 * 屏幕上那句「比过去快了」是这一栏唯一想传达的东西，编一个基线出来会让它变成假话。
 */

/**
 * 确认回执上「这类问题过去中位 X」里那个 X —— **同类议题从提出到定下来的中位耗时**。
 *
 * 「这类」= 同一个 `origin`（信号推上来的 / 自己提的 / 从别的东西派生的）。三种的
 * 提出时刻含义不一样，混在一起算出来的中位不指任何东西。
 *
 * 原来这里根本没算中位：返回的是 `${done.length} 次同类决定的中位耗时（信号类）`，
 * 而调用处那句话已经写了「这类问题过去中位」—— 于是屏幕上是「这类问题过去中位
 * 3 次同类决定的中位耗时（信号类）」，把**件数印在了耗时的位置上**。定过两件事以后
 * 一号位就会读到这一句。数量和耗时都是数字，一眼看不出错，所以它一直在。
 *
 * 一件同类的都还没定过就返回 null，调用处跟着整半句不说。原来那句「首例 · 无历史
 * 中位」接在「这类问题过去中位」后面是「过去中位 无历史中位」—— 自己否掉了前半句。
 *
 * 中位而不是均值：一件拖了半个月的会把均值拉到没法读。偶数件取中间两件的平均。
 *
 * 算式单独具名（`pastMedianLabelOf`）是为了它验得到：跑到这个量要一次 A10 起草，
 * 那一步得真调模型，单测进不去。
 */
export const pastMedianLabelOf = (hours: number[]): string | null => {
  if (hours.length === 0) return null;
  const sorted = [...hours].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  // 件数要写出来：一件的「中位」就是那一件本身，不写他会以为背后有一批样本。
  return `${elapsedLabel(median)}（${sorted.length} 件）`;
};

const pastMedianFor = (issue: Issue): string | null =>
  pastMedianLabelOf(
    store.issues
      .filter(
        (i) => i.id !== issue.id && i.decidedAt && i.origin === issue.origin,
      )
      .map((i) => hoursBetween(i.raisedAt, i.decidedAt as string)),
  );

/**
 * 读一次判断板。
 *
 * 抽成模块级函数而不是让 api 方法之间互相 `this.xxx()` 调用 —— `/api/data` 是把
 * 方法从对象上取下来单独调的（`fn(...args)`），那时 `this` 是 undefined。
 * 这个坑只在跨方法调用时才会踩到，而且报错是「Cannot read properties of undefined」，
 * 跟真正的原因隔着一层。
 */
const readBoard = (issueId: string): JudgementBoard => {
  const all = (store.board[issueId] ?? []).map((j) => ({
    ...j,
    notes: resolveReportTraces(j.notes, boardReport(j, store.agentRuns), { docExists: (id: string) => store.docs.some((d) => d.id === id) }),
  }));
  return {
    issueId,
    draft: clone(all.filter((x) => !x.confirmed)).sort((a, b) =>
      b.at.localeCompare(a.at),
    ),
    confirmed: clone(all.filter((x) => x.confirmed)).sort((a, b) =>
      (b.confirmed?.at ?? "").localeCompare(a.confirmed?.at ?? ""),
    ),
    pending: judgementsPending(issueId),
    /*
     * 上一轮没跑完、但留下了几份能读的原件时，空板那一句话要改口（见
     * `JudgementBoard.reportsKept`）。0 不给：那一档屏幕上说的就是「没有报告可读」。
     *
     * 只数**已经收场**的那一轮（`error` 有值）。在跑的那一轮也边跑边落原件，而那时候
     * 板上该说的是「报告还在路上」—— 说「留住了 2 份」等于替一轮还没结束的深研收了尾。
     */
    ...(store.unfinishedResearch[issueId]?.error &&
    store.unfinishedResearch[issueId].reports.length
      ? { reportsKept: store.unfinishedResearch[issueId].reports.length }
      : {}),
  };
};

/**
 * 空板的原因。屏幕要照实说是哪一种（见 `JudgementBoard.pending`）。
 *
 * Demo 模式恒为 null：那边永远不叫模型，内容包里有板的就有，没有的就是空板 ——
 * 说「正在读」是在演一个不存在的后台。
 */
const judgementsPending = (issueId: string): JudgementBoard["pending"] => {
  if (DEMO) return null;
  const st = taskState("judge", issueId).status;
  if (st === "running") return "running";
  if (st === "failed") return "failed";
  // 手上没有报告就没有可读的东西。这不是「一会儿就有」，空板照实是空板。
  if (!store.researchDocs[issueId]) return null;
  if ((store.board[issueId] ?? []).some((b) => b.origin === "research"))
    return null;
  /*
   * 报告在库、板上一条参谋给的判断都没有，而那一轮**已经跑完**：这块板是真的空的。
   *
   * 「读完了」和「读出了东西」是两件事 —— 模型一条都没交、或者交的几条全被板上的
   * 去重挡下，都是一次成功的读报告（见 `ensureJudgements` 末尾那句日志）。这种时候
   * 说「正在读」是许下一个不会到来的承诺：不会再有下一轮了（同一份报告只读一遍），
   * 而屏幕上那个圈会一直转。
   *
   * 也不能报 null：那一档屏幕上说的是「深研报告还没到」，而报告就在库里躺着 ——
   * 换了一句假话而已。这是它自己一档。
   */
  if (st === "done") return "read-nothing";
  // idle：要么还没起，要么进程重启把在跑的那一轮丢了（见 `tasks.ts`）。
  // 两种都是「一会儿就有」—— 下一次读板会顺手起一轮。
  return "running";
};

/**
 * 板上去重的判据 —— 正文前 30 字（空白抹掉）。
 *
 * 提成模块级是因为它有第二个用户：`landTalkCandidate` 在 `boardPush` 返回 null
 * （去重命中）时要按同一判据把既有那一条找回来。判据抄成两份的表现是那一次找不回来，
 * 于是回执里的编号指不到板上任何一条。
 */
const boardKey = (t: string) => t.replace(/\s/g, "").slice(0, 30);

/**
 * 记下「这一轮结算落定时判断是什么样子」（`TalkPoint.settledJudgement`，那一栏的理由
 * 写在 `talk/point.ts`）。轮外结算每结算一轮调一次。
 *
 * **不进 `api`，所以浏览器够不着。** `api` 上的每一个方法都是一个 RPC 方法
 * （`scope.ts` 的 `RpcMethod` 就是它的键），而这一栏是反谄媚那本账的锚点：它能被外面
 * 改，等于「这一轮之前判断是什么样子」可以由调用方指定，那本账就不再是账。
 * 挂成模块级导出、由 `settleTurn` 那一格注入进去，同 `accounting` 那两个闭包的姿态。
 *
 * 判断状态还不存在时什么都不做：那说明这条议题一次对谈都还没跑过，没有「上一轮」可言。
 */
export async function markTalkSettled(
  issueId: string,
  judgement: string,
): Promise<void> {
  const point = store.talkPoints[issueId];
  if (!point) return;
  point.settledJudgement = judgement;
  /*
   * 不叫 `persistSoon()` —— 同这一层的两个邻居（`proposeTalkPoint`、
   * `recordDeliberationEntry`）。那个函数除了排落盘还会报一声「库改过了」，而这一栏
   * 屏幕上没有任何东西读它，报一声只会让前端为一次看不见的写多问一遍库。落盘照旧有：
   * `/api/data` 每次调用收尾都兜底排一次（`persistOnly`），整份 store 一起落。
   */
}

/**
 * 一件议题的记忆标签 —— `[domainId, ...judgmentRefs]` 摘掉空值（裁定 2b）。
 *
 * **两个调用方必须同源**：`confirmCandidate` 用它算出**写进**记忆的那一份，
 * `buildAdvisorContext` 用它算出**查回来**用的那一份。两处各抄一份的表现不是重复代码，
 * 而是某天只改了一头之后，装配时按新口径去查、库里存的是旧口径 —— 于是取不到自己
 * 刚写下的那条记忆，而两边的测试都绿。
 *
 * 装的是域 id 加判断 id，不是自由文本，也与报告正文那套证据强度标签无关（见
 * `DecisionMemory.issueTags` 的注释）。
 */
const issueTagsOf = (issue: Issue): string[] =>
  [issue.domainId, ...issue.judgmentRefs].filter((x): x is string => !!x);

/**
 * 暂缓那条决策记忆的判断句前缀。**这是一个记号，不是一个字段** —— 说清楚为什么。
 *
 * `DecisionMemory.status` 只有 `active` / `overturned` 两档，而那个类型在参谋那一侧
 * （`agent/talk/memory.ts`），这一件不动它。所以「这条记忆记的是一次暂缓、不是一次决定」
 * 现在只能写在判断句里。
 *
 * 导出是为了让测试和将来的视图**按同一个常量判**，而不是各自抄一遍这四个字 ——
 * 字符串记号最坏的死法是有人改了文案、另一头还在比旧串，两边都不报错。
 *
 * 欠账：`DecisionMemory` 该有一档 `held`。改那个类型时把这里连同下面 `approveCommandBrief`
 * 里那一处一起换掉。
 */
export const HELD_MEMORY_PREFIX = "暂缓下达 · ";

/**
 * 决断包批准落在 `QuickDecision.nodeId` 上的那个值。
 *
 * `QuickDecision` 原来只有一个来源（议题研究里点掉一个探针节点），所以那一栏一直是真节点号。
 * 决断包这条路上**没有探针节点** —— 建议是深研收口那一次直接交出来的。填一个像节点号的
 * 假值会让「按 nodeId 把节点找回来」这种代码在这几条上静默取空，所以填一个明摆着不是
 * 节点号的常量：读到它就知道该去 `researchDocs[issueId].commandBrief` 找出处。
 */
export const COMMAND_BRIEF_NODE_ID = "command-brief";

/** 一条判断板条目。id 用来源 + 序号，重跑同一来源不会重复堆。 */
const boardPush = (
  issueId: string,
  item: Omit<BoardJudgement, "id" | "issueId">,
): BoardJudgement | null => {
  const list = (store.board[issueId] ??= []);
  /*
   * 去重：同一句判断只上板一次。
   *
   * 深研重跑、对谈里参谋把同一句换个说法再说一遍 —— 这些都会试图往板上加。
   * 一块堆满近义句的板，比一块空板更没用：他没法判断到底有几条判断。
   * 判据是 `boardKey`（正文前 30 字），够挡住重跑，也不至于把真正的新版本误判成重复。
   */
  if (list.some((x) => boardKey(x.statement) === boardKey(item.statement)))
    return null;
  /*
   * 序号往后找到第一个没被占的。
   *
   * 不能直接用 `list.length + 1`：被改写的那一条会从板上撤掉（`dropSuperseded`），
   * 板缩短之后下一条算出来的序号正是刚刚还在的那一个 —— 两条判断同一个 id，
   * 而屏幕上的表现是点第二条的确认按钮确认了第一条。
   */
  let n = list.length + 1;
  while (list.some((x) => x.id === `BJ-${issueId}-${item.origin}-${n}`)) n++;
  const made: BoardJudgement = {
    id: `BJ-${issueId}-${item.origin}-${n}`,
    issueId,
    ...item,
  };
  list.push(made);
  return made;
};

/**
 * 板上一条的短编号 —— **从 id 算出来，不是列表下标**。
 *
 * 用下标（"1"、"2"）会出一个很难查的错：他看着上下文里的「第 2 条」说「这条我认了」，
 * 而在这中间板上多了或少了一条，同一个「2」指到了另一条判断上 —— 一次错误的确认，
 * 而确认是这个产品里唯一一次权力转移。从 id 算出来的编号跟着那一条判断走，永远
 * 不会改指。来源首字母是为了不同来源的序号撞不上（research-1 和 dialogue-1）。
 */
const refCodeOf = (b: BoardJudgement): string =>
  `${{ research: "R", dialogue: "D", meeting: "M" }[b.origin]}${b.id.split("-").at(-1) ?? ""}`;

/**
 * 判断板递给模型时的样子（对谈上下文和 A6 萃取用的是同一份，编号必须同源）。
 *
 * 顺序照屏幕：上半层在前，都按时间倒序 —— 他说「上面那条」时指的是屏幕上那一条。
 */
const boardRefsFor = (issueId: string): BoardRef[] => {
  const b = readBoard(issueId);
  return [...b.draft, ...b.confirmed].map((x) => ({
    ref: refCodeOf(x),
    id: x.id,
    ...(x.label ? { label: x.label } : {}),
    statement: x.statement,
    confirmed: Boolean(x.confirmed),
  }));
};

/**
 * 一条判断被改写之后，把旧的那一条从板上撤掉。
 *
 * 为什么要撤：一块并排摆着旧版和新版的板，他答不出「现在到底有几条判断」——
 * 而那正是这块板存在的全部理由。新的那一条身上带着 `changeFrom → changeTo`，
 * 改了什么在那一行上说得清。
 *
 * **已经确认过的不撤。** 那是公司口径，是账；它退场只能由他再按一次。这时候板上
 * 会短暂地同时有一条已确认的旧口径和一条待确认的新版 —— 那是事实，不是 bug。
 */
const dropSuperseded = (
  issueId: string,
  oldId: string,
  next: BoardJudgement,
): void => {
  const list = store.board[issueId] ?? [];
  const i = list.findIndex((x) => x.id === oldId);
  if (i < 0) return;
  const old = list[i];
  if (old.confirmed) {
    console.log(
      `[tkos:a6x] ${issueId} 被改写的那一条已确认过，留在板上（${old.id}）。`,
    );
    return;
  }
  list.splice(i, 1);
  console.log(
    `[tkos:a6x] ${issueId} 板上「${old.statement.slice(0, 20)}」被改写成「${next.statement.slice(0, 20)}」，旧的撤掉。`,
  );
};

/** 去向记录上那一行怎么写这次确认是在哪儿发生的（见 `ConfirmChannel`）。 */
const CONFIRM_WHERE: Record<ConfirmChannel, string> = {
  manual: "手动",
  dialogue: "对谈中",
  meeting: "会上",
};

/**
 * 确认一条判断的内核 —— 从上半层落到下半层。
 *
 * 抽出来是因为有两条路走到这里：板上那颗按钮（`confirmBoardJudgement`，缺条件时
 * **报错**，因为那是他刚点的一下，必须给回话），和对谈里那一句「第 2 条我认了，
 * 因为……」（`settleTurn`，缺条件时**静静跳过**，因为那一轮的产出本来就允许是空）。
 * 两条路记进库的东西必须一模一样，否则半年后同一件事有两种长相。
 *
 * 落不下去就返回 null：找不到、已经确认过、或者没写凭什么。
 */
const applyConfirm = (
  id: string,
  channel: ConfirmChannel,
  support: string,
): BoardJudgement | null => {
  const reason = support.trim();
  if (!reason) return null;
  const issueId = Object.keys(store.board).find((k) =>
    (store.board[k] ?? []).some((x) => x.id === id),
  );
  const item = issueId
    ? (store.board[issueId] ?? []).find((x) => x.id === id)
    : undefined;
  if (!issueId || !item || item.confirmed) return null;

  const at = nowIso();
  item.confirmed = { at, channel, support: reason };
  pushEvent(issueId, {
    id: `E-${issueId}-confirm-${item.id}`,
    kind: "judgment",
    at,
    headline: `判断已确认 · ${CONFIRM_WHERE[channel]}`,
    actor: viewer().name,
    detail: `${item.statement}\n\n凭什么：${reason}`,
    defaultOpen: false,
  });
  touch(findIssue(issueId), at);
  return item;
};

/**
 * 保证这件议题的深研报告已经被读成几条**待他确认**的判断（A5）。
 *
 * ## 为什么这一步是自动的
 *
 * 议题沉淀成战略议题、深研出报告之后，报告是四节并列的研究结果 —— 那不是他能
 * 拿去对外说的话。判断是几句能被单独摘出去用的口径，每一句都得有依据、边界和
 * 重开条件。这一层收窄是参谋的活，所以它自动发生；**而确认不是**：板的上半层
 * 全是候选，升到下半层只能由他自己按下 —— 板上、对谈里、或者会上（见 `ConfirmChannel`）。
 *
 * ## 为什么是自己一个任务键
 *
 * 深研那一轮已经花了一到三分钟。把 A5 塞进同一个任务里，它挂掉会把那份已经写成
 * 的报告一起标成 `failed` —— 而 `failed` 在这里意味着不自动重开，报告就再也不会
 * 被读成判断了。两条失败分开记，运营台上也才看得出到底是哪一步没过。
 *
 * 和深研一样立刻返回：判断板自己有一个状态可以轮询。
 */
const ensureJudgements = (issueId: string): TaskState => {
  const doc = store.researchDocs[issueId];
  // 没有报告就没有可读的东西。这不是失败，是还没到这一步。
  if (!doc) return { status: "idle" };
  /*
   * 成稿没跑成（一个块都没有）的报告也不读。2026-09-06 ISS-234：网宿断了，草稿、对账、成稿全没跑成，
   * 台账里只有检索计划从空草稿编出来的十一条零散证据（AI 芯片、EDA），A5 从它们里提炼出
   * 「TKOS 在 AI 芯片操作系统上的技术优势」三条判断上了板。没有正文就没有可提炼的判断。
   */
  if (doc.blocks && !doc.blocks.blocks.length && !doc.judgment.length) return { status: "idle" };
  /*
   * 板上已经有参谋给的判断就不再跑。
   *
   * 判据是「有没有 research 来源的条目」，不是「板空不空」：对谈和会上沉淀的判断
   * 也在同一块板上，拿板空不空判会导致他聊过一轮之后这一步永远不再发生。
   */
  if ((store.board[issueId] ?? []).some((b) => b.origin === "research"))
    return { status: "done" };
  /*
   * Demo 模式**永远不叫模型**。内容包里那几块板已经摆好了（上面那一行返回 done），
   * 没摆的就该照实是空板 —— 演示当中现起一轮判断生成，屏幕上只有一个转圈。
   */
  if (DEMO) return { status: "idle" };
  const cur = taskState("judge", issueId);
  // 同深研：失败过不自动重开。轮询会把一次失败变成几十次真实的模型调用。
  if (cur.status === "failed") return cur;
  /*
   * **跑过了也不自动重开** —— 哪怕上面那一行没拦住（板上一条 research 来源都没有）。
   *
   * 「A5 跑完了」和「A5 落住了东西」是两件事：模型一条都没交、或者交的几条全被板上
   * 的去重挡下，都是一次**成功**的读报告（下面那句 `没有判断上板` 的日志说的正是这件
   * 事）。只看板上有没有东西的话，这一轮之后每一次读板都会再起一轮 —— 而读板是被
   * 轮询和「库改过了」那条线反复触发的，于是同一份报告被反复读，一次一笔真实的模型
   * 账。同一份报告再读一遍也不会读出不同的结果。
   *
   * 想要再来一轮的路是明写的那两个动作（打回重研、重新起一轮深研），它们都会
   * `clearTask("judge", …)` 把这道闩打开。
   */
  if (cur.status === "done") return cur;
  const issue = store.issues.find((i) => i.id === issueId);
  if (!issue) return { status: "idle" };

  return runTask("judge", issueId, async () => {
    // 开跑就记一条（同深研那处，理由见 `agentRunOpen`）。`input` 与 A5 收尾时那条一致。
    const openId = agentRunOpen({
      agent: "A5",
      input: `${issueId} · ${issue.title}`,
    });
    const judgments = issue.judgmentRefs
      .map((id) => store.judgments.find((j) => j.id === id))
      .filter((j): j is Judgment => Boolean(j))
      .map((j) => ({ id: j.id, statement: j.statement, standing: j.standing }));

    let r: Awaited<ReturnType<typeof runJudgements>>;
    try {
      r = await runJudgements({
        issueId,
        title: issue.title,
        doc,
        judgments,
        // 板上已经有的原样递过去 —— 不递的话它会换个措辞再写一遍，而板上的去重
        // 按正文前 30 字判：换了措辞就躲过去，躲不过的被静默丢掉。
        existing: (store.board[issueId] ?? []).map((b) => b.statement),
      });
    } catch (e) {
      // 同 A3/A4/A10：把开跑那条换成失败的那条再原样抛。不上板、不推事件。
      agentRunSettle(
        openId,
        e instanceof AgentRunFailed
          ? e.run
          : { error: e instanceof Error ? e.message : String(e) },
      );
      throw e;
    }
    agentRunSettle(openId, r.run);

    const at = nowIso();
    /*
     * 上板。`origin: "research"` —— 这是「参谋通读材料之后的判断」那一种来源。
     *
     * 不写 `confirmed`：这一行是整条链路上最要紧的一行。参谋只往上半层放东西，
     * 那道从候选到口径的转移只有他能按。
     */
    const landed = r.judgements.filter(
      (j) =>
        boardPush(issueId, {
          statement: j.statement,
          label: j.label,
          basis: j.basis,
          boundary: j.boundary,
          reopenIf: j.reopenIf,
          origin: "research",
          at,
          notes: resolveReportTraces(j.traces, doc, { docExists: (id: string) => store.docs.some((d) => d.id === id) }),
        }) !== null,
    ).length;

    const p0 = r.violations.filter((v) => v.severity === "p0").length;
    pushEvent(issueId, {
      id: `E-${issueId}-judge-draft`,
      kind: "judgment",
      at,
      headline: `报告已读成 ${landed} 条待确认判断`,
      actor: "您的 Agent",
      detail: [
        p0
          ? `${r.attempts} 轮仍有 ${p0} 条质量门没过 —— 判断照常给您，问题记在运营台。`
          : `${r.attempts} 轮成文，质量门全过。`,
        "这些是候选，不是公司口径。您在对谈里或者会上逐条确认之后才算。",
      ].join("\n"),
      defaultOpen: false,
    });
    /*
     * 一条都没落住要在日志里说出来。板上是空的、事件里写着「0 条」，而原因
     * （全被去重挡掉 / 模型一条都没交出来）只在这一行里。
     */
    if (!landed) {
      console.warn(
        `[tkos:a5] ${issueId} 没有判断上板：模型交了 ${r.judgements.length} 条，全被去重挡下或整形后为空。`,
      );
    }
    if (p0) {
      console.warn(
        `[tkos:a5] ${issueId} 走完重试仍有 p0：`,
        r.violations
          .filter((v) => v.severity === "p0")
          .map((v) => v.rule)
          .join(","),
      );
    }
    persistSoon();
    return { attempts: r.attempts, landed };
  });
};

/**
 * 散会到 `at` 之间多少分钟 —— **这个量是算出来的，不是写死的**。
 *
 * 三种情况没有这个量：没上会（读完研究就定那一条路）、那场会还在开、那场会没有散会
 * 时刻。三种都返回 null，屏幕上跟着不说「会后几分钟」这句话。写死一个 0 顶上去会被
 * 读成「刚散会、赶紧确认」—— 而这一栏唯一的用处正是「会后半小时内确认掉」这条规矩，
 * 读反方向比不说更糟。
 *
 * 单独具名是因为它是产品逻辑（那一栏的口径）而不是一行算式：这样它自己就钉得住。
 * 负数夹到 0：两台机器的钟差不该在屏幕上变成「会后 -3 分钟」。
 */
export const minutesSinceMeetingAt = (
  meeting: Meeting | undefined,
  at: string,
): number | null =>
  meeting?.endedAt
    ? Math.max(
        0,
        Math.round((Date.parse(at) - Date.parse(meeting.endedAt)) / 60000),
      )
    : null;

/**
 * 保证这件议题有一份写回提案（A10）。和深研一样：立刻返回，前端轮询。
 *
 * 触发点现在只有惰性的那两个：`getClosureDraft`（进会后确认那一页）与
 * `startWriteBack`。原来还有一个提前触发点长在「升级分发」里（`escalate`），随那段
 * 模拟一起拆掉了 —— 它在那个时点起草，草案里读的是深研报告，**恰好不含刚回传的
 * 那一份**；没有深研报告时还会把 `research: null` 递给 A10，让它凭 question 和对谈
 * 就去写七要素。
 *
 * 代价说清楚：一号位走到会后确认那一页时，第一次可能要等这一轮起草。**这个洞不在
 * 这个任务里补** —— 补法是给起草找一个真实的、有前提的时点，而不是在回传那一刻
 * 编一份草案出来。
 */
const ensureWriteBack = (issueId: string): TaskState => {
  if (store.closureDrafts[issueId]) return { status: "done" };
  const cur = taskState("writeback", issueId);
  if (cur.status === "failed") return cur;
  const issue = store.issues.find((i) => i.id === issueId);
  if (!issue) return { status: "idle" };

  return runTask("writeback", issueId, async () => {
    // 开跑就记一条（同深研那处，理由见 `agentRunOpen`）。`input` 与 A10 收尾时那条一致。
    const openId = agentRunOpen({ agent: "A10", input: issue.title });
    const doc = store.researchDocs[issueId];
    const q = store.framed[issueId] ?? store.decisionQuestions[issueId] ?? null;
    const thread = store.advisorThreads[issueId] ?? [];
    const judgments = issue.judgmentRefs
      .map((id) => store.judgments.find((j) => j.id === id))
      .filter((j): j is Judgment => Boolean(j))
      .map((j) => ({ id: j.id, statement: j.statement, standing: j.standing }));

    let r: Awaited<ReturnType<typeof runWriteBack>>;
    try {
      r = await runWriteBack({
        issueId,
        title: issue.title,
        research: doc
          ? {
              judgment: doc.judgment.map((s) => s.text),
              keyEvidence: doc.keyEvidence.map((s) => s.text),
              counters: doc.counters.map((s) => s.text),
              unknowns: doc.unknowns.map((s) => s.text),
              routeSuggestion: doc.routeSuggestion,
            }
          : null,
        question: q,
        dialogue: thread.map((m) => ({ role: m.role, text: m.text })),
        judgments,
      });
    } catch (e) {
      // 同 A3/A4：把开跑那条换成失败的那条再原样抛。不写草案、不推事件。
      agentRunSettle(
        openId,
        e instanceof AgentRunFailed
          ? e.run
          : { error: e instanceof Error ? e.message : String(e) },
      );
      throw e;
    }
    agentRunSettle(openId, r.run);

    /*
     * 这份草案是哪来的：这个域那场会散了之后起的，还是没上会、读完研究就定。
     * 两者在屏幕上是两句不同的话，所以这里必须分得出来。
     */
    const meeting = store.meetings.find((m) => m.domainId === issue.domainId);
    const draftedAt = nowIso();
    store.closureDrafts[issueId] = {
      issueId,
      sourceMeetingId: meeting?.id ?? "",
      minutesSinceMeeting: minutesSinceMeetingAt(meeting, draftedAt),
      fields: r.fields,
      writeBack: null,
      revises: r.revises,
      /*
       * 没有历史就照实说没有。编一个「中位 3 天」出来，屏幕上那句
       * 「比过去快了」就是假的 —— 而那正是这一栏唯一想传达的东西。
       */
      pastMedianLabel: pastMedianFor(issue),
    };

    const p0 = r.violations.filter((v) => v.severity === "p0").length;
    pushEvent(issueId, {
      id: `E-${issueId}-writeback-draft`,
      kind: "judgment",
      at: nowIso(),
      headline: "写回提案已起草",
      actor: "您的 Agent",
      detail: p0
        ? `${r.attempts} 轮仍有 ${p0} 条质量门没过 —— 草案照常给您，问题记在运营台。`
        : `${r.attempts} 轮成文，七要素齐全，质量门全过。这是提案，您确认之前本体不会变。`,
      defaultOpen: false,
    });
    if (p0) {
      console.warn(
        `[tkos:a10] ${issueId} 走完重试仍有 p0：`,
        r.violations
          .filter((v) => v.severity === "p0")
          .map((v) => v.rule)
          .join(","),
      );
    }
    persistSoon();
    return { attempts: r.attempts };
  });
};

/**
 * 这条路会派出去几条 Evidence Action。
 *
 * 抽出来是因为它有两个读者：`confirmClosure` 真的派，而确认之前那一眼（`Preview`）
 * 要照实预告。两处各算一遍的话，其中一处哪天改了另一处不会报错 —— 屏幕上就会出现
 * 「按之前说好的」和「实际发生的」不一致，而这块屏幕上一号位唯一能凭的就是它说到做到。
 *
 * C 是明摆着去取证据，所以是 1 条。A 也派一条：判断翻了版，那条新陈述得有真实数据来
 * 验证，否则翻版只是换了一句话。B 交出去的是执行、D 是关闭，都不派。
 */

// ---------------------------------------------------------------------------

/**
 * 卡片出库时把预研此刻的样子带上：跑完没有、判成了什么、还是那一轮挂了。
 *
 * 预研是**自动跑的**，不是他点出来的 —— 所以这三件事属于卡片本身的状态，不是
 * 详情页才该知道的事。这里合成而不是存进 `store.cards`：预研文档是另一张表，把它的
 * 时间戳和结论复制一份进卡片，两边就会各自漂。
 */
const withPre = (c: Card): Card => {
  const pre = store.preResearch[c.issueId];
  if (pre)
    return {
      ...clone(c),
      preResearchAt: pre.at,
      preResearchStatus: pre.status,
    };
  // 报告不在。是在跑还是挂了，只有任务状态答得出来 —— 不问就只能写成「进行中」。
  const t = taskState("preresearch", c.issueId);
  if (t.status === "failed") return { ...clone(c), preResearchFailed: true };
  /*
   * 在跑：把「第几步」和「什么时候起的」一起带上。
   *
   * **只在 `running` 这一档带**，不是「没有报告就带」。起点在卡面上就是「有一轮在跑」
   * 这句话本身（`runTask` 给每一条 running 都盖了 `startedAt`）—— 所以 demo 那一档
   * （压根没起任务，`idle`）在卡面上不会呼吸，屏幕也不会替一件没人在做的事去轮询。
   *
   * `step` 可能没有而 `startedAt` 一定有：只有主动上报的链路给步骤。没有就不带，
   * 卡面退回那句「预研进行中」——**不许拿「第 1 步」兜底**。
   */
  if (t.status !== "running") return clone(c);
  return {
    ...clone(c),
    ...(t.step ? { preResearchStep: t.step } : {}),
    ...(t.startedAt ? { preResearchStartedAt: t.startedAt } : {}),
  };
};

/**
 * 会后确认布控下去的重开条件，在回执上那一行。
 *
 * 收成一处而不是两处各抄一遍：写它的入口有两个（链路处置、会后写回），以前是逐字
 * 相同的两段。布控回的那一屏是 `/signals`，它自己的抬头是「潜在议题」——
 * 屏幕上没有一处叫「待定事项」，回执上就不能这么指。
 */
const reopenTriggerLabel = (armed: number): string =>
  `Re-open Trigger ×${armed} · 已布控回潜在议题监测靶点`;

/**
 * 已布控的 Re-open Trigger 摊成靶点。
 *
 * 两个方法要同一份：待定事项头部那行「监测中」（`listSensorTargets`），和监控策略里
 * 「这几条一动就重开」那一段（`getMonitorStrategy`）。各写一遍的下场是同一屏上两个数。
 */
/**
 * 靶点库：这一轮预研可能撞上的既有判断。
 *
 * **只装在版判断**。`TargetKind` 里另外留着战略/假设/承诺三类，但 store 里今天
 * 只有判断这一类既有 `id` 又有可比的正文；把承诺按标题塞进去会让靶点匹配
 * 在没有正文可比的东西上瞎猜。等那几类有正文可读时再往这里加。
 */
function buildTargetIndex(): TargetRef[] {
  return store.judgments.map((j) => ({
    kind: "judgment" as const,
    id: j.id,
    text: j.statement,
    href: `/judgments/${j.id}`,
  }));
}

const sensorTargets = (): SensorTarget[] =>
  store.judgments.flatMap((j) =>
    j.reopenTriggers
      .filter((t) => t.armed)
      .map((t) => ({
        id: t.id,
        text: t.text,
        judgmentId: j.id,
        href: `/judgments/${j.id}`,
      })),
  );

export const api = {
  // -------------------------------------------------------------------------
  // 本体读取
  // -------------------------------------------------------------------------

  /**
   * 演示前一键重置：把对象库恢复到种子状态。
   *
   * `resetToSeed` 之前是导出了但没有任何调用点 —— 等于只能手动删 .data/store.json
   * 再重启。演示前十分钟要重置的时候，那是个会出错的操作。
   *
   * 要求传一个确认串：这一栏一按就把一号位当前的会话状态全清了，
   * 而它离「重新装配」只有一个误触的距离。
   */
  async resetDemo(confirm: string): Promise<{ ok: true; at: string }> {
    if (confirm !== "RESET")
      throw new ApiError(
        "要重置请传 RESET —— 这一步会清掉当前所有对话、报告与写回草案。",
      );
    resetToSeed();
    console.warn("[tkos:store] 对象库已重置回种子状态。");
    return { ok: true, at: nowIso() };
  },

  /**
   * 把他粘进来的一段话直接立成在办的战略议题，并当场开跑深研。**调试用入口。**
   *
   * ## 它为什么不是 `addIssue`
   *
   * `addIssue` 是产品里那条正路：他自己想到的事也要先落成一条潜在议题，等他在提请台上
   * 按三个键之一 —— 那一次处置就是「值不值得占我时间」这个决定（理由写在那个方法上）。
   *
   * 这里正相反：**那个决定已经做完了**，题目是他自己认定的战略议题，粘进来只为看 A4
   * 这一轮跑成什么样。所以它跳过潜在议题、跳过预研（A3），也不建卡 —— 一件调试用的
   * 议题不该在提请台上留一行。
   *
   * A4 调完之后删掉，别让它长成一个正式功能：真实的立案只有雷达、DRI 上报、他自己提
   * 这三条来路，每一条都带着自己的来历。
   *
   * ## 粘进来的原文当「范围与背景」
   *
   * 一句话 / 一整篇 / 一个链接三支归一，和「我自己有一件事」用的是同一个读法
   * （`readOwnIssueInput`）：标题由它给，正文落进 `store.issueScopes` 递给深研。
   * 只递标题的话，长的那两支会在这里被压成一行十几个字，深研就照着那一行去查了。
   */
  async addStrategicIssue(
    text: string,
  ): Promise<{ issueId: string; research: TaskState }> {
    const raw = text.trim();
    if (raw.length === 0) throw new ApiError("议题不能是空的。");

    // 抓链接、起标题都在这一下里等（同 `addIssue`）：他这一刻正看着这个框。
    const input = await readOwnIssueInput(raw);

    const at = nowIso();
    const issue: Issue = {
      id: nextIssueId(),
      title: input.title,
      /*
       * 直接落在「研究中」（`Exploring` 的中文标签，见 `state-badge.tsx`）—— 和他在
       * 提请台上按下「深研」之后落的那一档一模一样（`disposeCard` 的 discuss 支）。
       * 域留空：这件事碰的是哪块生意还没人接出来，那是诚实的空，它落在首页的总览里。
       */
      state: "Exploring",
      origin: "manual",
      judgmentRefs: [],
      nextActionForUser: null,
      raisedAt: at,
      updatedAt: at,
    };
    store.issues.push(issue);

    /*
     * 原文封到 6000 字。深研那一栏是「范围与背景」，不是材料区（A4 没有材料区，见
     * `A4Input`）—— 两万字塞进去既超预算，也会把这条议题的边界淹掉。这条线和预研
     * 读原文的那条线取同一个值。
     */
    if (input.body) {
      store.issueScopes[issue.id] = input.body.slice(
        0,
        MATERIAL_FOR_PRE_RESEARCH,
      );
    }

    pushEvent(issue.id, {
      id: `E-${issue.id}-pasted`,
      kind: "state",
      at,
      headline: "议题立项（您粘进来的，已定为战略议题）· 直接进研究中",
      actor: viewer().name,
      detail:
        "这一件是粘进来试深研的：跳过了潜在议题那一次处置，也没跑预研。" +
        (input.note ? `\n\n${input.note}` : ""),
      defaultOpen: true,
    });

    // 深研就在这一下起 —— 他按的这一下就是「开始研究」，不该等他再点进那一页。
    const deep = ensureDeepResearch(issue.id);
    issue.monitoringNote = deepResearchNote(deep.status);

    persistSoon();
    console.warn(
      `[tkos:store] 粘进一件议题：${issue.id}（${issue.title}），深研 ${deep.status}。`,
    );
    return { issueId: issue.id, research: deep };
  },

  /**
   * 把一件议题连它身上的东西一起删掉。**内部测试用，不是产品功能。**
   *
   * ## 为什么需要它
   *
   * 这几条链路（立案、预研、深研、判断）现在都在真模型上调，一天要试十几轮。每一轮
   * 都留一件议题在议题板上，而 live 档没有重置这一档的入口 —— `resetDemo` 是把整库
   * 推回种子，连他上一场聊出来的东西一起没。删一件的能力因此是调试用的最小刀口。
   *
   * ## 为什么不做成「归档」
   *
   * 归档是一个产品动作，要有理由、要有账、要能翻出来。这里要的正相反：**试出来的
   * 垃圾不该在账上留痕**。所以这一刀是真删，删完屏幕上就像它没来过。真正的产品动作
   * 是三键处置里的「搁置」和会后确认的关闭，那两条都有账（`disposeCard`、`signClosure`）。
   *
   * ## 删什么、不删什么
   *
   * 删：议题本身、它那张卡（连今天那一批里的编号）、以及所有按议题号存的那些
   * （时间线、预研、深研报告、判断板、对谈、一页纸、闭环草案、链路图、快决策……），
   * 再把它从 `judgment.shakenBy` 上摘下来 —— 留着的话，判断页上会写着「有议题在晃它」
   * 指向一件不存在的东西。收件柜里那条信号的 `judged.issueId` 也清掉，理由同上
   * （`InboxSignalMeta.judged.issueId` 上写着它不该指向不存在的对象）。
   *
   * **不删 `agentRuns`。** 那是「模型这一轮干了什么」的台账，是评分的唯一凭据；
   * 议题删了不等于那次调用没发生过。同理不删扫描记录和那条信号本身。
   *
   * ## 正在跑的任务挡着不让删
   *
   * 预研 / 深研 / A5 / 写回都是先返回再在后台写库的。删到一半那边写回来，
   * `store.board[issueId]` 之类会凭空复活成一批挂在不存在议题下的孤儿，而屏幕上
   * 看不出任何异常。所以这里照实拒绝，让他等那一轮跑完 —— 一到三分钟。
   */
  async removeIssue(
    issueId: string,
  ): Promise<{ issueId: string; removed: true }> {
    await sleep(120, 260);
    const idx = store.issues.findIndex((i) => i.id === issueId);
    if (idx < 0)
      throw new ApiError(`没有 ${issueId} 这件议题 —— 可能已经删掉了。`);

    const running = (
      ["preresearch", "deep", "judge", "writeback"] as const
    ).filter((kind) => taskState(kind, issueId).status === "running");
    if (running.length > 0) {
      throw new ApiError(
        `这件议题上还有 ${running.length} 个任务在跑（${running.join("、")}），跑完再删 —— ` +
          "现在删的话，那一轮的结果会写回成挂在不存在议题下的孤儿。",
      );
    }
    for (const kind of ["preresearch", "deep", "judge", "writeback"] as const) {
      clearTask(kind, issueId);
    }

    const title = store.issues[idx].title;
    store.issues.splice(idx, 1);

    // 那张卡，以及它在每一批 digest 里的编号。卡留着的话，提请台上会剩一行点进去
    // 是 404 的潜在议题。
    const cardIds = new Set(
      store.cards.filter((c) => c.issueId === issueId).map((c) => c.id),
    );
    store.cards = store.cards.filter((c) => c.issueId !== issueId);
    store.digests.forEach((d) => {
      d.cardIds = d.cardIds.filter((id) => !cardIds.has(id));
    });

    /*
     * 按议题号存的那些。**逐个列出来，不遍历 store 的键** —— 遍历的写法会在往后
     * 新加一张按议题号存的表时自动把它一起删掉，听着像优点，但它同样会自动删掉
     * 一张恰好用议题号当键、而语义上不该跟着走的表（比如那份台账）。
     */
    delete store.timelines[issueId];
    delete store.researchDocs[issueId];
    delete store.unfinishedResearch[issueId];
    delete store.preResearch[issueId];
    delete store.issueScopes[issueId];
    delete store.board[issueId];
    delete store.advisorPresets[issueId];
    delete store.advisorThreads[issueId];
    delete store.decisionQuestions[issueId];
    delete store.framed[issueId];
    delete store.briefs[issueId];
    delete store.closureDrafts[issueId];
    delete store.probeNodes[issueId];
    delete store.probeEdges[issueId];
    delete store.driReports[issueId];
    store.quickDecisions = store.quickDecisions.filter(
      (q) => q.issueId !== issueId,
    );
    /*
     * 命令跟着议题一起走。留着的话，命令板上会出现一条点不开出处的命令 ——
     * `DecisionOrder.issueId` 指向一件已经不存在的议题，而屏幕上没有任何一处说得出为什么。
     */
    store.decisionOrders = store.decisionOrders.filter(
      (o) => o.issueId !== issueId,
    );

    clearShakenBy(issueId);
    store.inboxSignals.forEach((s) => {
      if (s.judged?.issueId === issueId) delete s.judged.issueId;
    });

    persistSoon();
    console.warn(
      `[tkos:store] 删掉一件议题：${issueId}（${title}）—— 调试用入口。`,
    );
    return { issueId, removed: true };
  },

  /** 正在看这块屏幕的人。后端接上后这一项来自会话。 */
  async getViewer(): Promise<Person> {
    await sleep(80, 180);
    return clone(viewer());
  },

  /**
   * 待定事项头部那行「监测中」。已布控的 Re-open Trigger 摊回 Sensor 靶点 ——
   * 会后确认回到待定事项的那条回环在屏幕上的样子。写回一确认，这里就多一条。
   */
  async listSensorTargets(): Promise<SensorTarget[]> {
    await sleep(100, 220);
    return sensorTargets();
  },

  /**
   * 读触发器表。**读之前顺手清扫过期项** —— 没有定时器，清扫挂在读上：
   * 表只在有人看它的时候才需要是干净的，而这样就不必引入一个后台循环。
   *
   * 返回的是一个新数组，不是表本体 —— 姿态和旁边的 `sensorTargets()` 一致。
   * 交出本体等于任何拿到它的调用方都能 `push`/`splice` 库里的表，而那条路上
   * 没有 `touch`、没有 `pushEvent`、没有 `persistSoon`：改了库、屏幕上没痕迹。
   */
  async listTriggers(): Promise<TriggerProposal[]> {
    const { next, expired } = expireTriggers(store.triggers, nowIso());
    if (expired.length > 0) {
      store.triggers = next;
      console.warn(
        `[tkos:pre] 清掉 ${expired.length} 条到期的监控条件：`,
        expired.join("、"),
      );
      persistSoon();
    }
    return [...store.triggers];
  },

  /**
   * 监控策略整份 —— 待定事项那一行和 `/sensors` 那一页读的是同一个方法。
   *
   * 两半分别取：靶点策略读本仓库那一份（`scan/strategy-body.ts`），触发条件是这边
   * 自己的账。前一半原来现读实验台，于是它有一档「读不到」—— 那一档跟着抓取一起
   * 搬走了，现在两半都在手边，`unavailable` 永远是空的。
   */
  async getMonitorStrategy(): Promise<MonitorStrategy> {
    const strategy = scanStrategy();
    return {
      origin: strategy.origin,
      hypotheses: strategy.hypotheses,
      domains: strategy.domains,
      limits: strategy.limits,
      body: strategy.body,
      triggers: sensorTargets(),
      ...(store.monitorFocus ? { focus: clone(store.monitorFocus) } : {}),
    };
  },

  /**
   * 他当面交代一句「下一轮多盯着点什么」。**空串就是撤掉这句交代。**
   *
   * 它落在 `inputs[0].q` 上，只改下一轮的取向，不动时窗与阈值 ——
   * 为什么这一条存在这一侧、以及它到底能改什么，写在 `MonitorFocus` 上。
   *
   * 打字和说话进的是同一个方法：语音只是把这个框填上，最后按下「交代下去」的
   * 仍然是他自己。识别错字他能在按之前改掉，所以这里不需要分「打的还是说的」——
   * 分了反而要在屏幕上替一句他已经确认过的话打上「可能听错」的标。
   *
   * 返回整份策略：这一页的其余部分（域、口径、触发条件）跟着一次答复重画，
   * 前端不用自己拼一个「大概是这样」的新状态。
   */
  async setMonitorFocus(text: string): Promise<MonitorStrategy> {
    const said = text.trim();
    if (said.length > 300) {
      throw new ApiError(
        "这句交代太长了 —— 它是给下一轮扫描定取向的一句话，不是一份策略。",
      );
    }
    store.monitorFocus = said ? { text: said, at: nowIso() } : null;
    persistSoon();
    return api.getMonitorStrategy();
  },

  // -------------------------------------------------------------------------
  // 页面1 待定事项 —— 提请卡与三键处置
  // -------------------------------------------------------------------------

  /**
   * 某一天的提请。处置过的卡带着处置结果继续返回，这一天的账保持完整。
   * 没有 digest 的日子是安静的一天，不是错误。
   */
  /**
   * 提请台上摊开的那几张。
   *
   * 当天没有摘要时**回落到最近一批**，不返回空。
   *
   * 理由：TODAY 改成真实日期之后，一号位周一用完、周二回来，当天的摘要不存在
   * （雷达还没做，没有东西在按天产生新批次），提请台会是空的 —— 而屏幕上「空」
   * 的含义是「都处理完了」。那些卡一张都没被处置，说成处理完了是撒谎。
   *
   * 等雷达接上、真的每天有新批次进来，这条回落自然不会被触发。
   */
  async listPending(date: string = seed.TODAY): Promise<Card[]> {
    await sleep();
    const digest = digestFor(date);
    if (!digest) return [];
    return digest.cardIds
      .map((id) => store.cards.find((c) => c.id === id))
      .filter((c): c is Card => Boolean(c))
      .map(withPre);
  },

  /** 这份数据的「今天」。信号卡上「今日新」的判据。 */
  today: seed.TODAY,

  /**
   * 待定区：被「待定」收起来的低优先级信号。它们没有被丢掉 —— 待定是一次留痕的
   * 处置，随时可以从这里升级为深度研究。
   */
  async listParked(): Promise<Card[]> {
    await sleep(160, 340);
    return store.cards
      .filter((c) => c.disposedAs === "watch")
      .map(withPre)
      .sort((a, b) => (b.disposedAt ?? "").localeCompare(a.disposedAt ?? ""));
  },

  /** 潜在议题的处置记录：每个被发现的信号最终去了哪。最新在上。 */
  async listSignalLog(): Promise<SignalLogEntry[]> {
    await sleep(160, 340);
    return store.cards
      .filter((c): c is Card & { disposedAs: CardDisposition } =>
        Boolean(c.disposedAs),
      )
      .map((c) => {
        const issue = findIssue(c.issueId);
        return {
          card: clone(c),
          issueId: issue.id,
          issueTitle: issue.title,
          disposition: c.disposedAs,
          at: c.disposedAt ?? c.createdAt,
          ...(issue.assigneeName ? { assigneeName: issue.assigneeName } : {}),
        };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  },

  /**
   * 待挑的信号：**未处置的那些**，分数高的在前，同分先来的在前。
   *
   * **不在这里再过一遍阈值**（rollout §9）：线上一装过滤器，实验台调出来的阈值就
   * 不再是最终阈值，那次调参就白做了。差一点的信号摊在屏幕上不伤人 —— 他没挑的
   * 那几条本身就是对阈值最好的标注。
   *
   * 处置过的不出现在这里，也没有第二个读它的方法：**v1 只记不读**（rollout §5）。
   */
  async listInboxSignals(): Promise<InboxSignal[]> {
    await sleep(160, 340);
    /*
     * 两段排序。**人报的整段在前面**，段内按收件时间倒序（最新的在上）；抓取的那段
     * 按分数。
     *
     * 为什么不给人报的算一个分数插进同一条序里：那个分数只能是编的。而这条序要
     * 表达的东西本来就不是「分数谁高」，是「先看哪一条」—— 一个同事把名字押在
     * 一条线索上，它就该在机器打的 4.9 前面，而且这一侧一个月也就那么几条。
     */
    const open = store.inboxSignals
      .filter((s) => !s.disposedAs)
      .map((s) => clone(s));
    const reported = open
      .filter(
        (s): s is ReportedSignalInput & InboxSignalMeta =>
          s.kind === "reported",
      )
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    const crawled = open
      .filter(
        (s): s is CrawledSignalInput & InboxSignalMeta => s.kind === "crawled",
      )
      .sort(
        (a, b) => b.score - a.score || a.receivedAt.localeCompare(b.receivedAt),
      );
    return [...reported, ...crawled];
  },

  /**
   * 每一轮扫描提名了什么 —— **处置过的也在里面**，按扫描批次分组用。
   *
   * 这一条明确推翻了上面那句「处置过的没有第二个读它的方法」。理由是一号位的原话：
   * agent 在「这条信号会不会动到公司战略」这一步的判断不一定比他深，所以他要能回头
   * 瞅一眼机器提名了什么、以及每一条最后去了哪 —— 包括被 A1a 判成噪音的那些。
   * 只写不读的账等于没有账。
   *
   * 它**不是**全部抓回来的东西：没过线的那些从来没到这一侧（留在实验台那一轮里，
   * 拿 `runId` 可查）。收件柜封顶 200 条，满了先丢已处置的，所以这份记录会从尾巴
   * 上变短 —— 屏幕上要照实说这件事。
   *
   * **只返回抓取的那一支**：人报的没有 runId / scannedAt，放不进「按扫描批次分组」。
   *
   * ## `rounds` 为什么跟着这一趟一起回来
   *
   * 每一轮扫描本身的账（`ScanRound`，包括**过线零条**的那些）和信号是两份数据，
   * 但屏幕上是同一份清单。分成两个读口的话，那一页会先按信号画完、再在一两百毫秒后
   * 把「这一轮没有过线的东西」插进去 —— 一轮都没收到东西的时候更糟：空态那句
   * 「还没有扫描记录」会先断言一件不真的事，然后自己改口。
   */
  async listNominatedSignals(): Promise<{
    rounds: ScanRound[];
    signals: InboxSignal[];
  }> {
    await sleep(160, 340);
    const signals = store.inboxSignals
      .filter(
        (s): s is CrawledSignalInput & InboxSignalMeta => s.kind === "crawled",
      )
      .map((s) => clone(s))
      .sort(
        (a, b) =>
          (b.scannedAt || b.receivedAt).localeCompare(
            a.scannedAt || a.receivedAt,
          ) || b.score - a.score,
      );
    const rounds = store.scanRounds
      .map((r) => clone(r))
      .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
    return { rounds, signals };
  },

  /**
   * 扫描的节奏：**从实际发生过的轮次里算**，不是拄一个周期数。
   *
   * 真正的定时器在抓取作业那一侧（不在这个仓库里），本仓库是被动收件方，读不到
   * 对面的定时配置。能说的只有这一张台账上真来过几轮、隔多久来一轮 —— 而对面停摆时
   * 恰恰只有这一个数字会跟着变，那句手写的「每天一轮」不会。
   *
   * 算法在 `scanCadence` 里（纯函数，单测在 `scan/cadence.test.ts`）。这一层只负责把台账
   * 递过去：只读，不改任何东西。
   */
  async getScanCadence(): Promise<ScanCadence> {
    await sleep(100, 220);
    return scanCadence(store.scanRounds);
  },

  /** 三键处置里的「待定」与「不看了」。「开成议题」走 `POST /api/agent/a1a/inbox`。 */
  async disposeInboxSignal(
    dedupeKey: string,
    action: InboxDisposition,
  ): Promise<InboxSignal> {
    await sleep(160, 320);
    const got = inboxSignalDispose(dedupeKey, action);
    if (!got) throw new ApiError(`找不到这条信号：${dedupeKey}`);
    return got;
  },

  /**
   * 一号位在待挑页上**确认**把一条信号升级成潜在议题。
   *
   * ## 为什么这一下不等模型
   *
   * 确认那一句话的意思是「这件事值得占我的时间」——**那是他的判断，不是模型的**。
   * 让它等一两分钟的 A1a 跑完再落地，等于把他刚做的决定挂起，屏幕上还得替这段等待
   * 编一个状态。所以这里当场就建：一条 `Candidate` 议题、一张摊在今天那一批里的卡、
   * 一轮预研、一条时间线。他松手的那一刻，潜在议题那一屏上就有它了。
   *
   * A1a 随后照跑（待挑页那条 route 起的），但它此刻的职责只剩**写四块框架**，
   * 跑完由 `patchSignalIssueFraming` 补到这条已经存在的议题上。选路那一步的结论仍然
   * 记在 `judged.route` 上 —— 它不再决定这条议题的生死，但「参谋当时怎么看」是一条
   * 要留的账。
   *
   * ## 标题是他给的
   *
   * 默认值是屏幕上那条信号自带的「建议方向」（扫描那一步就写好的一句问题句），他可以
   * 原样确认，也可以改。改过的那句**不许被模型的版本覆盖**——确认这一步的全部意义就
   * 在这里。
   *
   * ## 处置就地记下
   *
   * `disposedAs: "issue"` 当场标上，所以这条信号下一次进这一页就不在了（列表按它过滤）。
   * 屏幕上那一行留着不动、换成一块「已升级」的深色块，是前端的事（同三键处置那条规矩：
   * 按下去屏幕不跳走）。
   */
  async upgradeSignal(dedupeKey: string, title: string): Promise<{ issueId: string }> {
    await sleep(200, 420);
    const text = title.trim();
    if (!text) throw new ApiError("议题不能是空的。");

    const sig = store.inboxSignals.find((s) => s.dedupeKey === dedupeKey);
    if (!sig) throw new ApiError(`找不到这条信号：${dedupeKey}`);

    /* 同一条信号不许立两次案（同 `applyA1aInbox` 与 `openIssueAnyway` 那道闸）。 */
    const already = issueOfSignal(sig);
    if (already && store.issues.some((i) => i.id === already)) {
      throw new ApiError(`这条信号已经开成议题 ${already} 了。`);
    }

    const { issue, at, pre } = landSignalIssue(sig, { title: text, framing: null, out: {} });

    const who = viewer().name;
    pushEvent(issue.id, {
      id: `E-${issue.id}-raised`,
      kind: "state",
      at,
      headline: "议题提出（一号位在待挑页确认升级）· 待处置",
      actor: who,
      detail: [
        `${who} 把这条信号确认升级成潜在议题。标题是他确认的那一句：${text}`,
        sig.kind === "reported" ? `信号来自 ${sig.by} 的上报。` : `信号来自 ${sig.source || "抓取"}。`,
        "四块框架由随后那一轮 A1a 补上；补不上就空着，不编。",
        pre.status === "running" ? "预研已经在跑了。" : "",
      ]
        .filter(Boolean)
        .join("\n"),
      defaultOpen: true,
    });

    sig.issueId = issue.id;
    if (!sig.disposedAs) {
      sig.disposedAs = "issue";
      sig.disposedAt = at;
    }

    persistSoon();
    return { issueId: issue.id };
  },

  /**
   * A1a 判这条不值得开成议题，一号位不采纳这条判断，仍然开。
   *
   * ## 为什么标题必须由他给
   *
   * 判为噪音那条路上模型**没有产出过任何议题正文**（`applyA1aInbox` 的 `ignore` 支
   * 一个对象都不建）。没有可回落的东西：拿信号原标题顶上去，池子里就会多一条标题
   * 是一家媒体的稿件标题的议题；让模型再跑一轮起标题，等于用另一次调用绕开他刚刚
   * 否掉的那次判断。所以这一下要他自己说清这件事是什么。
   *
   * ## 这条议题和 A1a 判为值得开出来的那条差在哪
   *
   * 建法共用 `landSignalIssue`（议题、卡、今天这一批、一轮预研、锚哪条判断），
   * 三处有意不同：
   *
   *   1. **仍然算信号来的**（`origin: "signal"`，卡的来源照 `sig.kind` 走）。它确实是
   *      从一条信号来的，改记成「他自己想的」是抹掉来路。
   *   2. **没有那四块框架**（`Card.framing` 是 `undefined`）。模型在这条路上根本没产出
   *      它们，编一份比没有更坏。
   *   3. **时间线上明写这次分歧** —— 参谋判了什么、他决定了什么。半年后回看，
   *      「我们看过、参谋说不用、我坚持要看」是一条完整的判断记录，丢了就找不回来。
   *
   * 处置这一格不动：起 A1a 那一下（`/api/agent/a1a/inbox`）在跑之前就把这条信号标成
   * 了 `disposedAs: "issue"`，这里再标一次只会把处置时刻推后。
   */
  async openIssueAnyway(dedupeKey: string, title: string): Promise<Issue> {
    await sleep(200, 420);
    const text = title.trim();
    if (!text) throw new ApiError("议题不能是空的。");

    const sig = store.inboxSignals.find((s) => s.dedupeKey === dedupeKey);
    if (!sig) throw new ApiError(`找不到这条信号：${dedupeKey}`);

    /* 同一条信号不许立两次案（同 `applyA1aInbox` 那道闸，理由也一样）。 */
    const already = issueOfSignal(sig);
    if (already && store.issues.some((i) => i.id === already)) {
      throw new ApiError(`这条信号已经开成议题 ${already} 了。`);
    }

    const { issue, at, pre } = landSignalIssue(sig, {
      title: text,
      framing: null,
      out: {},
    });

    const who = viewer().name;
    const judged = sig.judged;
    pushEvent(issue.id, {
      id: `E-${issue.id}-raised`,
      kind: "state",
      at,
      headline: "议题提出（参谋判不值得，一号位仍决定开）· 待处置",
      actor: who,
      /*
       * 这一段是台账，不是屏幕文案：它要答的是「半年后回看，当时到底发生了什么」。
       * 参谋判了什么（哪次运行、什么时候）、他决定了什么（不采纳、标题是他自己写的），
       * 两件事都得在。少任何一件，剩下的那件都会被读成「系统当时就是这么建的」。
       */
      detail: [
        judged
          ? `A1a 运行 ${judged.runId} 在 ${formatStamp(judged.at)} 判这条不值得开成议题。`
          : "A1a 判这条不值得开成议题。",
        `${who} 不采纳这条判断，仍然开成议题。标题是他自己写的：${text}`,
        "这条议题没有 A1a 的四块框架 —— 判不值得那条路上模型没有产出它们。",
        pre.status === "running" ? "预研已经在跑了。" : "",
      ]
        .filter(Boolean)
        .join("\n"),
      defaultOpen: true,
    });

    /*
     * 把编号记回这条信号。**只在 A1a 真判过的时候记** —— `judged` 的另外三格
     * （runId / status / at）说的是那次运行，这里编不出来，缺了就不许伪造一条。
     */
    if (judged) judged.issueId = issue.id;

    persistSoon();
    return hydrateIssue(issue);
  },

  /**
   * DRI 上报一条信号。四个字段（spec §3.1）：一句话 / 出处 / 为什么是现在 /
   * 动摇哪条判断（可空）。
   *
   * **不进一号位的任何「今日」视图** —— 他在待挑页里挑，和抓取作业推进来的
   * 那些排在一起。
   */
  async submitDriSignal(input: {
    title: string;
    source: string;
    text: string;
    why: string;
    url?: string;
    shakes?: string;
  }): Promise<InboxSignal> {
    await sleep(220, 460);
    const title = input.title.trim();
    if (!title) throw new ApiError("一句话总得有 —— 这条信号是什么。");

    const me = viewer();
    const trimmedUrl = input.url?.trim() || "";
    const url = trimmedUrl ? normalizeUrl(trimmedUrl) : "";
    return reportSignal({
      kind: "reported",
      by: me.name,
      dedupeKey: url || reportedKey(me.name, title, seed.TODAY),
      title,
      url,
      text: input.text.trim(),
      publishedAt: "",
      source: input.source.trim(),
      why: input.why.trim(),
      ...(input.shakes?.trim() ? { shakes: input.shakes.trim() } : {}),
    });
  },

  /** 「我上报的被怎么处置了」。只有他自己那几条。 */
  async listMyReports(): Promise<DriReportedSignal[]> {
    await sleep(120, 260);
    const me = viewer().name;
    return store.inboxSignals
      .filter((s) => s.kind === "reported" && s.by === me)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .map((s) => ({
        dedupeKey: s.dedupeKey,
        title: s.title,
        receivedAt: s.receivedAt,
        ...(s.disposedAs
          ? { disposedAs: s.disposedAs, disposedAt: s.disposedAt }
          : {}),
        ...(s.judged?.issueId ? { issueId: s.judged.issueId } : {}),
      }));
  },

  /**
   * 上报表单里「动摇哪条判断」那个下拉。
   *
   * **只给他自己域的在版判断，且只给 id 和陈述** —— DRI 同步边界是分层的
   * （HANDOFF §10）：判断本体的依据、修订史、Re-open Trigger 都不在这一侧。
   */
  async listMyDomainJudgments(): Promise<{ id: string; statement: string }[]> {
    await sleep(80, 180);
    const me = viewer();
    const mine = new Set(
      allDomains.filter((d) => d.driIds.includes(me.id)).map((d) => d.id),
    );
    return store.judgments
      .filter((j) => mine.has(j.domainId) && j.standing !== "dropped")
      .map((j) => ({ id: j.id, statement: j.statement }));
  },

  /**
   * 派给我的研究任务。
   *
   * **只认显式点名**（`handoffStatus` 上那段注释说过为什么不按域回落：那会让
   * 一个人同时「欠」着九件他从来没被要求过的事）。
   */
  async listMyHandoffs(): Promise<import("./types").DriHandoff[]> {
    await sleep(140, 300);
    const me = viewer().name;
    return store.issues
      .filter((i) => i.assigneeName === me)
      .map((issue) => {
        const q = store.framed[issue.id] ?? store.decisionQuestions[issue.id];
        const brief = store.briefs[issue.id];
        // 从时间线里找回传事件，取最后一条的时间。
        const timeline = store.timelines[issue.id] ?? [];
        const reportEvents = timeline.filter((e) =>
          e.id.startsWith(`E-${issue.id}-dri-report-`),
        );
        const submittedAt =
          reportEvents.length > 0
            ? reportEvents[reportEvents.length - 1].at
            : undefined;
        return {
          issueId: issue.id,
          title: issue.title,
          question: q?.text ?? "",
          deadline: q?.deadline ?? "",
          assignedAt: assignedAtOf(issue),
          brief: brief ? briefText(brief) : null,
          submitted: Boolean(store.driReports[issue.id]),
          submittedAt,
        };
      })
      .sort((a, b) => b.assignedAt.localeCompare(a.assignedAt));
  },

  /**
   * 回传一份研究。**产物就是现有的 `ResearchDoc`，不新建类型**（spec §3.2）：
   * 一号位那侧的议题研究页读的是同一个对象，于是「人查的」和「机器查的」在
   * 屏幕上是同一种东西的两个来源，而不是两套页面。
   *
   * 每一句盖 `{kind:"human", source:"<姓名>（<域> DRI）"}` —— `TraceKind` 里
   * `"human"` 这一档就是为此存在的。`byAgentLabel` 写人名，不写 Agent 名。
   */
  async submitDriReport(
    issueId: string,
    doc: {
      sourceText: string;
      judgment: string[];
      keyEvidence: string[];
      counters: string[];
      unknowns: string[];
      routeSuggestion: string;
    },
  ): Promise<import("./types").DriHandoff> {
    await sleep(320, 640);
    const issue = findIssue(issueId);
    const me = viewer();
    if (issue.assigneeName !== me.name) {
      throw new ApiError("这件事不是派给你的。");
    }

    const domain = allDomains.find((d) => d.id === issue.domainId);
    const source = `${me.name}（${domain?.name ?? "未定域"} DRI）`;
    const lines = (xs: string[]): Statement[] =>
      xs
        .map((t) => t.trim())
        .filter(Boolean)
        .map((text) => ({
          text,
          traces: [{ kind: "human" as const, source }],
        }));

    const sections = {
      judgment: lines(doc.judgment),
      keyEvidence: lines(doc.keyEvidence),
      counters: lines(doc.counters),
      unknowns: lines(doc.unknowns),
    };
    const total = Object.values(sections).reduce((n, xs) => n + xs.length, 0);
    if (total === 0) {
      /*
       * 空回传要拒。它在屏幕上和一份真的回传长得一模一样（「已回传」那一行会亮），
       * 于是一号位会以为这件事有人查过了 —— 那比没有回传坏得多。
       */
      throw new ApiError(
        "四节里总得有一句 —— 一份空的回传会被读成「查过了」。",
      );
    }

    store.driReports[issueId] = {
      issueId,
      ...sections,
      routeSuggestion: doc.routeSuggestion.trim(),
      byAgentLabel: source,
      /* 装配清单：他这一份是人查的，来源只有他自己。不编一条 Context 进来。 */
      assembledFrom: [{ label: source, kind: "human" }],
      ...(doc.sourceText.trim() ? { sourceText: doc.sourceText.trim() } : {}),
    };

    const at = nowIso();
    touch(issue, at);
    pushEvent(issueId, {
      id: `E-${issueId}-dri-report-${at}`,
      kind: "judgment",
      at,
      headline: `承接研究回传 · ${me.name}`,
      actor: me.name,
      detail: sections.judgment[0]?.text ?? "",
      defaultOpen: true,
    });

    /*
     * 回传这一下才推状态到待上会。
     *
     * 上一版模拟代码替 DRI 把这一步在 `escalate` 里做了（理由写在那个方法头上）。现在
     * 等的是一个真人，他交出东西那一刻，这件议题才客观上「方案到位，可以上会」。
     *
     * 两道闩：
     *
     * · 已经确认过写回的不再推。分流 C（补证据）会把一件已经拍过板的议题设回
     *   `WaitingEvidence` 等新证据（见 `confirmClosure`），此时上一轮的 `writeBack`
     *   已经写在草案上。再推一次「待上会」，屏幕会把他指回一份**写着结果的旧账**。
     *   这一轮要重新起草才算数，而起草时机不在这个任务里改。
     * · 「会前准备已就绪」只在会前准备真的装出来时才写。`briefs[issueId]` 是
     *   `escalate` 现装的，而 `synthBrief` 没有深研报告就返回 null —— 无条件写这句话，
     *   他点进去撞到的是 `getBrief` 抛的「议题 X 还没有会前准备。」，同一屏上还有
     *   `briefReady: false` 和它对着打。
     */
    const closureConfirmed = Boolean(store.closureDrafts[issueId]?.writeBack);
    if (issue.state === "WaitingEvidence" && !closureConfirmed) {
      issue.state = "ReadyForDecision";
      if (store.briefs[issueId]) issue.nextActionForUser = "会前准备已就绪";
      pushEvent(issueId, {
        id: `E-${issueId}-st-rfd-${at}`,
        kind: "state",
        at,
        headline: "状态迁移 等证据 → 待上会",
        actor: "系统",
        defaultOpen: true,
      });
    }

    persistSoon();

    const mine = await api.listMyHandoffs();
    return mine.find((h) => h.issueId === issueId)!;
  },

  // -------------------------------------------------------------------------
  // Commitment —— 纲领在 store 上的读写
  // -------------------------------------------------------------------------

  /**
   * DRI 读自己域的那几份承诺。**只返回我的域**（过滤在服务端）。
   *
   * `periodId` 可空：不传就用活动周期。这样 DRI 首页可以直接调用而不用关心当前是哪一期。
   */
  async listMyCommitments(
    periodId?: string,
  ): Promise<import("./types").CommitmentScreen[]> {
    await sleep(180, 350);
    const me = viewer();
    const myDomains = allDomains.filter((d) => d.driIds.includes(me.id));
    const actualPeriodId = periodId ?? activePeriod().id;
    const mine = store.commitments
      .filter(
        (c) =>
          c.periodId === actualPeriodId &&
          myDomains.some((d) => d.id === c.domainId),
      )
      .map((c) => screenOf(c));
    return mine;
  },

  /**
   * DRI 提交回传。`proposed` 字段照录原值 —— 公司提案原文不是 DRI 能改的。
   */
  async submitCommitment(
    id: string,
    draft: {
      northStar: string;
      items: {
        id: string;
        verdict: "accept" | "modify" | "rewrite" | "reject";
        reason?: string;
        evidence: string[];
        milestone: { companyGate?: string; own?: string };
        tier: "acceptance" | "required";
      }[];
      assumptions: { text: string; defaultPath: string; dueOn?: string }[];
      preconditions: string[];
      questions: {
        text: string;
        toWhom: string;
        needBy: string;
        closed: boolean;
      }[];
      note: string;
    },
  ): Promise<import("./types").CommitmentScreen> {
    await sleep(260, 520);
    const c = findCommitment(id);
    const domain = allDomains.find((d) => d.id === c.domainId);
    if (!domain?.driIds.includes(viewer().id)) {
      throw new ApiError("这不是你的域。");
    }
    if (draft.preconditions.length > 2) {
      throw new ApiError("生效前提最多两条 —— 超过两条就不是前提，是计划。");
    }

    /* 按 id 对齐条目，proposed 照录原值。 */
    const next: typeof c = {
      ...c,
      northStar: draft.northStar.trim(),
      items: c.items.map((orig) => {
        const incoming = draft.items.find((i) => i.id === orig.id);
        if (!incoming) return orig;
        return {
          ...orig,
          proposed: orig.proposed,
          verdict: incoming.verdict,
          reason: incoming.reason?.trim(),
          evidence: incoming.evidence.map((e) => e.trim()).filter(Boolean),
          milestone: incoming.milestone,
          tier: incoming.tier,
        };
      }),
      assumptions: draft.assumptions.map((a) => ({
        text: a.text.trim(),
        defaultPath: a.defaultPath.trim(),
        ...(a.dueOn ? { dueOn: a.dueOn } : {}),
      })),
      preconditions: draft.preconditions.map((p) => p.trim()).filter(Boolean),
      questions: draft.questions.map((q) => ({
        text: q.text.trim(),
        toWhom: q.toWhom.trim(),
        needBy: q.needBy,
        closed: q.closed,
      })),
    };

    const submitted = submitDraft(next, {
      actor: viewer().name,
      at: nowIso(),
      note: draft.note,
    });

    /* 写回 store */
    const idx = store.commitments.findIndex((x) => x.id === id);
    if (idx >= 0) store.commitments[idx] = submitted;

    persistSoon();
    return screenOf(submitted);
  },

  /**
   * 读一条承诺的完整内容。CEO 侧与 DRI 侧都用这个。
   */
  async getCommitment(id: string): Promise<import("./types").CommitmentScreen> {
    await sleep(140, 280);
    return screenOf(findCommitment(id));
  },

  /**
   * 一号位逐条裁决。
   */
  async adjudicateCommitment(
    id: string,
    rulings: Record<
      string,
      { verdict: "endorse" | "revise" | "reject"; note: string }
    >,
  ): Promise<import("./types").CommitmentScreen> {
    await sleep(300, 600);
    const c = findCommitment(id);
    const adjudicated = adjudicate(c, rulings, {
      actor: viewer().name,
      at: nowIso(),
    });

    const idx = store.commitments.findIndex((x) => x.id === id);
    if (idx >= 0) store.commitments[idx] = adjudicated;

    persistSoon();
    return screenOf(adjudicated);
  },

  /**
   * 一号位签一次，生效。此后只读。
   */
  async signCommitment(
    id: string,
  ): Promise<import("./types").CommitmentScreen> {
    await sleep(180, 360);
    const c = findCommitment(id);
    const effective = makeEffective(c, {
      actor: viewer().name,
      at: nowIso(),
    });

    const idx = store.commitments.findIndex((x) => x.id === id);
    if (idx >= 0) store.commitments[idx] = effective;

    persistSoon();
    return screenOf(effective);
  },

  /**
   * 「主动开始扫描」：真的去实验台起一轮抓取。
   *
   * 常态仍然是实验台自己定时推过来（`scripts/catch.py`），这个方法只是把**发起权**
   * 交到一号位手上 —— 空屏上他按一下，抓的是同一套靶点、同一批阈值。
   *
   * 不 await 那一轮：整轮是分钟级的真实抓取 + 模型研判，挂在这个请求上必然超时。
   * 起完就返回当下状态，进度由 `scanStatus` 轮询。
   */
  async startScan(): Promise<ScanState> {
    return startScan();
  },

  /** 那一轮到哪一步了。前端在跑的时候轮询这个。 */
  async scanStatus(): Promise<ScanState> {
    return scanState();
  },

  /** agent 运行记录。最新在上。 */
  async listAgentRuns(agent?: string): Promise<AgentRunRecord[]> {
    await sleep(120, 260);
    return store.agentRuns
      .filter((r) => !agent || r.agent === agent)
      .map((r) => withSnapshotState(clone(r)))
      .reverse();
  },

  async getAgentRun(id: string): Promise<AgentRunRecord | null> {
    await sleep(80, 160);
    const hit = store.agentRuns.find((r) => r.id === id);
    return hit ? withSnapshotState(clone(hit)) : null;
  },

  /**
   * 议题去向记录：全部议题时间线上的组织动作，摊成一条流水。只取导向判断的那几类
   * （状态迁移 / 交接 / 深研 / 决策），过程性内容（对谈、信号）不进这份账。
   */
  async listIssueLog(): Promise<IssueLogEntry[]> {
    await sleep(200, 420);
    const KINDS: TimelineEventKind[] = [
      "state",
      "handoff",
      "deep",
      "decision",
      "judgment",
    ];
    const entries: IssueLogEntry[] = [];
    for (const [issueId, events] of Object.entries(store.timelines)) {
      const issue = store.issues.find((i) => i.id === issueId);
      if (!issue) continue;
      for (const e of events) {
        if (!KINDS.includes(e.kind)) continue;
        entries.push({
          at: e.at,
          issueId,
          issueTitle: issue.title,
          kind: e.kind,
          headline: e.headline,
          ...(e.actor ? { actor: e.actor } : {}),
        });
      }
    }
    return entries.sort(compareIssueLogByTime);
  },

  /** 没出卡的账。预算制要可信，被压下去的就得摊开、可核对。 */
  async listWithheld(date: string = seed.TODAY): Promise<WithheldItem[]> {
    await sleep();
    const day = store.withheld.find((w) => w.date === date);
    return clone(day?.items ?? []);
  },

  /** 「这个我要看」。捞回一条被压下的信号，出卡门槛按这次校准。 */
  async reclaimWithheld(id: string): Promise<WithheldItem> {
    await sleep(320, 700);
    const item = store.withheld
      .flatMap((w) => w.items)
      .find((i) => i.id === id);
    if (!item) throw new ApiError(`找不到这一条（${id}）。`);
    item.requestedAt = nowIso();
    item.requestedNote =
      "已记下 · 明早以完整提请出卡；这类信号的门槛也按这次校准";
    return clone(item);
  },

  /**
   * 三键处置：采信 / 观察 / 搁置。Signal 永远不会自动
   * 升级为组织任务，确认权在这一下点击里。
   */
  /** 可指派的承接人（负责人层）。「深研并指派」那个下拉的封闭集合。 */
  /**
   * 指派列表。**每个人带上他管的域**（见 `DriOption`）。
   *
   * 管着域的排在前面，按域编号；剩下的按原顺序跟在后面。排序不是整理癖：这份名单在
   * 屏幕上要被扫着找人，而「他管哪一摊」正是找的时候用的那条线索 —— 把有域的和没域的
   * 混着排，那条线索就断了。
   *
   * 一个域都不管的人**照旧在名单里**：指派给他们是正常的（有些承接人本来就不是任何一个
   * 域的负责人），把他们摘出去等于用一条排序规则悄悄削掉一项能力。
   *
   * ## 岗位占位不进这份名单
   *
   * 本体里有六条是**岗位**不是人（「CEO」「业务负责人」「产品负责人」…，各自的说明里
   * 写着「在位人待确认」）。它们在这份名单里没有位置，两条理由：
   *
   *   1. **一件事只能派给一个人。** 派给「产品负责人」等于派给一个还没有名字的位置 ——
   *      屏幕上那一行看起来和真派过一模一样，而没有任何人收到它。真名那几位已经把
   *      「谁管这一摊」说清了（每行后面跟着他管的域编号）。
   *   2. **「CEO」这一条尤其不该在。** 这个界面就是给一号位用的，他不需要在名单里找到
   *      自己 —— **不选人就是留给自己**（会后那张卡上的「自己留着」说的就是这件事）。
   *
   * 判据取的是那句「在位人待确认」，不是列一张 id 的黑名单：种子是从本体生成的
   * （`scripts/gen-seed-from-ontology.mjs`），列 id 的话，本体那边补上在位人、或者再多
   * 一个岗位，这份名单就会静默地不对 —— 而它错的样子是「多了一个点得动的位置」。
   *
   * 域那一列不受这条影响：某个域的 DRI 此刻确实还是一个岗位，屏幕上照实写岗位名
   * （见 `listDomains`）。**能不能派给它**和**它是谁**是两个问题。
   */
  async listDris(): Promise<DriOption[]> {
    await sleep(60, 140);
    const rows = tk.people
      .filter((p) => p.role === "dri" && !p.title.includes("在位人待确认"))
      .map((p) => ({
        id: p.id,
        name: p.name,
        title: p.title,
        domains: tk.domains
          .filter((d) => d.driIds.includes(p.id))
          .sort((a, b) => a.code.localeCompare(b.code))
          .map((d) => ({ code: d.code, name: d.name })),
      }));
    // 稳定排序：只把「有域的」提到前面，各自内部保持原顺序。
    return [
      ...rows.filter((r) => r.domains.length).sort((a, b) => a.domains[0].code.localeCompare(b.domains[0].code)),
      ...rows.filter((r) => !r.domains.length),
    ];
  },

  /**
   * 首页左下的业务域列表：域、DRI、手上有几件在办议题。
   *
   * 这里返回的是**词元云集自己的八个域**（本体的 D-01…D-08）。读者是这家公司的
   * CEO，他的业务域就是这八个；`ad.bizDomains` 那三块集团生意是王总那一层的，
   * 摆在这块屏幕上等于把别人的分工端给他看。
   *
   * DRI 那一栏可能是**岗位名而不是人名**（「CEO」「产品负责人」）—— 本体里这八个域
   * 的直接责任方现在就是岗位，六个岗位的说明里都写着「在位人待确认」。屏幕上照实
   * 写岗位，不替他填人。
   */
  async listDomains(): Promise<DomainSummary[]> {
    await sleep(120, 260);
    const settled = new Set(["Decided", "Monitoring", "Closed", "Dismissed"]);
    return tk.domains.map((d) => ({
      id: d.id,
      code: d.code,
      name: d.name,
      outcome: d.outcome,
      driName: domainDriLabel(d),
      /*
       * 「在办」= 已经决定要研究、还没了结的。`Candidate` 不算 —— 它还在左上角
       * 那扇窗里等他看一眼，把它算进来，这个数字就变成「今天有多少条信号」，
       * 而不是「这块生意上我手里压着几件事」。
       */
      openIssues: store.issues.filter(
        (i) =>
          i.domainId === d.id &&
          i.state !== "Candidate" &&
          !settled.has(i.state),
      ).length,
    }));
  },

  /**
   * 首页右栏：Agent 对一件战略议题的参谋意见。全部从当下的对象现算，报告没好就
   * 照实说研究在跑 —— 这一栏不允许出现一句没有出处的立场。
   */
  async getIssueCounsel(issueId: string): Promise<IssueCounsel> {
    settleResearch();
    await sleep(220, 440);
    const issue = findIssue(issueId);
    const doc = store.researchDocs[issueId];
    const rounds = agentRounds(issueId);
    const irs = (store.probeNodes[issueId] ?? []).filter(
      (ir) => ir.revealAfterRound <= rounds,
    );
    const pendingCandidates = irs.filter((ir) => ir.standing === "direction");
    const rawCount = irs.filter((ir) => ir.standing === "raw").length;

    const briefReady =
      Boolean(store.briefs[issueId]) &&
      (issue.state === "ReadyForDecision" ||
        issue.state === "Decided" ||
        issue.state === "Monitoring");

    return {
      issue: summarize(issue),
      ...(doc?.judgment[0] ? { stance: doc.judgment[0].text } : {}),
      pendingCandidates: clone(pendingCandidates),
      rawCount,
      ...(doc?.counters[0] ? { strongestCounter: doc.counters[0].text } : {}),
      unknowns: (doc?.unknowns ?? []).map((s) => s.text),
      judgments: issue.judgmentRefs
        .map((id) => clone(findJudgment(id)))
        .sort(byStanding),
      briefReady,
      ...(issue.assigneeName ? { assigneeName: issue.assigneeName } : {}),
      researchReady: Boolean(doc),
    };
  },

  /**
   * 这件议题的全部研究报告，按页签排好。
   *
   * 顺序：同一轮深研那三条链路（DeepSeek → Claude → ChatGPT）→ 被指派 DRI 的承接研究。
   * 前面几栏出自同一次深研，最后一种是另一个立场 —— 页签上都署名，不混排。
   *
   * 三条链路之间的顺序**在这里排**，按产出带过来的 `tabOrder`（钉在 `a4/run.ts` 的链路表
   * 上）。不能照数组原样：主源那一条排在最后一栏，而它在数据里是单独一份文档（`agentDoc`）、
   * 不在 `altReports` 里 —— 照原样就是把它顶到第一栏。老数据没有 `tabOrder`，那时候主源
   * 确实是第一栏，回落成原来那个顺序。
   */
  async listReports(issueId: string): Promise<IssueReport[]> {
    settleResearch();
    ensureDeepResearch(issueId);
    await sleep(200, 400);
    const issue = findIssue(issueId);
    const out: IssueReport[] = [];
    const agentDoc = store.researchDocs[issueId];
    if (agentDoc) {
      /*
       * 页签名取产出自己带的那个（「ChatGPT」）。`sourceLabel` 是空的只有一种情形：那份是
       * 只有一份原件那会儿落的库 —— 那时候屏幕上就一栏，回落成「深研报告」是对的。
       *
       * **不在这里按 `modelAlias` 拼名字**：那等于在数据层再维护一张别名到中文的对照表，
       * 而换模型时没人会想起去改它。名字由跑它的那一轮给（`a4/run.ts` 的链路表）。
       */
      const round: { order: number; item: IssueReport }[] = [
        {
          order: agentDoc.sourceTabOrder ?? -1,
          item: {
            key: "agent",
            label: agentDoc.sourceLabel ?? "深研报告",
            doc: clone(agentDoc),
          },
        },
      ];
      /*
       * 主源之外那几条链路各自跑出来的一份。它们**不是 `ResearchDoc`**：四节是主源那一份
       * 压出来的，挂到这几份上等于把主源写的话署到别人名下，留空又会让页签切过去得到一份
       * 空报告。所以走 `source` 那一支（见 `IssueReport`），只有正文。
       *
       * **装配清单和用时各取自己那一份**，不再抄主源的。三条链路各自编命题、各自联网取证，
       * 抓回来的页不一样、花的时间不一样 —— 抄过来就是在屏幕上把 ChatGPT 取回的页说成是
       * Claude 取回的。只有时刻（`at`）仍然共享：那是这一轮深研收尾的时刻。
       *
       * 老数据里 `assembledFrom` / `durationMs` 是没有的（那时候几份原件确实共享一套证据），
       * 缺了就不给 —— 回落到主源那一份会把那句假话重新写回屏幕上。
       *
       * `kind` / `basedOn` 原样带过去：视图不许按 label 猜，label 是文案。
       */
      for (const [i, alt] of (agentDoc.altReports ?? []).entries()) {
        round.push({
          order: alt.tabOrder ?? i,
          item: {
            // key 按 `tabOrder` 拼，和跑那一轮上报草稿时用的是同一套算法（`DraftReport.key`）。
            // 按数组下标拼的话，中间那条链路没跑成时后面那条的 key 会往前挪一格 —— 他正读着
            // 的那一栏在报告落库那一瞬换了 key，屏幕把他弹回主源。
            key: `agent:alt${alt.tabOrder ?? i}`,
            label: alt.label,
            source: {
              modelAlias: alt.modelAlias,
              text: alt.text,
              ...(alt.assembledFrom?.length
                ? { assembledFrom: clone(alt.assembledFrom) }
                : {}),
              byAgentLabel: agentDoc.byAgentLabel,
              ...(agentDoc.at ? { at: agentDoc.at } : {}),
              ...(alt.durationMs !== undefined
                ? { durationMs: alt.durationMs }
                : {}),
              ...(alt.kind ? { kind: alt.kind } : {}),
              ...(alt.basedOn?.length ? { basedOn: [...alt.basedOn] } : {}),
              // 区块那一份整份带过去，**不与正文互斥**：这一栏两面都有，页签在视图里选。
              ...(alt.blocks ? { blocks: clone(alt.blocks) } : {}),
            },
          },
        });
      }
      // 稳定排序：同一个 order 的（老数据里主源和第一份 alt 都可能算出 -1 / 0）保持原样。
      out.push(...round.sort((a, b) => a.order - b.order).map((x) => x.item));
    } else {
      /*
       * 这一轮还在跑，还没有任何东西落库 —— 但三条链路此刻各自的样子就该在页签行上
       * （见 `DraftReport`）。三条同时起跑、各要跑十几分钟、不会同时结束；等到全跑完才让
       * 页签出现，等于让他对着一行「正在深研」多坐十几分钟，而先跑完那一份早就能读了。
       *
       * 草稿的顺序**照原样**，不在这里排：产出那一轮是按链路表的顺序上报的（`a4/run.ts`
       * 的 `report()`），那就是页签行的顺序。
       *
       * **只在没有 `agentDoc` 时读这一份。** 反过来的话，重跑一轮时这一轮的草稿会和上
       * 一轮已落库的报告混在同一排页签上，而两者的 key 一样（`agent` / `agent:alt<n>`）——
       * 屏幕上表现成同一栏的正文在两份之间跳。落了库就以库为准，草稿这时已经是旧的。
       */
      const live = taskState("deep", issueId).reports ?? [];
      /*
       * 上一轮没跑完留下来的那几份原件（`UnfinishedResearchRound`）—— 进程重启之后任务表是
       * 空的，这几栏只能从库里来。
       *
       * **有活的一轮就以它为准**，理由同上面那段：两轮的页签 key 是同一套。新起的那一轮
       * 第一时间就会把几栏占位报上来，所以这里判的是「这一轮报了没有」，不是「有没有写完的」。
       *
       * 也只读**已经收场**的那一轮（`error` 有值）：在跑的那一轮的原件同样落着盘，而那一轮
       * 的几栏由上面那份进度稿摆（连秒表和步号一起），从库里再摆一遍会把一条还在跑的链路
       * 说成一份留下来的原件。
       */
      const unfinished = store.unfinishedResearch[issueId];
      const settled = unfinished?.error ? unfinished : null;
      const kept = live.length || !settled ? [] : settled.reports;
      for (const d of [...live, ...kept]) {
        if (d.text) {
          out.push({
            key: d.key,
            label: d.label,
            source: {
              modelAlias: d.modelAlias,
              text: d.text,
              byAgentLabel: d.byAgentLabel,
              ...(d.durationMs !== undefined
                ? { durationMs: d.durationMs }
                : {}),
              ...(d.kind ? { kind: d.kind } : {}),
              ...(d.basedOn?.length ? { basedOn: [...d.basedOn] } : {}),
              ...(d.blocks ? { blocks: clone(d.blocks) } : {}),
              /*
               * 留下来的那几份要在屏幕上说明白自己是哪来的（见 `ReportSource.unfinished`）。
               * 这一档只可能出自 `kept`：活着的那一轮还没结论，`unfinished` 是上一轮的事。
               */
              ...(kept.length && settled?.error
                ? {
                    unfinished: {
                      at: settled.at ?? settled.startedAt,
                      error: settled.error,
                    },
                  }
                : {}),
            },
          });
        } else {
          /*
           * 这一条还在跑（或者已经挂了）。**全是事实，一句话都不在这里编**：走到第几步、
           * 从什么时候起跑、为什么没跑成，都由那条链路自己报上来（见 `IssueReport.pending`）。
           * 那块表就是靠 `startedAt` 走的 —— 三条链路各自计时，这里少给一个字段，屏幕上
           * 那一栏就没有表。
           */
          out.push({
            key: d.key,
            label: d.label,
            pending: {
              note: d.note ?? "正在跑这一条",
              ...(d.step ? { step: { ...d.step } } : {}),
              ...(d.startedAt ? { startedAt: d.startedAt } : {}),
              ...(d.error ? { error: d.error } : {}),
              /*
               * 正文还没写完，但已经读得通的那几个块**这时候就给**（见
               * `IssueReport.pending.blocks`）。这一栏照旧是 pending：表还在走、步骤还在报，
               * 只是它已经有东西可读了。空的那份不给 —— 一份零个块的区块报告在屏幕上是一片
               * 空白，而空白答不出「是还没开始交还是交出来全被拦了」。
               */
              ...(d.blocks?.blocks.length ? { blocks: clone(d.blocks) } : {}),
            },
          });
        }
      }
    }
    /*
     * DRI 那一份：已经点名派出去就得有这个页签，即使还没回传。
     *
     * 没有页签会被读成「还没派」，而实际状态可能是已经派了三天、正等着。
     *
     * 但这个页签里**不是一份报告**，所以它不带 `doc` 而带 `awaiting`（见
     * `IssueReport`）。这里只给两个事实：等谁、从什么时候起。那句话由
     * `report-pane.tsx` 写 —— 上一版把成品文案塞成一份四节全空的 `ResearchDoc`，
     * 于是产品自己的话被摆进「报告原文」那一栏，还能被划词「记成判断」。
     *
     * 只认 `waiting`：`done` 那一档必然有 `driReports[issueId]`（见 `handoffStatus`），
     * 上面那一支已经接住了。
     */
    const driDoc = store.driReports[issueId];
    const handoff = handoffStatus(issue);
    if (driDoc) {
      out.push({
        key: "dri",
        label: `承接研究 · ${driDoc.byAgentLabel}`,
        doc: clone(driDoc),
      });
    } else if (handoff.state === "waiting") {
      out.push({
        // 页签上照抄首页那三句的口径（`home-view.tsx` 的 `HandoffStatusLine`），不另写一套。
        key: "dri",
        label: `承接研究 · 等 ${handoff.driName} 回传`,
        awaiting: { name: handoff.driName, since: assignedAtOf(issue) },
      });
    }
    return out;
  },

  /**
   * 知识关系：这件议题在本体里牵住的一切。全部取活对象 —— 图上每个点都点得开，
   * 点不开的图叫示意图，不叫知识关系。
   */
  async getIssueKnowledge(issueId: string): Promise<IssueKnowledge> {
    await sleep(240, 480);
    const issue = findIssue(issueId);
    const judgments = issue.judgmentRefs
      .map((id) => clone(findJudgment(id)))
      .sort(byStanding);
    const domain = issue.domainId ? findDomain(issue.domainId) : undefined;

    // 报告引到的内部文件
    const docIds = new Set<string>();
    const collect = (doc?: ResearchDoc) => {
      if (!doc) return;
      [
        ...doc.judgment,
        ...doc.keyEvidence,
        ...doc.counters,
        ...doc.unknowns,
      ].forEach((s) =>
        s.traces.forEach((t) => {
          if (t.href?.startsWith("/docs/"))
            docIds.add(t.href.slice("/docs/".length));
        }),
      );
      doc.assembledFrom.forEach((m) => {
        if (m.href?.startsWith("/docs/"))
          docIds.add(m.href.slice("/docs/".length));
      });
    };
    collect(store.researchDocs[issueId]);
    collect(store.driReports[issueId]);
    // 判断的依据也引文件 —— 本体这一侧的线。
    judgments.forEach((j) =>
      j.basis.forEach((s) =>
        s.traces.forEach((t) => {
          if (t.href?.startsWith("/docs/"))
            docIds.add(t.href.slice("/docs/".length));
        }),
      ),
    );

    const derivedIssues = store.issues
      .filter(
        (i) =>
          i.id !== issueId &&
          (i.origin === "derived" ||
            i.judgmentRefs.some((r) => issue.judgmentRefs.includes(r))),
      )
      .map(summarize);

    const decisions = [
      ...store.quickDecisions
        .filter((q) => q.issueId === issueId)
        .map((q) => ({
          id: q.decisionId,
          label: q.nodeText,
          href: "/decisions",
        })),
      ...judgments.flatMap((j) =>
        j.revisions
          .filter((r) => r.decisionId)
          .map((r) => ({
            id: r.decisionId as string,
            label: `${j.id} → v${r.version} · ${r.note}`,
            href: `/judgments/${j.id}`,
          })),
      ),
    ];

    const extCount = [
      ...(store.researchDocs[issueId]
        ? [
            ...store.researchDocs[issueId].judgment,
            ...store.researchDocs[issueId].keyEvidence,
            ...store.researchDocs[issueId].counters,
            ...store.researchDocs[issueId].unknowns,
          ]
        : []),
    ].filter((s) => s.traces.some((t) => t.kind === "ext")).length;

    return {
      issue: summarize(issue),
      judgments,
      ...(domain
        ? {
            domain: {
              code: domain.code,
              name: domain.name,
              driName: domainDriLabel(domain),
            },
          }
        : {}),
      missions: domain
        ? allMissions.filter((m) => m.domainId === domain.id).map(clone)
        : [],
      docs: Array.from(docIds)
        .map((id) => store.docs.find((d) => d.id === id))
        .filter((d): d is Doc => Boolean(d))
        .map((d) => ({ id: d.id, title: d.title })),
      externalEvidence: {
        label: "online deep research · 约 40 轮检索",
        count: extCount,
      },
      derivedIssues,
      decisions,
    };
  },
  /**
   * 打回重研 —— **真的起一轮**。
   *
   * 上一版这里只写字：屏幕上出现「第二轮深度研究进行中」，事件流里也躺着一条
   * 「第二轮深度研究启动」，而没有任何任务被起来。屏幕说的话必须是真的，所以
   * 现在走的是和手动重开**同一个** `reopenDeepResearch`（丢掉旧报告和上一轮的原件、
   * 解开两道失败闩、开一轮），而且**文案按它返回的状态写** —— 起不来就照实说起不来。
   *
   * 留言只走一条路：发给被指派的承接人。它**到不了 A4** —— `A4Input`（见
   * `agent/a4/prompt.ts`）没有留言字段，第二轮拿到的输入和第一轮一样。原来那句
   * 「您的留言已带入」是假的，删掉；缺口记在运维须知 §6。
   */
  async requestRework(issueId: string, comment: string): Promise<Issue> {
    await sleep(500, 900);
    const issue = findIssue(issueId);
    const at = nowIso();
    const note = comment.trim();

    const task = reopenDeepResearch(issueId);

    issue.monitoringNote =
      task.status === "running"
        ? "已打回 · 第二轮深度研究进行中"
        : task.status === "failed"
          ? "已打回 · 第二轮没跑成"
          : undefined;
    touch(issue, at);
    pushEvent(issueId, {
      id: `E-${issueId}-rework-${at}`,
      kind: "deep",
      at,
      headline:
        task.status === "running"
          ? "打回重研 · 第二轮深度研究已启动"
          : task.status === "failed"
            ? "打回重研 · 第二轮没能启动"
            : "打回重研 · 已记下",
      actor: viewer().name,
      detail: [
        note
          ? `留言已发${issue.assigneeName ?? "承接人"}：\n${note}`
          : "未附留言。",
        task.status === "failed"
          ? `第二轮没跑起来：${task.error ?? "原因未记录"}`
          : task.status === "running"
            ? "第二轮按第一轮的同一批材料重跑，留言不进模型输入。"
            : "这一轮没有起模型（演示模式或议题已不在库里）。",
      ].join("\n\n"),
      defaultOpen: true,
    });
    return hydrateIssue(issue);
  },

  /**
   * 触发一次预研。**立刻返回状态，不等它跑完。**
   *
   * 议题被建出来的那一刻已经起过一轮（见 `ensurePreResearch`），所以这条现在是**兜底**：
   * 进程重启会丢掉正在跑的任务，他点进这张卡的时候那一轮可能已经不在了。视图那边的轮询
   * 仍然打这个入口，落到 `ensurePreResearch` 上就是「有就不动，没有才起」。
   */
  async startPreResearch(issueId: string): Promise<TaskState> {
    findIssue(issueId);
    return ensurePreResearch(issueId);
  },

  /**
   * 这件议题的判断板。上半层未确认，下半层已确认。
   *
   * 排序：上半层按时间倒序（最新的判断最要紧），下半层按确认时间倒序
   * （最近拍的板最可能还在生效）。两层都不混排来源 —— 来源是标签不是分组，
   * 按来源分组会让「这个议题现在到底有几条判断」这个问题要数三次才答得出来。
   */
  async getBoard(issueId: string): Promise<JudgementBoard> {
    await sleep(120, 260);
    findIssue(issueId);
    /*
     * 顺手结算一次：深研跑完时已经叫过 A5，但进程重启会把在跑的任务丢掉（见
     * `tasks.ts`），而在那之前写成的报告还在库里躺着。这里再叫一次是自愈的 ——
     * 这一层是被轮询和「库改过了」那条线反复读的，所以那一步里跑过、正在跑、
     * 跑挂过三种都直接返回，一份报告只读一遍（见 `ensureJudgements`）。
     */
    ensureJudgements(issueId);
    return readBoard(issueId);
  },

  /** 判断生成跑到哪了。前端在上半层没有 research 来源的条目时轮询这个。 */
  async judgementsStatus(issueId: string): Promise<TaskState> {
    return taskState("judge", issueId);
  },

  /**
   * 确认一条判断 —— 从上半层落到下半层。
   *
   * 这是这个产品里唯一一处**权力转移**：一句参谋的猜测变成公司的口径。所以三样
   * 缺一不可：什么时候、通过什么途径、凭什么。缺了「凭什么」，半年后要重新打开
   * 这条判断时，没人知道当时的依据还成不成立。
   *
   * 真正写库的是 `applyConfirm` —— 对谈里那句「这条我认了，因为……」走同一段
   * （见 `settleTurn`）。这里多出来的只是三句报错：他刚点了一下，屏幕必须给回话。
   */
  async confirmBoardJudgement(
    id: string,
    channel: ConfirmChannel,
    support: string,
  ): Promise<JudgementBoard> {
    if (!support.trim())
      throw new ApiError("要写清楚凭什么确认 —— 只记「已确认」等于没记。");
    const issueId = Object.keys(store.board).find((k) =>
      (store.board[k] ?? []).some((x) => x.id === id),
    );
    const item = issueId
      ? (store.board[issueId] ?? []).find((x) => x.id === id)
      : undefined;
    if (!issueId || !item) throw new ApiError(`找不到这条判断（${id}）。`);
    if (item.confirmed) throw new ApiError("这一条已经确认过了。");

    applyConfirm(id, channel, support);
    persistSoon();
    return readBoard(issueId);
  },

  /** 预研跑到哪了。前端在 pre 为空时轮询这个。 */
  async preResearchStatus(issueId: string): Promise<TaskState> {
    return taskState("preresearch", issueId);
  },

  /**
   * 潜在议题详情页要的全部。
   *
   * 预研是**议题一建出来就自动跑的**（见 `ensurePreResearch`），所以这里没有「开始预研」
   * 这个动作 —— 屏幕上也不该有那个按钮。他点进来时它已经在那儿了，或者已经在跑了，
   * `pre.at` 写明是什么时候跑完的。
   */
  async getSignal(issueId: string): Promise<SignalDetail> {
    await sleep(180, 360);
    const issue = findIssue(issueId);
    const card = store.cards.find((c) => c.issueId === issueId);
    if (!card) throw new ApiError(`${issueId} 没有对应的潜在议题卡。`);
    return {
      card: clone(card),
      issue: clone(issue),
      pre: store.preResearch[issueId]
        ? clone(store.preResearch[issueId])
        : null,
      judgments: [card.strategyRef.id, card.hypothesisRef?.id]
        .filter((id): id is string => Boolean(id))
        .map((id) => clone(findJudgment(id))),
    };
  },

  /**
   * 取这件议题此刻的探讨链路。
   *
   * 节点与边**一次给全**：分两次取会出现「边指向一个还没到的点」，屏幕上就是一根
   * 指向空气的箭头。分幕按对谈轮数算（`revealAfterRound`）—— demo 里参谋每答一轮，
   * 链路就长一截；真实后端由萃取 Worker 推送，这个字段消失。
   */
  async listProbe(issueId: string): Promise<ProbeMap> {
    await sleep(140, 300);
    const rounds = agentRounds(issueId);
    const nodes = (store.probeNodes[issueId] ?? []).filter(
      (n) => n.revealAfterRound <= rounds,
    );
    const alive = new Set(nodes.map((n) => n.id));
    alive.add("ROOT");
    const edges = (store.probeEdges[issueId] ?? []).filter(
      (e) =>
        e.revealAfterRound <= rounds && alive.has(e.from) && alive.has(e.to),
    );
    const doc = store.researchDocs[issueId];
    return {
      rootLabel: doc ? `深研报告 · ${doc.byAgentLabel}` : "深研报告",
      initial: initialJudgmentOf(issueId),
      nodes: clone(nodes),
      edges: clone(edges),
    };
  },

  /**
   * 议题研究页头上的「指派负责人」。改派也走这里 —— 每次指派都落时间线。
   *
   * **这一下推状态到 `WaitingEvidence`。** 派出去了，这件议题客观上就是在等一个具体
   * 的人交证据；不推的话，「等谁、从什么时候开始等」这句话在状态机上没有落点 ——
   * 屏幕两侧都显示「已回传」而议题还停在 `Exploring`，一号位那侧没有任何东西告诉他
   * 这件事到位了，而且失败是静默的。
   *
   * 闸门设在这里而不是 `escalate`：UI 上唯一的派活入口就是这个方法
   * （`issue-header.tsx` 的「指派负责人」），`api.escalate` 在 `src/app` 和
   * `src/components` 里没有任何调用点。
   */
  async assignIssue(issueId: string, personId: string): Promise<Issue> {
    await sleep(320, 620);
    const issue = findIssue(issueId);
    const person = findPerson(personId);
    const at = nowIso();
    const reassigned = Boolean(issue.assigneeName);
    issue.assigneeName = person.name;
    /*
     * 派人这一下顺手归域。
     *
     * 升级的时候没派人的议题是没有域的（见 `disposeCard` 里那一段），它一直待在首页
     * 的总览里。这一刻它有主人了，就该同时出现在那个人的域清单上 —— 否则「派了人就
     * 进域」这条规则只在提请台那一个入口成立，而事后补派是同一件事。
     *
     * 已经有域的不动：改派承接人不该把一件议题搬到另一块生意底下。
     */
    if (!issue.domainId) issue.domainId = domainOfDri(personId)?.id;
    /*
     * 只从 `WaitingEvidence` **之前**的状态推过去。已经能上会、已经拍过板的不回退 ——
     * 换一个承接人不该把一件已经到位的议题打回去等证据。
     *
     * 状态迁移不另推一条时间线事件：下面那条指派事件就是这次迁移的来路，两条并排
     * 只会让时间线上出现一次「什么都没发生」的重复。
     */
    const beforeEvidence: IssueState[] = [
      "Candidate",
      "Watching",
      "Exploring",
      "Researching",
    ];
    if (beforeEvidence.includes(issue.state)) {
      issue.state = "WaitingEvidence";
      // 他这一刻没有下一步 —— 等的是别人。卡上那行「承接研究 · 等 X 回传」
      // 由 `handoffStatus` 说，不在这里写一句话重复它。
      issue.nextActionForUser = null;
    }
    touch(issue, at);
    pushEvent(issueId, {
      id: `E-${issueId}-assign-${at}`,
      kind: "handoff",
      at,
      headline: `${reassigned ? "改派" : "指派"}承接人 · ${person.name}`,
      actor: viewer().name,
      defaultOpen: true,
    });
    return hydrateIssue(issue);
  },

  async disposeCard(
    cardId: string,
    action: CardDisposition,
    reason?: string,
    assigneeId?: string,
  ): Promise<Issue> {
    await sleep(320, 700);
    const card = store.cards.find((c) => c.id === cardId);
    if (!card) throw new ApiError(`找不到提请 ${cardId}。`);
    const issue = findIssue(card.issueId);
    const at = nowIso();

    /*
     * 议题落在哪个域，是在这一下点击里定的。
     *
     * 本体的 StrategicIssue 上没有「属于哪个域」这层关系，所以种子里的议题是没有
     * domainId 的 —— 它们还在提请台上，压根还不是「某个域里在办的事」。他按下三个键
     * 里的任何一个，这件事就开始占他的注意力了，这时候才该有归属：取卡片碰到的那个域
     * （卡片的 domainIds 由「议题动摇哪条判断 → 判断属于哪个域」两跳接出来）。
     *
     * **升级为战略议题（discuss）这一档多一个条件：他这一下点了人，才归域。**
     *
     * 「属于某个域」在这个产品里的含义是「这块生意上我手里压着的一件事」，而没有
     * DRI 的议题在组织里还没有落点 —— 归了域，它就会混进那个域的清单里，读起来像
     * 已经有人在办；不归域，它落在首页的「总览」里等他派人，而总览这一格存在的
     * 全部理由就是接住这一档。派了人（这里，或者事后 `assignIssue`）它才同时出现在
     * 总览和那个域的清单上。
     *
     * 待定与搁置不受这条约束：它们不进域清单（一个在待定区、一个已经否掉），
     * 归域在那两档里只是把「这件事碰的是哪块生意」记下来。
     *
     * 卡片接不出域时看 DRI 自己管哪个域；两头都接不出来就留空 —— 那是诚实的空
     * （ISS-009 就是这一档），不编一个。
     */
    if (!issue.domainId && (action !== "discuss" || assigneeId)) {
      issue.domainId =
        card.domainIds[0] ??
        (assigneeId ? domainOfDri(assigneeId)?.id : undefined);
    }

    card.disposedAs = action;
    card.disposedAt = at;
    if (reason) card.dismissReason = reason;

    if (action === "discuss") {
      /*
       * 采信的这一下就把深研真的起起来。
       *
       * 原来这里只登记一个屏幕上的「在跑」标记（`openResearch`），而真正起一轮 A4 的是
       * `getResearchDoc` / `listReports` —— 也就是他点进议题研究那一页的时候。于是下面
       * 这句「深度研究进行中」在他不点进去的情况下一直是**假的**：没有任何东西在跑。
       * 他把这件事升成战略议题就是那个决定，研究该从那一刻开始。
       *
       * `ensureDeepResearch` 自己挡 demo、自己登记那个标记、同一件议题也不会起两轮。
       * 深研跑完接着自动读成判断（A5），所以他再进来时板上已经有东西。
       */
      const deep = ensureDeepResearch(issue.id);
      issue.state = "Exploring";
      // 研究状态由 researchReady 在屏幕上表达（✓ 已完成 / 进行中动效），不再写成待办句。
      issue.nextActionForUser = null;
      issue.monitoringNote = deepResearchNote(deep.status);

      /*
       * 升级的那一刻，判断板上必须已经有东西。
       *
       * 内容包里备了深研报告的议题（Oasis），报告里的判断在装载时就上板了。剩下三条
       * 只有预研 —— 那份预研的 `take` 本来就是「参谋读完之后说的那段话」，也就是一条
       * 判断。把它推上板，一号位按完「升级为议题」进去看到的是一条判断，不是一块
       * 「正在研究」的占位。
       *
       * 只在 demo 里这么做：真跑的时候，深研完成之后会自己上板（见
       * `ensureDeepResearch`），这里再推一条会让同一段话在板上出现两遍。
       */
      if (DEMO && (store.board[issue.id] ?? []).length === 0) {
        const pre = store.preResearch[issue.id];
        if (pre) {
          boardPush(issue.id, {
            statement: pre.take,
            origin: "research",
            at,
            notes: pre.finding.flatMap((f) => f.traces),
          });
        }
      }
      if (assigneeId) {
        const person = findPerson(assigneeId);
        issue.assigneeName = person.name;
      }
    } else if (action === "watch") {
      issue.state = "Watching";
      issue.nextActionForUser = null;
      issue.monitoringNote = "已待定 · 收进待定区，随时可捞回深研";
    } else {
      issue.state = "Dismissed";
      issue.nextActionForUser = null;
      issue.monitoringNote = reason ? `已搁置 · ${reason}` : "已搁置";
    }

    /*
     * 预研备好的监控条件在这里定生死。**这是它唯一的转正路径**：
     * `proposed → active` 只发生在他按下「待定」那一下 —— 这一下是真实的人按下，
     * 所以不需要（也不许）另开一道确认门。
     *
     * 按了议一议或不看了，那些提案就作废（`expired`）：议一议的这一条要去做研究，
     * 不是挂着盯；不看了的更不该在表上留一条会自己冒出来的监控。
     *
     * 这一段一条 `ReopenTrigger.armed` 都不写 —— 布控仍然只由
     * `confirmCandidate` / `confirmClosure` / `signClosure` 写，那是他按确认那一下。
     */
    const mine = store.triggers.filter(
      (t) => t.provenance.issueId === issue.id && t.status === "proposed",
    );
    for (const t of mine) {
      t.status = action === "watch" ? "active" : "expired";
    }
    if (mine.length > 0) {
      pushEvent(issue.id, {
        // 复用函数开头那个 `at`，**不要再取一次时间**：同一次处置写出两个时间戳，
        // 台账排序上就栽过一次。
        id: `E-${issue.id}-tg-${at}`,
        kind: "deep",
        at,
        headline:
          action === "watch"
            ? `开始监控 ${mine.length} 条条件`
            : `作废 ${mine.length} 条备好的监控条件`,
        // 和同一个函数里那条既有事件一致：这一下是他按的，署他的名。
        actor: viewer().name,
        detail: mine
          .map((t) => `${t.condition}（挂在 ${t.targetRef.id}）`)
          .join("\n"),
        /*
         * 按 `defaultOpen` 自己的口径：组织动作与状态迁移导向判断（展开）、
         * 过程性内容不导向判断（折叠）—— 这一条是状态迁移，而且是他自己按出来的。
         */
        defaultOpen: true,
      });
      /*
       * 真翻了东西才落盘、才报版本：触发器从 `proposed` 翻到 `active` 是一次真实的
       * 库变更，不叫它，他按下的那一下可能既不落盘也不上屏。
       *
       * **只管新加的这一格。** `disposeCard` 既有那些写操作（议题状态、卡上的处置、
       * 归域）今天也没有落盘这一下 —— 那是本任务范围之外的既有状况，补它是改既有行为。
       */
      persistSoon();
    }

    touch(issue, at);

    pushEvent(issue.id, {
      id: `E-${issue.id}-${at}`,
      kind: "state",
      at,
      headline:
        action === "discuss"
          ? assigneeId
            ? `深研并指派 · 已指派 ${issue.assigneeName} · 后台深研启动（→ 研究中）`
            : "自动深度研究 · 状态迁移 → 研究中，后台深研启动"
          : action === "watch"
            ? "待定 · 收进待定区（状态 → 观察中）"
            : "搁置 · 状态迁移 → 已否掉",
      actor: viewer().name,
      detail:
        action === "dismiss" && reason
          ? `处置原因：${reason}。该原因回喂去噪，不影响本议题的可找回性。`
          : undefined,
      defaultOpen: true,
    });

    return hydrateIssue(issue);
  },

  // -------------------------------------------------------------------------
  // 页面2 议题列表 —— 全生命周期的容器
  // -------------------------------------------------------------------------

  async listIssues(): Promise<IssueSummary[]> {
    settleResearch();
    await sleep();
    return store.issues.map(summarize);
  },

  /**
   * 一号位自己探索 —— 三个来源之二（另两个是雷达发现、DRI 上报）。
   *
   * **它落在提请台上，不落在议题清单上。** 三个来源的起点是同一个地方，他自己提的
   * 那一件也要先成为一条潜在议题，等他按三键处置。
   *
   * 上一版这里直接建一条 `Exploring` 的在办议题、后台立刻开跑深研 —— 那是给他自己
   * 开了一条特权通道（原来那个入口的注释里就写着「手动提的事不是特权通道」，代码
   * 却是反的），而且替他跳过了那一次确认：他打完一行字，系统就当他已经决定要投入
   * 认知资源了。真实情况是他刚想到，还没决定值不值得。
   *
   * 所以这里只建两个对象：一条 `Candidate` 议题，和一张 `ceo` 来路的卡摊到今天这一
   * 批里。**深研**在他按下「聊聊」那一刻才开跑（见 `disposeCard`）；归到哪个域也在那时
   * 才定，而他自己提的这一条**接不出域** —— 没有判断可挂，那是诚实的空。
   *
   * 预研是另一档：便宜、自动，这里就起（`ensurePreResearch`）。它不替他决定投不投入
   * 认知资源，正相反 —— 他要按的那三个键，本来就该在读过参谋查出来的东西之后按。
   */
  async addIssue(title: string): Promise<Issue> {
    await sleep(380, 720);
    const text = title.trim();
    if (text.length === 0) throw new ApiError("议题不能是空的。");

    /*
     * 一句话 / 一整篇 / 一个链接，三支归一（见 `own-issue-input.ts`）。
     *
     * 这一步会去抓链接、会叫一次小模型起标题，所以它可能花上几秒。放在这里等，而不是
     * 先落一张卡再回头换标题：换标题意味着他刚提的那件事在清单上会自己变一次样，而他
     * 那一刻正在看它。**签名没变**（还是一个字符串）—— 分类是服务端的事，屏幕不必先
     * 替系统判断这是什么。
     */
    const input = await readOwnIssueInput(text);

    const at = nowIso();
    const issue: Issue = {
      id: nextIssueId(),
      title: input.title,
      state: "Candidate",
      origin: "manual",
      judgmentRefs: [],
      nextActionForUser: null,
      raisedAt: at,
      updatedAt: at,
    };
    store.issues.push(issue);

    // 回填 judgment.shakenBy。今天 judgmentRefs 是 []，空转；但将来如果这里的逻辑
    // 改成会带 judgmentRefs，这个调用会自动生效。
    linkIssueToJudgments(issue);

    /*
     * 卡上的四段，只有第一段有内容 —— 他贴进来的那段东西，出处是他本人（贴的是链接就
     * 是那个链接）。**他只打了一句话时第一段是空的**：那一句已经在标题上，同一句话在
     * 卡上出现两遍（大字一遍、小字再一遍）看着像系统坏了。
     *
     * 另外三段照实写「还没查」。这里最容易犯的错是替他把「为什么现在重要」和
     * 「动摇哪条判断」编上：那两段的份量全在「系统真的去查过」，编出来的话会让他
     * 以为系统已经研究过他刚想到的事。
     */
    const card: Card = {
      id: issue.id.replace("ISS-", "CARD-"),
      issueId: issue.id,
      headline: input.title,
      titleByModel: input.titleByModel || undefined,
      source: { kind: "ceo" },
      what: input.body
        ? [
            {
              text: input.body,
              traces: input.link
                ? [
                    {
                      kind: "ext",
                      source: input.link.host,
                      href: input.link.url,
                    },
                  ]
                : [{ kind: "human", source: `${viewer().name} 贴进来的` }],
            },
          ]
        : [],
      materialNote: input.note ?? undefined,
      why: "您自己提的，系统还没查过。",
      strategyRef: {
        id: "",
        statement: "还不知道它动摇哪条判断 —— 您按下「聊聊」之后才去找。",
      },
      suggestion: { text: "先只决定一件事：值不值得占您的时间。", traces: [] },
      refs: input.link
        ? [{ kind: "ext", source: input.link.host, href: input.link.url }]
        : [],
      domainIds: [],
      createdAt: at,
    };
    store.cards.push(card);
    todayDigest().cardIds.unshift(card.id);

    /*
     * 预研现在就起 —— 必须在卡进 store **之后**：那一轮要读卡上的原文当材料
     * （见 `ensurePreResearch`），先起就只看得到一个标题。
     *
     * 卡上那句「参谋在查」跟着它的真实状态写：demo 那一档不叫模型，于是它返回 idle，
     * 卡上就仍然是「还没查过」。
     */
    const pre = ensurePreResearch(issue.id);
    if (pre.status === "running") {
      card.why =
        "您自己提的。参谋已经在查了 —— 一到两分钟后这张卡上会多一段判断。";
    }

    pushEvent(issue.id, {
      id: `E-${issue.id}-raised`,
      // 立案是这件议题的第一次状态落定（落到「待处置」），把它归成「对谈」从来不成立 ——
      // 那一刻没有任何对谈发生。改成 state 之后 `/issues-log` 那句「每件议题的每一步」才是真的。
      kind: "state",
      at,
      headline: "议题提出（您自己添加）· 待处置",
      actor: viewer().name,
      // 抓没抓到、截没截，台账上也要有 —— 事后回看「当时参谋读到的是什么」，
      // 只有这一条答得出来。
      detail: input.note ?? undefined,
      defaultOpen: true,
    });
    return hydrateIssue(issue);
  },

  /**
   * 改题。**议题标题和卡面那一行一起改。**
   *
   * 它们是同一个字符串，不是碰巧一样的两句：`issueFromSignal` 和 `addIssue` 落卡时
   * 都写着「卡面最响的一行就是这条议题本身，不另编一句」。分开改的话，议题研究页顶上
   * 是新题、潜在议题页顶上还是旧题 —— 同一件事在两页上写着两句话，而屏幕上看不出
   * 哪一句是现在这一句。所以这两处只能由同一个方法动。
   *
   * 一条议题下的卡**全部改**，不是只改第一张：`removeIssue` 那边也是按 `issueId` 收
   * 一批卡，一张卡一张卡地对付等于假设了「一条议题只有一张卡」，而那个假设没有任何
   * 地方保证。
   *
   * 改完推一条时间线事件，`detail` 里留着原题 —— 改题是唯一一种「原来那句话再也找
   * 不回来」的改动，账上不留原题的话，那句话就真的没了。
   */
  async renameIssue(issueId: string, title: string): Promise<Issue> {
    await sleep(160, 320);
    const next = title.trim();
    if (next.length === 0) throw new ApiError("议题不能是空的。");

    const issue = findIssue(issueId);
    const before = issue.title;
    /* 一个字都没改就什么都不做：账上多一条「改题」而两句话一模一样，读的人只会疑惑。 */
    if (next === before) return hydrateIssue(issue);

    const at = nowIso();
    issue.title = next;
    for (const card of store.cards) {
      if (card.issueId === issueId) card.headline = next;
    }
    touch(issue, at);

    /*
     * 事件 id 把时刻编进去：改题可以发生很多次，而 `pushEvent` 对固定后缀的 id 是
     * 「后来的覆盖前面的」—— 用固定后缀就只剩最后一次，中间改过什么全丢了。
     */
    pushEvent(issueId, {
      id: `E-${issueId}-retitle-${at}`,
      kind: "state",
      at,
      headline: "改题",
      actor: viewer().name,
      detail: `原题：${before}`,
      defaultOpen: true,
    });

    persistSoon();
    return hydrateIssue(issue);
  },

  async getIssue(id: string): Promise<Issue> {
    settleResearch();
    await sleep();
    return hydrateIssue(findIssue(id));
  },

  /** 倒序：最新在上。打开时想看的是「现在到哪了」，不是「当初怎么来的」。 */
  async getTimeline(id: string): Promise<TimelineEvent[]> {
    await sleep();
    findIssue(id);
    return clone(store.timelines[id] ?? []).reverse();
  },

  // -------------------------------------------------------------------------
  // 页面3 议题研究 —— 首轮调研 + 对谈 + 反问 + 定题
  // -------------------------------------------------------------------------

  /**
   * 首轮调研文档。没有就返回 null —— 「装配中」是视图该照实说的话，不是错误。
   *
   * 取的同时确保有一轮 A4 在跑。放在这里而不是放一个「开始深研」按钮：
   * 他点进议题研究就是要看报告，多一次点击不会让报告来得更快。
   */
  async getResearchDoc(issueId: string): Promise<ResearchDoc | null> {
    settleResearch();
    ensureDeepResearch(issueId);
    await sleep(260, 520);
    findIssue(issueId);
    const doc = store.researchDocs[issueId];
    return doc ? clone(doc) : null;
  },

  /** 深研跑到哪了。前端在报告为空时轮询这个。口径见 `deepRoundState`。 */
  async deepResearchStatus(issueId: string): Promise<TaskState> {
    return store.researchDocs[issueId]
      ? { status: "done" }
      : deepRoundState(issueId);
  },

  /** 手动再开一轮深研。`requestRework` 打回重研走的也是这条。口径全在 `reopenDeepResearch`。 */
  async startDeepResearch(issueId: string): Promise<TaskState> {
    findIssue(issueId);
    return reopenDeepResearch(issueId);
  },

  async getAdvisorPreset(issueId: string): Promise<AdvisorPreset | null> {
    await sleep(80, 160);
    const preset = store.advisorPresets[issueId];
    return preset ? clone(preset) : null;
  },

  /**
   * 分诊那一栏的对谈记录。**这一支的 key 是 `${issueId}:signal`，不是裸 `issueId`。**
   *
   * 两个 key 分家不是命名习惯，是这一栏能落库的**前提**。判断演进萃取、板上那几条的
   * 来源、以及「这件议题聊过几轮」四五处统计读的都是裸 `issueId` 那一支
   * （`store.ts` 里 `advisorThreads[issueId]` 那几处）。分诊那几轮写进裸 key，
   * 它们立刻会被当成「这件事讨论过了」的证据往判断上推 —— 而他当时只是在决定要不要
   * 开始。写进 `:signal` 那一支就一处都不进：那几处一个字都不用改。
   *
   * 所以这一页现在的口径是**记录留下、萃取不做**，而不是上一版的「什么都不留」。
   * 上一版的理由（这一页的对话不该变成证据）保住了，代价没有跟着一起付 —— 那个代价是
   * 他再点进这张卡，上一次聊的几轮全没了。
   *
   * 不铺开场白仍然照旧：这一栏开场是「上次聊到哪」，没聊过就是空的。
   */
  async getSignalTranscript(issueId: string): Promise<AdvisorMessage[]> {
    await sleep(120, 240);
    return clone(store.advisorThreads[`${issueId}:signal`] ?? []);
  },

  /**
   * 分诊那一栏：他说了一句。
   *
   * 与 `openAdvisorTurn` 有意分家的两件事，都是为了守住上面那条边界：
   *
   * 1. **不 `findIssue`。** 分诊这一页站在潜在议题上，那条东西不一定在 `issues` 里；
   *    照抄那一侧会让这一栏在信号还没立案时整个报错。
   * 2. **不 `touch`、不 `bumpTalkEvent`、不 `settleTurn`。** 那三样是「这件议题有进展了」
   *    的信号，会把它在首页往上顶、会去动判断板。分诊聊几轮不是进展，是他还在决定
   *    要不要开始。
   *
   * **也不叫 `persistSoon()`**，这一点和隔壁 `openAdvisorTurn` 一致：落盘由
   * `/api/data` 每次调用结束那一次 `persistOnly()` 兜住，而 `persistSoon()` 会额外报一声
   * 「库改过了」—— 那一声会让屏幕上所有资源重问一遍，包括这一栏自己。它正在流式吐字，
   * 重问回来的那份里还没有这一轮，刚落下的字会被覆盖掉。
   */
  async openSignalTurn(issueId: string, text: string): Promise<AdvisorMessage[]> {
    await sleep(90, 200);
    const line = text.trim();
    if (line.length === 0) throw new ApiError("说点什么再发。");
    const list = (store.advisorThreads[`${issueId}:signal`] ??= []);
    list.push({
      id: `SM-${issueId}-${list.length + 1}`,
      role: "user",
      text: line,
      at: nowIso(),
    });
    return clone(list);
  },

  /** 分诊那一栏：模型说完了，记下来。同上，不动议题状态、不起萃取、不报「库改过了」。 */
  async recordSignalReply(
    issueId: string,
    text: string,
    elapsedMs?: number,
  ): Promise<AdvisorMessage[]> {
    const line = text.trim();
    if (line.length === 0) throw new ApiError("模型没说出东西来。");
    const list = (store.advisorThreads[`${issueId}:signal`] ??= []);
    list.push({
      id: `SM-${issueId}-${list.length + 1}`,
      role: "agent",
      text: line,
      at: nowIso(),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    });
    return clone(list);
  },

  /**
   * 对谈记录。第一次打开时把预设的开场白铺进来 —— 开场白是 Agent 交底，
   * 不是等他先开口。
   */
  async listAdvisorMessages(issueId: string): Promise<AdvisorMessage[]> {
    await sleep(120, 260);
    findIssue(issueId);
    let list = store.advisorThreads[issueId];
    if (!list) {
      list = store.advisorThreads[issueId] = [];
      const preset = store.advisorPresets[issueId];
      if (preset) {
        list.push({
          id: `AM-${issueId}-opening`,
          role: "agent",
          text: preset.opening,
          at: stamped,
        });
      }
    }
    return clone(list);
  },

  /** 他说了一句。只记这一步；回答由真模型现说，说完再 `recordAdvisorReply`。 */
  async openAdvisorTurn(
    issueId: string,
    text: string,
  ): Promise<AdvisorMessage[]> {
    await sleep(90, 200);
    const line = text.trim();
    if (line.length === 0) throw new ApiError("说点什么再发。");
    const issue = findIssue(issueId);
    const list = (store.advisorThreads[issueId] ??= []);
    const at = nowIso();
    list.push({
      id: `AM-${issueId}-${list.length + 1}`,
      role: "user",
      text: line,
      at,
    });
    touch(issue, at);
    bumpTalkEvent(issueId, at);
    return clone(list);
  },

  /** 模型说完了，记下来。这一步不再打延迟：真正的等待在模型那一侧。 */
  async recordAdvisorReply(
    issueId: string,
    text: string,
    /** 这一答花了多久 —— 前端从发问那一刻掐的表，屏幕上要如实写出来。 */
    elapsedMs?: number,
    /**
     * 这一轮转过深研的话，那次转手。跟着这一轮一起落库 —— 理由整段写在
     * `AdvisorMessage.deepHandoff` 上（一句话：转手是这一轮里真的发生过的事）。
     */
    deepHandoff?: { issueId: string; why: string },
  ): Promise<AdvisorMessage[]> {
    const line = text.trim();
    if (line.length === 0) throw new ApiError("模型没说出东西来。");
    const issue = findIssue(issueId);
    const list = (store.advisorThreads[issueId] ??= []);
    const at = nowIso();
    list.push({
      id: `AM-${issueId}-${list.length + 1}`,
      role: "agent",
      text: line,
      at,
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
      ...(deepHandoff === undefined ? {} : { deepHandoff }),
    });
    touch(issue, at);
    /*
     * 这一轮说完了，去看看板该不该动。**不 await** —— 一号位这一刻要的是
     * 对话框里的回复已经落下来，左栏晚几秒多出一行是可以接受的；
     * 让他等一次分类调用才看到自己刚说的话，不可接受。
     */
    settleTurn(issueId);
    return clone(list);
  },

  /**
   * 他给某一轮点了赞或踩 —— **对谈那一支**。
   *
   * ## 为什么这件事要落库
   *
   * 屏幕上那两枚拇指如果只活在组件 state 里，刷新一次就没了。那不是「少存一样东西」，
   * 是**这个动作本身变成了假的**：他点完踩，下次进来这一轮看起来跟没点过一样，于是
   * 他要么再点一次，要么不再点。而这两个数是我们唯一拿得到的「他是不是还愿意用」的证据
   * （同 `RatingProvider` 那一段的理由）。
   *
   * ## 再点一次是收回
   *
   * 传进来的和已经在的一样就抹掉这一栏。三态（赞 / 踩 / 没表过态）里「没表过态」必须
   * 回得去 —— 手滑点了个赞而收不回来，下一次他就不点了。
   *
   * ## 不 `touch`、不 `settleTurn`
   *
   * 与 `openSignalTurn` 那一段同一条边界：点个赞不是「这件议题有进展了」。把它算进
   * 进展会让一件议题在首页因为他点了个拇指而往上顶，而判断板会去重读一轮没有变化的对话。
   */
  async rateAdvisorMessage(
    issueId: string,
    messageId: string,
    verdict: "up" | "down",
  ): Promise<AdvisorMessage[]> {
    return rateInThread(issueId, issueId, messageId, verdict);
  },

  /** 分诊那一栏的同一件事。key 分家的理由整段写在 `getSignalTranscript` 上。 */
  async rateSignalMessage(
    issueId: string,
    messageId: string,
    verdict: "up" | "down",
  ): Promise<AdvisorMessage[]> {
    return rateInThread(`${issueId}:signal`, issueId, messageId, verdict);
  },

  /**
   * 定题（Frame）—— Advisor 四能力的最后一个：把探讨收敛成一句真正需要公司决定的
   * Decision Question。定过题的议题再定一次，返回同一句 —— 题不是随手换的。
   */
  async frameQuestion(issueId: string): Promise<DecisionQuestion> {
    // 真模型自带十几秒的等待，不再叠假延迟。
    return doFrame(issueId);
  },

  /** 定过的题。刷新回来那行 Decision Question 还得在。 */
  async getFramedQuestion(issueId: string): Promise<DecisionQuestion | null> {
    await sleep(60, 140);
    const framed = store.framed[issueId];
    return framed ? clone(framed) : null;
  },

  /**
   * 升级并分发 DRI。交接包发出，议题停在 `WaitingEvidence`。
   *
   * **这里不再替 DRI 回话。** 上一版把「交接包发出 → DRI 给出方案 → 进入可决策」
   * 压缩成一次调用（注释原文：「demo 把真实世界里的半天压缩成一次调用」）。真人
   * 接手之后那半天是真的半天，屏幕上要照实说等谁、从什么时候开始等 ——
   * 承接人回传走 `submitDriReport`，那一下才推状态。
   *
   * 它也不替真人认领：谁承接由「指派负责人」（`assignIssue`）定，那是一次显式点名。
   */
  async escalate(issueId: string, revealStance: boolean): Promise<Issue> {
    await sleep(500, 900);
    const issue = findIssue(issueId);
    const question = store.framed[issueId] ?? store.decisionQuestions[issueId];
    if (!question) throw new ApiError("先定题，再分发。");

    const me = viewer();
    const handoffAt = nowIso();

    /*
     * 一号位选了要不要附上自己的倾向，Brief 上的署名就必须跟着变 —— 这是这个产品
     * 对反谄媚的全部保证：附了倾向，DRI 的推荐就得按这个打折。
     */
    /*
     * Brief 现装配。旧种子里是预置好的，词元云集这一版没有 —— 而它的每一栏
     * 都能从深研四节搬出来（见 synthBrief）。装配不出来（还没有深研报告）时
     * 让它保持为空：议题会停在 WaitingEvidence，屏幕上照实说在等承接研究，
     * 而不是给一份空的会前预审。
     */
    if (!store.briefs[issueId]) {
      const made = synthBrief(issueId);
      if (made) store.briefs[issueId] = made;
    }
    const brief = store.briefs[issueId];
    if (brief) brief.stanceRedacted = !revealStance;

    pushEvent(issueId, {
      id: `E-${issueId}-handoff`,
      kind: "handoff",
      at: handoffAt,
      headline: `交接包发出 · ${question.suggestedDri}`,
      actor: me.name,
      detail: revealStance
        ? `问题：${question.text}\n限时 ${question.deadline}。已附您的倾向。`
        : `问题：${question.text}\n限时 ${question.deadline}。未披露您的倾向——交接包只呈现「您关注的问题」。`,
      defaultOpen: true,
    });
    pushEvent(issueId, {
      id: `E-${issueId}-st-we`,
      kind: "state",
      at: handoffAt,
      headline: "状态迁移 → WaitingEvidence",
      actor: "系统",
      defaultOpen: true,
    });

    issue.state = "WaitingEvidence";
    issue.nextActionForUser = null;
    /*
     * 不写「${suggestedDri}承接中」。
     *
     * 那句话此刻站不住：`suggestedDri` 是模型建议的人名，而这里从不写
     * `issue.assigneeName`（`handoffStatus` 和 `listMyHandoffs` 只认显式点名，理由写在
     * `handoffStatus` 头上）。写上去的后果是同一块屏幕上出现「白田田承接中」和
     * 「承接研究 · 未指派」，而白田田那侧根本收不到这一件。
     *
     * 清掉旧的那句也是必要的：这件议题上一刻可能还写着「深度研究进行中」，而状态已经
     * 是等证据了。清掉之后这一栏落到 `getIssueCounsel` 的「等 Evidence 返回。」。
     */
    issue.monitoringNote = undefined;
    touch(issue, handoffAt);

    return hydrateIssue(issue);
  },

  /**
   * 递给议题研究那一侧模型的事实。从**当下的 store** 现算，不是一份写好的简介：
   * 一号位刚把 01-J2 写回 v2，下一句话里模型就不该还在说 v1。
   */
  async advisorContext(issueId: string): Promise<string> {
    return buildAdvisorContext(issueId);
  },

  /**
   * 对谈的判断状态。第一次取时初始化空状态。
   */
  async getTalkPoint(
    issueId: string,
  ): Promise<import("@/lib/agent/talk/point").TalkPoint> {
    await sleep(60, 120);
    findIssue(issueId);
    let point = store.talkPoints[issueId];
    if (!point) {
      point = store.talkPoints[issueId] = {
        issueId,
        thesis: "",
        statements: [],
        openQuestions: [],
        candidate: null,
      };
    }
    return clone(point);
  },

  /**
   * 提一份迁移提议。过了校验才落库；不过就抛 `ApiError` 并留痕。
   */
  async proposeTalkPoint(
    issueId: string,
    proposal: unknown,
  ): Promise<import("@/lib/agent/talk/point").TalkPoint> {
    await sleep(90, 180);
    findIssue(issueId);
    const { checkProposal, applyProposal } =
      await import("@/lib/agent/talk/point");
    const result = checkProposal(proposal);
    if (!result.ok) {
      const msg = `迁移提议被拒：${result.why.join("；")}`;
      console.error(`[proposeTalkPoint] ${issueId} — ${msg}`);
      throw new ApiError(msg);
    }
    let cur = store.talkPoints[issueId];
    if (!cur) {
      cur = store.talkPoints[issueId] = {
        issueId,
        thesis: "",
        statements: [],
        openQuestions: [],
        candidate: null,
      };
    }
    const next = applyProposal(cur, result.value);
    store.talkPoints[issueId] = next;
    return clone(next);
  },

  /**
   * 记一条让步日志。过了校验才落库；不过就抛 `ApiError` 并留痕。
   */
  async recordDeliberationEntry(
    issueId: string,
    entry: unknown,
  ): Promise<import("@/lib/agent/talk/point").DeliberationEntry> {
    await sleep(80, 150);
    findIssue(issueId);
    const { checkEntry } = await import("@/lib/agent/talk/point");
    const result = checkEntry(entry);
    if (!result.ok) {
      const msg = `让步日志被拒：${result.why.join("；")}`;
      console.error(`[recordDeliberationEntry] ${issueId} — ${msg}`);
      throw new ApiError(msg);
    }
    let log = store.deliberationLog[issueId];
    if (!log) {
      log = store.deliberationLog[issueId] = [];
    }
    log.push(result.value);
    return clone(result.value);
  },

  /**
   * 把当前候选落到判断板上与研究链路上。**候选从库里读**
   * （`store.talkPoints[issueId].candidate`），不从入参收 —— 入参只有 `extraArms`。
   * 这样调用方连一个确认字段都递不进来。候选为空则抛 `ApiError`。
   *
   * **落完之后一条重开条件都没布控。** 板上那一条在上半层、图上那一条是 `direction`，
   * 布控要等他按下确认（`confirmCandidate` 的 ontology 分支）——「候选变成公司口径」
   * 是这个产品里唯一一次权力转移，它只能来自他按的那个按钮。
   *
   * 另两档回执不许说假话，见下面各自那段注释：板上已有一句开头相同但结尾不同的判断时
   * 照实说这一句没落上去、也不落图（不静默报成功，也不抛 —— 那一档是并发撞车，不是故障），
   * 他已经确认过这一句时不当待确认项报（`nodeId` 交回 null）。
   *
   * **这一条没有 `await sleep(...)`，而它两个邻居都有。** 那两个（`recordDeliberationEntry`
   * / `landTalkEvidence`）在这一层的假延时是模拟真实库的往返，而这一条跑在轮外结算里 ——
   * 前面刚跑完一次复核模型调用（几秒那一档），后面没有任何人在等它。给它加一个 80–150ms
   * 的人为延迟，屏幕上量不出任何差别，只是让那一整条结算链更晚落定。
   */
  async landTalkCandidate(
    issueId: string,
    extraArms?: readonly string[],
  ): Promise<import("@/lib/agent/talk/land").Landing> {
    const issue = findIssue(issueId);
    const candidate = store.talkPoints[issueId]?.candidate;
    if (!candidate) {
      throw new ApiError("现在没有待落的候选判断 —— 先在对谈里把它聊到收敛。");
    }

    const at = nowIso();
    const plan = planLanding({
      issueId,
      candidate,
      revisesJudgmentId: issue.judgmentRefs[0] ?? null,
      extraArms,
      round: agentRounds(issueId),
      at,
    });

    /*
     * `boardPush` 返回 null = 去重命中（同一句已经在板上）。这时按同一判据（`boardKey`）
     * 把既有那一条找回来 —— 回执里的编号必须指得到板上真有的一条，否则屏幕上那句
     * 「已落到判断板（D2）」点开是空的。
     */
    const pushed = boardPush(issueId, plan.board);
    const landed =
      pushed ??
      (store.board[issueId] ?? []).find(
        (x) => boardKey(x.statement) === boardKey(plan.board.statement),
      );
    if (!landed) {
      throw new ApiError(
        "这一句已经在判断板上，但按同一判据找不回它 —— 这一步没有落成。",
      );
    }

    /*
     * 板按正文前 30 字去重，图按整句去重 —— 两条判据不一样。于是「开头 30 字相同、结尾
     * 不同」的那一句会上不了板、却在图上新起一个待确认项：他读的是板上那句旧的，而按下
     * 确认之后写进在版判断的是新的那句。确认是这个产品里唯一一次权力转移，不能让它落在
     * 一句他没读过的话上 —— **所以撞上就不落图**，也不静默报成功。
     *
     * **这一档是回执，不是异常。** 从前这里抛 `ApiError`，而这条路的调用方是轮外结算
     * （`settleTurn` 里那一下 `void settleTalkTurn(...)`）：抛出去被 `doSettle` 的 catch
     * 接住、rethrow、最后落成运营台账上一条「第 N 轮结算失败」。而撞车不是故障 —— A6
     * 萃取那条写板路和这条路在同一次 `settleTurn` 里并发跑、写的是同一张板，一次正常的
     * 并发就能撞上。把并发记成失败，账就不是账了。现在它照实交一份说得清的回执：
     * 板上留的是哪一条、这一次这一句没落上去、链路上没有待确认项。
     *
     * **这里只挡撞车，不做改版。** 把板上旧的那一条撤下来、换成新的一版，是判断板上
     * 既有那条路（`changeFrom` / `changeTo` 那一套）要做的事；在这一步里另开一条改版
     * 链路会变成第二套改版语义。**那一档是欠账，本轮不做。**
     *
     * 两条路的署名 / 依据 / 是否落图今天仍然由谁先落库决定（A6 那条署「您的 Agent ·
     * 第 N 轮」、不落图；这条署「议事对话」、落图）。**那件事这一轮也没修**，它要的是
     * 一次显式合并，同样牵进改版语义。这里只保证撞上之后的行为是确定的、说得清的。
     */
    const collided = !pushed && landed.statement !== plan.board.statement;

    /*
     * 图上那一条。先按 `nextStatement` 找有没有落过同一句：他把同一句聊定两次
     * （或者结算重跑）不该在链路上留两个待确认项 —— 那意味着他得按两次，而第二次
     * 按下去时那条判断已经翻过版了。
     */
    const nodePlan = plan.node;
    let node: ProbeNode | null = null;
    /*
     * 他已经确认过的那一句，不再当待确认项报回去。
     *
     * `confirmCandidate` 不清空候选、也不动板上那一条，所以他确认之后只要复核再过一次，
     * 这个方法就会再跑一遍同一句 —— 而那时候图上那条已经 confirmed、重开条件已经布控完。
     * 照旧交回去的话，回执会对着一个按不动的按钮说「等你确认后布控 N 条」，而屏幕上任何
     * 接了这个 `nodeId` 的按钮按下去只会吃一个「这一条已经确认过了」。
     *
     * 判 `standing` 这一栏就够：`confirmedAt` 是同一件事的第二个证据。
     * 这一档不按「没有待落的候选」处理 —— 那句话是假的（候选确实在），而且抛异常会让
     * 整轮结算记成失败，等于他确认过之后每一轮都在运营台账上留一条不存在的失败。
     */
    let alreadyConfirmed = false;
    // 撞车那一档一条都不落图：确认那一下写进在版判断的，不许是一句板上没有的话
    if (nodePlan && !collided) {
      const nodes = (store.probeNodes[issueId] ??= []);
      const existing =
        nodes.find((n) => n.nextStatement === nodePlan.nextStatement) ?? null;
      if (existing?.standing === "confirmed") {
        alreadyConfirmed = true;
      } else if (existing) {
        node = existing;
      } else {
        // 序号往后找第一个没被占的，理由同 `boardPush`：节点会被别处筛掉，
        // 用 `length + 1` 会算出一个已经在用的 id。
        let n = nodes.length + 1;
        while (nodes.some((x) => x.id === `PN-${issueId}-talk-${n}`)) n++;
        node = { id: `PN-${issueId}-talk-${n}`, ...nodePlan };
        nodes.push(node);
      }
    }

    const ref = refCodeOf(landed);
    const nodeId = node?.id ?? null;
    /*
     * 从图上那一条读，不从方案读：去重命中那一次，真会被布控的是图上既有那一条的
     * 重开条件，而方案里那几条一条都没落进去。
     */
    const queuedArms = [...(node?.arms ?? [])];
    /*
     * 这句话给人看，所以不出现内部字段名。**今天读到它的是回头翻运营台账的人** ——
     * 轮外结算把它记进这一轮的记录（`settle.ts` 里那条「候选落地回执」），屏幕上还没有
     * 入口。措辞照上屏的标准写，但别把「它已经上屏了」当成事实。
     *
     * 五档分开写：撞上板上开头相同的那一条、他已经确认过这一句、落了图且有重开条件排队、
     * 落了图但候选没写重开条件、以及没有在版判断可翻。第四档不能套第三档的措辞 ——
     * 「布控 0 条重开条件」是一句读不通的话。
     *
     * 撞车那一档摆第一个，而且**不许出现「已落到判断板」**：这一次那一句一个字都没进板。
     * 它要说清三件事 —— 板上留着的是哪一句、这一次这一句没落上去、接下来要他做什么。
     */
    const why = collided
      ? `判断板上已经有一句开头相同的判断（${ref}）：「${landed.statement}」；这一次要落的是：` +
        `「${plan.board.statement}」。两句只差结尾，所以这一句这次没落上去，链路上也没有` +
        `待确认项 —— 落上去的话，板上留的仍是前一句，而你确认之后写进在版判断的是后一句。` +
        `先在板上把前一条处理掉，再落这一句。`
      : alreadyConfirmed
        ? `这一条你已经确认过了，判断板上那条（${ref}）还在原处`
        : !nodeId
          ? `已落到判断板（${ref}）。这件议题现在没有在版判断可翻，所以链路上没有待确认项`
          : queuedArms.length > 0
            ? `已落到判断板（${ref}）与研究链路上，等你确认后布控 ${queuedArms.length} 条重开条件`
            : `已落到判断板（${ref}）与研究链路上，等你确认后翻版在版判断`;

    /*
     * 他已经确认过的那一路上库里一个字都没动（板上去重命中、图上那条原封不动），
     * 所以不留痕也不动「最近动静」—— 那条痕迹说的是「聊定一条待确认判断」，在他确认
     * 之后拿新时刻再盖一次，等于账上说刚才又有一条在等他。
     *
     * 撞车那一路同理，而且更硬：那一次板上图上一个字都没写成，留一条「聊定一条待确认
     * 判断」的痕迹就是一句假话 —— 时间线上会多出一条指向前一句的记录，而他这一轮聊的
     * 是后一句。
     */
    if (!alreadyConfirmed && !collided) {
      pushEvent(issueId, {
        id: `E-${issueId}-talk-land-${landed.id}`,
        kind: "judgment",
        at,
        headline: `对谈里聊定一条待确认判断 · ${ref}`,
        actor: "您的 Agent",
        detail: [
          candidate.statement,
          "还是候选。您确认之后才是公司口径。",
        ].join("\n\n"),
        defaultOpen: false,
      });
      touch(issue, at);
      persistSoon();
    }

    /*
     * 撞车那一档在回执上单独挂一栏。**读它的是轮外结算那一格**：那边要在运营台账上
     * 记一条「这一次一个字都没落上去」，而撞车与「他已经确认过」两路的 `nodeId` 都是
     * null —— 靠 `why` 的措辞去分辨，等于把一句会改的屏幕文案当成判据。
     */
    return {
      boardId: landed.id,
      ref,
      nodeId,
      queuedArms,
      why,
      ...(collided ? { collided: true as const } : {}),
    };
  },

  /**
   * 列出一个议题的让步日志。
   */
  async listDeliberationLog(
    issueId: string,
  ): Promise<import("@/lib/agent/talk/point").DeliberationEntry[]> {
    await sleep(60, 120);
    findIssue(issueId);
    const log = store.deliberationLog[issueId] || [];
    return clone(log);
  },

  /**
   * 轮内取证的产物落到报告台账上，返回**真落进去的那几条**（编号已经重排过）。
   *
   * 编号怎么排、扫哪两处找最大号全在 `landMicroEvidence`（`talk/land.ts`）里，这里不写第二份；
   * 异步补证那一路（`recordEscalation`）走的也是这个方法 —— 一套逻辑一处。返回重排后的条目
   * 是因为调用方要拿新编号喂回模型：他下一轮问那个号，两头才对得上。
   *
   * **没有报告就不落，也不为此造一份空报告**（同交接深研那一路的口径）：屏幕上宁可少几条
   * 证据，也不许凭一次对谈生出一份没跑过深研的报告 —— 那份报告会让四处都说「深研已就绪」。
   *
   * 这一条**没有 `sleep`**：它压在一次对谈的路径上，而那一栏唯一的指标是第一个字什么时候出现。
   */
  async landTalkEvidence(
    issueId: string,
    entries: readonly import("@/lib/research/ledger").Evidence[],
  ): Promise<import("@/lib/research/ledger").Evidence[]> {
    if (entries.length === 0) return [];
    const doc = store.researchDocs[issueId];
    if (!doc) {
      console.warn(
        `[landTalkEvidence] 议题 ${issueId} 还没有报告，这次查证结果没有落处`,
      );
      return [];
    }
    const { doc: updated, added } = landMicroEvidence(doc, entries);
    store.researchDocs[issueId] = updated;
    persistSoon();
    return clone(entries.map((e, i) => ({ ...e, id: added[i] })));
  },

  /**
   * 「查一下」—— **他按下的那一次轻量核查**。一轮检索，落进同一本台账，就地引用作答。
   *
   * ## 它补的是哪个洞
   *
   * 一句追问值得核一下、又撑不起一整轮深研时，从前只有两档：什么都不查（模型凭记忆
   * 答），或者起一轮十几分钟的深研。这是中间那一档。
   *
   * ## 三步，前两步一个字都不新写
   *
   * 1. **取证** 走 `runMicroResearch` —— 它自己走 `a4/evidence.ts` 的 `gatherEvidence`，
   *    检索、抓取、抽取、入账、共源折叠、覆盖判定全是那一套。这里不碰检索。
   * 2. **落台账** 走 `landTalkEvidence` —— 与轮内取证、异步补证同一条路，编号在
   *    `landMicroEvidence` 里从台账现有最大号往后接。**共用台账是这一档的要害**：
   *    这一次查到的东西，后面那轮深研要能接着用，否则这一档就是白花钱。
   * 3. **作答** 走 `talk/check.ts` 的 `answerFromCheck`，编号只许从落库回来那几条里取。
   *
   * ## 三条不许越的线
   *
   * · **不读 `getResearchDoc`。** 那个方法不是纯读：它会 settle 一轮、没有报告时还会
   *   **起一轮深研**。一次分钟级的核查顺手起一轮十几分钟、花真钱的深研，是这条路上
   *   最贵的一种错，而屏幕上只表现成「这次查得有点久」。要台账就直接读
   *   `store.researchDocs`，要判有没有报告就判它在不在。
   * · **不进那套 25 分钟的预算**（`a4/deadline.ts`）：这里开的 harness 不带 deadline。
   * · **查不到不是失败**：照实回一句「这一轮没查到」，`found: false`，不抛。
   *
   * 落对话由调用方做（对话栏走它自己那条 `openAdvisorTurn` / `recordAdvisorReply`），
   * 这里只把话交出去 —— 记一轮对话的路已经有一条了，不在这里再开第二条。
   */
  async quickCheck(
    issueId: string,
    question: string,
  ): Promise<{ reply: string; found: boolean; evidenceIds: string[] }> {
    const q = question.trim();
    if (!q) throw new ApiError("要查什么，先写一句。");
    findIssue(issueId);

    const input = `查一下：${q}`;
    const openId = agentRunOpen({ agent: "A4", input });
    // 不带 deadline —— 这一档是分钟级的，不进深研那 25 分钟的墙上时间上限。
    const h = new Harness({ agent: "A4", slot: "pro" });
    try {
      // 三家里只有一家在跑时，产出的东西和只配了一家长得一模一样 —— 配置要留痕。
      const { list: search, skipped } = providers();
      h.note("检索配置", describeSearch(search, skipped), "local");

      const got = await runMicroResearch(
        h,
        { search },
        { question: q, issueId },
      );
      /*
       * 落库回来那几条才是喂给作答那一次的输入 —— 编号是落库那一步重排过的。拿重排
       * 之前的喂，他看到的 `[E1]` 指的是报告里另一条证据。落不下去（这条议题还没有
       * 报告）时就当这一轮没查到：一段引着不存在的编号的回答，比没有回答坏。
       */
      const landed =
        got.kind === "found"
          ? await api.landTalkEvidence(issueId, got.entries)
          : [];
      const out =
        landed.length > 0
          ? await answerFromCheck(h, q, landed)
          : notFoundReply(got.kind === "found" ? [q] : got.tried);

      if (out.fabricated.length) {
        // 正文不动（改了之后屏幕上那段话和它真说过的话就对不上），但要留痕。
        console.warn(
          `[quickCheck] ${issueId} 这一次引了台账里没有的号：${out.fabricated.join("、")}`,
        );
      }

      agentRunSettle(
        openId,
        h.finish({
          status: landed.length > 0 ? "ok" : "ignored",
          input,
          output:
            landed.length > 0
              ? {
                  found: landed.length,
                  cited: out.cited,
                  fabricated: out.fabricated,
                }
              : { why: out.reply },
        }),
      );
      return {
        reply: out.reply,
        found: landed.length > 0,
        evidenceIds: landed.map((e) => e.id),
      };
    } catch (err) {
      agentRunSettle(
        openId,
        err instanceof AgentRunFailed
          ? err.run
          : { error: err instanceof Error ? err.message : String(err) },
      );
      throw err;
    }
  },

  /**
   * 记一次升级 —— 轮内答不完时的三个出口。
   *
   * 过了校验才落库；不过就抛 `ApiError` 并留痕。三个出口各自挂到既有设施上：
   * - `async_research` → `runTask("talk-async", issueId, ...)` 并追加台账
   * - `evidence_action` → 只校验告知，`landed` 返回空串，`console.warn`（这一路还没有落点）
   * - `deep_research_handoff` → 调用 `ensureDeepResearch(issueId)`
   */
  async recordEscalation(
    escalation: unknown,
  ): Promise<{ landed: string; told: string }> {
    await sleep(80, 150);

    // 校验
    const result = checkEscalation(escalation);
    if (!result.ok) {
      const msg = `升级被拒：${result.why.join("；")}`;
      console.error(`[recordEscalation] ${msg}`);
      throw new ApiError(msg);
    }

    const e = result.value;
    const told = tellHim(e);

    // 按 type 分别处理
    if (e.type === "async_research") {
      // 转异步：runTask + 追加台账
      const { issueId, question } = e.payload;
      findIssue(issueId); // 确保议题存在

      // 按问题去重而不是按议题：同一个问题反复升级只跑一轮，不同问题各起一轮。
      // key 是 Map 的键，长一点没有代价，而写成问题原文的好处是任务表上一眼看得出在查什么。
      const taskId = `${issueId}:${question.trim()}`;

      runTask("talk-async", taskId, async () => {
        // 记账到运营台账，input 加前缀区分对谈取证与真的深研
        const openId = agentRunOpen({
          agent: "A4",
          input: `对谈取证：${question}`,
        });

        try {
          /*
           * **槽位写明，不吃默认值。** 轮内取证那一路（`src/app/api/chat/route.ts` 里
           * `micro` 那一格）写的是 `{ agent: "A4", slot: "pro" }`，这里从前只写 agent ——
           * 今天两者等价（`harness.ts` 默认就是 `pro`），而那个默认值一改，同一件事的
           * 两条路就分家了：台账上一半的取证记在 pro 上、一半记在别处，而两边都不会红。
           *
           * 那两段的**记账配方**（开一条运行、记检索配置、`h.finish` 的形状、catch 里
           * `AgentRunFailed ? err.run : { error }`）今天仍然是逐字两份，没合并：两条路的
           * 骨架不一样 —— 这一条跑在 `runTask` 里、`providers()` 自己取、落台账失败不必
           * 回退；那一条压在一次对谈的路径上、`search` 从外面带进来、落不下去要把原样那
           * 几条喂回模型。硬合出来的那个函数得收五个注入参数，比两份拷贝更难读。
           * **谁改这一段，隔壁那一段要一起改。**
           */
          const h = new Harness({ agent: "A4", slot: "pro" });
          const { list: search, skipped } = providers();
          // 记检索配置：三家里只有一家在跑，产出的报告和只配了一家长得一模一样
          h.note("检索配置", describeSearch(search, skipped), "local");

          const microResult = await runMicroResearch(
            h,
            { search },
            { question, issueId },
          );

          // 追加台账 —— 与轮内取证走同一个方法（`landTalkEvidence`），落法只有一份
          if (microResult.kind === "found") {
            await api.landTalkEvidence(issueId, microResult.entries);
          }

          // 收尾记账（成功） —— 调用 h.finish 获取运行记录
          const run = h.finish({
            status: microResult.kind === "found" ? "ok" : "ignored",
            input: `对谈取证：${question}`,
            output:
              microResult.kind === "found"
                ? {
                    found: microResult.entries.length,
                    groups: microResult.independentGroups,
                  }
                : { tried: microResult.tried, why: microResult.why },
          });
          agentRunSettle(openId, run);
          return {};
        } catch (err) {
          // 收尾记账（失败） —— 照 ensureDeepResearch 的写法
          agentRunSettle(
            openId,
            err instanceof AgentRunFailed
              ? err.run
              : { error: err instanceof Error ? err.message : String(err) },
          );
          throw err;
        }
      });

      return { landed: `talk-async:${taskId}`, told };
    } else if (e.type === "evidence_action") {
      // 取证行动：只校验告知，不落库
      const { issueId } = e.payload;
      findIssue(issueId);
      console.warn(`[recordEscalation] evidence_action 这一路还没有落点`);
      return { landed: "", told };
    } else {
      // deep_research_handoff：调用 ensureDeepResearch
      const { issueId } = e.payload;
      findIssue(issueId);
      const state = ensureDeepResearch(issueId);

      // 已有报告时 ensureDeepResearch 不起新一轮，如实告知
      if (state.status === "done") {
        return { landed: "", told: tellHim(e, { reportAlreadyThere: true }) };
      }

      return { landed: `deep:${issueId}`, told };
    }
  },

  /**
   * 直接确认一条候选决策 —— 判断 + 去向一步完成。
   *
   * 确认永远有运行后果（M1-A 原则 05）：`ontology` 真的翻版判断并布控重开条件；
   * `evidence` 真的布控监测靶点；`mission` 落成给 DRI 的建议（M1-A 止于建议）。
   * 「上会」不走这里 —— 用 `sendCandidateToMeeting`。
   */
  async confirmCandidate(
    issueId: string,
    nodeId: string,
  ): Promise<{ ir: ProbeNode; quick: QuickDecision }> {
    await sleep(700, 1200);
    const issue = findIssue(issueId);
    const ir = findNode(issueId, nodeId);
    if (!ir.route) {
      throw new ApiError(
        "这句判断还没有去向 —— 先在对话里把它聊到收敛，链路上才会给出去向。",
      );
    }
    if (ir.standing === "confirmed") throw new ApiError("这一条已经确认过了。");

    const at = nowIso();
    const me = viewer();
    const decisionId = nextDecisionId(at);
    const updatedObjects: WriteBackTarget[] = [
      {
        kind: "decision",
        label: `Decision ${decisionId} · 议题研究直接确认 · ${PROBE_ROUTE_LABEL[ir.route]}`,
        href: "/decisions",
      },
    ];
    let triggersArmed = 0;

    if (ir.route === "ontology" && ir.revisesJudgmentId && ir.nextStatement) {
      const judgment = findJudgment(ir.revisesJudgmentId);
      judgment.version += 1;
      judgment.statement = ir.nextStatement;
      judgment.standing = "confirmed";
      judgment.confirmedBy = me.name;
      judgment.confirmedAt = at;
      judgment.revisions.push({
        version: judgment.version,
        at,
        decisionId,
        note: ir.revisionNote ?? `因 ${issueId} 的候选决策直接确认而修订。`,
        actor: me.name,
      });
      judgment.shakenBy = judgment.shakenBy.filter((x) => x !== issueId);
      (ir.arms ?? []).forEach((text, i) => {
        judgment.reopenTriggers.push({
          id: `RT-${judgment.id}-${judgment.version}-${i + 1}`,
          text,
          armed: true,
        });
      });
      triggersArmed += (ir.arms ?? []).length;
      updatedObjects.push({
        kind: "judgment",
        label: `判断 ${judgment.id} → v${judgment.version}（已标注修订）`,
        href: `/judgments/${judgment.id}`,
      });
      recordChange({
        id: `JC-${judgment.id}-${at}`,
        at,
        judgmentId: judgment.id,
        kind: "version",
        headline: `${judgment.id} → v${judgment.version} · 因 ${decisionId} 变更（议题研究直接确认）`,
        actor: me.name,
        decisionId,
      });
    } else if (ir.route === "evidence") {
      const targetId = ir.targetJudgmentId ?? issue.judgmentRefs[0];
      if (targetId) {
        const judgment = findJudgment(targetId);
        (ir.arms && ir.arms.length > 0 ? ir.arms : [ir.text]).forEach(
          (text, i) => {
            judgment.reopenTriggers.push({
              id: `RT-${judgment.id}-${decisionId}-${i + 1}`,
              text,
              armed: true,
            });
            triggersArmed += 1;
          },
        );
        updatedObjects.push({
          kind: "evidence",
          label: `Evidence Action · ${ir.text}`,
        });
        recordChange({
          id: `JC-${judgment.id}-${at}`,
          at,
          judgmentId: judgment.id,
          kind: "armed",
          headline: `${judgment.id} 布控监测靶点 · 因 ${decisionId}`,
          actor: me.name,
          decisionId,
        });
      }
    } else if (ir.route === "mission") {
      updatedObjects.push({
        kind: "issue",
        label: `Mission 建议已发 ${issue.dri?.name ?? "对应 DRI"} · 待承接（M1-A 止于建议）`,
      });
    } else if (ir.route === "strategy") {
      updatedObjects.push({
        kind: "issue",
        label: "已标记为 Strategy 更新建议 · 进 M1-B 议程",
      });
    }

    if (triggersArmed > 0) {
      updatedObjects.push({
        kind: "trigger",
        label: reopenTriggerLabel(triggersArmed),
        href: ir.revisesJudgmentId
          ? `/judgments/${ir.revisesJudgmentId}`
          : ir.targetJudgmentId
            ? `/judgments/${ir.targetJudgmentId}`
            : undefined,
      });
    }

    ir.standing = "confirmed";
    ir.confirmedAt = at;
    ir.decisionId = decisionId;
    ir.writeBack = clone(updatedObjects);

    const quick: QuickDecision = {
      decisionId,
      issueId,
      issueTitle: issue.title,
      nodeId: ir.id,
      nodeText: ir.text,
      route: ir.route,
      at,
      updatedObjects: clone(updatedObjects),
    };
    store.quickDecisions.push(quick);

    pushEvent(issueId, {
      id: `E-${issueId}-quick-${decisionId}`,
      kind: "decision",
      at,
      headline: `候选决策直接确认 · Decision ${decisionId}`,
      actor: me.name,
      detail: `${ir.text}\n${updatedObjects.map((o) => o.label).join("\n")}`,
      defaultOpen: true,
    });
    touch(issue, at);

    // 写决策记忆：确认时沉淀判断、凭什么、以及推翻条件（Task 13）
    const statement = ir.nextStatement ?? ir.text;
    /*
     * 「凭什么」取板上那一条真写着的话，优先级三档：
     *
     * 1. `confirmed.support` —— **他自己点头时说的那句**。半年后重新打开这条判断，
     *    要检查的恰恰是他当时凭什么点的头（`BoardJudgement.confirmed.support` 的注释）。
     * 2. `basis` —— 参谋凭什么这么写。他还没在板上单独确认过这一条时（`confirmCandidate`
     *    走的是图上那条节点，不必经过板上那颗按钮），手边最实的就是这一句。
     * 3. 指针 —— 两样都没有时才退到这里。这一档等于没有信息，所以排最后：一条
     *    答不出「当初为什么那么判」的决策记忆，等于没有存在理由。
     *
     * 按 `boardKey`（正文前 30 字）把板上那一条找回来 —— 与 `landTalkCandidate`
     * 去重命中时用的是同一个口，判据只有一份。
     */
    const onBoard = (store.board[issueId] ?? []).find(
      (x) => boardKey(x.statement) === boardKey(statement),
    );
    const rationale =
      onBoard?.confirmed?.support ??
      onBoard?.basis ??
      `见 ${issueId} 的证据台账与 Decision ${decisionId} 的回写记录`;
    store.decisionMemories.push({
      id: `DM-${decisionId}`,
      judgment: statement,
      rationale,
      overturnConditions: ir.arms ?? [],
      issueTags: issueTagsOf(issue),
      sessionId: issueId, // 这个产品还没有独立的 session 身份，用 issueId 代替
      confirmedAt: at,
      status: "active",
    });
    persistSoon();

    return { ir: clone(ir), quick: clone(quick) };
  },

  /**
   * 一号位**明确进入行动整理** —— 从研究那一面走到「把已讨论的判断整理成可批准的行动」。
   *
   * ## 为什么这一下要落到服务端
   *
   * 研究完成不等于已经形成决议，更不等于该立即派发命令。深研自己交出一份决断包，那只是
   * 参谋把话整理成了可批准的形状；一号位有没有走进这一步，是另一件事。
   *
   * 这件事只记在浏览器里的话，`approveCommandBrief` 那道闸就只是把按钮藏起来了 ——
   * `/api/data` 是一个直接 POST 就打得进来的口（Next.js `mutating-data` 那份指南里那条
   * 警告说的正是这个）。所以它落库，批准那一路读它。
   *
   * ## 幂等
   *
   * 已经进过就把原来那个时刻还回去，不刷新 —— 这一栏答的是「他第一次走进行动整理是什么
   * 时候」，每点一次页签就往前挪一次的话，它答的就成了「他最后一次点开这一栏是什么时候」。
   *
   * **它不判交付完整性。** 缺论证的结果可以读、可以聊、可以接着研究，也可以走进来看看
   * 参谋把话整理成了什么样 —— 拦的是从这里按出去的那一下（见 `approveCommandBrief`）。
   */
  async enterActionStaging(issueId: string): Promise<{ at: string }> {
    await sleep(120, 260);
    const doc = store.researchDocs[issueId];
    if (!doc) {
      throw new ApiError("这件议题上还没有深研报告 —— 先把深研跑完，再谈整理行动。");
    }
    if (!doc.commandBrief) {
      throw new ApiError(
        "这一轮没有交出可批准的行动建议 —— 研究结果可以读、可以接着追问，但这里没有东西可整理。",
      );
    }
    if (!doc.actionStagingAt) {
      doc.actionStagingAt = nowIso();
      persistSoon();
    }
    return { at: doc.actionStagingAt };
  },

  /**
   * 批准一份决断包 —— 一号位在那一屏上按下的那一下，本地怎么落账。
   *
   * 三个动作同一个入口：
   *
   *   · **批准并下达** —— 不带 `edits`，参谋写的那一版原样生效。
   *   · **修改后批准** —— 带 `edits`，他改过的那几处覆盖掉原文并**固化回报告**。
   *   · **暂缓** —— 带 `hold`，只记一条决策记忆，**一条命令都不发、议题状态不动**。
   *
   * 批准这一路一次做五件事，**中间不许有 await**：记一条正式决策（走现成的
   * `quickDecisions` + `nextDecisionId`）、固化他改过的决心、把 `proposedOrders` 逐条落成
   * `DecisionOrder`、把指挥边界写成决策记忆的重开条件、推议题状态。这五件里任何一件单独
   * 落下都是一个不自洽的库（发了命令没有决策编号、决策记了却没有边界），所以下面那一段
   * 全是同步代码 —— 这个 store 是单线程的，一段不 await 的同步代码就是它能有的事务。
   * `sleep()` 只在最前面。
   *
   * **通知 DRI、写回本体：这一件不做。** 落一条 `DecisionOrder` 只是把「这条命令发过了」
   * 记在本地账上；真去找那个人（消息、待办、日程）没有实现。写回本体也没有 —— memory-api
   * 现在**只读**，本体的写接口来了再接（DECISIONS §U-5）。写在这里是因为别人读到
   * 「批准并下达」这个名字会以为命令真的送出去了，而这一层什么都没送。
   */
  async approveCommandBrief(
    issueId: string,
    input?: {
      /** 一号位改过的地方。不带 = 原样批准。 */
      edits?: CommandBriefEdits;
      /** 带上就是暂缓。`why` 是他当场给的理由，进决策记忆的「凭什么」。 */
      hold?: { why: string };
    },
  ): Promise<CommandBriefApproval> {
    await sleep(300, 600);

    const issue = findIssue(issueId);
    const doc = store.researchDocs[issueId];
    const brief = doc?.commandBrief;
    if (!brief) {
      throw new ApiError(
        "这件议题上还没有决断包 —— 它由深研收口那一次交出来，先把深研跑完。",
      );
    }

    /*
     * **这道闸在服务端，不是把按钮藏起来。**
     *
     * `/api/data` 是一个直接 POST 就打得进来的口（Next.js 那份 `mutating-data` 指南里
     * 写着同一句话：Server Function 不只从你自己的界面进得来，每一处都要自己验）。所以
     * 「这一轮进没进过行动整理」「这一份交付完不完整」只能在这里判 —— 屏幕上那一颗置灰
     * 的按钮拦得住手，拦不住一条 curl。
     *
     * 判据只有一份（`dispatchBlockReason`），屏幕拿同一句话置灰并写原因。
     *
     * 暂缓那一路只过**行动整理**这一关：它一条命令都不发，拦它没有可保护的东西；而它本身
     * 就只在行动整理那一屏上按得到，所以那一关照过。完整性和「只够讨论」两关只拦真会
     * 下达的那两路（批准并下达 / 修改后批准）。
     */
    const delivery = readReportDelivery(doc);
    if (!delivery.staged) {
      throw new ApiError(dispatchBlockReason(delivery)!);
    }
    if (!input?.hold) {
      const blocked = dispatchBlockReason(delivery);
      if (blocked) throw new ApiError(blocked);
    }

    const at = nowIso();
    const me = viewer();

    /*
     * 指挥边界摊成决策记忆的重开条件。**三类各自带前缀**：`renderDecisionMemories` 是
     * 把这一栏一行一行原样打进模型前缀的（`talk/prefix.ts`），不加前缀的话「不许动价格」
     * 和「价格动了就回来」在那一屏上长得一模一样，而它们要求的行为正好相反。
     */
    const overturnConditions = [
      ...brief.controls.mustNot.map((x) => `不许：${x}`),
      ...brief.controls.changeTriggers.map((x) => `变了就回来：${x}`),
      ...brief.controls.abortConditions.map((x) => `直接中止：${x}`),
    ];

    // ---- 暂缓 --------------------------------------------------------------
    if (input?.hold) {
      /*
       * 暂缓**不占决策编号**：它不是一个决定，是「今天先不定」。占了编号的话，判断修订史
       * 里那个「因哪个决定变的」的键会指向一次什么都没发生的操作。
       *
       * 记忆 id 因此也不能是 `DM-<决策编号>` —— 同一件议题可以暂缓两次，所以把时刻编进去。
       */
      const memoryId = `DM-hold-${issueId}-${at}`;
      store.decisionMemories.push({
        id: memoryId,
        judgment: `${HELD_MEMORY_PREFIX}${brief.recommendation.action}`,
        rationale: input.hold.why,
        /*
         * 暂缓照样存边界。它答的是「什么变了就该把这件事重新端上来」—— 而一件被暂缓的事
         * 恰恰是最需要这个答案的：批准过的事有命令盯着，暂缓的事只有这一条记忆盯着。
         */
        overturnConditions,
        issueTags: issueTagsOf(issue),
        sessionId: issueId, // 这个产品还没有独立的 session 身份，用 issueId 代替
        confirmedAt: at,
        status: "active",
      });

      pushEvent(issueId, {
        id: `E-${issueId}-brief-hold-${at}`,
        kind: "decision",
        at,
        headline: "决断包暂缓 · 未下达命令",
        actor: me.name,
        detail: `${brief.recommendation.action}\n暂缓理由：${input.hold.why}`,
        defaultOpen: true,
      });
      touch(issue, at);
      persistSoon();

      return {
        decisionId: null,
        issueId,
        at,
        held: true,
        orders: [],
        memoryId,
        // 暂缓不推状态：这件事还压在他身上，屏幕上就得照旧压着。
        newState: issue.state,
        updatedObjects: [],
      };
    }

    // ---- 批准（原样 / 改过） ------------------------------------------------
    const edits = input?.edits;
    const decisionId = nextDecisionId(at);

    /*
     * 1）固化他改过的决心。改的是**报告上那一份**，不是另存一份「批准版」：一份决断包是
     *    这一轮深研的结论面（见 `ResearchDoc.commandBrief`），存两份就得回答「屏幕上该
     *    显示哪一份」，而半年后他要看的只有一个答案 —— 他点头的那一版。参谋原来那一版
     *    留在决策记忆和下面这些 `DecisionOrder` 的账上。
     */
    const recommendation = {
      ...brief.recommendation,
      ...(edits?.recommendation ?? {}),
    };
    const decisionsRequired = clone(
      edits?.decisionsRequired ?? brief.decisionsRequired,
    );
    const patchOf = (index: number) =>
      edits?.orders?.find((p) => p.index === index);
    const proposedOrders = brief.proposedOrders.map((o, i) => {
      const p = patchOf(i);
      return {
        ...clone(o),
        role: p?.role ?? o.role,
        outcome: p?.outcome ?? o.outcome,
        dueOn: p?.dueOn ?? o.dueOn,
        acceptance: clone(p?.acceptance ?? o.acceptance),
      };
    });
    doc.commandBrief = {
      ...clone(brief),
      recommendation,
      decisionsRequired,
      proposedOrders,
    };

    /*
     * 2）逐条落成命令。
     *
     *    `driId` 只从这次调用的参数来 —— 决断包里根本没有这一栏（模型不许填人名，理由写在
     *    `CommandBrief.proposedOrders` 上）。没给就整个字段不写：库里「没有这个键」和
     *    「这个键是空串」在屏幕上是两句话，前者才是「还没派人」。
     */
    const briefAt = doc.at ?? at;
    const orders: DecisionOrder[] = proposedOrders.map((o, i) => {
      const driId = patchOf(i)?.driId;
      /*
       * 期限分两栏落（`splitDue`）。决断包里那一栏是模型写的一行自由文本，可能是
       * `2026-09-15`，也可能是「首访前」，也可能什么都没写 —— 而 `DecisionOrder.dueOn`
       * 是会被日期解析器消费的那一栏。相对时间原话进 `dueNote`，不换算成任何一个具体
       * 日子：「首访前」是哪一天取决于首访约在哪天，这个库不知道。
       */
      const due = splitDue(o.dueOn);
      return {
        id: `DO-${decisionId}-${i + 1}`,
        issueId,
        briefAt,
        role: o.role,
        ...(driId ? { driId } : {}),
        outcome: o.outcome,
        dueOn: due.dueOn,
        ...(due.dueNote ? { dueNote: due.dueNote } : {}),
        acceptance: clone(o.acceptance),
        issuedAt: at,
      };
    });
    store.decisionOrders.push(...clone(orders));

    /*
     * 3）记一条正式决策。走现成的 `quickDecisions` 那条路，不新开一张决策表 ——
     *    `nextDecisionId` 是从账上算「哪些编号发过了」的（它的头注释写着：再开一条发编号
     *    的路就得把落点加进去），而 `quickDecisions` 已经是它认的三条来源之一。落在这里，
     *    编号去重、决策那一页、议题详情里的「相关决定」三处一次都不用改。
     *
     *    `route` 记 `mission`：批准一份决断包的运行后果就是把活派出去（M1-A 的 B 档）。
     *    `nodeId` 不是探针节点 —— 决断包这条路上没有节点，写一个说得出出处的常量。
     */
    const updatedObjects: WriteBackTarget[] = [
      {
        kind: "decision",
        label: `Decision ${decisionId} · 决断包批准 · ${PROBE_ROUTE_LABEL.mission}`,
        href: "/decisions",
      },
      ...orders.map((o) => ({
        kind: "issue" as const,
        /*
         * 没有日期就写「时间待定」，不写「 前 …」—— 那句话读起来像「在空白之前完成」。
         * 有相对时间说明就照原话写，不带「前」字：「首访前 前 …」是两个前。
         */
        label: `命令 ${o.id} · ${o.role}${o.driId ? ` · ${o.driId}` : " · 待指派"} · ${
          o.dueOn ? `${o.dueOn} 前 ` : `${dueLabel(o)} · `
        }${o.outcome}`,
      })),
    ];
    if (overturnConditions.length > 0) {
      updatedObjects.push({
        kind: "trigger",
        label: `指挥边界 ${overturnConditions.length} 条 · 已进决策记忆`,
      });
    }

    const quick: QuickDecision = {
      decisionId,
      issueId,
      issueTitle: issue.title,
      nodeId: COMMAND_BRIEF_NODE_ID,
      nodeText: recommendation.action,
      route: "mission",
      at,
      updatedObjects: clone(updatedObjects),
    };
    store.quickDecisions.push(quick);

    /*
     * 4）决策记忆 + 指挥边界。口径照 `confirmCandidate` 那一处：`judgment` 是定下来的那句话，
     *    `rationale` 是凭什么。这里两样都在决断包里现成写着 —— `intent` 是「要达成什么」、
     *    `whyNow` 是「为什么是现在」，合起来正是半年后重开这条决策时要核的那两问。
     */
    const memoryId = `DM-${decisionId}`;
    store.decisionMemories.push({
      id: memoryId,
      judgment: recommendation.action,
      rationale: `${recommendation.intent}｜${recommendation.whyNow}`,
      overturnConditions,
      issueTags: issueTagsOf(issue),
      sessionId: issueId, // 同上：还没有独立的 session 身份
      confirmedAt: at,
      status: "active",
    });

    /*
     * 5）议题状态。批准并下达是这件议题在一号位这里的最后一次处置 —— 它转成执行，不该再
     *    挂在等他拍板那一栏里。落 `Decided` 而不是 `Monitoring`：`SETTLED_STATES` 里这两档
     *    都算「已部署」，而 `Monitoring` 在这个库里的意思是「布控了重开条件在盯着」，
     *    那条路要有真的 `ReopenTrigger`（见下面那条欠账），这里没有。
     *
     *    已经了结的不再覆盖，口径同 `confirmDebrief`：重复批准不该把一件已经关掉的议题
     *    拽回「已拍板」。
     */
    if (!SETTLED_STATES.has(issue.state)) {
      issue.state = "Decided";
      issue.decidedAt = at;
    }
    issue.nextActionForUser = null;
    issue.monitoringNote =
      orders.length > 0
        ? `决断包已批准 · 下达 ${orders.length} 条命令`
        : "决断包已批准 · 无命令";
    touch(issue, at);
    updatedObjects.push({
      kind: "issue",
      label: `${issueId} → ${issue.state}`,
      href: `/issues/${issueId}`,
    });

    pushEvent(issueId, {
      id: `E-${issueId}-brief-${decisionId}`,
      kind: "decision",
      at,
      headline: `决断包批准 · Decision ${decisionId}${edits ? " · 修改后批准" : ""}`,
      actor: me.name,
      detail: `${recommendation.action}\n${updatedObjects.map((o) => o.label).join("\n")}`,
      defaultOpen: true,
    });
    persistSoon();

    return {
      decisionId,
      issueId,
      at,
      held: false,
      orders: clone(orders),
      memoryId,
      newState: issue.state,
      updatedObjects: clone(updatedObjects),
    };
  },

  /**
   * 命令板要的那张表。不带议题号 = 全部，带了 = 只看这一件的。
   *
   * 状态不在返回值里 —— 由 `decisionOrderState(order)` 现推（理由写在那个函数上）。
   */
  async listDecisionOrders(issueId?: string): Promise<DecisionOrder[]> {
    await sleep(140, 300);
    const all = issueId
      ? store.decisionOrders.filter((o) => o.issueId === issueId)
      : store.decisionOrders;
    return clone(all);
  },
  /** 会后确认里「议题研究直接确认」那一小节的账。最新在上。 */
  // -------------------------------------------------------------------------
  // 会议
  // -------------------------------------------------------------------------

  /**
   * 这个域下一场会准备得怎么样了。
   *
   * 议程是算出来的，不是存下来的：一件议题**从议题研究里带了拆分点上会**，它才在议程上。
   * 一件都没带上会 = 这场会还开不起来，屏幕上照实说，并且给一条回研究室的路 ——
   * 「没准备好」不是一句评价，是一个待办，待办要能点。
   */
  async getMeetingPrep(domainId: string): Promise<MeetingPrep> {
    settleResearch();
    await sleep(240, 460);
    const meeting = store.meetings.find((m) => m.domainId === domainId);
    if (!meeting) throw new ApiError("这个域还没有排会。");
    const domain = allDomains.find((d) => d.id === domainId);
    if (!domain) throw new ApiError("没有这个业务域。");
    const driName =
      domainDriLabel(domain);

    /*
     * 议程 = 这个域**没了结的议题** + **已经装配了会前一页纸的议题**。
     *
     * 只按「没了结」筛的那一版里，一件已经拍过板、但这场会还要复核一次的议题
     * 进不了议程 —— 而它的一页纸就躺在对象库里，屏幕上却说这个域没有议程。
     * 有一页纸就是上过议程的证据，比状态机的值更贴近「这场会要谈什么」。
     */
    const items: MeetingPrepItem[] = store.issues
      .filter(
        (i) =>
          i.domainId === domainId &&
          // 潜在议题不进议程 —— 它还没被决定要研究，更谈不上要在会上过。
          i.state !== "Candidate" &&
          (!SETTLED_STATES.has(i.state) || Boolean(store.briefs[i.id])),
      )
      .map((issue) => ({
        issue: summarize(issue),
        queued: (store.probeNodes[issue.id] ?? []).filter(
          (ir) => ir.standing === "direction",
        ).length,
        briefReady: Boolean(store.briefs[issue.id]),
      }))
      .sort(
        (a, b) =>
          b.queued - a.queued ||
          b.issue.updatedAt.localeCompare(a.issue.updatedAt),
      );

    return {
      meeting: clone(meeting),
      domain: { id: domain.id, code: domain.code, name: domain.name, driName },
      items,
    };
  },

  /** 开会。议程为空开不了 —— 一场没有议程的会，产物只会是又一次「再研究研究」。 */
  async startMeeting(domainId: string): Promise<Meeting> {
    await sleep(400, 700);
    const meeting = store.meetings.find((m) => m.domainId === domainId);
    if (!meeting) throw new ApiError("这个域还没有排会。");
    if (meeting.state !== "preparing") return clone(meeting);
    const onAgenda = store.issues.some(
      (i) =>
        i.domainId === domainId &&
        (store.probeNodes[i.id] ?? []).some(
          (ir) => ir.standing === "direction",
        ),
    );
    if (!onAgenda)
      throw new ApiError(
        "议程还是空的 —— 先到议题研究里把一条判断聊到立得住。",
      );
    meeting.state = "running";
    meeting.startedAt = nowIso();
    return clone(meeting);
  },

  /**
   * 散会。这一下生成闭环单草案。
   *
   * **草案是从会前带上会的那些拆分点装出来的**，不是凭空写的：每条拆分点带着它自己的
   * 去向、要改的判断、接受的风险、重开条件 —— 那正好就是闭环单一个条目要的东西。
   * 会上没说全的（期限、成功证据）标成「AI 补全」，等他核。
   */
  async endMeeting(domainId: string): Promise<Meeting> {
    await sleep(500, 900);
    const meeting = store.meetings.find((m) => m.domainId === domainId);
    if (!meeting) throw new ApiError("这个域还没有排会。");
    if (meeting.state === "preparing") throw new ApiError("这场会还没开始。");
    if (meeting.state === "closed") return clone(meeting);
    meeting.state = "closed";
    meeting.endedAt = nowIso();
    store.closures[meeting.id] = buildClosure(meeting);
    return clone(meeting);
  },

  /** 这个域此刻有没有一份等着签发的闭环单。 */
  async getMeetingClosure(domainId: string): Promise<MeetingClosure | null> {
    await sleep(180, 340);
    const meeting = store.meetings.find((m) => m.domainId === domainId);
    if (!meeting || meeting.state !== "closed") return null;
    const closure = store.closures[meeting.id];
    if (!closure) return null;
    return clone({ ...closure, minutesSince: minutesSince(closure.endedAt) });
  },

  /**
   * 这件议题那场会 —— 会前要读的、会后要核的，一次取齐。
   *
   * 会议按域取的那一版里，屏幕先要选域、再在域下面找议题；而一件议题只开一次讨论会，
   * 会前准备准备的就是这一件事。所以入参是议题，不是域。
   *
   * 闭环单只留**这件议题的条目**：一场会同时过了三件议题，把三件的条目全摆在一件的
   * 会后确认页上，他就分不清哪几条是这件事定的。
   */
  async getIssueMeeting(issueId: string): Promise<IssueMeeting> {
    settleResearch();
    await sleep(220, 420);
    const issue = findIssue(issueId);
    const meeting =
      store.meetings.find((m) => m.domainId === issue.domainId) ?? null;

    const closureAll =
      meeting && meeting.state === "closed"
        ? store.closures[meeting.id]
        : undefined;
    const mine = closureAll?.items.filter((i) => i.issueRef === issueId) ?? [];
    const closure =
      closureAll && mine.length > 0
        ? clone({
            ...closureAll,
            minutesSince: minutesSince(closureAll.endedAt),
            items: mine,
          })
        : null;

    const domain = allDomains.find((d) => d.id === issue.domainId);
    const driName = domainDriNames(domain)[0];

    return {
      issue: summarize(issue),
      meeting: meeting ? clone(meeting) : null,
      intake: (dm.meetingIntake[issueId] ?? []).map((it) => ({
        ...it,
        label:
          it.kind === "dri" && driName ? `DRI 反馈 · ${driName}` : it.label,
      })),
      briefReady: Boolean(store.briefs[issueId]),
      records: (dm.meetingRecords[issueId] ?? [])
        .map((docId) => store.docs.find((d) => d.id === docId))
        .filter((d): d is Doc => Boolean(d))
        .map((d) => ({
          docId: d.id,
          title: d.title,
          body: d.body,
          updatedAt: d.updatedAt,
        })),
      closure,
    };
  },

  // -------------------------------------------------------------------------
  // 排会 —— 首页那块编辑模式
  //
  // 五个写口一个读口。所有的「聚类」都在 `scheduleIssue` 那一句里：时间算出 id，
  // 库里有就往里加一件。别处一行合并逻辑都没有，也不该有。
  // -------------------------------------------------------------------------

  /**
   * 已经排下的那些会。给排会面板上「并进已有的一场」那几颗按钮用。
   *
   * 连**已经开完的**一起给：他可能在会后才回来看，而那时那几场会正是要传录音的那几场。
   * 「开完没有」由屏幕按时间自己判（`slotEnded`），数据层不预先筛掉 —— 筛掉的话，
   * 一场刚散的会在屏幕上会直接消失。
   */
  async listSlots(): Promise<MeetingSlot[]> {
    await sleep(120, 240);
    return clone([...store.meetingSlots].sort(bySlotTime));
  },

  /**
   * 把一件议题排进某一天的上午或下午。**这一下同时就是「排进哪一场会」。**
   *
   * 同一个日期加同一个半天算出同一个 id（`slotIdOf`），所以：库里已经有那一格，这件议题
   * 就加进去，两件议题从此在同一场会上；没有就新建一场。屏幕上那个聚类不需要任何额外的
   * 动作，也没有「合并两场会」这种操作 —— 于是也就不会有「看着是同一场、其实是两条」。
   *
   * 换时间就是先摘再排：一件议题只可能在一场会上。摘完那场会空了就把它删掉 ——
   * 一场没有议题的会在屏幕上是一块什么都不说的色块。
   *
   * **前期调研没做完的不给排。** 这一条是他自己定的：可以开会的判据是那份研究到手了
   * （`readyForMeeting`，口径写在 `IssueSummary` 上）。屏幕上那几件本来就没有排会的入口，
   * 这里再挡一道是因为拖拽也能排 —— 两条路必须落在同一个判据上。
   */
  async scheduleIssue(
    issueId: string,
    at: { date: string; half: DayHalf },
  ): Promise<MeetingSlot> {
    await sleep(120, 240);
    const issue = findIssue(issueId);
    const bad = slotTimeError(at.date, at.half);
    if (bad) throw new ApiError(bad);
    /*
     * 已了结的议题不排会。它要么已经拍过板、要么已经否掉 —— 给它排一场会，会上没有
     * 任何要定的事，而它会占掉议程上一行。
     */
    if (SETTLED_STATES.has(issue.state))
      throw new ApiError("这件议题已经了结了，不用再上会。");
    if (!isReadyForMeeting(issueId)) {
      throw new ApiError("这件议题的前期调研还没到手，先让研究跑完。");
    }

    detachFromSlot(issueId);

    const id = slotIdOf(at.date, at.half);
    let slot = store.meetingSlots.find((s) => s.id === id);
    if (!slot) {
      slot = {
        id,
        date: at.date,
        half: at.half,
        issueIds: [],
        extraDomainIds: [],
        createdAt: nowIso(),
      };
      store.meetingSlots.push(slot);
    }
    /*
     * 已经结束的那一格不再收新议题 —— **到点了算结束，他提前按那一下也算**。
     *
     * 收进去的话，这件议题会立刻显示成「在等你确认会后要点」，而那场会上根本没谈过它。
     * 两条判据合成一句是因为屏幕上它们本来就是同一件事：编排页只摆还没结束的那几格
     * （见 `slotPast` 上那段），所以走到这里的只可能是拖拽落错或者两个人同时在改。
     */
    /*
     * 「过去了」先判：一场昨天开完的会两条都命中，而那时该说的是「已经过去了」——
     * 「已经开完了」听起来像是今天刚散的那一场，会让他去找一个不存在的下一格。
     */
    if (slotPast(slot, readClock())) {
      throw new ApiError("这一场已经过去了，排到下一场。");
    }
    if (slot.endedAt) throw new ApiError("这场会已经开完了，排到下一场。");
    slot.issueIds.push(issueId);

    pushEvent(issueId, {
      id: `E-${issueId}-slot-${id}`,
      kind: "state",
      at: nowIso(),
      headline: `编排会议 · ${slotLabel(slot, seed.TODAY)}${
        slot.issueIds.length > 1 ? `（同场 ${slot.issueIds.length} 件）` : ""
      }`,
      actor: viewer().name,
      defaultOpen: false,
    });

    persistSoon();
    console.warn(
      `[tkos:store] ${issueId} 排进 ${id}（这场会共 ${slot.issueIds.length} 件）。`,
    );
    return clone(slot);
  },

  /** 并进已经排好的一场。和 `scheduleIssue` 是同一件事的另一种说法，省得屏幕去抄那两个字段。 */
  async joinSlot(issueId: string, slotId: string): Promise<MeetingSlot> {
    const slot = store.meetingSlots.find((s) => s.id === slotId);
    if (!slot) throw new ApiError("没有这一场会 —— 可能刚被撤掉了。");
    return api.scheduleIssue(issueId, { date: slot.date, half: slot.half });
  },

  /**
   * 请一个域的 DRI 到场 / 撤掉 —— **只用于「他手上没有议题在这场会上」的那种到场。**
   *
   * 参会域默认是算出来的（会上那几件议题各自的域，见 `domainsOfSlot`），所以绝大多数
   * 情况这个方法不会被调到。它补的是唯一一种算不出来的情形：某个域的人要来，但他没有
   * 议题在议程上。
   *
   * 已经在议程上的域**不许再加一遍**：加了之后撤不掉（撤的是 `extraDomainIds`，而它
   * 本来就由议题贡献着），屏幕上就会出现一个按不动的标记。
   */
  async inviteDomain(
    slotId: string,
    domainId: string,
    on: boolean,
  ): Promise<MeetingSlot> {
    await sleep(100, 200);
    const slot = store.meetingSlots.find((s) => s.id === slotId);
    if (!slot) throw new ApiError("没有这一场会。");
    if (!allDomains.some((d) => d.id === domainId))
      throw new ApiError("没有这个业务域。");
    const fromIssues = slot.issueIds.some(
      (id) => store.issues.find((i) => i.id === id)?.domainId === domainId,
    );
    if (fromIssues) {
      throw new ApiError("这个域已经有议题在这场会上了。");
    }
    const at = slot.extraDomainIds.indexOf(domainId);
    if (on && at < 0) slot.extraDomainIds.push(domainId);
    if (!on && at >= 0) slot.extraDomainIds.splice(at, 1);
    persistSoon();
    return clone(slot);
  },

  /**
   * 标记这场会开完了。
   *
   * **为什么需要一个人按下去**：粒度只到上午/下午之后，时钟答不出「散会了没有」——
   * 而这件事必须有一个确定的答案，会后那整条链路（交材料、提炼、确认）都挂在它后面。
   * 会中自动记录那条路还没有，所以这一下同时也是「我要开始交材料了」的起点。
   *
   * 幂等：按第二下什么都不做。屏幕上那颗键按完就换成上传入口，但两个人（他和秘书）
   * 同时开着这一屏时仍然可能各按一下。
   */
  async endMeetingSlot(slotId: string): Promise<MeetingSlot> {
    await sleep(120, 240);
    const slot = store.meetingSlots.find((s) => s.id === slotId);
    if (!slot) throw new ApiError("没有这一场会。");
    if (slot.endedAt) return clone(slot);
    if (slot.issueIds.length === 0)
      throw new ApiError("这场会上一件议题都没有。");
    slot.endedAt = nowIso();
    for (const issueId of slot.issueIds) {
      pushEvent(issueId, {
        id: `E-${issueId}-slot-end-${slotId}`,
        kind: "state",
        at: slot.endedAt,
        headline: `会议结束 · ${slotLabel(slot, seed.TODAY)}`,
        actor: viewer().name,
        defaultOpen: false,
      });
    }
    persistSoon();
    console.warn(
      `[tkos:store] ${slotId} 标记为已结束（${slot.issueIds.length} 件议题）。`,
    );
    return clone(slot);
  },

  /**
   * **这场会没开。** 整场撤掉，上面那几件议题原样回到议题清单里。
   *
   * ## 为什么必须有这一口
   *
   * 「这一格过去了」现在是由时钟判的（见 `slotPast`），所以一场排在昨天下午的会，第二天
   * 早上一定会出现在会后那一栏里等纪要 —— **哪怕它压根没开**。会被取消、人没到齐、临时
   * 挪走，这些都不会有任何东西来通知系统。
   *
   * 没有这一口的话，那几件议题就卡死在「等一份永远不会来的纪要」上：它们不在议题栏里
   * （已经挪走了），也排不进新的会（`scheduleIssue` 会先 `detachFromSlot`，但屏幕上根本
   * 没有入口把它们拖回去）。唯一的出路是伪造一份纪要，而那是往账上写一场没发生过的会。
   *
   * ## 为什么是删掉整场，不是只标一个「取消」
   *
   * 一场没开过的会在账上不该留下痕迹 —— 它没有产出、没有参会人、没有任何可查的东西。
   * 留一条「已取消」的空记录，只会让日程上多一格什么都不说的色块。真正该留痕的是那几件
   * 议题各自的时间线，所以下面按议题各推一条。
   *
   * 已经有纪要的不给撤：那时它已经开过了，账上有东西了。要退回研究中走「还需再议」。
   */
  async cancelMeetingSlot(slotId: string): Promise<{ issueIds: string[] }> {
    await sleep(120, 240);
    const slot = store.meetingSlots.find((s) => s.id === slotId);
    if (!slot) throw new ApiError("没有这一场会 —— 可能刚被撤掉了。");
    const withNotes = slot.issueIds.filter(
      (id) => store.debriefs[debriefKeyOf(slotId, id)],
    );
    if (withNotes.length > 0) {
      throw new ApiError(
        "这场会已经有纪要了，撤不掉。要退回研究中，走「还需再议」。",
      );
    }

    const issueIds = [...slot.issueIds];
    const at = nowIso();
    const label = slotLabel(slot, seed.TODAY);
    // 先把事件推完再删 —— `detachFromSlot` 摘空之后这一场就没了，`label` 也就取不到了。
    for (const issueId of issueIds) {
      pushEvent(issueId, {
        id: `E-${issueId}-slot-cancel-${slotId}`,
        kind: "state",
        at,
        headline: `会议未召开 · ${label}`,
        actor: viewer().name,
        defaultOpen: false,
      });
    }
    for (const issueId of issueIds) detachFromSlot(issueId);

    persistSoon();
    console.warn(
      `[tkos:store] ${slotId} 未召开，${issueIds.length} 件议题退回清单。`,
    );
    return { issueIds };
  },

  /** 把这件议题从它那场会上摘下来。摘空了那场会就没了。 */
  async unscheduleIssue(issueId: string): Promise<{ issueId: string }> {
    await sleep(100, 200);
    findIssue(issueId);
    if (!detachFromSlot(issueId)) return { issueId };
    persistSoon();
    console.warn(`[tkos:store] ${issueId} 撤掉了排会。`);
    return { issueId };
  },

  /**
   * 他在面板上拖出来的顺序。
   *
   * 整串写回，不做增量：拖一次动的是整份清单的相对次序（见 `store.agendaOrder`）。
   * 传进来的号里有已经不存在的也照收 —— 那只是一个不会被用到的下标，而为了这个去
   * 校验一遍反而会让「刚删掉一件议题就再也拖不动」成为可能。
   */
  async reorderAgenda(issueIds: string[]): Promise<{ order: string[] }> {
    await sleep(60, 140);
    if (
      !Array.isArray(issueIds) ||
      issueIds.some((x) => typeof x !== "string")
    ) {
      throw new ApiError("顺序得是一串议题号。");
    }
    /*
     * 同一场会里拖动，顺序要落在**那场会自己的议程**上，不是落在 `agendaOrder` 上：
     * 一场会内部的次序由 `slot.issueIds` 说了算（`agendaCompare` 先比它）。不同步的话，
     * 他在一场会里把第三件拖到第一，松手之后它会弹回去 —— 而弹回去看着就像拖拽坏了。
     */
    for (const slot of store.meetingSlots) {
      const rank = new Map(issueIds.map((id, i) => [id, i] as const));
      slot.issueIds.sort(
        (a, b) =>
          (rank.get(a) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
      );
    }
    store.agendaOrder = [...issueIds];
    persistSoon();
    return { order: [...store.agendaOrder] };
  },

  // -------------------------------------------------------------------------
  // 会后 —— 录音转成的字，提炼成要点和待办
  // -------------------------------------------------------------------------

  /**
   * 一份会议记录进来，先判它有没有用，有用才按议题拆成要点和待办。
   * **转写在路由那一层做完，这里只收文字；而且立刻返回，两段都在后台跑。**
   *
   * ## 为什么立刻返回
   *
   * 一号位定的样子是：交完材料，那一块**不动位置**（仍在议题栏），底下换成流动的
   * 马赛克，跑完了才整场挪到右栏。要做到「不动位置」，屏幕就得在他松手那一刻立刻
   * 拿到「正在判」这个状态 —— 而等跑完再返回的话，那几十秒到几分钟里屏幕手上什么
   * 都没有，只能自己编一句话。所以这里只做三件当场答得出的事（这场会在不在、材料
   * 够不够长、这场会上有没有议题），把全文落库，然后开一个任务就返回。
   *
   * 屏幕之后问 `slotIntakeState` 拿这一场走到哪一步了。
   *
   * ## 为什么先判一眼再提炼
   *
   * 交错东西是这条链路上最常见的错（传成上周那场会、传成一份产品方案、录音只录到
   * 开场）。原来这三种全都直接进 A7 —— 那是一次 `pro` 档、吃下几万字的调用，跑完
   * 摊在卡面上的是一份「读起来通顺、说的却是别的事」的要点。所以先花一次 `flash`
   * 问一句对不对得上（`a7/intake.ts`），对不上就把它那句原话留在这一场会上，
   * **后面那一大笔不花**。
   *
   * ## 一场会过了几件议题就出几份
   *
   * `MeetingDebrief` 的单位是「议题 × 会」。已经有过一份的重跑会**盖掉** —— 但确认过
   * 的那几份不盖：那时候上面已经有他改过的字。
   */
  async ingestMeetingNotes(
    slotId: string,
    transcript: string,
    audioName?: string,
  ): Promise<SlotIntakeState> {
    const slot = store.meetingSlots.find((s) => s.id === slotId);
    if (!slot) throw new ApiError("没有这一场会。");
    const text = transcript.trim();
    if (text.length < 20)
      throw new ApiError("这份记录太短了，提炼不出东西来。");
    const issues = slot.issueIds
      .map((id) => store.issues.find((i) => i.id === id))
      .filter(Boolean) as Issue[];
    if (issues.length === 0) throw new ApiError("这场会上一件议题都没有。");
    /*
     * 上一份还在跑的时候不收第二份。**这一句是拒绝，不是排队**：两轮同时跑会往同一批
     * `debriefs` 上写，先写完的那一份被后写完的盖掉，而屏幕上看不出发生过这件事。
     * 秘书和他同时传一份，或者他手一抖点了两次，走的都是这条。
     */
    const running = taskState("debrief", slotId);
    if (running.status === "running")
      throw new ApiError("这一场的材料正在处理，等它跑完再交下一份。");

    /*
     * 全文先落库，判和提炼都还没跑。
     *
     * 顺序是有意的：这一份是**他交上来的东西**，它在不在库里跟模型判成什么无关。反过来
     * 写（跑完再存）的话，判没用的那一份就永远进不了库 —— 而那正是他最想点开看一眼
     * 「我到底传了个什么」的一份。
     */
    slot.transcript = text;
    if (audioName) slot.audioName = audioName;
    // 上一份被判掉时留的那句话不许跟到这一份上：屏幕会照登它，而它说的是上一份。
    delete slot.intakeRejection;
    persistSoon();

    const label = slotLabel(slot, seed.TODAY);
    runTask("debrief", slotId, async () => {
      /* ---- 第一段：这份材料是不是这场会的记录 ---- */
      const checkId = agentRunOpen({ agent: "A7", input: `${label} · 判材料` });
      let verdict: Awaited<ReturnType<typeof judgeIntake>>;
      try {
        verdict = await judgeIntake(
          {
            slotLabel: label,
            transcript: text,
            issues: issues.map((i) => ({ id: i.id, title: i.title })),
          },
          /*
           * kind/id 和上面那句 `runTask` 一模一样，理由见 `HarnessInit.progress`。
           * `total: 2` 是这条路自己的性质：判一次、提炼一次。
           */
          { progress: { kind: "debrief", id: slotId, total: 2 } },
        );
      } catch (err) {
        agentRunSettle(
          checkId,
          err instanceof AgentRunFailed
            ? err.run
            : { error: err instanceof Error ? err.message : String(err) },
        );
        throw err;
      }
      agentRunSettle(checkId, verdict.run);

      if (!verdict.usable) {
        /*
         * 判没用就停在这里 —— **不建任何 debrief**，也不写 `transcribedAt`。写一份空的
         * 提炼上去的话，右栏会立刻摞出一张什么都没有的卡，而他要做的事恰恰是回到议题栏
         * 重新交一份材料。
         */
        slot.intakeRejection =
          verdict.reason || "这一轮判它对不上这场会，但没说清为什么。";
        persistSoon();
        console.warn(
          `[tkos:store] ${slotId} 交上来的材料被判没用：${slot.intakeRejection}`,
        );
        return {};
      }

      /* ---- 第二段：按议题提炼 ---- */
      /*
       * 这一步的序号由**开任务的这一方**报，不由链路自己报。
       *
       * 两段是两次调用、两个 Harness，而 `Harness` 的步号是每个实例从 1 起的 —— 提炼那
       * 一段没有任何办法说出「第 2 步 / 共 2 步」。谁排的顺序谁报，是这里唯一说得通的
       * 落法（同一条 kind/id，见上面那句 `progress`）。
       */
      taskStep("debrief", slotId, {
        label: "按议题提炼",
        no: 2,
        total: 2,
        at: nowIso(),
      });
      await extractAndLandDebriefs(slot, issues, text, label);
      return {};
    });

    return {
      status: "checking",
      ...(slot.audioName ? { name: slot.audioName } : {}),
    };
  },

  /**
   * 这一场会交上来的材料此刻走到哪一步了。**屏幕上那块流动的底靠它决定要不要动。**
   *
   * 每一档都是从事实读出来的，不另存一份状态机：正在跑的那两段读任务表（`kind` 是
   * `"debrief"`、`id` 是 slotId），判没用读这一场会上那句原话，跑完了读 `transcribedAt`。
   * 存一份状态字段的话，它和这三样之间任何一次不同步都会让屏幕上那块底一直流动下去。
   */
  async slotIntakeState(slotId: string): Promise<SlotIntakeState> {
    const slot = store.meetingSlots.find((s) => s.id === slotId);
    if (!slot) return { status: "idle" };
    const named = slot.audioName ? { name: slot.audioName } : {};
    const t = taskState("debrief", slotId);
    /*
     * 两段分得开靠的是任务表上那个步号（第 1 步是判、第 2 步是提炼）。没报步号的那一瞬
     * （任务刚起、第一次上报还没发生）算 `checking` —— 那时确实是在判，不是在提炼。
     */
    if (t.status === "running")
      return { status: t.step?.no === 2 ? "summarizing" : "checking", ...named };
    if (slot.intakeRejection)
      return { status: "rejected", reason: slot.intakeRejection, ...named };
    if (t.status === "failed")
      return {
        status: "failed",
        ...(t.error ? { reason: t.error } : {}),
        ...named,
      };
    if (slot.transcribedAt) return { status: "done", ...named };
    /*
     * 交过材料、三种结局一个都没有 —— 只可能是那一轮**没跑完就没了**（任务表跟着进程走，
     * 见 `agent/tasks.ts`）。这一档不许说成 `idle`：`idle` 的意思是「还没交过材料」，
     * 而屏幕据此显示的是那两颗交材料的键 —— 他会以为自己刚才那一次根本没传上去。
     */
    if (slot.transcript)
      return {
        status: "failed",
        reason: "上一轮没跑完（服务重启会掐断它）。这一份要重新交一次。",
        ...named,
      };
    return { status: "idle", ...named };
  },

  /** 还压在他那儿的那几份会后提炼。首页那一叠摞着的卡片就是它。 */
  /**
   * 已部署那一屏右半边的内容。**此刻大半是示意数据**，理由和生成逻辑写在
   * `mock-deployment.ts`；`mocked` 那一格逐项点名，屏幕上照登。
   *
   * 走 `api` 而不是让视图自己拼：这层关系接上之后换的是这一个方法的实现，视图一个字
   * 不用改 —— 而如果拼在视图里，接真数据那天要动的是屏幕。
   */
  async getDeployment(issueId: string): Promise<DeploymentDetail | null> {
    await sleep(80, 160);
    const issue = store.issues.find((i) => i.id === issueId);
    if (!issue) return null;
    const summary = summarize(issue);
    const domain = issue.domainId
      ? (await this.listDomains()).find((d) => d.id === issue.domainId)
      : undefined;
    return mockDeployment(summary, domain);
  },

  async listDebriefs(): Promise<MeetingDebrief[]> {
    await sleep(120, 240);
    return clone(
      Object.values(store.debriefs)
        // 两个出口都空才是「还压在他那儿」（见 `MeetingDebrief.reopenedAt`）。
        .filter((d) => !d.confirmedAt && !d.reopenedAt)
        // 早开的会排在前面：他要处理的顺序就是事情发生的顺序。
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
  },

  /**
   * 改一份会后提炼。**改过的字一律算他自己的话**（`editedAt`）。
   *
   * 和闭环单那条规矩是同一条（见 `updateClosureItem`）：屏幕上要分得出哪几句是模型
   * 提炼的、哪几句是他改过的 —— 他亲手改完之后还挂着「待核」，就是屏幕在说假话。
   */
  async updateDebrief(
    slotId: string,
    issueId: string,
    patch: {
      summary?: string;
      points?: { text: string; boundary?: string }[];
      todos?: { text: string; owner?: string; due?: string }[];
      open?: string[];
    },
  ): Promise<MeetingDebrief> {
    await sleep(100, 200);
    const key = debriefKeyOf(slotId, issueId);
    const rec = store.debriefs[key];
    if (!rec) throw new ApiError("没有这一份会后提炼。");
    if (rec.confirmedAt) throw new ApiError("这一份已经确认过了。");

    if (patch.summary !== undefined) {
      const s = patch.summary.trim();
      // 概述是卡面的第一行，空了那张卡就没有开头。改空按「没改」处理。
      if (s) rec.summary = s;
    }
    if (patch.points) {
      /*
       * **勾要按位置带回来。**
       *
       * 这一段是整份重建（id 按下标重发），所以上一版重建完之后，他刚才一条一条勾过的
       * 记号**全没了** —— 而屏幕上没有任何提示：他改了一条措辞，回来发现五个勾变成零个，
       * 只会以为自己记错了。
       *
       * 按位置带回是**尽力而为**，不是精确的：这条路允许增、删、换序，换过序之后位置对
       * 应的就是另一条了。精确的那条路是 `updateDebriefPoint`（只改一条的措辞，id、边界、
       * 勾全都原样留着）—— 屏幕上每一条旁边那支笔走的就是它。这里管的是「整份改」，
       * 而整份改本来就答不出「改完之后第三条还是不是原来那条」。
       */
      const wasChecked = rec.points.map((p) => p.checked === true);
      rec.points = patch.points
        .map((p, i) => ({
          id: `PT-${slotId}-${issueId}-${i + 1}`,
          text: p.text.trim(),
          ...(p.boundary?.trim() ? { boundary: p.boundary.trim() } : {}),
          ...(wasChecked[i] ? { checked: true } : {}),
        }))
        .filter((p) => p.text.length > 0);
    }
    if (patch.todos) {
      rec.todos = patch.todos
        .map((t, i) => ({
          id: `TD-${slotId}-${issueId}-${i + 1}`,
          text: t.text.trim(),
          ...(t.owner?.trim() ? { owner: t.owner.trim() } : {}),
          ...(t.due?.trim() ? { due: t.due.trim() } : {}),
        }))
        .filter((t) => t.text.length > 0);
    }
    if (patch.open) rec.open = patch.open.map((o) => o.trim()).filter(Boolean);
    rec.editedAt = nowIso();
    persistSoon();
    return clone(rec);
  },

  /**
   * 勾掉 / 取消勾掉一条要点。
   *
   * **它不是确认，也不是确认的前置。** 一场会谈出五条，他多半一条一条过；勾是给他自己
   * 留的记号（「这条我看过了」），做成一道闸的话，一件五条要点的议题要按六下才过得完，
   * 而那一栏存在的全部理由是扫一眼就能确认。理由整段写在 `DebriefPoint.checked` 上。
   *
   * 勾这一下**不算「他改过字」**（不写 `editedAt`）：那枚标记的含义是「这几句已经是他
   * 自己的话」，而勾掉一条并没有改动任何一个字。
   */
  /**
   * 改一条要点的措辞。**只动那一条的字，id、边界、勾一样都不碰。**
   *
   * 为什么不复用 `updateDebrief`：那一条是整份重建（id 按下标重发），改一句话的代价是
   * 整份要点的 id 全换一遍、勾只能按位置猜回来。而屏幕上每一条旁边那支笔的语义恰恰是
   * 最窄的那一种 —— 「这一句参谋总结得有出入，我改一下」—— 它不该有能力动到别的条。
   *
   * 空文本按「没改」处理，不删这一条：删一条要点是另一个动作，走整份编辑。
   */
  async updateDebriefPoint(
    slotId: string,
    issueId: string,
    pointId: string,
    text: string,
  ): Promise<MeetingDebrief> {
    await sleep(60, 140);
    const rec = store.debriefs[debriefKeyOf(slotId, issueId)];
    if (!rec) throw new ApiError("没有这一份会后提炼。");
    if (rec.confirmedAt) throw new ApiError("这一份已经确认过了。");
    const point = rec.points.find((p) => p.id === pointId);
    if (!point) throw new ApiError("这一条不在这份提炼上。");
    const next = text.trim();
    if (next) {
      point.text = next;
      // 改过的字一律算他自己的话（同 `updateDebrief`）：屏幕上要分得出哪几句是模型写的。
      rec.editedAt = nowIso();
      persistSoon();
    }
    return clone(rec);
  },

  /**
   * 把一条要点派给某个 DRI。`driId` 传 `null` 就是撤掉这次指派。
   *
   * ## 为什么是单独一条方法
   *
   * 同 `updateDebriefPoint` 那一段：整份重建会把别的条的 id 和勾一起换掉，而屏幕上这颗
   * 下拉的语义是最窄的那一种 ——「这一件事交给他」。
   *
   * ## 为什么名字在这里定下来，不留给屏幕去查
   *
   * 名字是**指派那一刻的快照**（理由写在 `DebriefPoint.assignee` 上）。让屏幕每次拿 id
   * 去 DRI 表里换名字的话，那张表一变，账上过去那几行跟着变 —— 而那正是一本账不该有的
   * 性质。所以这里查一次、抄下来，之后那一行不再依赖任何人还在不在表上。
   *
   * ## 已经确认过的那一份不许再派
   *
   * 同这一族别的写方法：确认那一下是这份提炼的封口，封口之后它是一条历史记录。要改，
   * 先「还需再议」把它退回来。
   */
  async assignDebriefPoint(
    slotId: string,
    issueId: string,
    pointId: string,
    driId: string | null,
  ): Promise<MeetingDebrief> {
    await sleep(60, 140);
    const rec = store.debriefs[debriefKeyOf(slotId, issueId)];
    if (!rec) throw new ApiError("没有这一份会后提炼。");
    if (rec.confirmedAt) throw new ApiError("这一份已经确认过了。");
    const point = rec.points.find((p) => p.id === pointId);
    if (!point) throw new ApiError("这一条不在这份提炼上。");

    if (driId === null) {
      delete point.assignee;
    } else {
      const person = tk.people.find((p) => p.id === driId);
      /*
       * 找不到就报出来，不静默落一个只有 id 的指派：屏幕上那一行会显示成一个空名字，
       * 而「派给了谁」是这一行唯一要答的问题。
       */
      if (!person) throw new ApiError("没有这个人。");
      point.assignee = { id: person.id, name: person.name };
    }
    persistSoon();
    return clone(rec);
  },

  /**
   * 拍板 —— 他对**这一条待办**的裁决落下来的那一刻。
   *
   * 只动这一条的 `decidedAt`，理由同 `updateDebriefPoint`：整份重建的 `updateDebrief`
   * 按下标重发 id，别的待办的裁决状态会被按位置猜回来。
   *
   * 这一份**确认过或者退回再议过**的都不许再收裁决 —— 两者都是这份提炼的封口
   * （同 `assignDebriefPoint`；`reopenedAt` 一并挡住，是因为「这场会没谈拢」之后，
   * 原地对某一条单独拍板已经答不上「拍的是哪一场会的板」）。
   */
  async confirmDebriefTodo(
    slotId: string,
    issueId: string,
    todoId: string,
  ): Promise<MeetingDebrief> {
    await sleep(60, 140);
    const rec = store.debriefs[debriefKeyOf(slotId, issueId)];
    if (!rec) throw new ApiError("没有这一份会后提炼。");
    if (rec.confirmedAt) throw new ApiError("这一份已经确认过了。");
    if (rec.reopenedAt) throw new ApiError("这一份已经退回再议了。");
    const todo = rec.todos.find((t) => t.id === todoId);
    if (!todo) throw new ApiError("这一条不在这份提炼上。");
    todo.decidedAt = nowIso();
    persistSoon();
    return clone(rec);
  },

  /**
   * 改一条待办的措辞。只动这一条的字，id、owner、assignedTo、principal、decidedAt
   * 一样都不碰 —— 理由同 `updateDebriefPoint`。空文本按「没改」处理。
   */
  async updateDebriefTodoText(
    slotId: string,
    issueId: string,
    todoId: string,
    text: string,
  ): Promise<MeetingDebrief> {
    await sleep(60, 140);
    const rec = store.debriefs[debriefKeyOf(slotId, issueId)];
    if (!rec) throw new ApiError("没有这一份会后提炼。");
    if (rec.confirmedAt) throw new ApiError("这一份已经确认过了。");
    if (rec.reopenedAt) throw new ApiError("这一份已经退回再议了。");
    const todo = rec.todos.find((t) => t.id === todoId);
    if (!todo) throw new ApiError("这一条不在这份提炼上。");
    const next = text.trim();
    if (next) {
      todo.text = next;
      rec.editedAt = nowIso();
      persistSoon();
    }
    return clone(rec);
  },

  /**
   * 取一份会后提炼 —— **不管它此刻在哪一档。**
   *
   * 和 `listDebriefs` 的分工：那一份答的是「还压在他那儿的有哪几份」，所以两个出口都空
   * 才进得去。详细内容那一页问的是另一件事 ——「这一件议题在那一场会上被提炼成了什么」
   * —— 而它在他确认之后仍然要答得出来。拿 `listDebriefs` 去答，已确认和已退回的那几份
   * 会落到一个空页上，而屏幕分不出是「没有这一份」还是「有但它已经不在待办里了」。
   */
  async getDebrief(slotId: string, issueId: string): Promise<MeetingDebrief | null> {
    await sleep(80, 160);
    const rec = store.debriefs[debriefKeyOf(slotId, issueId)];
    return rec ? clone(rec) : null;
  },

  /**
   * 面板右栏的取数口：会后归**当前视角这个人**的执行项。
   *
   * ## 为什么不按 `confirmedAt` / `reopenedAt` 过滤
   *
   * `listDebriefs` 答的是「还压在秘书那儿待处置的有哪几份」，两个出口都空才算数
   * （相一那一屏）。这里问的是完全不同的问题——「这几件事此刻是不是他的」。秘书
   * 按下「无需再议」的那一刻，意思恰恰是**这些结论认了**，事情这时才真正落到一号位
   * 头上；按 `confirmedAt` 过滤会让他自己的执行项在秘书确认的那一瞬间从他的面板上
   * 消失，而那正是这个取数口存在要保护的那件事。已经退回再议的（`reopenedAt`）也
   * 不摘：那一下摘掉的是议题在会上的座位，不是这条待办本身是不是他的。
   *
   * ## `assignedTo` 缺字段时现算一次，不写回
   *
   * 落库那一步（见上面 `todos: d.todos.map(...)`）已经把 `assignedTo` 算好存了下来，
   * 但那是这个字段加入之后才有的行为——加入之前落的库里，todo 上只有 `owner` 这一个
   * 自由文本，没有缓存的判断结果。这里对缺字段的记录用 `resolveTodoAssignee(t.owner)`
   * 现算一次、只读不写：写回意味着以后每加一条新的判人规则，都要跑一遍历史数据迁移，
   * 而现算的代价只是一次字符串比较，两者不成比例。
   *
   * ## `principal` 缺字段时兜底成「归他」，兜底只在这一处
   *
   * 同上一条的处境（相三之前落的库里没有这一格），但兜的方式不一样：`assignedTo` 能
   * 从 `owner` 那句原话里重新算出来，而「要不要他拍板」是一次模型判断，事后无从算起。
   * 所以这里不算，直接落到 `resolvePrincipal` 的兜底 ——「没判出来 —— 先归到你这里」。
   *
   * 这也是一号位立的那条规矩落地的地方：**一条 action item 不许最后没有人在判它**。
   * 兜底放在读口而不是面板那一侧，是因为面板不止一处会读这份投影，每一处各兜各的，
   * 迟早有一处兜漏；而兜漏的那一次在屏幕上什么都看不出来 —— 那条待办只是不见了。
   * 所以 `ActionItem.principal` 是不可选的：读口一定填得出来，读的人不必再想这件事。
   *
   * ## 排序
   *
   * 拿 `slotId` 本身当排序键——它是 `slotIdOf` 造出来的 `MS-<date 去掉横线>-<half>`。
   * **这不是因为这串字符「本来就可比」**：`agenda.ts` 的 `slotOrderKey` 之所以专门
   * 存在，恰恰是因为半天这个字段不能直接按字符串比——它把 `half` 过一遍
   * `halfOrder()` 再拼进可比串，不是信任 `"am"`/`"pm"` 自己的字母序。这里能直接
   * `localeCompare` 而不出错，靠的是巧合：`slotId` 的日期段是定长数字（`YYYYMMDD`）
   * 去掉横线，字符序天然等于时间序；半天段恰好拼的是 `"am"`/`"pm"` 这两个词，而
   * `"am" < "pm"` 又恰好和真实的时间先后一致。换一种拼法（比如某天把半天字段改成
   * 别的词）这条比较就会悄悄比错，`slotOrderKey` 不依赖这种巧合，这里依赖了，只是
   * 目前的字面量选择让它不出事。倒着比就是「刚散的那一场排最前」，不必再去
   * `store.meetingSlots` 里确认那场会还在不在：一件议题被确认之后会从会上摘下来
   * （`detachFromSlot`），但摘的是议题，`slotId` 这个字符串不会因此变化。
   */
  async listActionItems(): Promise<ActionItem[]> {
    await sleep(120, 240);
    const me = viewer().id;
    const items: ActionItem[] = [];
    for (const d of Object.values(store.debriefs)) {
      for (const t of d.todos) {
        const assignedTo = t.assignedTo ?? resolveTodoAssignee(t.owner);
        if (assignedTo?.personId !== me) continue;
        const slot = store.meetingSlots.find((s) => s.id === d.slotId);
        const principal = resolvePrincipal(t.principal);
        items.push({
          id: t.id,
          text: t.text,
          assignedTo,
          principal,
          ...(t.due ? { due: t.due } : {}),
          ...(t.decidedAt ? { decidedAt: t.decidedAt } : {}),
          // 同 `principal`：缺字段的老记录在这里兜一次底，卡的顶行不许没有来源。
          label: resolveLabel(t.label, principal.needed),
          issueId: d.issueId,
          issueTitle: findIssue(d.issueId).title,
          slotId: d.slotId,
          slotLabel: slot ? slotLabel(slot, seed.TODAY) : "已开完的会",
          debriefSummary: d.summary,
          siblings: d.todos
            .filter((o) => o.id !== t.id)
            .map((o) => ({ id: o.id, text: o.text })),
        });
      }
    }
    return items.sort((a, b) => b.slotId.localeCompare(a.slotId));
  },

  async toggleDebriefPoint(
    slotId: string,
    issueId: string,
    pointId: string,
  ): Promise<MeetingDebrief> {
    await sleep(60, 140);
    const rec = store.debriefs[debriefKeyOf(slotId, issueId)];
    if (!rec) throw new ApiError("没有这一份会后提炼。");
    if (rec.confirmedAt) throw new ApiError("这一份已经确认过了。");
    const point = rec.points.find((p) => p.id === pointId);
    if (!point) throw new ApiError("这一条不在这份提炼上。");
    point.checked = !point.checked;
    persistSoon();
    return clone(rec);
  },

  /**
   * 确认一份 —— **这一下把议题推进到已部署。**
   *
   * 上一版这里只标一个「看过了」，不动议题状态。那是错的：会后确认正是这件议题在
   * 一号位这里的**最后一次处置** —— 他认下这场会的结论，这件事就不再压在他身上，
   * 转成执行。不推状态的话，屏幕上会出现一件「会开完了、要点也认了、却还挂在议题栏
   * 里等着排下一场会」的东西，而没有任何动作能让它离开那一栏。
   *
   * 落到 `Decided`：`SETTLED_STATES` 里 `Decided` 与 `Monitoring` 就是「已部署」那一档
   * （首页那一栏一直是这么算的）。`Monitoring` 留给布控之后，那是另一条路的事。
   *
   * **这不是签发。** 逐条的去向、写回、落章仍然在闭环单那条路上（`signClosure`）。
   * 这里是「这场会谈出来的东西我认了」，而不是「我在这张卡上签发了这几条决定」。
   */
  async confirmDebrief(
    slotId: string,
    issueId: string,
  ): Promise<MeetingDebrief> {
    await sleep(100, 200);
    const key = debriefKeyOf(slotId, issueId);
    const rec = store.debriefs[key];
    if (!rec) throw new ApiError("没有这一份会后提炼。");
    if (rec.confirmedAt) return clone(rec);
    rec.confirmedAt = nowIso();

    const issue = store.issues.find((i) => i.id === issueId);
    if (issue && !SETTLED_STATES.has(issue.state)) {
      issue.state = "Decided";
      issue.decidedAt = rec.confirmedAt;
      touch(issue, rec.confirmedAt);
      pushEvent(issueId, {
        id: `E-${issueId}-debrief-ok-${slotId}`,
        kind: "state",
        at: rec.confirmedAt,
        headline: "会后确认 · 状态迁移 → 已部署",
        actor: viewer().name,
        detail: rec.summary,
        defaultOpen: true,
      });
    }
    // 认完就从日程上摘下来：它已经不是一件要安排的事了。
    detachFromSlot(issueId);
    persistSoon();
    return clone(rec);
  },

  /**
   * 还需再议 —— **这场会没谈拢，这件议题退回研究中，等着排下一场。**
   *
   * 它和「确认」是并排的两条路，不是「不确认」。一件议题常常要开几次会才谈拢，而那
   * 中间的每一次都真的发生过：这一下不删这份提炼（它是那场会的记录，`confirmedAt`
   * 留空表示他没有认下它作为结论），只把议题从这一场会上摘下来、状态退回在办。
   *
   * 摘下来是必须的：不摘的话，这件议题在屏幕上仍然挂在一场已经开完的会下面，而他
   * 接下来要做的恰恰是给它排新的一场。
   */
  async reopenDebrief(
    slotId: string,
    issueId: string,
  ): Promise<{ issueId: string }> {
    await sleep(100, 200);
    const key = debriefKeyOf(slotId, issueId);
    const rec = store.debriefs[key];
    if (!rec) throw new ApiError("没有这一份会后提炼。");
    if (rec.confirmedAt) throw new ApiError("这一份已经确认过了。");
    // 收进档：它不再等他处置，但那场会谈过什么要留着。
    rec.reopenedAt = nowIso();

    const issue = store.issues.find((i) => i.id === issueId);
    if (issue) {
      touch(issue, rec.reopenedAt);
      pushEvent(issueId, {
        id: `E-${issueId}-debrief-again-${slotId}`,
        kind: "state",
        at: rec.reopenedAt,
        headline: "会后确认 · 还需再议，退回研究中",
        actor: viewer().name,
        detail: rec.consensus.reason,
        defaultOpen: true,
      });
    }
    detachFromSlot(issueId);
    persistSoon();
    return { issueId };
  },

  /**
   * 改一条。
   *
   * 会后确认允许**就地改字**，而不是只能勾选或圈除。理由是这张单子上的话是散会后
   * 装配出来的，措辞未必是他会上说的那句 —— 让他把那句话改对，比让他为了一个词把整条
   * 圈除掉合理得多。
   *
   * 一条纪律：**他改过的字段一律转成 `confirmed`。** 「AI 补全 · 待核」这枚标记的
   * 含义是「这句没人认过」；他亲手改完之后再挂着它，就是屏幕在说假话。
   */
  async updateClosureItem(
    meetingId: string,
    itemId: string,
    patch: {
      title?: string;
      boundary?: string;
      fields?: { index: number; value: string }[];
      /** 签不签这一条。勾选 = 要签发；不勾 = 他认为没必要，其余照签。 */
      excluded?: boolean;
    },
  ): Promise<MeetingClosure> {
    await sleep(120, 240);
    const closure = store.closures[meetingId];
    if (!closure) throw new ApiError("这场会没有闭环单。");
    if (closure.signedAt) throw new ApiError("已签发的闭环单不能再改。");
    const item = closure.items.find((i) => i.id === itemId);
    if (!item) throw new ApiError("这一条不在单子上。");

    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (t.length === 0) throw new ApiError("标题不能空着。");
      item.title = t;
    }
    if (patch.boundary !== undefined) {
      const b = patch.boundary.trim();
      if (b.length === 0) delete item.boundary;
      else item.boundary = b;
    }
    for (const f of patch.fields ?? []) {
      const target = item.fields[f.index];
      if (!target) continue;
      const v = f.value.trim();
      if (v === target.value) continue;
      target.value = v;
      target.origin = "confirmed";
    }
    if (patch.excluded !== undefined) item.excluded = patch.excluded;
    return clone({ ...closure, minutesSince: minutesSince(closure.endedAt) });
  },

  /**
   * 圈除 / 恢复一条。
   *
   * 批示文化里，领导对个别事项写「缓」「再议」不影响其余照办。圈除的那一条转未决，
   * 其余照常签发 —— 一张混合的单子不该因为一条争议整份卡住。
   */
  async toggleClosureItem(
    meetingId: string,
    itemId: string,
  ): Promise<MeetingClosure> {
    await sleep(120, 240);
    const closure = store.closures[meetingId];
    if (!closure) throw new ApiError("这场会没有闭环单。");
    if (closure.signedAt) throw new ApiError("已签发的闭环单不能再改。");
    const item = closure.items.find((i) => i.id === itemId);
    if (item) item.excluded = !item.excluded;
    return clone({ ...closure, minutesSince: minutesSince(closure.endedAt) });
  },

  /**
   * 签发。一次动作，全部写回。
   *
   * 这里做的是**公证**，不是决策：拍板已经在会上当众发生过了。所以没有逐条确认，
   * 只有一次落章；落章之后就地展开回执，写回了什么一条不落地列出来。
   */
  async signClosure(meetingId: string): Promise<ClosureReceipt> {
    await sleep(700, 1200);
    const closure = store.closures[meetingId];
    if (!closure) throw new ApiError("这场会没有闭环单。");
    if (closure.signedAt) throw new ApiError("这份闭环单已经签发过了。");

    const at = nowIso();
    const me = viewer();
    const signedNo = `批-${at.slice(5, 7)}${at.slice(8, 10)}-${String(
      Object.values(store.closures).filter((c) => c.signedAt).length + 1,
    ).padStart(2, "0")}`;
    const updated: WriteBackTarget[] = [];

    for (const item of closure.items) {
      if (item.excluded) continue;
      const ir = (store.probeNodes[item.issueRef] ?? []).find(
        (x) => x.id === item.id,
      );

      if (
        item.kind === "writeback" &&
        ir?.revisesJudgmentId &&
        ir.nextStatement
      ) {
        const judgment = findJudgment(ir.revisesJudgmentId);
        judgment.version += 1;
        judgment.statement = ir.nextStatement;
        judgment.standing = "confirmed";
        judgment.confirmedBy = me.name;
        judgment.confirmedAt = at;
        judgment.revisions.push({
          version: judgment.version,
          at,
          note: ir.revisionNote ?? `第 ${closure.seq} 次战略会拍板后修订。`,
          actor: me.name,
        });
        judgment.shakenBy = judgment.shakenBy.filter(
          (x) => x !== item.issueRef,
        );
        (ir.arms ?? []).forEach((text, i) => {
          judgment.reopenTriggers.push({
            id: `RT-${judgment.id}-${judgment.version}-${i + 1}`,
            text,
            armed: true,
          });
        });
        recordChange({
          id: `JC-${judgment.id}-${at}`,
          at,
          judgmentId: judgment.id,
          kind: "version",
          headline: `${judgment.id} → v${judgment.version} · 第 ${closure.seq} 次战略会签发`,
          actor: me.name,
        });
      }

      if (item.kind === "mission" && ir?.route === "evidence") {
        const targetId =
          ir.targetJudgmentId ?? findIssue(item.issueRef).judgmentRefs[0];
        if (targetId) {
          const judgment = findJudgment(targetId);
          (ir.arms && ir.arms.length > 0 ? ir.arms : [ir.text]).forEach(
            (text, i) => {
              judgment.reopenTriggers.push({
                id: `RT-${judgment.id}-${signedNo}-${i + 1}`,
                text,
                armed: true,
              });
            },
          );
        }
      }

      if (ir) ir.standing = "confirmed";
      updated.push(...item.writeBack);
    }

    const deferred = closure.items.filter((i) => i.excluded).length;
    closure.signedAt = at;
    closure.signedNo = signedNo;

    // 议题状态跟着走：这场会覆盖的每件议题都推到「已拍板」。
    const touched = new Set(
      closure.items.filter((i) => !i.excluded).map((i) => i.issueRef),
    );
    touched.forEach((issueId) => {
      const issue = store.issues.find((i) => i.id === issueId);
      if (!issue) return;
      issue.state = deferred > 0 ? "Decided" : "Decided";
      issue.nextActionForUser = null;
      issue.monitoringNote = `第 ${closure.seq} 次战略会已签发 · ${signedNo}`;
      /*
       * 「最近动静」按 `updatedAt` 排（屏幕上那一栏），而签发是这件议题身上最重的一次
       * 动静：状态推到已拍板、判断改版、重开条件布控。不 `touch` 的表现是签完之后它在
       * 列表里还停在会前的位置 —— 这一行曾经被一次改动顺手删掉，全仓一千一百条测试没有
       * 一条会红，所以下面那条测试专钉它。
       */
      touch(issue, at);
      pushEvent(issueId, {
        id: `E-${issueId}-signed-${at}`,
        kind: "decision",
        at,
        headline: `会后闭环单签发 · ${signedNo}`,
        actor: me.name,
        detail: `第 ${closure.seq} 次战略会。写回 ${updated.length} 个对象${
          deferred > 0 ? `；圈除 ${deferred} 条转未决` : ""
        }。`,
        defaultOpen: true,
      });
    });

    return { signedNo, signedAt: at, updated, deferred };
  },

  async listQuickDecisions(): Promise<QuickDecision[]> {
    await sleep(140, 300);
    return clone(store.quickDecisions).reverse();
  },

  // -------------------------------------------------------------------------
  // 页面4 会前准备 —— 压缩，不是汇总
  // -------------------------------------------------------------------------

  async getBrief(id: string): Promise<Brief> {
    await sleep();
    const brief = store.briefs[id];
    if (!brief) throw new ApiError(`议题 ${id} 还没有会前准备。`);

    const agent = tk.agents.find((a) => a.id === brief.byAgentId);
    if (!agent) throw new ApiError(`找不到 Agent ${brief.byAgentId}。`);

    /*
     * 这场会赌的是哪几条判断，取活对象：写回之后再打开这份 Brief，页尾那行必须
     * 已经写着新版本号，而不是停在会前的旧账上。
     */
    const issue = findIssue(id);

    return {
      ...clone(brief),
      byAgent: clone(agent),
      byPerson: clone(findPerson(agent.personId)),
      judgments: issue.judgmentRefs
        .map((jid) => clone(findJudgment(jid)))
        .sort(byStanding),
    };
  },

  // -------------------------------------------------------------------------
  // 页面5 会后确认 —— 四选一分流与写回
  // -------------------------------------------------------------------------

  /** 会后确认的账：有 Closure 草案的议题。待确认的在前，定过的按时间倒序。 */
  async listDecisions(): Promise<DecisionEntry[]> {
    await sleep(260, 520);
    return Object.values(store.closureDrafts)
      .map((draft) => ({
        issue: summarize(findIssue(draft.issueId)),
        draft: clone(draft),
      }))
      .sort((a, b) => {
        const aOpen = a.draft.writeBack ? 1 : 0;
        const bOpen = b.draft.writeBack ? 1 : 0;
        if (aOpen !== bOpen) return aOpen - bOpen;
        return (b.issue.updatedAt ?? "").localeCompare(a.issue.updatedAt ?? "");
      });
  },

  async getClosureDraft(id: string): Promise<ClosureDraft> {
    const t = ensureWriteBack(id);
    await sleep();
    const draft = store.closureDrafts[id];
    if (!draft) {
      // 状态照实说。「还没有草案」和「正在起草」和「起草失败了」是三件事，
      // 都说成同一句会让他不知道该等还是该点重试。
      if (t.status === "running")
        throw new ApiError(`议题 ${id} 的写回提案正在起草，稍等一下再看。`);
      if (t.status === "failed")
        throw new ApiError(`写回提案起草失败：${t.error ?? "未知原因"}`);
      throw new ApiError(
        `议题 ${id} 还没有 Closure 草案 —— 先做完深研并定题。`,
      );
    }
    return clone(draft);
  },

  /** 写回提案起草到哪了。 */
  async writeBackStatus(issueId: string): Promise<TaskState> {
    return store.closureDrafts[issueId]
      ? { status: "done" }
      : taskState("writeback", issueId);
  },

  /** 手动起草一份写回提案。深研做完、题定完之后可以直接用。 */
  async startWriteBack(issueId: string): Promise<TaskState> {
    findIssue(issueId);
    return ensureWriteBack(issueId);
  },

  /**
   * 确认 Closure —— 四选一分流，没有「再研究研究」按钮。
   *
   * 这里必须真的把判断翻版：分流 A 下 `draft.revises` 里那条判断版本 +1、陈述换新、
   * 重开条件布控回靶点。做完这一步，本体那一行字才会不一样；不做，Closure 就只是
   * 一段写得漂亮的会议记录。
   */
  async confirmClosure(
    issueId: string,
    fields: Closure,
    route: DecisionRoute,
  ): Promise<WriteBackResult> {
    await sleep(700, 1200);
    const draft = store.closureDrafts[issueId];
    if (!draft) throw new ApiError(`议题 ${issueId} 还没有 Closure 草案。`);
    if (draft.writeBack) throw new ApiError("这份决定已经确认过了。");
    const issue = findIssue(issueId);
    const at = nowIso();
    const me = viewer();
    const decisionId = nextDecisionId(at);

    draft.fields = clone(fields);
    clearShakenBy(issueId);

    const updatedObjects: WriteBackTarget[] = [
      {
        kind: "decision",
        label: `Decision ${decisionId} · v1 · 分流 ${ROUTE_LABEL[route]}`,
        href: `/decisions`,
      },
    ];
    let triggersArmed = 0;

    // 分流 A：判断真的翻版。其余三条路判断不动 —— 各自的后果在下面分别落地。
    if (route === "strategy") {
      for (const revision of draft.revises) {
        const judgment = findJudgment(revision.judgmentId);
        judgment.version += 1;
        judgment.statement = revision.nextStatement;
        judgment.standing = "confirmed";
        judgment.confirmedBy = me.name;
        judgment.confirmedAt = at;
        judgment.revisions.push({
          version: judgment.version,
          at,
          decisionId,
          note: revision.note,
          actor: me.name,
        });
        revision.arms.forEach((text, i) => {
          judgment.reopenTriggers.push({
            id: `RT-${judgment.id}-${judgment.version}-${i + 1}`,
            text,
            armed: true,
          });
        });
        triggersArmed += revision.arms.length;

        updatedObjects.push({
          kind: "judgment",
          label: `判断 ${judgment.id} → v${judgment.version}（已标注修订）`,
          href: `/judgments/${judgment.id}`,
        });
        recordChange({
          id: `JC-${judgment.id}-${at}`,
          at,
          judgmentId: judgment.id,
          kind: "version",
          headline: `${judgment.id} → v${judgment.version} · 因 ${decisionId} 变更`,
          actor: me.name,
          decisionId,
        });
      }
    } else if (issue.judgmentRefs[0] && fields.reopenTrigger.trim()) {
      // B / C / D：重开条件照样布控 —— 布在这个议题咬住的第一条判断上。
      const judgment = findJudgment(issue.judgmentRefs[0]);
      judgment.reopenTriggers.push({
        id: `RT-${judgment.id}-${decisionId}`,
        text: fields.reopenTrigger.trim(),
        armed: true,
      });
      triggersArmed += 1;
      recordChange({
        id: `JC-${judgment.id}-${at}`,
        at,
        judgmentId: judgment.id,
        kind: "armed",
        headline: `${judgment.id} 布控重开条件 · 因 ${decisionId}`,
        actor: me.name,
        decisionId,
      });
    }

    const evidenceActions = evidenceActionsFor(route);
    if (evidenceActions > 0) {
      updatedObjects.push({ kind: "evidence", label: evidenceActionLabel });
    }
    if (triggersArmed > 0) {
      updatedObjects.push({
        kind: "trigger",
        label: reopenTriggerLabel(triggersArmed),
        href:
          route === "strategy" && draft.revises[0]
            ? `/judgments/${draft.revises[0].judgmentId}`
            : issue.judgmentRefs[0]
              ? `/judgments/${issue.judgmentRefs[0]}`
              : undefined,
      });
    }

    const newState =
      route === "evidence"
        ? "WaitingEvidence"
        : route === "close"
          ? "Closed"
          : "Monitoring";
    updatedObjects.push({
      kind: "issue",
      label: `${issueId} → ${newState}`,
      href: `/issues/${issueId}`,
    });

    const impactHints =
      route === "strategy" || route === "mission"
        ? clone(seed.writeBackTemplate.impactHints)
        : [];

    const result: WriteBackResult = {
      decisionId,
      route,
      updatedObjects,
      triggersArmed,
      evidenceActions,
      newState,
      impactHints,
      elapsedLabel: elapsedLabel(hoursBetween(issue.raisedAt, at)),
      pastMedianLabel: draft.pastMedianLabel,
    };
    draft.writeBack = clone(result);

    issue.state = newState;
    issue.decidedAt = at;
    issue.nextActionForUser = null;
    issue.monitoringNote =
      route === "evidence"
        ? "Evidence Action 在途 · 结果返回后自动重开"
        : triggersArmed > 0
          ? `已布控 ${triggersArmed} 条 Re-open Trigger`
          : "已确认";
    touch(issue, at);

    pushEvent(issueId, {
      id: `E-${issueId}-decision`,
      kind: "decision",
      at,
      headline: `Decision ${decisionId} 确认并写回 · 分流 ${ROUTE_LABEL[route]}`,
      actor: me.name,
      detail: result.updatedObjects.map((o) => o.label).join("\n"),
      defaultOpen: true,
    });

    return clone(result);
  },

  async submitRating(
    targetId: string,
    quality: number,
    experience: number,
    note?: string,
  ): Promise<void> {
    await sleep(200, 450);
    store.ratings.push({ targetId, quality, experience, note });
  },

  // -------------------------------------------------------------------------
  // 判断与文档 —— 溯源的落点
  // -------------------------------------------------------------------------

  /** 一条判断的全部。`/judgments/01-J2` 就是这个。 */
  async getJudgment(id: string): Promise<JudgmentDetail> {
    await sleep();
    const judgment = findJudgment(id);
    /*
     * 不属于任何域的那几条（`Judgment.domainId` 空着）这三栏都不给：没有域，就没有域的
     * 负责人，也没有这个域的 Mission。`findDomain` 找不到会抛，而抛在这条路上是整页白掉。
     */
    const domain = judgment.domainId
      ? allDomains.find((d) => d.id === judgment.domainId)
      : undefined;
    // 名单空着时这两栏不给，理由同 `issueDetail`。
    const dri = tk.people.find((p) => p.id === domain?.driIds[0]);
    const linked = store.issues.filter((i) => i.judgmentRefs.includes(id));

    return {
      judgment: clone(judgment),
      ...(domain ? { domain: clone(domain) } : {}),
      ...(dri ? { dri: clone(dri), driAgent: clone(agentOf(dri.id)) } : {}),
      freshDaysLeft: daysBetweenDays(seed.TODAY, judgment.freshUntil),
      shakingIssues: linked.filter((i) => !i.decidedAt).map(summarize),
      decidedIssues: linked
        .filter((i) => i.decidedAt)
        .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))
        .map(summarize),
      missions: judgment.domainId
        ? allMissions.filter((m) => m.domainId === judgment.domainId).map(clone)
        : [],
    };
  },

  /** 文档树。正文不带回来 —— 列表不需要它。 */
  async listDocs(): Promise<Omit<Doc, "body">[]> {
    await sleep(180, 380);
    return clone(store.docs)
      .map((doc) => ({
        ...omit(doc, "body"),
        ...(doc.ownerId ? { ownerName: findPerson(doc.ownerId).name } : {}),
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  /** 一份文档，连它被哪些判断引用过。 */
  async getDoc(
    id: string,
  ): Promise<{ doc: Doc; citedBy: Judgment[]; owner?: Person }> {
    await sleep(220, 480);
    const doc = store.docs.find((d) => d.id === id);
    if (!doc) throw new ApiError(`找不到文档 ${id}。`);
    return {
      doc: clone(doc),
      citedBy: doc.citedBy
        .map((jid) => store.judgments.find((j) => j.id === jid))
        .filter((j): j is Judgment => Boolean(j))
        .map(clone),
      ...(doc.ownerId ? { owner: clone(findPerson(doc.ownerId)) } : {}),
    };
  },

  // -------------------------------------------------------------------------
  // 溯源与搜索
  // -------------------------------------------------------------------------

  /** 一个代号到底是什么。hover 浮层里那三行。认不出来返回 null，视图不做 chip。 */
  async resolveCode(code: string): Promise<CodeRef | null> {
    await sleep(60, 160);
    return resolveCodeSync(code);
  },

  /** 全部认得的代号，一次拿完 —— 代号要在它出现的那一刻就已经是可点的。 */
  async codeIndex(): Promise<Record<string, CodeRef>> {
    await sleep(80, 170);
    const index: Record<string, CodeRef> = {};
    const put = (code: string) => {
      const ref = resolveCodeSync(code);
      if (ref) index[code.toUpperCase()] = ref;
    };
    for (const j of store.judgments) put(j.id);
    for (const m of allMissions) {
      put(m.id);
      put(m.code);
    }
    for (const d of allDomains) put(d.code);
    for (const i of store.issues) put(i.id);
    for (const d of store.docs) put(d.id);
    return index;
  },

  /**
   * 目标与任务那棵树：公司总 Outcome → 业务域 → Mission。
   *
   * 一份数据两处用 —— `/outcomes` 页和口述模式的舞台全貌树（`stage/stage-map.tsx`）。
   * 投影上那棵树和他明天在桌面上翻的那棵树必须是同一棵，否则这套东西就不可信了。
   * `weeks` 只有舞台那边用得上，这一页只画树。
   */
  async getOutcomes(): Promise<OutcomeScreen> {
    await sleep(260, 540);

    const project = tk.projects[0];
    const period = activePeriod();
    const company = store.companyOutcomes.find((o) => o.periodId === period.id);
    if (!company) throw new ApiError("本期还没有确认公司 Outcome。");

    const domains = allDomains
      .filter((d) => d.projectId === project.id)
      .map((domain) => {
        const judgments = store.judgments.filter(
          (j) => j.domainId === domain.id,
        );
        return {
          code: domain.code,
          name: domain.name,
          outcome: domain.outcome,
          driName: domainDriLabel(domain),
          commitmentStatus: domain.commitmentStatus,
          confirmed: judgments.filter((j) => j.standing === "confirmed").length,
          total: judgments.filter((j) => j.standing !== "dropped").length,
          shaking: shakingNote(judgments),
          href: `/judgments/${judgments[0]?.id ?? ""}`,
          missions: allMissions
            .filter((m) => m.domainId === domain.id)
            .map(clone),
          commitment: (() => {
            const c = store.commitments.find(
              (x) => x.domainId === domain.id && x.periodId === period.id,
            );
            /* 没灌纲领就是 null。屏幕上照实说这一期还没有承诺，不摆一个 0/0。 */
            if (!c) return null;
            return {
              id: c.id,
              status: c.status,
              version: c.version,
              rounds: convergenceRounds(c),
              items: c.items.length,
              /* 「有几条改了提案」是这一行唯一值得一号位一眼看到的数字。 */
              changed: c.items.filter((i) => i.verdict !== "accept").length,
              href: `/outcomes/commitment/${encodeURIComponent(c.id)}`,
            };
          })(),
        };
      });

    const codeOf = (domainId?: string) =>
      allDomains.find((d) => d.id === domainId)?.code;

    const decided: OutcomeEntry[] = store.issues
      .filter((i) => i.decidedAt)
      .map((i) => ({
        id: i.id,
        at: i.decidedAt as string,
        headline: i.title,
        href: `/issues/${i.id}`,
        ...(codeOf(i.domainId) ? { domainCode: codeOf(i.domainId) } : {}),
      }));

    const moved: OutcomeEntry[] = store.changes
      .filter((c) => REVISION_KINDS.includes(c.kind))
      .map((c) => {
        const j = store.judgments.find((x) => x.id === c.judgmentId);
        return {
          id: c.id,
          at: c.at,
          headline: c.headline,
          actor: c.actor,
          href: `/judgments/${c.judgmentId}`,
          ...(j && codeOf(j.domainId)
            ? { domainCode: codeOf(j.domainId) }
            : {}),
        };
      });

    const inWeek = (
      e: OutcomeEntry,
      w: { startsOn: string; endsOn: string },
    ) => {
      const d = dayOf(e.at);
      return d >= w.startsOn && d <= w.endsOn;
    };
    const newest = (a: OutcomeEntry, b: OutcomeEntry) =>
      b.at.localeCompare(a.at);

    const weeks: OutcomeWeek[] = weeksOf(period.startsOn, period.endsOn)
      .map((w) => ({
        ...w,
        current: seed.TODAY >= w.startsOn && seed.TODAY <= w.endsOn,
        decided: decided.filter((e) => inWeek(e, w)).sort(newest),
        moved: moved.filter((e) => inWeek(e, w)).sort(newest),
      }))
      .filter((w) => w.startsOn <= seed.TODAY)
      .reverse();

    return {
      period: clone(period),
      company: clone(company),
      setOn: period.startsOn,
      daysLeft: daysBetweenDays(seed.TODAY, company.dueOn),
      domains,
      weeks,
    };
  },

  // -------------------------------------------------------------------------
  // 封存 —— 口述模式（stage/*）的数据依赖，语音交互重启时随它们一起复核
  // -------------------------------------------------------------------------

  /** 口述模式递给模型的那份事实。 */
  async chatContext(): Promise<string> {
    return buildCompanyContext();
  },

  // -------------------------------------------------------------------------
  // 录音与逐字稿
  //
  // 这几个方法都很薄：表上的读写在 `lib/recording/registry.ts`（纯函数），正文在
  // `transcript.ts`（落文件）。这里只做三件事 —— 叫它们、叫 `persistSoon()`、
  // 把结果 `clone` 出去。
  //
  // **二进制不走这条路。** 收分片、收上传、发音频、下载 txt 都在 `/api/recordings/*`
  // 那几条 REST 上（理由同 `/api/meeting/audio` 顶上那段：这条是 JSON-RPC）。
  // -------------------------------------------------------------------------

  /**
   * 列表。**正文不进列表** —— 那是一两千条句子乘以行数。
   *
   * 但说话人数和句子数要给：列表上一眼看出「这一场只认出一个人」，那多半是麦克风的事，
   * 而不是转写的事。代价是每一行读一次逐字稿文件；几十场会的量级，不值得为它建索引。
   */
  async listRecordings(): Promise<RecordingSummary[]> {
    await sleep(80, 160);
    return [...store.recordings].sort(rec.byRecent).map((r) => {
      const t = r.status === "done" ? readTranscript(r.id) : null;
      return rec.toSummary(r, {
        speakerCount: t?.speakers.length,
        utteranceCount: t?.utterances.length,
      });
    });
  },

  /**
   * 一份录音的全部。找不到返回 `null` 而不是抛 —— 屏幕上要说「这一份不在了」，
   * 而不是弹一个错。
   *
   * 逐字稿文件不在时给空数组：元数据说 done、文件丢了，这两件事可能对不上（一个在
   * 快照里、一个在文件里）。那时候整页照旧打得开，只是没有正文 —— 比整页打不开好。
   */
  async getRecording(id: string): Promise<RecordingDetail | null> {
    await sleep(80, 160);
    const r = rec.find(store.recordings, id);
    if (!r) return null;
    const t = readTranscript(id);
    return {
      recording: clone(r),
      utterances: t?.utterances ?? [],
      speakers: t?.speakers ?? [],
    };
  },

  /** 现场录音开一场。返回 id，屏幕拿它去 PUT 分片。 */
  async startRecording(title?: string, participants?: string[]): Promise<string> {
    const r = rec.create(store.recordings, {
      now: new Date(),
      source: "live",
      title,
      participants,
    });
    persistSoon();
    return r.id;
  },

  /**
   * 现场录音结束。**只翻状态、不在这条请求里跑流水线** —— 拼片加转码加转写要几分钟，
   * 而屏幕得在他按下那一刻就跳走。流水线由路由那一侧起（见 `/api/recordings`）。
   */
  async finishRecording(id: string): Promise<void> {
    const r = rec.find(store.recordings, id);
    if (!r) throw new ApiError("这份录音不在了。");
    if (r.status !== "recording") return; // 幂等：标签页关掉又打开会按第二次
    rec.advance(store.recordings, id, "uploaded", new Date(), {
      endedAt: nowIso(),
    });
    persistSoon();
  },

  /** 改标题。空标题不许 —— 空标题的列表没法读。 */
  async renameRecording(id: string, title: string): Promise<void> {
    const t = title.trim();
    if (!t) throw new ApiError("标题不能是空的。");
    if (!rec.patch(store.recordings, id, { title: t }, new Date()))
      throw new ApiError("这份录音不在了。");
    persistSoon();
  },

  async setRecordingParticipants(id: string, names: string[]): Promise<void> {
    const ok = rec.patch(
      store.recordings,
      id,
      { participants: rec.normalizeParticipants(names) },
      new Date(),
    );
    if (!ok) throw new ApiError("这份录音不在了。");
    persistSoon();
  },

  /**
   * 给某个说话人起名字。写的是**逐字稿文件**，不是这张表。
   *
   * 所以要单独叫一次 `persistSoon()`：那一句在这里不是为了落这份改动（它已经落进
   * 文件了），是为了报「库改过了」——否则别的标签页上那份逐字稿会一直显示旧名字。
   */
  async renameRecordingSpeaker(
    id: string,
    speakerId: string,
    displayName: string,
  ): Promise<void> {
    if (!rec.find(store.recordings, id)) throw new ApiError("这份录音不在了。");
    if (!renameSpeaker(id, speakerId, displayName.trim()))
      throw new ApiError("这一份的逐字稿不在了，改不了名字。");
    persistSoon();
  },

  /**
   * 重跑。**只把状态推回 `uploaded`，真正重跑由路由起。**
   *
   * 从 `uploaded` 重来而不是从倒下的那一段接着：转码产物和 TOS 上那份可能都在，也可能
   * 只上传了一半，而「一半」在对象存储上和「全部」长得一样。整条重来一次的代价是几分钟，
   * 判断「上一次到底走到哪」的代价是一类查不出来的错。
   */
  async retryRecording(id: string): Promise<void> {
    const r = rec.find(store.recordings, id);
    if (!r) throw new ApiError("这份录音不在了。");
    if (r.status !== "failed") throw new ApiError("这一份没有失败，不用重跑。");
    if (!r.rawAudioPath) throw new ApiError("这一份的原始音频不在了，重跑也没有输入。");
    rec.advance(store.recordings, id, "uploaded", new Date());
    persistSoon();
  },

  /** 删一份。元数据和正文一起删 —— 只删一边会留下一个读得到、点不开的东西。 */
  async removeRecording(id: string): Promise<void> {
    const at = store.recordings.findIndex((r) => r.id === id);
    if (at < 0) return;
    store.recordings.splice(at, 1);
    deleteTranscript(id);
    persistSoon();
  },
};

export type Api = typeof api;

// ---------------------------------------------------------------------------
// 上下文的组装
// ---------------------------------------------------------------------------

/**
 * 对谈时间线上只有一条 talk 事件，标题数轮次 —— 对谈是过程性内容，折叠。
 *
 * 「只有一条」这件事由 `pushEvent` 保证（同 id 覆盖），这里不再自己找一遍旧的：
 * 原来这里手写了一份「找到就改、没找到才 push」的分支，而那份分支只挡住了对谈这
 * 一条事件，别的固定 id 事件照样能记出两条来。同一个不变量写在两个地方，第二个
 * 地方就一定会漏。
 */
const bumpTalkEvent = (issueId: string, at: string) => {
  const rounds = (store.advisorThreads[issueId] ?? []).filter(
    (m) => m.role === "user",
  ).length;
  pushEvent(issueId, {
    id: `E-${issueId}-talk`,
    kind: "talk",
    at,
    headline: `议题研究对谈 ${rounds} 轮`,
    actor: `${viewer().name} · 您的 Agent`,
    detail: "对谈全文在议题研究那一页可回看。",
    defaultOpen: false,
  });
};

/**
 * 公司层的事实，一次拼好。形状上刻意像一份会前材料而不是 JSON：模型读散文比读
 * 嵌套对象稳。
 */
const buildCompanyContext = (): string => {
  const project = tk.projects[0];
  const period = activePeriod();
  const outcome = store.companyOutcomes.find((o) => o.periodId === period.id);
  const me = viewer();

  const lines: string[] = [
    `公司：${tk.company.name}。项目：${project.name}。今天是 ${seed.TODAY}。`,
    `跟你说话的人：${me.name}，${me.title}。`,
  ];

  if (outcome) {
    lines.push(
      "",
      `本期（${period.label}）公司 Outcome，${outcome.dueOn} 到期，还有 ${daysBetweenDays(seed.TODAY, outcome.dueOn)} 天：`,
      outcome.statement,
    );
  }

  lines.push("", "业务域与在版判断：");
  for (const domain of allDomains) {
    const judgments = store.judgments
      .filter((j) => j.domainId === domain.id)
      .sort(byStanding);
    lines.push(
      "",
      `${domain.code} ${domain.name}，DRI ${domainDriLabel(domain)}。Domain Outcome：${domain.outcome}`,
    );
    for (const j of judgments) {
      lines.push(
        `  ${j.id} v${j.version} ${STANDING_TEXT[j.standing]}，${j.verifiedByTasks} 个真实任务验证过：${j.statement}`,
      );
      if (j.shakenBy.length > 0) {
        lines.push(`    正在动摇它的议题：${j.shakenBy.join("、")}`);
      }
      for (const t of j.reopenTriggers) {
        lines.push(
          `    重开条件${t.armed ? "（已布控）" : "（未布控）"}：${t.text}`,
        );
      }
    }
    const note = shakingNote(judgments);
    if (note) lines.push(`  这个域现在不安静：${note}`);
  }

  const open = store.issues.filter(
    (i) => !i.decidedAt && i.state !== "Dismissed",
  );
  if (open.length > 0) {
    lines.push("", "还没定下来的议题：");
    for (const i of open) {
      lines.push(
        `  ${i.id} ${i.title}（${i.state}）：${i.nextActionForUser ?? "他这边暂时不用做什么"}`,
      );
    }
  }

  return lines.join("\n");
};

/**
 * 议题研究那一栏的上下文 = 公司层事实 + 这个议题的全部 + 首轮调研全文 + 引到的文档正文
 * + 预设标准口径。
 *
 * 标准口径那一段是「接真模型，但答案不出格」的落点：对预设过的问题，模型必须按
 * 口径作答（可以展开，不得矛盾）；模型接不上的时候，同一份口径由视图原样打出兜底。
 */
const buildAdvisorContext = (issueId: string): string => {
  const issue = findIssue(issueId);
  const lines: string[] = [buildCompanyContext(), ""];

  lines.push(
    `当前在议题研究里探讨的议题：${issue.id} ${issue.title}（${issue.state}）。`,
  );
  if (issue.judgmentRefs.length > 0) {
    lines.push(`它正在动摇的判断：${issue.judgmentRefs.join("、")}。`);
  }

  /*
   * 还在潜在议题那一档的，进来的是**预研**，不是深研报告。两者的语气必须不同：预研
   * 是「我先扫了一眼」，深研是「我替您查完了」。把预研当深研来说，是这条链上最容易
   * 犯的一种撒谎 —— 他会据此以为这件事已经被查过了。
   */
  const pre = store.preResearch[issueId];
  if (pre && !store.researchDocs[issueId]) {
    lines.push(
      "",
      `这条还在潜在议题这一档，你手上只有一份**预研**（${pre.at} 自动跑完的，他没等过）。预研要回答的那一句：${pre.question}`,
      "预研查到的：",
      ...pre.finding.map(
        (f) =>
          `  ${f.text}（出处：${f.traces.map((t) => t.source).join("、")}）`,
      ),
      "这一轮还答不上来的（也就是升级深研会去查什么）：",
      ...pre.openQuestion.map((q) => `  ${q.text}`),
      `你的落点：${pre.soWhat}`,
    );

    /*
     * v2 的那几段（预研的「报告正文」槽位）。`stages` 不在就是 v1 的一份预研 ——
     * 那时这一整块跳过，进数组的东西与拆这次 `lines.push` 之前逐字相同。
     *
     * **这里只读，不重取。** 台账是预研那一轮当场入账的那一份，原样搬进对话：同一条
     * 证据再抓一次，拿到的可能是改过的页面，于是同一个编号在卡上和在对话里指的不是
     * 同一份原文。编号也一样 —— `buildLiteIndex` 印的是 `EvidenceLite.id`，就是卡上
     * `basis` 里那几个 `E{n}`，这一段不另编一套。
     */
    const st = pre.stages;
    if (st) {
      const idx = buildLiteIndex(st.evidence);
      /*
       * 空表时那句话由这里写（`buildLiteIndex` 回空串）——
       * **照 `searchless` 的口径说，不说成「查了但没查到」**：这一轮一条外部证据都没入账。
       */
      lines.push("", `## 证据台账\n${idx || "这一轮一条外部证据都没入账。"}`);
      if (st.hits.length > 0) {
        lines.push(
          `## 这条撞上的既有判断\n${st.hits
            .map(
              (x) =>
                `- ${x.target.id}｜${x.match}｜${x.target.text}（${x.why}）`,
            )
            .join("\n")}`,
        );
      }
      lines.push(
        `## 参谋这一轮的提案\n${st.impact.statement}（依据：${st.impact.basis.join("、") || "没有"}）`,
      );
      if (st.blindspot.isBlindspot) {
        lines.push(
          `这件事挨着他在管的事，但不在他的监控清单上：${st.blindspot.why.join("；")}`,
        );
      }
      if (!st.critic.pass) {
        lines.push(
          `**这份提案没过批判**：${st.critic.why.join("；")} —— 在对话里别把它当已经站住的结论。`,
        );
      }
    }

    /*
     * 这一段必须留在最后：它是给模型的**收尾指令**，是上面所有材料的框。
     * 材料排到框后面，读起来就是「先给你规矩、再塞一堆料」，而模型对最后一段最听话。
     * 上面那个空字符串跟着这句话走（拆之前它就在这句的前一个位置）—— 所以
     * `stages` 不在时，进数组的元素与拆之前一字不差。
     */
    lines.push(
      "",
      "这一页他只做一个决定：**这值不值得升级成战略议题**。所以你说的每一句都要对着那个决定说 —— 不要在这里替他把议题研究做掉。他问深了，就告诉他那要升级之后才查得动，以及升级之后你会先查什么。",
    );
  }

  const doc = store.researchDocs[issueId];
  if (doc) {
    /*
     * 深研 v2 是 2026-08-26 才默认开的，库里躺着的旧议题只有四段式那份产物。
     * 有 `doc.blocks` = 跑过 v2、报告是分层的；没有 = 跑过 v1、只有四节。
     * 两条路都要有 —— 替换掉等于让那些旧议题的对谈突然没了报告。
     */
    if (doc.blocks) {
      // v2 路径：分层报告，只带正文层，附录不进前缀
      lines.push("", "你已经给他装配的深研报告（他屏幕右侧就是这份）：");
      lines.push(buildReportBody(doc.blocks));
      // 索引要带上对谈里现查到追加的那几条（它们只在 doc.ledger 上）—— 不然
      // 「查证结果稍后补上」许诺的下一轮，他问那个编号会被告知没有这一条。
      const ledgerIndex = buildLedgerIndex(
        indexEntries(doc.blocks.evidence, doc.ledger),
      );
      if (ledgerIndex) {
        lines.push("", "证据台账索引：", ledgerIndex);
      }
      lines.push("", `建议分流：${doc.routeSuggestion}`);
    } else {
      // v1 路径（旧议题）：四段式，一个字不改
      const section = (label: string, items: Statement[]) => {
        lines.push("", `${label}：`);
        for (const s of items) {
          const src = s.traces[0]?.source;
          lines.push(`  ${s.text}${src ? `（出处：${src}）` : ""}`);
        }
      };
      lines.push("", "你已经给他装配的深研报告（他屏幕右侧就是这份）：");
      section("当前判断", doc.judgment);
      section("关键 Evidence", doc.keyEvidence);
      section("反证与风险", doc.counters);
      section("不确定性", doc.unknowns);
      lines.push("", `建议分流：${doc.routeSuggestion}`);
    }
  }

  // 引到的文档正文。全文塞进去 —— 不建索引，索引会引入「检索没命中」这种没法解释的失败。
  const citedDocIds = new Set<string>();
  const collect = (traces: Trace[] | undefined) => {
    for (const t of traces ?? []) {
      if (t.href?.startsWith("/docs/"))
        citedDocIds.add(t.href.slice("/docs/".length));
    }
  };
  if (doc) {
    [
      ...doc.judgment,
      ...doc.keyEvidence,
      ...doc.counters,
      ...doc.unknowns,
    ].forEach((s) => collect(s.traces));
    doc.assembledFrom.forEach((m) => {
      if (m.href?.startsWith("/docs/"))
        citedDocIds.add(m.href.slice("/docs/".length));
    });
  }
  for (const id of citedDocIds) {
    const d = store.docs.find((x) => x.id === id);
    if (!d) continue;
    lines.push("", `文档 ${d.id}《${d.title}》全文：`, d.body);
  }

  const preset = store.advisorPresets[issueId];
  if (preset && preset.chips.length > 0) {
    lines.push(
      "",
      "以下问题公司已有标准口径。他问到同样或相近的问题时，按口径作答 —— 可以展开、可以换说法，但结论与依据不得与口径矛盾：",
    );
    preset.chips.forEach((chip, i) => {
      lines.push("", `口径 ${i + 1}，问：${chip.q}`, `答：${chip.reply}`);
    });
  }

  /*
   * 左栏此刻那块判断板 —— **这是这一段上下文里最要紧的一块**。
   *
   * 他和参谋看的是同一块板：他说「第 2 条」「战略边界那条」时指的就是这几行。板不递
   * 进去的后果不是参谋少知道一件事，而是它会把已经在板上的话再说一遍（板上于是长出
   * 一堆近义句），也听不出「这条我认了」是在认哪一条 —— 而那一句是这个产品里唯一
   * 一次权力转移。
   *
   * 编号和 A6 萃取用的是同一份（`boardRefsFor`）：他嘴里的那一条、参谋眼里的那一条、
   * 落库时被确认的那一条，必须是同一条。
   */
  const refs = boardRefsFor(issueId);
  if (refs.length > 0) {
    const draft = refs.filter((r) => !r.confirmed);
    const done = refs.filter((r) => r.confirmed);
    lines.push("", "屏幕左栏那块**判断板**此刻的样子（他正看着）：");
    if (draft.length > 0) {
      lines.push(
        "",
        `待他确认（还只是候选，不是公司口径）—— ${draft.length} 条：`,
      );
      for (const r of draft)
        lines.push(
          `  ${r.ref}｜${r.label ? `${r.label}：` : ""}${r.statement}`,
        );
    }
    if (done.length > 0) {
      lines.push("", `他已经确认过（已经是公司口径）—— ${done.length} 条：`);
      for (const r of done)
        lines.push(
          `  ${r.ref}｜${r.label ? `${r.label}：` : ""}${r.statement}`,
        );
    }
    const bj = (id: string) =>
      (store.board[issueId] ?? []).find((x) => x.id === id);
    lines.push(
      "",
      "板上这几条底下还有三样，他点开就能看到；你引用某一条时可以直接接着说，不要另编一套：",
    );
    for (const r of refs) {
      const b = bj(r.id);
      if (!b) continue;
      /*
       * 这两个标签与决策记忆那一段引的是同一对常量（`prefix.ts` 的 `BASIS_LABEL` /
       * `REOPEN_LABEL`）。板那一块和记忆那一段进的是同一次模型调用，同一件事只能有一个
       * 说法 —— 上一版靠一行注释维持一致，已经漂过一次。
       */
      const bits = [
        b.basis ? `${BASIS_LABEL}${b.basis}` : "",
        b.boundary ? `边界（它不主张什么）：${b.boundary}` : "",
        b.reopenIf ? `${REOPEN_LABEL}${b.reopenIf}` : "",
        b.confirmed ? `他确认时给的理由：${b.confirmed.support}` : "",
      ].filter(Boolean);
      if (bits.length > 0) lines.push(`  ${r.ref}：${bits.join("；")}`);
    }
    lines.push(
      "",
      "关于这块板，四条规矩：",
      "  一、上半层不是公司口径。谈到那几条时说清它们还在等他确认，不要当成已经定了的事往下推。",
      "  二、**确认只能由他按下。** 你可以建议他确认某一条，但不许代他确认，也不许说「我已经记下了 / 已经写进去了」—— 板上那一行是系统落的，不是话术落的。",
      "  三、他说要确认某一条却没说凭什么，你这一轮的活就是把那一句问出来：半年后要重新打开这条判断，查的就是他当时凭什么点的头，而那只能是他自己的话。问法要具体，别问「您为什么这么认为」，要问到他真正在赌的那一点上。",
      "  四、引用板上某一条时，说它的抬头和原句（「战略边界那条」），**不要写编号**（R1、D2 这种）—— 那是给系统用的，他屏幕上没有这些代号，写出来他只会以为你在说别的东西。",
    );
  }

  /*
   * 决策记忆与用户卡（Task 13）
   */
  const issueTags = issueTagsOf(issue);

  /*
   * 按议题相似度取 top-5 决策记忆（k=5：够用来建立模式，又不至于把前缀塞满）。
   * 渲染走 `renderDecisionMemories` —— 与 `assemblePrefix` 那一份是同一段代码，不是抄的。
   */
  const memories = pickDecisionMemories(store.decisionMemories, issueTags, 5);
  const memoryLines = renderDecisionMemories(memories);
  if (memoryLines.length > 0) lines.push("", ...memoryLines);

  /*
   * 新证据里逐字出现了某条记忆的重开条件 —— 命中就说一句，由他和模型自己看。
   * 措辞与上面记忆块、以及判断板那块的 `reopenIf` 一致（都叫「重新打开」/「重开条件」），
   * 同一份前缀里同一件事不留两个说法。`hitOverturn` 自己已经按（记忆 + 条件）去重，
   * 所以这里不会把同一行印两遍。
   */
  if (doc && doc.ledger) {
    const hits = hitOverturn(store.decisionMemories, doc.ledger);
    if (hits.length > 0) {
      lines.push("", "新证据命中了以下几条重开条件：");
      for (const h of hits) {
        const mem = store.decisionMemories.find((m) => m.id === h.memoryId);
        if (mem) {
          lines.push(
            `  决策记忆「${mem.judgment}」的重开条件「${h.condition}」已被新证据命中`,
          );
        }
      }
    }
  }

  // 用户卡：他本人的长期偏好（提示词正文里一律称「他」，「一号位」只出现在注释里）
  if (store.userCard) {
    const cardText = packUserCard(store.userCard);
    if (cardText) {
      lines.push(
        "",
        "他的表达偏好与他常挑的那几个口径（用来预判他会挑什么、以及怎么说他才读得进去，**不做结论的引力方向**）：",
        cardText,
      );
    }
  }

  /*
   * 他自己从报告原文里挑出来记下的那几句（报告页那道划线）。它们**不是**判断 ——
   * 没有依据、边界和重开条件，所以上不了板；但参谋要看得见：那是他在意的地方，
   * 追问一句就能把它长成板上的一条。
   */
  const STANDING_TEXT: Record<ProbeNode["standing"], string> = {
    raw: "还不成熟 · 你自己说过它没站住",
    firming: "聊过之后开始立得住",
    direction: "已收敛成对这件议题的战略方向判断",
    confirmed: "已确认并写回本体",
    dropped: "已放下",
  };
  const rounds = agentRounds(issueId);
  const visible = (store.probeNodes[issueId] ?? []).filter(
    (n) => n.revealAfterRound <= rounds,
  );
  if (visible.length > 0) {
    lines.push(
      "",
      "这场探讨走到此刻记下的话（他和你都看得见；引用时照原句写）：",
    );
    for (const n of visible) {
      lines.push(
        `  「${n.text}」（${n.by === "ceo" ? "他提出" : "你提出"}，${STANDING_TEXT[n.standing]}${n.route ? `，建议去向：${PROBE_ROUTE_LABEL[n.route]}` : ""}）`,
      );
      // 扣题与份量是每条 point 的必填内容 —— 上下文里带上，模型才知道新开一条要补什么。
      if (n.whyOnTopic) lines.push(`    它为什么扣着这件议题：${n.whyOnTopic}`);
      if (n.ifIgnored) lines.push(`    不理它会怎样：${n.ifIgnored}`);
      if (!n.whyOnTopic && n.by === "ceo") {
        lines.push(
          "    这一条是他自己从报告原文里挑出来记下的，你还没解读过它。他问到时先补上「它为什么扣着这件议题」和「不理它会怎样」。",
        );
      }
    }
    const edges = (store.probeEdges[issueId] ?? []).filter(
      (e) => e.revealAfterRound <= rounds,
    );
    if (edges.length > 0) {
      lines.push("", "这几步各自是被什么推动的：");
      for (const e of edges) lines.push(`  ${e.from} → ${e.to}：${e.because}`);
    }
    lines.push(
      "这些是台账，不是他屏幕上的那块板 —— 引用它们时照原话说，不要提「链路」「节点」这些词。一条聊到你自己认为立得住时，明说它立住了，并且把它整成一条能上板的判断：一句结论、凭什么、边界、以及什么新证据会把它重新打开。",
    );
  }

  const question = store.framed[issueId] ?? store.decisionQuestions[issueId];
  if (question) {
    lines.push(
      "",
      `这场探讨该收敛去的 Decision Question：${question.text}（建议 DRI：${question.suggestedDri}，限时 ${question.deadline}）。他聊到收敛处，可以提醒他「定题」。`,
    );
  }

  return lines.join("\n");
};

/*
 * 这里原来有一对中文二元字组（bigram）相似度函数，给旧版「在文档里高亮这条判断引到的
 * 那一句」用 —— 那个屏幕随三栏工作台一起删了。五个页面里的引用都带着显式的
 * `Trace.source`，不需要猜是哪一句，所以这套东西不留：留着的死代码下一个人会以为
 * 它是当前方案的一部分。
 */

const CODE_KIND_LABEL: Record<string, string> = {
  judgment: "判断",
  mission: "Mission",
  domain: "业务域",
  issue: "议题",
  doc: "文档",
};

const MISSION_STATUS: Record<string, string> = {
  running: "在跑",
  confirmed: "已确认",
  pending: "未提",
};

/** 把一个代号翻译成人话。认不出来就说认不出来。 */
const resolveCodeSync = (raw: string): CodeRef | null => {
  const code = raw.trim().toUpperCase();

  const judgment = store.judgments.find((j) => j.id.toUpperCase() === code);
  if (judgment) {
    return {
      code: judgment.id,
      kindLabel: CODE_KIND_LABEL.judgment,
      text: judgment.statement,
      standing: standingSentence(judgment),
      source: judgment.confirmedBy
        ? `${judgment.confirmedBy} · ${dayOf(judgment.confirmedAt)} 确认`
        : "尚未确认",
      href: `/judgments/${judgment.id}`,
    };
  }

  const mission = allMissions.find(
    (m) => m.id.toUpperCase() === code || m.code.toUpperCase() === code,
  );
  if (mission) {
    const domain = findDomain(mission.domainId);
    return {
      code: mission.code,
      kindLabel: CODE_KIND_LABEL.mission,
      text: mission.name,
      standing: `${MISSION_STATUS[mission.status]} · ${mission.milestone}`,
      source: `${domain.code} ${domain.name} · ${findPerson(mission.driId).name}`,
    };
  }

  const domain = allDomains.find(
    (d) => d.id.toUpperCase() === code || d.code === code,
  );
  if (domain) {
    return {
      code: domain.code,
      kindLabel: CODE_KIND_LABEL.domain,
      text: domain.outcome,
      standing: `Commitment ${domain.commitmentStatus} · DRI ${domainDriLabel(domain)}`,
    };
  }

  const issue = store.issues.find((i) => i.id.toUpperCase() === code);
  if (issue) {
    return {
      code: issue.id,
      kindLabel: CODE_KIND_LABEL.issue,
      text: issue.title,
      standing: `${issue.state} · ${issue.nextActionForUser ?? "无待办"}`,
      href: `/issues/${issue.id}`,
    };
  }

  const doc = store.docs.find((d) => d.id.toUpperCase() === code);
  if (doc) {
    return {
      code: doc.id,
      kindLabel: CODE_KIND_LABEL.doc,
      text: doc.title,
      source: doc.mirrorOf,
      href: `/docs/${doc.id}`,
    };
  }

  // `M1-A` / `M2` 这类方法论代号在本体里没有对象。认不出来就说认不出来。
  return null;
};
