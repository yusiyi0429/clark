/**
 * TKOS object model.
 *
 * The file is in two halves. The **ontology** half (Company → Judgment) is what
 * makes TKOS 把公司的判断变成持久对象; the **issue chain** half is how a single
 * judgement gets shaken, argued and settled — M1-A 的五个环节各自落在议题链的一段：
 * 待定事项出 Card，三键处置把它收成议题，议题研究产出 ResearchDoc 与对谈，
 * 会前准备是 Brief，会后确认是四选一、Closure 写回与 Re-open Trigger。
 *
 * The two halves are joined at exactly one place — `Issue.judgmentRefs` — and
 * every write in this product ends by moving a `Judgment` version. If a feature
 * does not eventually change a Judgment, it does not belong here.
 */

/*
 * 这个文件唯一的 import，而且只 import 类型。
 *
 * 方向看着是反的（对象模型去引参谋那一侧的东西），但 `blocks/schema.ts` 自己**一个
 * import 都没有** —— 它是模块图上的叶子，跟这个文件一样是纯声明，引它不会把参谋那一侧
 * 的任何运行时代码拖进来。
 *
 * 把那 14 种块的形状抄一份到这里才是真的错：同一个 `judgment` 块会有两份定义，改一处漏
 * 一处，而编译器不会说话 —— 结构相同的类型互相赋值是合法的，两份定义漂开之后第一个发现
 * 的人是屏幕。
 */
import type { ReportBlocks } from "@/lib/agent/a4/blocks/schema";
import type { PreResearchStages } from "@/lib/agent/a3/stages";
import type { Evidence } from "@/lib/research/ledger";

/**
 * 溯源类别。
 *
 * `judgment` — 引用一条已确认的判断。It is the only kind that always resolves
 * to a page, which is what makes provenance navigable instead of decorative.
 * `peer` — 同僚的 Agent 说的。Deliberately not folded into `agent`: 「我推断」
 * and 「DRI 的 Agent 登记的」 are different weights of claim.
 */
export type TraceKind = "ext" | "int" | "human" | "agent" | "judgment" | "peer";

export interface Trace {
  kind: TraceKind;
  source: string;
  href?: string;
}

/** One assertion carrying its provenance. Facts never appear undressed. */
export interface Statement {
  /**
   * 这一条的判断式短标题 —— 一句话说完它的结论，屏幕把它**加粗**接在 `text` 前面。
   *
   * 方法域 S02 的产出案例里每条依据都长这样：一句加粗的判断（「瓶颈正在换层：从
   * 能不能做 AI 到能不能把 AI 组织起来」），后面才是支撑它的事实。为什么拆成两个
   * 字段而不让模型直接写 `**…**`：屏幕按纯文本渲染，星号会原样显示，而
   * `rules.ts` 的 `FE-md` 正是在挡它 —— 让模型写加粗记号等于让它去违反一条 p0。
   *
   * 所以**内容归 prompt，加粗归屏幕**：模型只管把这一句判断写出来，粗体是渲染层
   * 的事（`StatementLine`）。
   *
   * 可选：A4/A5 那几条产出没有这一层，只有 S02 的依据有。
   */
  label?: string;
  text: string;
  traces: Trace[];
}

/**
 * 这条议题是怎么被问出来的 —— 方法域 S01 Issue Framing 的四块，原样存着。
 *
 * **存的是内容，不是版面。** 小标题叫什么、哪一块在前、证据边界那一句前面缀什么词，
 * 全在 `agent/a1a/framing.ts` 的 `framingBlocks()` 里 —— 一个纯函数，屏幕和将来的
 * 导出都从它取。存成拼好的一段字看着省事，代价是改一次标题措辞救不了已经落库的那些
 * 议题，而它们仍然在屏幕上。
 *
 * 四块对 S01 §5.1 的 CEO-ready 结构：`title` 是 Sharp Title（一号位扫的那一行，
 * 不配小标题）；`whatHappened` + `evidenceBoundary` 是 What Happened；
 * `businessConsequence` + `realQuestion` 是 Implication 的两个动作；`source` 是 Source。
 * `statement` 是 §5.2 的 Internal Handoff —— 交给预研的那一条，比标题完整。
 */
export interface IssueFraming {
  /**
   * Sharp Title —— 短问句，一个最值得判断的张力。
   *
   * 它同时是 `Issue.title` 和 `Card.headline`（那两处要的正是这个：一行以内、
   * 问句、扫一眼就知道跟自己手上的事有没有关系）。模型没给时回落到 `statement`。
   */
  title: string;
  /** Potential Issue Statement —— 一到三句，中性、decision-oriented，交给预研的就是它。 */
  statement: string;
  /** 一个 decisive observation：哪一件事使原有判断值得重新审视。 */
  whatHappened: string;
  /**
   * 这次的证据到哪儿为止。
   *
   * 单独一个字段而不是揉进上一段：它要否掉的正是读完 `whatHappened` 最自然的那个
   * 假设 —— 「这些都已经核实过」。揉进去之后它就是长段落末尾的一个从句，而它是这
   * 四块里最容易被压掉、也最贵的一句。
   */
  evidenceBoundary: string;
  /** Implication ①：如果这条张力成立，哪一个当前重要判断可能需要重新审视。 */
  businessConsequence: string;
  /** Implication ②：当前真正需要进一步回答的那**一个**核心问题。 */
  realQuestion: string;
  /** 最小来源信息。二手汇编 / 未独立核实要写在这里。 */
  source: string;
}

// ===========================================================================
// 本体 —— 只读靶点
//
// Outcome / Domain / MissionCard are targeting structure the CEO reads, not
// structure TKOS manages. TKOS writes exactly one layer — 判断 — and for
// everything above it emits an 影响建议 and stops (M1-A 止于战略影响建议，
// 持续推进交给 M1-B/M2)。
// ===========================================================================

export interface Company {
  id: string;
  name: string;
  /** 屏幕上偶尔要短一点的场合 */
  shortName: string;
}

export interface Project {
  id: string;
  companyId: string;
  name: string;
  /** 一句话：这个 Project 在赌什么 */
  intent: string;
}

export interface Period {
  id: string;
  projectId: string;
  label: string;
  startsOn: string;
  endsOn: string;
}

/** 公司级 Outcome。原文照录 —— 这句话不是 TKOS 写的，改写它就是越界。 */
export interface CompanyOutcome {
  id: string;
  periodId: string;
  statement: string;
  dueOn: string;
}

export interface Domain {
  id: string;
  projectId: string;
  /** "01" … "04"。屏幕上永远带着它，因为 DRI 之间用编号互相引用。 */
  code: string;
  name: string;
  /** Domain Outcome，原文照录 */
  outcome: string;
  /**
   * 这个域的负责人，**可能不止一个，也可能一个都没有**。
   *
   * 上一版是单值 `driId`。改成名单是因为组织的事实就是名单：Engine & Ontology 有两个人
   * （刘人豪、于斯一），Agents 有两个（陈溪南、孙铭泽），而 TokenOps 现在一个都没有。
   * 单值那一版逼着这三种情况各自撒一次谎 —— 两个人时藏掉一个，没有人时指向一个占位的
   * 岗位实体（「数据负责人 · 在位人待确认」），而屏幕上那两种谎和「这个域有一个负责人」
   * 长得一模一样。
   *
   * **顺序有意义**：屏幕上按这个顺序念，第一个排在最前。它不表示主次 —— 名单本身就
   * 没有主次，谁在前是这份名单交上来时的顺序。
   *
   * **空数组是一个合法状态**，不是数据缺失：`[]` 说的是「这个域现在没有人负责」，
   * 那是一件要被看见的事。所以读它的地方一律走 `domainDriLabel`，那里把空写成「未指派」。
   *
   * 权限也认它（`d.driIds.includes(me.id)`）：域是我的 → 我看得见。名单里有我就算。
   */
  driIds: string[];
  /** 已确认 / 新建 Commitment —— 纲领里的原话 */
  commitmentStatus: string;
}

export type PersonRole = "ceo" | "dri" | "ic";

export interface Person {
  id: string;
  name: string;
  role: PersonRole;
  /** 他在公司里的位置，一行 */
  title: string;
}

/**
 * 每个使用者都有一个 Agent。一号位的 Agent 没有别的名字 —— 给它起名字就等于
 * 把它变成一个工具，而它是这家公司的判断本身。
 */
export interface Agent {
  id: string;
  personId: string;
  kind: PersonRole;
  /** 屏幕上怎么称呼它：「您的 Agent」/「推理 Agent 负责人的 Agent」 */
  label: string;
}

/** 只读：Mission 在 TKOS 里能看不能改。 */
export interface MissionCard {
  id: string;
  domainId: string;
  /** "04-2" */
  code: string;
  /** 结果命名 */
  name: string;
  driId: string;
  status: "running" | "confirmed" | "pending";
  milestone: string;
}

/**
 * 本期承诺 —— OM 纲领下发之后，DRI 逐条回传的那份东西。
 *
 * **这是这一版唯一新建的本体对象。** `MissionCard` 是只读的（TKOS 里能看不能改），
 * 而回传是一个真正的写路径：公司提案一条 Mission，DRI 接受/修改/重写/拒绝并给出
 * 成功证据与里程碑，一号位逐条裁决，收敛之后一次生效。
 *
 * 8 月那次复盘认定「两轮收敛」的主因就是**条目级回传**（G2）—— 任何 IM 卡片承载
 * 不了这个结构，这也是这一侧要有网页的原因。
 */
export interface Commitment {
  /** `${domainId}:${periodId}` —— 一个域一期只有一份。 */
  id: string;
  domainId: string;
  periodId: string;
  version: number;
  /**
   * 纲领灌进来那一刻是 `drafted`（提案在了，DRI 还没标注）。
   * DRI 提交 → `submitted`；一号位逐条裁完 → `adjudicated`；
   * DRI 按裁决修订再提交 → version+1 且回到 `submitted`（这就是「一轮」）；
   * 一号位签一次 → `effective`，此后只读。
   */
  status: "drafted" | "submitted" | "adjudicated" | "effective";
  /** 本月唯一核心验收，一句话。卡的第一节，不是最后一节 —— 复盘 A1。 */
  northStar: string;
  items: CommitmentItem[];
  /** ⚠ 假设 + 逾期默认路径。假设不写默认路径，逾期那天就没人知道该怎么办。 */
  assumptions: { text: string; defaultPath: string; dueOn?: string }[];
  /** 生效前提，硬上限 2 条（M2 承诺最低条件）。 */
  preconditions: string[];
  /** 复盘 H2 那张表：开放问题不追踪就会静默过期。 */
  questions: { text: string; toWhom: string; needBy: string; closed: boolean }[];
  /**
   * 每一次提交落一条。与 `JudgmentRevision` 同形状，不另起一套。
   *
   * **收敛轮次是从这里数出来的，不设字段** —— 屏幕上每个数字都是算出来的
   * （`store.ts` 文件头第四条）。
   */
  revisions: { version: number; at: string; actor: string; note: string }[];
}

export interface CommitmentItem {
  id: string;
  /** 公司提案的那条 Mission，原文照录。改写它就是越界。 */
  proposed: string;
  verdict: "accept" | "modify" | "rewrite" | "reject";
  /** 非 accept 必填。一个没有理由的「重写」在裁决时无法处理。 */
  reason?: string;
  /** 成功证据 3–5 项：行为与结果证据，不是功能清单。 */
  evidence: string[];
  milestone: { companyGate?: string; own?: string };
  /** 复盘 A2：验收项与实现必需项要分层，被裁时才补分层已经晚了。 */
  tier: "acceptance" | "required";
  /** 一号位的逐条裁决。 */
  ruling?: { verdict: "endorse" | "revise" | "reject"; note: string; at: string; by: string };
}

/**
 * 屏幕上看到的那份承诺 = 基础字段 + 域信息 + 算出来的派生量。
 *
 * `rounds` 从 `revisions` 长度算出来，`note` 从「修改」条目数算出来 ——
 * 屏幕上的每个数字都是算出来的（`store.ts` 文件头第四条）。
 */
export interface CommitmentScreen extends Commitment {
  domainCode: string;
  domainName: string;
  domainOutcome: string;
  rounds: number;
  note: string | null;
}

// ===========================================================================
// 判断 —— 核心对象
// ===========================================================================

export type JudgmentKind = "strategy" | "hypothesis";

/**
 * `unverified` is not a lesser state of `confirmed`; it is the honest state of
 * most hypotheses. A judgement the whole company is betting on with zero tasks
 * behind it is the single most useful thing TKOS can put in front of a CEO.
 */
export type JudgmentStanding =
  | "confirmed"
  | "unverified"
  | "shaking"
  /**
   * 被放弃。一条判断可以被推翻，这件事必须留在本体里而不是被删掉：CEO 半年后问
   * 「我们当初是不是赌过这个」，答案得在屏幕上。
   */
  | "dropped";

export interface JudgmentRevision {
  version: number;
  at: string;
  /** 哪个 Decision 造成了这次变更 —— 版本历史必须能点回决策 */
  decisionId?: string;
  /** 从上一版到这一版，实际变了什么 */
  note: string;
  actor: string;
}

/**
 * 重开条件。写回时布控（`armed`），布控之后它就是 Sensor 的一个监测靶点 ——
 * 待定事项头部那行「监测中」摊的就是这些。这是会后确认回到待定事项的那条线。
 */
export interface ReopenTrigger {
  id: string;
  text: string;
  /** 已布控回 Sensor 靶点 */
  armed: boolean;
  hitAt?: string;
}

export interface Judgment {
  /** 人读的 ID，也是 URL：`01-J2`。DRI 之间口头引用的就是这个串。 */
  id: string;
  /**
   * 这条判断挂在哪个业务域上。**空串 = 不属于任何域**，那是一个正常状态。
   *
   * 2026-08-31 去掉 01 / 02 两个域时留下了六条战略判断（见生成器里的 `KEPT_JUDGMENTS`）：
   * 域是组织分工，判断是公司押的那几句话，后者不因为前者被撤而不成立。屏幕上照实说
   * 「不属于任何业务域」—— 拿一个还在的域顶上去，等于把一句话的归属编给了别人。
   */
  domainId: string;
  kind: JudgmentKind;
  /** 一句话。屏幕上最重要的一行字。 */
  statement: string;
  version: number;
  standing: JudgmentStanding;
  confirmedBy: string;
  confirmedAt: string;
  /** 保鲜期：过了这天还没人复核，它就该被当成过期判断而不是现行判断。 */
  freshUntil: string;
  basis: Statement[];
  revisions: JudgmentRevision[];
  reopenTriggers: ReopenTrigger[];
  /** 正在动摇它的议题 */
  shakenBy: string[];
  /**
   * 有多少个真实任务验证过它。`0` 是要被看见的数字，不是缺省值 —— 01-J2 那条
   * 「架构能力即壁垒」正是靠这个 0 才刺眼。
   */
  verifiedByTasks: number;
}

/** 「最近变了什么」的一条。判断持久存在的证据。 */
export interface JudgmentChange {
  id: string;
  at: string;
  judgmentId: string;
  kind: "version" | "confirmed" | "registered" | "trigger" | "armed";
  headline: string;
  actor: string;
  decisionId?: string;
}

// ===========================================================================
// Issue 链
// ===========================================================================

export type IssueState =
  | "Candidate"
  | "Watching"
  | "Exploring"
  | "Researching"
  | "ReadyForDecision"
  | "WaitingEvidence"
  | "Decided"
  | "Monitoring"
  | "Reopened"
  | "Closed"
  | "Dismissed";

/** 三键处置：采信（收进议题列表）/ 观察 / 搁置。 */
export type CardDisposition = "discuss" | "watch" | "dismiss";

/**
 * 这条潜在议题是**怎么进来的**。
 *
 * 屏幕上必须分得开，因为可信度的来源完全不同：雷达抓的，可信来自「有人在外面盯着
 * 变化」；DRI 上报的，可信来自「一个具体的人把名字押在上面」；一号位自己加的，本来
 * 就不需要谁来背书；从某场研讨里掉出来的，可信来自「它从哪场讨论里长出来」—— 这一种
 * 尤其要标明，不然等于把自己刚说过的话当成新证据递回给自己。
 *
 * 四种而不是三种：前三种是他说的入口，第四种（`probe`）是研究阶段本来就会往回吐的
 * 东西，代码里一直存在，只是过去叫 `derivedFrom` 单独挂了个字段 —— 归到同一个联合
 * 里，卡面上「这是谁递上来的」就只有一个地方要读。
 */
export type CardSource =
  | { kind: "radar" }
  | { kind: "dri"; by: string }
  | { kind: "ceo" }
  | { kind: "probe"; issueId: string; title: string };

/** 提请卡片（四段式） */
/**
 * 卡面上是四段，而且**一个小标题都没有**。
 *
 * 顺序是一句话的三个节拍，读下来就是参谋在说话：
 *
 *   1. `what`     发生了什么 —— 具体、可核、带日期
 *   2. `why`      对公司可能造成什么影响
 *   3. `headline` **所以要问的那个问题** ← 整张卡最响的一行
 *   4. `refs`     来源
 *
 * 上一版每段顶一个小标题（「发生了什么」「它动摇哪条判断」…）。删掉了：标题把一段
 * 连贯的话切成四个待办事项，眼睛每读一段要先读一次标签再切回正文，四次。而这四段
 * 本来是一句话 —— 出了这件事，它意味着这个，所以要问那个。**区分靠字号和留白，
 * 不靠标签。**
 *
 * 议题（`headline`）放在第三拍而不是最上面：它是这张卡的**结论**，前两段是它的来路。
 * 结论用最大的字放在最后一拍，读完自然停在那里。
 */
export interface Card {
  id: string;
  issueId: string;
  /**
   * 这张卡真正要问的那个问题 —— 卡面最响的一行，也是详情页的标题。
   *
   * **写成问句。** 陈述句（「大厂正在收拢 AI 能力」）是信号的复述，那一段已经在
   * `what` 里了；这一行的职责是把信号变成一个**需要他回答的东西**，而只有问句
   * 逼得出回答。判据仍然只有一个：一号位扫过它，能立刻判断这跟他手上的事有没有
   * 关系；做不到，说明这张卡本来就不该出。
   *
   * 它不是 `what[0]` 的缩写，也不能由任何字段截出来。`what` 是记录（「团队提交
   * 33 人四层编队的执行计划，本周需批复启动预算与架构师招聘」），读完还得自己
   * 想一遍它意味着什么；`why` 是论证，三行起。一号位在驾驶舱左上角扫这一眼时
   * 两样都用不上 —— 他要的是**张力本身**：要发生的事，和它押在哪条正在晃的判断上。
   *
   * 写法上参照公众号标题：直给、有张力、不超过一行半。判据只有一个 —— 一号位扫过
   * 它，能立刻判断这跟他手上的事有没有关系。做不到这一点的标题，说明这张卡本来
   * 就不该出。
   *
   * 它是 Clark 的措辞，不是事实陈述，所以不挂溯源徽章（那一层留给紧接其下的
   * `what`：标题的依据就在它下面一行，不隔着任何东西）—— 和 `Issue.title` 同一
   * 类对象。
   */
  headline: string;
  /**
   * 这行标题是小模型起的，不是人写的。
   *
   * 只有一种情况会是 true：他往「我自己有一件事」里贴了一整篇文章或一个链接 —— 那一
   * 大段东西自己当不了标题，于是参谋读一遍起了一行（见 `own-issue-input.ts`）。他自己
   * 打的那一句话仍然原样当标题，这一格是 false。
   *
   * 它要写在详情页上（一行小字），但**不写在卡面上**：清单那一屏他在决定「哪几条值得
   * 点进去」，而「这行字是谁起的」改变不了那个决定；点进去之后才要紧 —— 那时候他读的
   * 是内容，得知道哪一句是他自己的话、哪一句是参谋的措辞。
   */
  titleByModel?: boolean;
  /** 它是怎么进来的 —— 雷达 / DRI 上报 / 一号位自己加 / 研讨衍生。 */
  source: CardSource;
  /**
   * 这条议题是怎么被问出来的 —— S01 那四块，**只在详情页摊开，不上卡面**。
   *
   * 卡面仍然是三拍（`what` → `why` → `headline`）。四块摆到卡面上会把清单那一屏变成
   * 四篇短文，而他在那一屏做的决定只有一个：哪几条值得点进去。四块要的注意力是点进去
   * 之后的那一档。
   *
   * `undefined` = 这张卡没有经过 issue framing：一号位自己贴进来的那一条（`api.addIssue`
   * 只叫小模型起了个标题），以及种子数据里的卡。屏幕上那一段跟着不出现 —— 诚实的空，
   * 不拿 `what`/`why` 拼一个假的四块出来。
   */
  framing?: IssueFraming;
  /** ① 发生了什么 */
  what: Statement[];
  /**
   * 关于上面那段原文，要照实交代的那一句。
   *
   * 三种话：截断了多少字、链接没抓到（连原因一起）、正文是粗抽的可能夹着导航文字。
   * 它必须和原文摆在同一个地方，因为它要否掉的正是读原文时最自然的那个假设 ——
   * 「我看到的就是全部」。没有这一格，一份被截到 20k 的长文在屏幕上和一份完整的
   * 长文长得一模一样。
   */
  materialNote?: string;
  /** ② 为何现在重要 */
  why: string;
  /** ③ 影响哪条判断 — 出卡门槛，为空即精度门失效。id 是真的 Judgment id。 */
  strategyRef: { id: string; statement: string };
  hypothesisRef?: { id: string; statement: string };
  /** ④ 建议动作 */
  suggestion: Statement;
  /**
   * 来源出处。**和 `source` 不是一回事。**
   *
   * `source` 是「谁递上来的」（雷达 / DRI / 一号位自己 / 研讨衍生），回答的是可信度
   * 来自哪里；`refs` 是「这件事在哪儿能查到」——「第一财经《字节跳动 To B 战略升级》
   * 2026-07-30」。一个是渠道，一个是出处。混成一个字段之后，屏幕上就再也答不出
   * 「你从哪看到的」这个问题 —— 而这是一号位对一条外部信号的第一个反问。
   */
  refs: Trace[];
  /**
   * 这条信号会影响哪几个业务域。
   *
   * 一号位手下有八个业务域，他扫这一屏时第一个动作是**把不相干的那些滤掉**。没有这个
   * 标注，每条都得读完正文才知道跟自己现在关心的那块有没有关系 —— 而这一屏的全部
   * 意义就是让他不用读完。
   *
   * 可以是多个：一条信号常常同时压在两个域上，而**跨域**这件事本身就是它值得被端
   * 上来的理由之一。也可以是空的 —— 本体里没有「议题属于哪个域」这层关系，接不出来
   * 时留空是诚实的空，不编一个。
   */
  domainIds: string[];
  createdAt: string;
  /**
   * 这条的预研什么时候跑完的。
   *
   * **每条被捕捉进来的信号一进来就自动跑一份预研**（见 `PreResearchDoc`），所以这里
   * 通常有值；`undefined` = 报告还不在（在跑，或者那一轮挂了 —— 挂没挂看
   * `preResearchFailed`）。这个字段要出现在卡片上，因为它回答的是一号位看
   * 这一屏时最先冒出来的那个问题 —— 「点进去有东西看吗」。没有它，那张卡就只是一个
   * 标题加三个按钮，点进去是不是空的全凭他赌一次。
   */
  preResearchAt?: string;
  /**
   * 预研**判成了什么**。只在 `preResearchAt` 有值时有意义。
   *
   * 卡面上那句话原先只分「跑完了 / 还在跑」两档，于是一条被参谋判掉的议题在提请台上
   * 写的仍然是「预研已完成 · 进去追问 →」—— 点进去才发现参谋说这条不值得继续投入。
   * 结论属于这一屏，不是详情页才该知道的事。
   *
   * `null` 跟着 `PreResearchDoc.status` 的口径：没判过就是没判过，**不默认成
   * `valid`**。
   */
  preResearchStatus?: PreResearchStatus | null;
  /**
   * 那一轮预研挂了。只在 `preResearchAt` 没值时有意义。
   *
   * 失败不许伪装成等待：没有这一格，一次挂掉的预研在卡面上永远写着「预研进行中…」，
   * 而没有任何一轮在跑。
   *
   * 它取的是进程内的任务状态（见 `agent/tasks.ts`），所以重启之后那次失败就不记得了 ——
   * 那时卡面回到「进行中」，而他点进详情页会真的重起一轮。这个洞在任务状态那一层，
   * 不在这里补。
   */
  preResearchFailed?: boolean;
  /**
   * 那一轮预研此刻在哪一步。只在 `preResearchAt` 没值、也没失败时有意义。
   *
   * 卡面那一格原来只写「预研进行中…」。三个字答不出他真正在问的那句话 —— 「它是
   * 真在干活，还是卡住了」。写出「正在装配上下文 · 第 1 步 / 共 2 步」之后，那一格
   * 从一句安抚变成一个可核对的事实：下次刷新它该往前走一格。
   */
  preResearchStep?: ResearchStep;
  /**
   * 那一轮预研是什么时候起的。卡面上「已 34 秒」由它在客户端算。
   *
   * 秒数不由服务端算：那样得每秒轮询一次才不跳字，而这一屏一次能挂十几张卡。给起点，
   * 让客户端自己走表。
   *
   * 有它就是**真有一轮在跑**（`runTask` 给每条 running 都盖了起点），所以卡面拿它当
   * 「要不要呼吸」的判据 —— 三个字段全空的那张卡是「没人在跑」，不是「在跑但不知道
   * 跑到哪」。
   */
  preResearchStartedAt?: string;
  /**
   * Set once the card has been disposed of. The digest for a given day keeps
   * returning every card it issued; a handled one collapses to a one-line
   * summary rather than vanishing, and the day's budget count stays put.
   */
  disposedAs?: CardDisposition;
  /** 处置发生在什么时候 —— 待定区里那行「待定于 …」的依据。 */
  disposedAt?: string;
  /** Optional reason tag captured when disposedAs === "dismiss". */
  dismissReason?: string;
  /** A1a 调研之后判为噪音的标注。见 `CardAgentVerdict`——它不会把卡收走。 */
  agentVerdict?: CardAgentVerdict;
  /**
   * 入库时算出来的：这条信号可能和哪条既有议题说的是同一件事，以及相对那一条多了哪几句。
   *
   * **它是「可能」，不是「已并入」。** 这一层没有合卡：卡照旧新建一张，那条旧议题
   * 一个字段都没动。`update_issue` 的取代成不成立，是一号位采信那一下的事
   * （见 `a1a/apply.ts` 那段注释）—— 所以这里只把算出来的关系摆上来给他看。
   * 屏幕上的措辞照这个口径写：「这条和 ISS-xxx 说的可能是同一件事」。
   *
   * 算不出来（一条都不过阈值）就没有这个字段 —— 不编一个。
   */
  maybeSameIssue?: { issueId: string; delta: string[] };
}

/**
 * 没出卡的一条。
 *
 * 每天最多 3 张的预算制要可信，就得把没出的卡的账也摊开：每条写明来源、一句话、
 * 和不出卡的理由。理由必须是可核对的标准（「单一来源」「不动摇任何在版判断」），
 * 不是含糊的「不重要」。一号位从这里捞回一条本身就是最直接的分诊纠错反馈。
 */
export interface WithheldItem {
  id: string;
  /** 来源一行：「外部靶点 · 行业新闻」/「内部经营 · MVP 周报」 */
  source: string;
  /** 它是什么，一句话 */
  line: string;
  /** 不出卡的理由，可核对 */
  reason: string;
  /** 与哪条判断相关；有就点得开 */
  judgmentId?: string;
  /** 一号位说过「这个我要看」的时刻 */
  requestedAt?: string;
  /** 捞回之后系统的答复，一行，服务端措辞 */
  requestedNote?: string;
}

export interface Issue {
  id: string;
  title: string;
  state: IssueState;
  /**
   * 议题列表的三个来源，缺一不可：`signal` 待定事项采信沉淀，`manual` CEO 手动添加，
   * `derived` 探讨中衍生。来源要写在屏幕上 —— 池子可信的前提是每条都答得出
   * 「它怎么进来的」。
   */
  origin: "signal" | "manual" | "derived";
  /**
   * 它归哪个业务域。手动添加的议题刚进来时没有域 —— 归域是 Agent 之后的事，
   * 这里不猜。没有域就没有 DRI，屏幕上照实写着。
   */
  domainId?: string;
  /**
   * 它在动摇哪些判断。`Judgment.id`，不是裸字符串 —— 指向不存在对象的编号会让
   * 「影响哪条判断」永远点不开。
   */
  judgmentRefs: string[];
  /**
   * `judgmentRefs` 解析出来的判断本身，由数据层填。
   *
   * 这是本体与议题链唯一的接缝，所以它必须在屏幕上：一号位看着一个议题，要能立刻
   * 知道它在晃公司赌的哪一句话，以及那句话此刻站不站得住。取的是 store 里的活对象：
   * 写回之后，同一个地址上这条判断已经是 v2 了。
   */
  judgments?: Judgment[];
  /** `domainId` 解析出来的域与它的 DRI，由数据层填。 */
  domain?: Domain;
  dri?: Person;
  driAgent?: Agent;
  /** null = 目前不需要用户做什么 */
  nextActionForUser: string | null;
  /** 深度研究是否已完成（报告已装配）。由数据层填，与 `IssueSummary.researchReady` 同源。 */
  researchReady?: boolean;
  /**
   * 一号位在发现议题时点名的承接人（「深研并指派」）。与 Domain 的 DRI 不同：
   * 这是一次显式点名，要在屏幕上标出来 —— 被指派的人和指派这件事都得可见。
   */
  assigneeName?: string;
  /**
   * What the system is watching on the user's behalf while there is nothing to
   * do. 安静的状态要说出声（「已布控 2 条 Re-open Trigger」），silence reads as
   * "did I miss something". Only meaningful when nextActionForUser is null.
   */
  monitoringNote?: string;
  /** 提出的时刻。与 decidedAt 一起构成「从提出到定下来多久」这个唯一的速度口径。 */
  raisedAt: string;
  decidedAt?: string;
  updatedAt: string;
}

/**
 * 一轮研究此刻在哪一步。
 *
 * ## 为什么是「第几步」而不是百分比
 *
 * 模型调用没有进度回传，所以时间上的百分比只能靠预估编出来（见 `IssueResearchStatus`
 * 那段）。但**步骤是真的**：预研是「装配上下文 → 写这一轮预研」，深研是「装配上下文 →
 * 写正式报告 → 压成四节 → 反证复核」，这几段在代码里就是那么排的，屏幕上写第几步是
 * 在说一件已知为真的事。
 *
 * ## label 是跑的那一侧的原话
 *
 * 和扫描那条链同一条规矩（`scan/run.ts` 头部第一条）：这几个字由链路自己声明，视图层
 * 一个字都不编。「正在分析全网资讯」这种没人核得动的话就是从视图层编步骤名开始的。
 */
export type ResearchStep = {
  /** 这一步的原话，如「写正式报告」。带重修轮次时是「压成四节 · 重修第 1 轮」。 */
  label: string;
  /**
   * 第几步，从 1 起。
   *
   * **重修不进序号** —— 重修是某一步内部再跑一遍，不是下一步。让它进序号，序号会
   * 冲过分母（共 4 步跑出第 5 步），而分母是这个数唯一的意义所在。
   */
  no: number;
  /** 这条链路计划几步。由链路声明的常量，不随重修变。 */
  total: number;
  /** 这一步是什么时候开始的。屏幕上暂时不用，但「卡在哪一步、卡了多久」要靠它答。 */
  at: string;
};

/**
 * 自动深研此刻的样子。
 *
 * 跑着的时候**可能**带进度：只有数据层真的知道这一轮要多久（预估写在 seed 里）才给
 * `progress`，否则只说「在跑」。编一个会走到 100% 却什么也不会发生的进度条，比不给
 * 进度条更糟 —— 一号位会盯着它等。
 *
 * `step` 和 `progress` 是两件不同的事，不互相兜底：`progress` 是**时间**过了多少
 * （只有预估过的那条路有），`step` 是**阶段**过了几个（真实跑的那条路有）。把步数
 * 折成百分比喂给那个进度环，就是把「4 步里的第 3 步」说成「快好了」——而第 3 步
 * （压成四节，带重修）恰恰可能占掉整轮七成的时间。
 */
export type IssueResearchStatus =
  | { state: "done" }
  /**
   * 排着队，还没起跑。**深研一次只跑一轮**（`agent/tasks.ts` 的 `lane`），第二件议题按下去
   * 之后落在这里。
   *
   * 单独一档而不是并进 `running`：并进去的话屏幕上写着「进行中」，而这一轮**一次模型调用
   * 都还没发**，秒表从按下去那一刻开始走 —— 十五分钟之后他看到的是「已 15 分 00 秒」压在
   * 一件根本没开始的事上。并进 `idle` 更糟：那句话是「没有人在做」，而它确实排着队。
   */
  | {
      state: "queued";
      /** 前面还有几轮（在跑的那一轮也算）。口径见 `TaskState.queuePosition`。 */
      queuePosition: number;
    }
  | {
      state: "running";
      progress?: number;
      remainingSeconds?: number;
      /** 此刻在哪一步。没上报就没有 —— 那时屏幕只说「在跑」。 */
      step?: ResearchStep;
      /**
       * 这一轮什么时候起的。**给的是起点，不是「已经跑了多少秒」**：秒数由屏幕自己
       * 走（`ResearchStepLine`），服务端只要报一次。给秒数的话，那个数要么每秒跳一次
       * 请求，要么停在装载的那一刻不动 —— 后者更糟，它长得像一块表停了。
       */
      startedAt?: string;
    }
  /**
   * 没有报告，也没有任何一轮在跑。
   *
   * 这一档过去不存在 —— 没报告就一律算「进行中」。那是这个产品最不该撒的谎：屏幕上
   * 一个转着的圈，代表的却是一件**没有人在做的事**，而一号位会一直等它。已部署的
   * 议题、被搁置的议题、模型调用失败之后的议题，全都落在这里。
   */
  | { state: "idle" };

/**
 * 承接研究 —— 被指派的 DRI 那一份。
 *
 * 它和自动深研是两份东西、两个立场，屏幕上必须分开说：一号位问的是「机器查完了没」
 * 和「人回话了没」，这是两个问题。
 */
export type HandoffStatus =
  | { state: "unassigned" }
  | { state: "waiting"; driName: string }
  | { state: "done"; driName: string };

export type IssueSummary = Pick<
  Issue,
  | "id"
  | "title"
  | "state"
  | "origin"
  | "nextActionForUser"
  | "updatedAt"
  | "domainId"
  | "monitoringNote"
> & {
  /**
   * 深研报告是否已装配。议题列表那行「深度研究装配中 · 报告就绪后可进入」的依据 ——
   * 一号位进议题研究的第一步永远是读报告，报告没好，池子要照实说。
   */
  researchReady: boolean;
  /** 「深研并指派」点名的承接人，列表行上要标出来。 */
  assigneeName?: string;
  /**
   * 会前一页纸装配好了没。
   *
   * 在摘要里而不是只在 `MeetingPrep` 里，是因为**域一级也要数它**：会议那一页左边
   * 那列写着每个域「议程几件」，而一页纸就是上过议程的证据。只数方向判断的话，
   * 一个已经摆好预审报告的域会显示「暂无议程」。
   */
  briefReady: boolean;

  /** 机器那份查到哪了。 */
  research: IssueResearchStatus;
  /** 人那份回话了没。 */
  handoff: HandoffStatus;
  /**
   * 能不能进议题研究页。**任意一份研究到手就够** —— 等两份齐了再放人进去，等于把
   * 已经查完的那份扣在手里。
   */
  canOpenResearch: boolean;
  /** 已了结（拍过板/已关闭/已否掉）。战略议题列表只看没了结的。 */
  settled: boolean;

  /* --- 「研究中」到底走到哪了：几个能算出来的数，不写一句概括 --- */
  /** 立项到今天几天 */
  ageDays: number;
  /** 等他把关的议题拆分点 */
  openCandidates: number;
  /** 已勾进会议清单的条数 */
  queuedForMeeting: number;
  /** 已经上会拍过几次（会后确认落过几次） */
  meetingsHeld: number;
  /** 与参谋对谈了几轮 */
  talkRounds: number;

  /* --- 排会 --- */
  /**
   * 前期调研做完了没 —— **排会面板上「这件可以开会了」的唯一判据。**
   *
   * 口径是「机器那份或人那份，任意一份到手」：深研报告落库了（`researchReady`），或者
   * 会前一页纸已经装配（`briefReady`）。比 `briefReady` 松一档是有意的 —— 一页纸是
   * **会议的产物**，要求它先有才准排会，等于让因果倒过来跑一遍。
   *
   * 算在数据层不在视图层：排会面板和议题卡片两处都要问这一句，各写一遍迟早会分家。
   */
  readyForMeeting: boolean;
  /** 已经排上会了的话，排在哪一场。没排就没有这一格。 */
  slot?: IssueSlot;
  /**
   * 排会面板上的手动顺序。他没拖过的是 `Number.MAX_SAFE_INTEGER` —— 于是「没拖过」
   * 天然排在「拖过」的后面，而两件都没拖过时由默认序（可开会的在前）说了算。
   */
  agendaRank: number;
  /**
   * 会后提炼出来的那一份，**还没被他确认的才给**。
   *
   * 确认过的不再挂在摘要上：那时它已经不是一件待办，而首页那一叠摞着的卡片摊的正是
   * 「还压在他那儿的」。要读会后全文，进这件议题。
   */
  debrief?: MeetingDebrief;
};

export type TimelineEventKind =
  | "state"
  | "signal"
  | "talk"
  | "deep"
  | "handoff"
  | "judgment"
  | "decision"
  | "trigger";

/**
 * 发现议题的处置记录一条。被发现的信号不管走了哪条路（深研 / 深研并指派 / 待定 /
 * 搁置），账都在这里 —— 列表本身只留未处置的，历史进记录页。
 */
export interface SignalLogEntry {
  card: Card;
  issueId: string;
  issueTitle: string;
  disposition: CardDisposition;
  at: string;
  assigneeName?: string;
}

/**
 * 报告区一排页签：主源那份深研报告、同一轮里另外那几条链路各自写的一份原件、被指派 DRI 的
 * 承接研究。四种页签，形状不同：
 *
 * - 一份完整的报告（`doc`）—— 原件加四节压缩面；
 * - **只有原件**的一份（`source`）—— 四节不是它压的，所以它没有那一面；
 * - 一个「已经点名派出去、还在等」的等待态（`awaiting`）—— 它**没有**报告；
 * - 一栏「这一轮会有，此刻还在跑」的占位（`pending`）—— 它也没有报告。
 *
 * 为什么不把那句等待的话塞成一份四节全空的 `ResearchDoc`：上一版这么做了，于是产品
 * 自己的文案被渲染进「报告原文」那一栏（`SourceText` 头上写着「一个字都不动」）、
 * 切到「四节压缩」会得到一份只有「五、建议分流」的空报告、划词还能把这句 UI 文案
 * 「记成判断」在图上开一支。**数据层只给事实（等谁、从什么时候起），那句话由页面写。**
 *
 * 第二种形状是同一条纪律的第二次应用：Claude 那条链路写的原件塞成 `ResearchDoc` 的话，四节
 * 要么填主源的（屏幕上把 ChatGPT 写的话署到 Claude 名下），要么填空（切过去得到一份空报告）。
 * 两种都不能要，所以它有自己的形状。
 *
 * 第四种（`pending`）是第三次应用：三条链路同时起跑，各自要跑十几分钟，那期间它们在页签行
 * 上就得占着位置（否则页签会在他眼前一枚一枚地凭空多出来），但**点开还没有正文**。塞一份空
 * 正文的 `source` 进去的话，屏幕上就是一栏空白的「报告原文」—— 而空白答不出「是还在跑还是
 * 跑完了是空的」。所以它带的是事实：这条链路走到第几步、从什么时候起跑、或者为什么没跑成。
 *
 * `pending` 那一栏**点得动**（除了压根还没起跑的那一档）：三条链路各自计时，那块表得有地方
 * 显示，而页签点不动的话它就没有地方显示。上一版这里是点不动的 —— 那时候只有一栏 pending
 * （多模型报告），它在等前面两份，点开确实什么都没有。
 */
export type IssueReport = {
  /**
   * `agent` 是主源那一份；`agent:alt<n>` 是同一轮里另一个模型写的那一份；`dri` 是承接研究。
   *
   * 不写成闭合的联合类型，因为别的模型有几个是运行时才知道的（配了几把 key）。视图里那几处
   * 「只有主源那一份才挂链路锚点」的判断认的是 `agent` 这个准确的值，不是前缀。
   */
  key: string;
  /**
   * 页签上的名字：「DeepSeek」/「Claude」/「ChatGPT」/「承接研究 · 白田田（Agents DRI）」/
   * 还在等时「承接研究 · 等 白田田 回传」（照抄首页 `HandoffStatusLine` 的口径）。
   */
  label: string;
} & (
  | { doc: ResearchDoc; source?: never; awaiting?: never; pending?: never }
  | { doc?: never; source: ReportSource; awaiting?: never; pending?: never }
  | {
      doc?: never;
      source?: never;
      /** `since` 是 `DriHandoff.assignedAt` 那同一个事实，同一段算法（`assignedAtOf`）。 */
      awaiting: { name: string; since: string };
      pending?: never;
    }
  | {
      doc?: never;
      source?: never;
      awaiting?: never;
      /**
       * 这一栏这一轮会有，此刻还在跑（或者已经跑挂了）。里面全是**事实**，那几句话由页面
       * 写 —— 数据层不知道屏幕上有多少地方要说这件事，也不该替它们定措辞。
       */
      pending: {
        /**
         * 照实说的那句话，由产出那一轮给。三条链路同时跑的时候它是「还没开始跑」这一类
         * 说不出别的的情况；走到某一步之后 `step` 比它准，页面优先读 `step`。
         */
        note: string;
        /** 这条链路此刻走到第几步。口径同 `IssueResearchStatus.step`。 */
        step?: ResearchStep;
        /**
         * 这条链路**自己**什么时候起跑的。给起点不给秒数，理由同
         * `IssueResearchStatus.startedAt`。三条链路各有一个 —— 这就是「单独计时」的落点。
         */
        startedAt?: string;
        /**
         * 这条链路为什么没跑成。有它就是**这一条挂了**，另外几条照旧 —— 一条链路挂掉不
         * 拖垮这一轮（见 `a4/run.ts`）。原话来自那次失败，不是视图编的。
         */
        error?: string;
        /**
         * 这条链路此刻**已经读得通的那些块**（口径同 `DraftReport.blocks`）。
         *
         * 这一栏仍然是 `pending`：报告没写完，表还在走，步骤还在报。有几个块可读不等于
         * 这一轮跑完了 —— 把它挪到 `source` 那一支会让屏幕上那块表停掉，而那时它明明还
         * 在跑。所以它挂在这里：屏幕上是「已经出来的几个块 + 后面的骨架 + 还在走的表」。
         */
        blocks?: ReportBlocks;
      };
    }
);

/**
 * 只有原件的一份报告：同一轮深研里，另一条链路自己跑出来的那一份。
 *
 * **它有自己的证据包和自己的用时。** 上一版这两样是从主源那份文档上取过来的 —— 那时候几份
 * 原件确实共享一套证据（同一份台账、同一份指令，只换了写的人）。三条链路各自编命题、各自
 * 联网取证之后那句话不再成立：抄主源的清单过来，屏幕上会把 ChatGPT 那条链路取回的页说成是
 * Claude 取回的。
 */
export interface ReportSource {
  /** 注册表别名（`claude-opus-5`）。台账上认这个，屏幕上不显示它。 */
  modelAlias: string;
  /** 正文，一字未改。段落约定同 `ResearchDoc.sourceText`。 */
  text: string;
  /**
   * 这一条链路装配自哪些对象 —— **它自己那一份**，不是主源的。
   *
   * **这一轮还在跑时没有**（见 `DraftReport`）：那份清单要到收尾才封（取证台账那几条是
   * 边跑边接上去的），先摆一份半成品出来，等这一轮跑完它会当着他的面变长 —— 而「装配自
   * N 个对象」是拿来核对的数，一个会自己变的数核不了任何东西。
   */
  assembledFrom?: ManifestItem[];
  byAgentLabel: string;
  /** 这一轮深研收尾的时刻。这个是**共享的** —— 三条链路属于同一轮。 */
  at?: string;
  /** 这一条链路自己跑了多久。不是整轮的用时（见 `AltReport.durationMs`）。 */
  durationMs?: number;
  /** 怎么来的。口径同 `AltReport.kind`。 */
  kind?: "writer" | "synthesis";
  /** 只有 `kind: "synthesis"` 有。口径同 `AltReport.basedOn`。 */
  basedOn?: string[];
  /**
   * 这一份的区块形态。口径同 `ResearchDoc.blocks`。这一栏**还在跑的时候也可能有**（半份，
   * 见 `IssueReport.pending.blocks` 与 `DraftReport.blocks`）。
   *
   * **证据表是它自己那一份。** 三条链路各自取证（见本接口头部），所以 `blocks.evidence`
   * 里的 E1 和另一栏的 E1 是两页不同的网页 —— 区块里那些 `[E1]` 芯片只能拿本栏的证据表
   * 去解析。跨栏解析的话，屏幕上会把 ChatGPT 抓回的页说成是 Claude 抓回的。
   */
  blocks?: ReportBlocks;
  /**
   * 这一份出自**一轮没跑完的深研**（见 `UnfinishedResearchRound`）：报告写出来了，而这一轮
   * 收在了后面某一步上 —— 压成四节那一步挂了，或者服务重启把它掐断了。
   *
   * 有它的时候屏幕上必须说出来。一份没有四节、没有句末溯源、判断板上一条都没有的原文，
   * 和一份正常的原件在屏幕上长得一模一样 —— 而两者的份量差得远：这一份没过跨链路对账，
   * 也没有人拿它压出过判断。
   */
  unfinished?: {
    /** 那一轮收场的时刻。 */
    at: string;
    /** 收场时的那句原话，照实带上（和 `deepResearchStatus` 给屏幕的是同一句）。 */
    error: string;
  };
}

/**
 * 一轮**还没落库**的深研：此刻在跑的那一轮，或者已经收场却没跑成的那一轮。
 *
 * 为什么要有这张表：几条链路各自跑十几分钟、各花一笔真钱，而它们全跑成之后还有一步 ——
 * 把几份压成判断／关键证据／反面／未知那四节。原来那几份原件只活在进程内的任务表上
 * （`DraftReport`），于是有两种真花过钱的丢法：
 *
 *   1. 整轮挂在后半段：任务翻成 `failed` 时任务表连着进度稿一起重建，几份写完的报告
 *      一起没了。2026-08-26 的 ISS-111 就是这样（四份报告全在手上）。
 *   2. **进程没了**：`next dev` 改一个服务端文件就重编译一次，任务表随之清空。
 *      2026-08-26 的 ISS-110 撞的是这一种 —— 一份 1.6 万字符的报告连同它带的可拖拽
 *      参数块一起消失，而屏幕上那件议题回到「没有一轮在跑」，下一次轮询又自己起了
 *      一轮真花钱的深研。
 *
 * 所以这一份**边跑边落盘**：一条链路写完就存一次（`error` 还没有值），收场时补上收场
 * 时刻和那句原话。它同时是那道「不自动重试」的闩 —— 任务表上那道闩跟着进程走，而这条
 * 口径不该跟着进程走。
 *
 * 留下来的**只有原件**，所以它不是 `ResearchDoc`：四节、句末溯源、判断板一样都没有，
 * 议题状态也不动。
 */
export interface UnfinishedResearchRound {
  /** 这一轮开跑的时刻。 */
  startedAt: string;
  /** 这一轮收场的时刻。**没有值 = 此刻还在跑。** */
  at?: string;
  /**
   * 收场时的那句原话。屏幕上照实写，不改写成产品话术。
   *
   * **没有值 = 此刻还在跑**，而「还在跑」这件事只有进程自己知道 —— 所以重启之后读到一条
   * 没有 `error` 的记录，意思是「上一次进程是在这一轮跑着的时候没的」，那时由 store 补上
   * 一句照实的话（见 `store.ts` 的恢复那一段）。
   */
  error?: string;
  /**
   * 开跑那一刻，**跑它的那张任务表**是哪一份（`tasks.ts` 的 `TASK_TABLE_ID`）。
   *
   * 上面那句「没有值 = 此刻还在跑」漏了一件事：还在跑的是**某一份进程内的任务表**，而
   * `next dev` 一次重编译可以只换掉那张表、留着这份库。那时这条记录看起来是「在跑」，
   * 而当下这份表里查不到它 —— 两个都不假，合起来却让 `ensureDeepResearch` 又开一轮
   * （2026-08-27 的 ISS-112：每次重编译起一轮，停不下来）。
   *
   * 有了这一栏，「还在跑」就问得出「谁在跑」：身份对不上，那一轮的下场这一份答不出来，
   * 一律按没跑成收场，要不要再花一轮由他自己按（见 `deepRoundState`）。
   *
   * 可选是为了读得懂旧快照：这一栏之前的记录没有值，那种记录一律按「不是这一份跑的」算。
   */
  runner?: string;
  /**
   * 已经写完的那几份原件，**只留有正文的**。形状照 `DraftReport`（页签 key、页签名、用时
   * 都在上面），报告页签行按它摆栏 —— 和这一轮还在跑时读的是同一套形状，视图那边不用
   * 再认一种新东西。
   */
  reports: DraftReport[];
}

/** 知识关系：这件议题在本体里牵住的一切，按对象类型分组。 */
export interface IssueKnowledge {
  issue: IssueSummary;
  judgments: Judgment[];
  domain?: { code: string; name: string; driName: string };
  missions: MissionCard[];
  docs: { id: string; title: string }[];
  externalEvidence: { label: string; count: number };
  derivedIssues: IssueSummary[];
  decisions: { id: string; label: string; href: string }[];
}

/**
 * 指派列表里的一行。**人是主角，域是背景。**
 *
 * 上一版这条路只递 `Person`，屏幕上于是只有一串名字 —— 而一号位在这一刻要回答的是
 * 「这件事该归谁」，那个判断靠的正是「谁管哪一摊」。名字底下带上他的域，那一问就在
 * 名单上答完了，不用先去别处对一遍分工。
 *
 * `domains` 是**名单**，不是一个：一个人可以管不止一个域，一个域也可以有不止一个人
 * （见 `Domain.driIds`）。空数组说的是「他不管任何一个域」—— 那不是数据缺失，指派给
 * 一个没有域的人是完全正常的一件事。
 */
export interface DriOption {
  id: string;
  name: string;
  /** 他在公司里的位置，一行。同 `Person.title`。 */
  title: string;
  /** 他负责的域，按编号排。屏幕上压淡一档显示。 */
  domains: { code: string; name: string }[];
}

/** 首页左下那列业务域：域本体 + 谁负责 + 手上有几件在办议题。 */
/**
 * 已部署那一屏右半边：这一件交出去之后的样子。
 *
 * **它此刻大半是示意数据**，`mocked` 那一格逐项点名，屏幕上照登 —— 议题和 Mission
 * 之间的关系本体里还不存在（生成逻辑与理由写在 `mock-deployment.ts`）。这一格不是
 * 装饰：一屏看起来什么都有、却分不出哪几样是真的，比这一屏空着更坏。
 */
export interface DeploymentDetail {
  issueId: string;
  /** 承接这件事的人，第一个是主责。**一个都没有就是空数组** —— 不拿人顶。 */
  owners: { name: string; role: string; domainName?: string; real: boolean }[];
  /** 交出去那一刻（ISO）。 */
  handedOverAt: string;
  /** 对应的那条 Mission。对不上就是 null。 */
  mission: {
    code: string;
    name: string;
    milestone: string;
    status: "running" | "confirmed" | "pending";
    periodLabel: string;
  } | null;
  /** 最近一次回话。没有就没有这一格。 */
  lastWord?: { at: string; text: string };
  /** 这一份里哪几样是示意的，一条一句。空数组 = 全部来自对象库。 */
  mocked: string[];
}

export interface DomainSummary {
  id: string;
  code: string;
  name: string;
  outcome: string;
  driName: string;
  openIssues: number;
}

/**
 * 首页右栏：Agent 对一件战略议题的参谋意见。全部从当下的对象现算 ——
 * 一句话判断、等他处置的候选决策、最强反证、在盯的未知、被动摇的判断。
 * 这是给一号位看的压缩面，不是报告的目录。
 */
export interface IssueCounsel {
  issue: IssueSummary;
  /** 当前判断的第一句。没有报告就没有立场，照实空着。 */
  stance?: string;
  /** 探讨链路上已经成熟到可以走的那几句（带建议去向）。 */
  pendingCandidates: ProbeNode[];
  /** 链路上还不成熟、参谋自己都说没站住的那几句。 */
  rawCount: number;
  strongestCounter?: string;
  unknowns: string[];
  judgments: Judgment[];
  briefReady: boolean;
  assigneeName?: string;
  researchReady: boolean;
}

/** 议题去向记录的一条：某件议题在某一刻发生了什么组织动作。 */
export interface IssueLogEntry {
  at: string;
  issueId: string;
  issueTitle: string;
  kind: TimelineEventKind;
  headline: string;
  actor?: string;
}

export interface TimelineEvent {
  id: string;
  kind: TimelineEventKind;
  at: string;
  headline: string;
  actor?: string;
  detail?: string;
  /** 组织动作与状态迁移导向判断（展开）；过程性内容不导向判断（折叠）。 */
  defaultOpen: boolean;
}

/**
 * 装配清单的一项。带 href 的项是本体对象，点得开 —— 一句「带了 4 项 Context」
 * 如果点不开，读者只能选择相信或不相信，那就不是证明。
 */
export interface ManifestItem {
  label: string;
  href?: string;
  kind?: TraceKind;
}

// ===========================================================================
// 议题研究 —— 首轮调研 + 对谈
// ===========================================================================

/**
 * 首轮调研文档。四节固定：当前判断 / 关键 Evidence / 反证与风险 / 不确定性，
 * 加一行建议分流 —— M1-A 对第一轮输出的原文要求，明确反对长报告。
 */
export interface ResearchDoc {
  issueId: string;
  /** 当前判断 */
  judgment: Statement[];
  /** 关键 Evidence */
  keyEvidence: Statement[];
  /** 反证与风险。Advisor 的 Challenge 能力首先落在这一节 —— 主动找反证，不做迎合。 */
  counters: Statement[];
  /** 不确定性 —— 答不出来的老老实实列出来 */
  unknowns: Statement[];
  /** 建议分流，一行 */
  routeSuggestion: string;
  /** 谁装配的 */
  byAgentLabel: string;
  /** 装配自哪些对象，逐项点得开 */
  assembledFrom: ManifestItem[];
  /**
   * 报告原文，一字未改。
   *
   * 上面四节是**压缩面** —— 参谋把一份九节的报告压成一号位五分钟能读完的四段。压缩
   * 一定有损：表格被拉成句子，编号引用被展开，两段合成一段。绝大多数时候这是对的，
   * 但有一种时刻不对 —— **他要核对参谋有没有改动原文的意思**。那一刻他要的不是更好
   * 的排版，是原件。
   *
   * 所以有原件就把原件摆在前面，压缩面退到第二个子页签。
   *
   * **A4 现在两层都出**：先写那份可署名分发的正式报告（进这个字段），再把它压成四节
   * （见 `a4/prompt.ts` 头部）。所以这个字段在深研报告上是常态有值，不再是「只有导入
   * 的报告才有原件」。留空的只剩两种：模型没能写出报告的那次，和老数据 —— 两层交付
   * 之前落库的深研报告确实没有原文，屏幕上直接给四节。
   *
   * 段落用空行分隔，`## ` 开头是小标题 —— 与 `Doc.body` 同一套约定。
   */
  sourceText?: string;
  /**
   * 上面那份原件的页签字：「ChatGPT」。
   *
   * 页签为什么写模型家的名字而不是「报告原文」：一轮深研现在是**三条独立链路**（见
   * `altReports`），三份摆在一排页签上时，「哪一份是谁跑的」是一号位唯一要先分清的事。
   * 名字由产出方给（`a4/run.ts` 的链路表），**视图不维护一张别名到中文的对照表** ——
   * 那张表换模型时没人会想起去改。
   *
   * `undefined` = 老数据（只有一份原件那会儿落的库）。屏幕上回落成「深研报告」。
   */
  sourceLabel?: string;
  /**
   * 这一份在页签行上排第几。三条链路的显示顺序是钉死的（DeepSeek → Claude → ChatGPT），
   * 而**主源不一定排第一** —— 主源是 ChatGPT 那条，它排在最后。所以顺序不能靠「主源在
   * 前、其余按数组顺序」推出来，得存。
   *
   * `undefined` = 老数据。那时候主源就是第一栏，屏幕上按原来那样排。
   */
  sourceTabOrder?: number;
  /** 主源那条链路**自己**跑了多久。整轮的用时在 `durationMs`。 */
  sourceDurationMs?: number;
  /**
   * 主源那份原件的**区块形态** —— 同一份报告，模型直接交出来的结构化那一份。
   *
   * 它和 `sourceText` 不是两份报告，是同一份的两种落法。区块那一份是**正规形态**：数字
   * 挂在证据编号上、判断带着证伪条件、三条链路的分歧是一个对象而不是一段话。`sourceText`
   * 是它的纯文本面 —— 屏幕上要签发、要复制、要和老数据摆在一排的那一面。
   *
   * 为什么两份都存，而不是只存区块、屏幕上从区块拼回文本：拼回来的那份**不是他签的那份**。
   * 一号位签发一份报告时签的是他读过的那些字，而「从 14 种块渲染成一段连续正文」是一次
   * 有损转写（表格拉成句子、卡片拉成排比句），每次改渲染规则都会让同一份报告的正文变样。
   *
   * 不存 HTML：HTML 是视图（任务书 §0）。存 HTML 就等于把这一版组件库的排版冻进库里，
   * 下一版改了间距，库里那几百份报告全部停在旧排版上。
   *
   * `undefined` = 这一轮没走区块那条路（开关关着，见 `blocks/flag.ts`），或者老数据。
   */
  blocks?: ReportBlocks;
  /**
   * 取证时那一份完整台账。**只有它带原文引句与口径四件套** —— `blocks.evidence` 那一份是
   * 屏幕上要的速查形态（编号、一句话、机构、等级），引句和口径都不在里面。
   *
   * 议事对话那一层的 `evidence_lookup` 吃的是这一栏：他问「E7 的原话是什么」时，端出去的
   * 必须是抓回来的那一句，不是模型照 `claim` 重写的一句。
   *
   * `undefined` = 分层之前跑出来的报告，或者 `TKOS_DR_V2=0` 那条对照链。这时只有速查那一份，
   * 工具回话里要明说这一条没留原文 —— 不能拿 `claim` 顶上。
   */
  ledger?: Evidence[];
  /**
   * 决断包 —— 深研收口那一次多交的那个块：参谋把这一轮的结论**整理成可批准的形状**。
   *
   * **它不是这一页的默认落点。** 交了它只说明参谋整理好了，不说明这件事已经形成决议、
   * 更不说明该立即派发命令。一号位默认看到的是判断那一面；要走到这一屏得他自己按一下
   * 「整理成行动建议」，那一下落在 `actionStagingAt` 上，而批准那道闸读它。
   *
   * 为什么它挂在报告上而不是单独一张表：一份决断包是这一轮深研的结论面，重跑一轮深研
   * 就该换掉它。单独存一张表的话，「哪一份决断包对应哪一版报告」要靠时间戳去猜，而这两样
   * 本来就是同一次产出的两个面（同一条理由写在 `blocks` 上）。
   *
   * 批准之后这一份会被**就地改写成他批准的那一版**（`api.approveCommandBrief` 里那次固化）——
   * 半年后重新打开这件议题，屏幕上要摆的是他点头的那份决心，不是参谋原来的建议。原建议
   * 留在决策记忆和 `DecisionOrder` 的账上。
   *
   * `undefined` = 这一轮没交这个块（老数据，或者那一轮模型没写出来）。这时屏幕退回四节。
   */
  commandBrief?: CommandBrief;
  /**
   * 这一轮另外那几条链路各自跑出来的原件。
   *
   * 三条链路（DeepSeek / Claude / ChatGPT）跑的是**同一套深研框架**：各自编命题、各自联网
   * 取证、各自写报告、各自过出口对账。它们不共享证据台账 —— 所以三份结论不一致的时候，
   * 那处不一致是三次独立研究的分歧，不是「同一批材料被两个人读出了两种意思」。
   *
   * 分开放而不是并成一份，因为它们没有可比的正确性：哪一份好是一号位读完自己判的，产品
   * 不替他挑。
   *
   * 上面四节和判断板上那几条只从 `sourceText` 那一份压出来（`a4.digest` 只读它，而那一份
   * 是 ChatGPT 那条链路的）。这不是偷懒：四节要能被引回原文的某一句，而三份原文的说法不会
   * 一致 —— 压三份就得回答「板上这条判断是哪一份的」，而那个问题在产品上没有答案。
   */
  altReports?: AltReport[];
  /**
   * 报告装配完的时刻。
   *
   * 这份文档过去**一个时间戳都没有** —— 报告页答得出「装配自哪几个对象」，答不出
   * 「什么时候装的」。一号位读一份深研时第一个要核的就是它有多新：一份三周前的报告
   * 和今早刚跑的，同样四节话，价值差一个数量级。
   *
   * `undefined` = 这份报告跑在有这个字段之前（老数据）。
   */
  at?: string;
  /**
   * 这一轮深研花了多久。取 `AgentRunRecord.latencyMs`，口径同 `PreResearchDoc.durationMs`。
   */
  durationMs?: number;
  /**
   * 这一份手上**一条外部证据都没有**时的那句声明。有证据时 `undefined`。
   *
   * 见 `NoExternalEvidence`。存在文档上而不是只落进运行记录，是因为报告页是他读这一份的
   * 那一屏 —— 这句话要和四节摆在一起。
   */
  noExternalEvidence?: NoExternalEvidence;
  /**
   * 这一轮**交付到什么程度**。见 `ReportCompleteness`。
   *
   * `undefined` = 未知，不是「完整」。这一栏是这一版才有的，而这一版之前落库的每一份报告
   * 都没有它 —— 把缺省读成「完整」等于给全部历史报告发一张它们没考过的合格证。也**不许
   * 从 `blocks.confidence` 猜**：置信度说的是「这个判断有多站得住」，完整性说的是「该写的
   * 几节写完了没有」，一份三节只成了一节的报告照样可以对那一节很有把握。
   */
  completeness?: ReportCompleteness;
  /**
   * 这一轮的结果**够不够拿来做决定**。`true` = 具备决策条件，`false` = 只够讨论。
   *
   * 和 `completeness` 分开的理由：一份三节都写完的报告，核心论证仍然可以是「关键依赖没
   * 查到，只能给条件性建议」。「这次调用结束了」「交付完整」「具备决策条件」是三件事
   * （HANDOVER §3.E），这里存后两件，第一件在运行记录上。
   *
   * `undefined` = 未知，同上，不从别的字段推。
   */
  decisionReady?: boolean;
  /**
   * 一号位**明确进入行动整理**的那一刻。没进过就没有这一栏。
   *
   * 为什么要存在服务端而不是留成屏幕上的一个 tab state：`approveCommandBrief` 是一个
   * 直接 POST 就能打到的口（`/api/data`，见 Next.js `mutating-data` 那份指南里那条警告
   * —— Server Function 不只从你自己的界面进得来）。把「他到底有没有走进行动整理这一步」
   * 只记在浏览器里，等于那道闸只是把按钮藏起来了。
   *
   * 研究完成 ≠ 已形成决议 ≠ 该立即派发命令：深研交出决断包**不等于**这一步发生过。
   */
  actionStagingAt?: string;
}

/**
 * 这一轮深研交付到什么程度。**产出侧的最小元数据**，落在报告对象上。
 *
 * · `complete` —— 该写的几节都写成了。
 * · `partial`  —— 有节超时/写挂了，收口补了摘要。**补摘要不等于补齐核心论证。**
 * · `failed`   —— 这一轮没有可读的正文。
 *
 * 缺这一栏是**未知**，不是 `complete`（理由写在 `ResearchDoc.completeness` 上）。
 */
export type ReportCompleteness = "complete" | "partial" | "failed";

/**
 * 「这一份能不能拿去下达」这一问的答案，读一次算清楚。
 *
 * 三档而不是布尔：`unknown` 必须和 `complete` / `partial` 一样是一档能被显示出来的东西 ——
 * 屏幕上写「完整性未知」和写「已完整」是两句话，而把未知折进任何一边都会让其中一句变成
 * 假话。
 */
export interface ReportDelivery {
  completeness: ReportCompleteness | "unknown";
  decisionReady: boolean | "unknown";
  /** 一号位明确进入过行动整理没有。 */
  staged: boolean;
}

/**
 * 报告上那两栏最小元数据读出来。
 *
 * **形状按产出侧那一条线正在落的那一版读**：`{ completeness?, decisionReady? }`。它此刻
 * 还没落地（`a4/stage-write.ts` 上在做），而它落在哪一层还没定 —— 可能在 `ResearchDoc`
 * 上，也可能在 `ReportBlocks` 上（`StageWritten.report` 就是那个对象）。两处都读，先读
 * 文档层：同一份报告两层都写了的话，文档层是这个库自己落的那一份。
 *
 * 读 `blocks` 那一层要绕过类型（那个接口在 `a4/blocks/schema.ts`，不归这条线改），
 * 用一个交叉类型而不是 `any` —— 口径同 `command-brief/pick.ts` 里那个 `BlocksWithBrief`：
 * 换成 `any` 的话，字段哪天改了名，这里一声不吭地读到 `undefined`，而屏幕上的样子是
 * 「所有报告的完整性都未知」。
 */
type DeliveryFields = { completeness?: unknown; decisionReady?: unknown };

export function readReportDelivery(
  doc: Pick<ResearchDoc, "completeness" | "decisionReady" | "actionStagingAt" | "blocks"> | null | undefined,
): ReportDelivery {
  const onBlocks = (doc?.blocks ?? undefined) as DeliveryFields | undefined;
  const rawCompleteness = doc?.completeness ?? onBlocks?.completeness;
  const rawReady = doc?.decisionReady ?? onBlocks?.decisionReady;
  return {
    completeness:
      rawCompleteness === "complete" || rawCompleteness === "partial" || rawCompleteness === "failed"
        ? rawCompleteness
        : "unknown",
    decisionReady: typeof rawReady === "boolean" ? rawReady : "unknown",
    staged: Boolean(doc?.actionStagingAt),
  };
}

/**
 * 这一份现在**能不能下达**。能就返回 `null`，不能就返回一句写给一号位读的话。
 *
 * 这一个函数是那道闸唯一的判据：`store.approveCommandBrief` 拿它抛 `ApiError`（原话
 * 原样回到屏幕上，见 `api/data/route.ts` 那个 409 分支），决断包那一屏拿同一句话把
 * 「批准并下达」置灰并把原因写在按钮底下。两处各判一次的话，屏幕上说得通的那一下会
 * 在服务端被拒，而他看不出为什么。
 *
 * ## 三条判据，为什么是这三条
 *
 * 1. **没进过行动整理** —— 研究完成不等于已形成决议，更不等于该立即派发命令。深研自己
 *    交了一份决断包，那只是参谋把话整理成了可批准的形状，不是他授权了下达。
 * 2. **交付不完整**（`partial` / `failed`）—— 缺论证的结果可以读、可以聊、可以接着研究，
 *    但不能靠按一颗按钮变成命令。
 * 3. **明确标了只够讨论**（`decisionReady === false`）。
 *
 * ## 未知这一档为什么放行
 *
 * `unknown` **不拦**。这两栏是这一版才有的，而这一版之前跑出来的决断包一份都没有它们 ——
 * 从严的话，那些报告会在按下批准的那一下被一句「完整性不足」拒掉，而这个库从来没有量过
 * 它们的完整性。那是拿未知当罪证。旧报告因此照旧可批（`保留兼容`），屏幕上照实标
 * 「完整性未知」，由他自己判。**未知就是未知，两边都不许猜**：不凭 `confidence` 猜成
 * 完整，也不凭它没有这一栏就当成不完整。
 */
export function dispatchBlockReason(delivery: ReportDelivery): string | null {
  if (!delivery.staged) {
    return "这一轮还没有进入行动整理 —— 深研交出的建议要先由您把它整理成行动，才谈得上下达。";
  }
  if (delivery.completeness === "failed") {
    return "这一轮深研没有交付出可读的正文，不能据此下达命令。可以继续研究或退回参谋重拟。";
  }
  if (delivery.completeness === "partial") {
    return "这一轮深研只交付了部分章节，核心论证没有写完 —— 可以读、可以接着追问，但不能据此下达命令。";
  }
  if (delivery.decisionReady === false) {
    return "这一轮的结果标的是「可供讨论」，不是「具备决策条件」，不能据此下达命令。";
  }
  return null;
}

/**
 * 「这一份没有外部证据」这句声明。
 *
 * 真发生过：两家检索一家 403、一家免费额度用尽，二十条检索式条条报错，一条外部证据都没
 * 入账 —— 而这一轮的产出是一份格式漂亮的报告，运行记录写着 ok。**一份没有外部证据的报告
 * 和一份有二十条证据的报告，在他打开的那一屏上长得一模一样**，要翻到运营台才看得出来。
 *
 * 所以有值就是「这一份不是联网核过的」，两句话都要上屏。怎么分格、每一格说什么，在
 * `a4/no-evidence.ts`。
 */
export interface NoExternalEvidence {
  /** 一句话，进事件标题和报告顶上那一行。不带换行。 */
  headline: string;
  /** 空在哪一格、带上厂商原话 —— 答的是「接下来该动哪里」。 */
  why: string;
}

/**
 * 主源之外的一条链路跑出来的那份报告（见 `ResearchDoc.altReports`）。
 *
 * 时刻（`at`）仍然不重复存 —— 那是**这一轮深研**收尾的时刻，三条链路共享。用时和装配清单
 * 反过来：三条链路各跑一整套框架，各自取回的页不一样、各自花的时间不一样，抄主源那一份
 * 过来就是在屏幕上说假话。
 */
export interface AltReport {
  /** 注册表别名（`claude-opus-5`）。台账上认这个，屏幕上不显示它。 */
  modelAlias: string;
  /** 页签上的字：「DeepSeek」「Claude」。由产出方给，视图不拼。 */
  label: string;
  /** 正文，一字未改。段落约定同 `ResearchDoc.sourceText`。 */
  text: string;
  /**
   * 这一份在页签行上排第几。口径同 `ResearchDoc.sourceTabOrder` —— 三条链路的显示顺序钉死
   * 在链路表上，而主源排在最后一栏，所以顺序推不出来，得存。
   */
  tabOrder?: number;
  /** 这一条链路自己跑了多久。整轮的用时在 `ResearchDoc.durationMs`。 */
  durationMs?: number;
  /** 这一条链路装配自哪些对象 —— 它自己那一份，不是主源的。 */
  assembledFrom?: ManifestItem[];
  /**
   * 这一份是怎么来的。
   *
   * · `writer`（缺省）：自己跑了一整套深研框架 —— 换的是模型，跑的是同一套流程。
   * · `synthesis`：读了别人已经写完的几份之后综合出来的一份。**A4 这条链路上现在没有这一
   *   种了**（三条链路各自独立研究，没有谁读谁）；留着这个取值是因为 DRI 那一侧还在用
   *   （`store.dri.test.ts`），而老库里也躺着几份。
   *
   * 存这个字段是因为屏幕上那句说明两种情况不一样。少了它，视图只能按 label 猜 —— 而 label
   * 是产出方给的文案，随时会改。
   *
   * `undefined` = 老数据，按 `writer` 读。
   */
  kind?: "writer" | "synthesis";
  /**
   * 综合的是哪几份。存屏幕上认得的短名（`["V4", "K3"]`），只有 `kind: "synthesis"` 有。
   *
   * 不存别名：这句话是要写到屏幕上给人读的（「读的是 V4、K3 那两份」），存别名的话
   * 视图又得自己维护一张别名到中文的对照表 —— 那张表换模型时没人会想起去改。
   */
  basedOn?: string[];
  /** 这一份的区块形态。口径同 `ResearchDoc.blocks`，证据表是本栏自己那一份。 */
  blocks?: ReportBlocks;
}

/**
 * 一轮**还在跑**的深研，三条链路此刻各自的样子（挂在任务表上，见 `TaskState.reports`）。
 *
 * 为什么要有这个东西：三条链路同时起跑，每条要走完编命题 → 取证 → 写报告 → 出口对账，
 * 一条跑十几分钟，而三条不会同时结束。全部落库才上页签的话，他对着一句「深度研究还在装配」
 * 等二十分钟 —— 而这期间屏幕本该答得出的是三件事：**哪条走到哪一步、各跑了多久、哪条已经
 * 能读了**。所以这三件事一条一条地往任务表上报，页签行从那里读。
 *
 * 它不是 `ResearchDoc`：这一轮的四节、判断板、时刻、装配清单一样都还没有。所以它只带正文
 * （或者一条链路此刻的进度）和页签名，摆在页签行上走 `IssueReport` 的 `source` / `pending`
 * 那两支。
 *
 * **不落盘**。这是一轮进程内任务的中间态，跟着任务表一起在重启时消失（那时那一轮本来也没
 * 了）；落盘就等于库里存着一份没有四节、没有出口对账账的半份报告，而下游没有一处认得它。
 */
export interface DraftReport {
  /**
   * 页签的 key，**必须和这一轮落库之后的那个一模一样**（主源 `agent`，其余按 `altReports`
   * 里的位置 `agent:alt<n>`）。对不上的后果不是多一栏：他正读着这一栏，报告落库那一瞬 key
   * 变了，屏幕会把他弹回主源那一栏。
   *
   * 主源是哪一条**跑之前就定了**（链路表上钉着 ChatGPT 那条），所以这个 key 从第一次上报
   * 起就是终值 —— 除了主源那条自己挂掉、顺位落到别人身上那一种，而那一下必然重排整排页签。
   */
  key: string;
  /** 页签上的字。同 `AltReport.label` / `ResearchDoc.sourceLabel`，由产出方给。 */
  label: string;
  /** 注册表别名。台账上认这个，屏幕上不显示它。 */
  modelAlias: string;
  /** 署名。同 `ResearchDoc.byAgentLabel` —— 几份原件署的是同一个参谋。 */
  byAgentLabel: string;
  /**
   * 正文。**没有 = 这一条还在跑（或者挂了）**，那时屏幕上说的是 `step` / `startedAt` /
   * `error` 那几样。
   *
   * 空字符串和没有是一回事，都按「还没写完」读：一份空正文的报告在屏幕上是一栏空白。
   */
  text?: string;
  /** 还没写完、而且连步骤都还没上报时照实说的那句话。有 `text` 时用不上。 */
  note?: string;
  /** 这一条链路此刻走到第几步。口径同 `IssueReport` 的 `pending.step`。 */
  step?: ResearchStep;
  /** 这一条链路自己什么时候起跑的。口径同 `IssueReport` 的 `pending.startedAt`。 */
  startedAt?: string;
  /** 这一条链路自己跑了多久 —— 写完那一刻封的。有 `text` 时才有意义。 */
  durationMs?: number;
  /** 这一条为什么没跑成。有它就是这一条挂了，另外几条照旧。 */
  error?: string;
  /** 口径同 `AltReport.kind`。 */
  kind?: "writer" | "synthesis";
  /** 口径同 `AltReport.basedOn`。 */
  basedOn?: string[];
  /**
   * 这一条链路此刻已经解析出来的那些块。**边跑边长**：模型每交完一行 JSONL，这里多一个块。
   *
   * 半份也要报。任务书 §3 要的就是这件事 —— 截断的 JSONL 前缀照旧渲染，后面接骨架占位，
   * 不白屏。所以这里存的是「到此刻为止读得通的那些块」，读不通的最后半行不在里面
   * （它在 `parse.ts` 的 `pending` 里，那一截不进任何一份产物）。
   *
   * 证据表这时候通常还很薄：台账是边跑边接的，收尾才封。所以正文里的 `[E1]` 芯片在跑的
   * 期间可能解析不开 —— 那时它照实显示成未解析的样子，**不能当成悬空引用报错**：这一轮
   * 还没跑完，那条证据可能下一秒就入账了。
   */
  blocks?: ReportBlocks;
}

/** 定题的产物。「定题」按下去，屏幕上那一行 Decision Question 就是它。 */
export interface DecisionQuestion {
  text: string;
  suggestedDri: string;
  deadline: string;
}

/**
 * 预设问答。问题做成对谈区的快捷条；答案有两个用途 —— 模型接不上时原样打出
 * （兜底），接得上时作为标准口径写进系统上下文，让真模型答不出格。
 */
export interface AdvisorPreset {
  opening: string;
  chips: { q: string; reply: string }[];
  /**
   * 点快捷条直接给 `reply`，**不叫模型**。
   *
   * 只有 demo 内容包会打开它。为什么放在数据上而不是一个环境变量：走不走剧本是
   * **这组问答**的性质，不是整个进程的性质 —— 同一次演示里，快捷条走剧本、
   * 他自己打字仍然接真模型，这两件事必须同时成立，否则演示要么像录像，
   * 要么在关键一问上翻车。
   */
  scripted?: boolean;
}

/**
 * 议题研究那一栏对谈的一轮。正文是纯文本；「反问：」开头的段落由视图渲染成挑战块
 * （counter 色）—— Advisor 的 Challenge 必须在屏幕上看得出来，不能混在普通
 * 回复里。这是一个文本约定，不是让模型输出结构。
 */
export interface AdvisorMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  at: string;
  /**
   * 这一答花了多久（毫秒）。只有 `agent` 那一侧有。
   *
   * 屏幕上写在回复的最上面。它不是装饰：参谋答一句要读上下文、要取本体、要过一遍
   * 判断板，慢是**真的在干活**。不写出来，等待就只是卡顿；写出来，等待才是成本。
   */
  elapsedMs?: number;
  /**
   * 他给这一轮的赞或踩。没表过态就没有这一栏 —— **不设默认值**：「没点过」和「点了赞
   * 又收回」在账上是两回事，用 `"none"` 之类的第三档表达的话，第一次读这份数据的人
   * 分不出哪些是他真的看过。
   *
   * 挂在这一条上，不另开一张反馈表：反馈的对象就是这一句话本身，分开存的话两张表
   * 迟早会对不上（一条被删的消息留下一条无主的赞）。
   *
   * **他自己那一侧也有**。语义不同：参谋那一侧是「这一答有没有用」，他自己那一侧是
   * 「这一问值不值得再问一次」—— 两件事都是他对这一栏的评价，都记在这一栏里。
   */
  verdict?: "up" | "down";
  /**
   * 这一轮参谋把事情转给了深研。有它，屏幕上这一轮底下就长出那块能点开报告的东西
   * （`DeepResearchCard`）。
   *
   * ## 为什么记在这一条上，不放在组件 state 里
   *
   * 上一版是组件 state：他离开这一页再回来，那块东西就没了 —— 而深研要跑一到三分钟，
   * 「离开再回来」正是这段时间里他最可能做的事。转手是**这一轮里真的发生过的一件事**，
   * 它和这一轮说的话一样该被记下来。
   *
   * 顺带解决位置：记在这一条上，它就长在这一轮底下，跟着对话一起滚 —— 而不是永远
   * 钉在整栏的最下面，离触发它的那句话越来越远。
   *
   * `issueId` 冗余存一份（这一栏本来就属于某条议题）：转手的落点由那一次转手自己说了算，
   * 从所在的线程反推等于假设两者永远一致，而那个假设没人保证。
   */
  deepHandoff?: { issueId: string; why: string };
}

// ===========================================================================
// IR —— 议题研究右栏的沉淀条目：初步想法 / 候选决策
//
// 对谈是流，右栏是沉淀。报告与讨论中值得留下的东西以 IR 落下来：**初步想法**是
// Agent 实时萃取（或一号位手动记下）的、可能升级的词条；**候选决策**只能由收敛
// 产生 —— 报告的「建议分流」预置一部分，多轮讨论成熟后长出另一部分。
//
// 两条硬规矩：
// 1. 每条 IR 必须有来源锚点（报告的哪一句 / 对谈的哪一轮 / 手动）——点得回去。
// 2. 候选决策生而带「建议去向」。直接确认 = 接受判断 + 接受去向，一步完成固化
//    与分流；没有「确认了但什么都没发生」这种状态（M1-A 原则 05）。
// ===========================================================================

/**
 * 预研。
 *
 * 每条被捕捉进来的潜在议题**一进来就自动出一份**，不等他点。理由是成本分层：信号是
 * 24/7 进来的，给每一条都配一次全量深研既慢又贵；但什么都不查就把标题摆给他，等于让他
 * 拿着一句话去猜要不要投入。预研是中间那一档 —— 便宜、快，只回答一个问题：**这值不值
 * 得您花时间**。
 *
 * 它的结构和深研报告**故意不一样**：没有四节，因为它不该长成第二份报告 —— 长成了，他
 * 就得把同样的东西读两遍。只有「查到了什么」「还答不上来的」「所以呢」三段。
 *
 * 其中「还答不上来的」是这份东西最有用的一段：它同时是**升级深研之后会去查什么**的
 * 清单。他决定要不要升级，看的正是这个 —— 不是看已经查到的，是看还能查到什么。
 */
/**
 * 预研的定性结论 —— 方法域 S02 的 Phase A。**先判这个，再决定写什么。**
 *
 * 一份预研永远是同一个形状，所以这个判断必须是一个显式字段，不能只藏在 `take` 的
 * 措辞里。藏在措辞里的后果是：屏幕上一份「参谋判它不值得继续」和一份「值得升级」
 * 长得一模一样，都是三段话加两条依据，谁也数不出今天有几条被判掉了。
 */
export type PreResearchStatus =
  /** 议题成立、说法也对，正常给结论。 */
  | "valid"
  /**
   * 查完之后它不值得继续投入认知 —— 不是「先观察」，是这一轮判掉。
   *
   * 这一档存在的理由：预研的价值一半在**拦下不值得的**。没有这个档，模型只能
   * 把「不值得」写成一句温和的 soWhat，而那句话读起来跟「值得」没有区别。
   */
  | "invalid"
  /**
   * 议题背后的张力是真的，但**现在这条说法描述不了它** —— 对象错、分类轴错、
   * 因果前提错，或者层级错。
   *
   * 参谋不自己改题（方法域的 Silent Reframing：改了题却说不清改的是哪一处，
   * 事后没人对得出新旧两条差在哪）。它只把「这一处不对」说出来，改不改、怎么改
   * 是一号位那一步的事。
   */
  | "reframing_needed";

/**
 * 一号位在议题里**给定**的公司事实（2026-09-05，预研 v3）。
 *
 * 「我们的第一个客户是维信诺」这一类话是他说的，不是查出来的。预研把它当**前提**：标明来源，
 * 不用本体里没有记录去否定它，也不把它升成已核验事实、不写进本体。`quote` 必须逐字出自
 * 议题标题或递上来的原文 —— 引不到原话的不算前提（`a3/run.ts` 的 `shape` 会丢掉）。
 */
export interface PreResearchPremise {
  /** 前提本身，一句话。 */
  text: string;
  /** 它在一号位输入里的原话（子串）。 */
  quote: string;
}

/**
 * 这一轮预研过没过批判，以及过程里改过什么。屏幕上固定显示，不参与正文篇幅的取舍。
 *
 * - `ok`：批判通过。
 * - `corrected`：批判打回过一次（比如把一号位给定的前提当成无依据），已按打回意见重写。
 * - `needsCorrection`：打回了、没能改成（没预算，或改完仍不过）——结论要打折看。
 * - `criticUnavailable`：批判那一次没跑成（模型不可用 / 返回读不出）。**不等于通过。**
 */
export interface PreResearchQuality {
  state: "ok" | "corrected" | "needsCorrection" | "criticUnavailable";
  /** 能上屏的一两句：打回的是什么、改了什么。 */
  notes: string[];
}

export interface PreResearchDoc {
  issueId: string;
  /**
   * 这一轮的定性结论。
   *
   * `null` = 这份预研跑在有这个字段之前，或者模型没给、重试也没补上（那次运行
   * 会带着 p0 落在运营台上）。**不默认成 `valid`** —— 默认的话「没判过」和
   * 「判过、成立」在屏幕上和统计里都分不开。
   */
  status: PreResearchStatus | null;
  /**
   * 判 `invalid` / `reframing_needed` 的那一句理由。这一句会直接显示在屏幕上，
   * 所以它要说清「哪一处」，不是「综合考虑」。`valid` 时为空串。
   */
  statusReason: string;
  /** 这次预研真正要回答的那一句 */
  question: string;
  /**
   * 一针见血的那一句（≤ 40 字）：值不值得他现在投入、最要紧的一个理由。它是这一页最大的字，
   * `take` 是它下面的展开。老预研没有这个字段。
   */
  verdict?: string;
  /** 一号位给定的前提，见 `PreResearchPremise`。老预研没有。 */
  premises?: PreResearchPremise[];
  /** 批判与裁决的结果，见 `PreResearchQuality`。老预研没有。 */
  quality?: PreResearchQuality;
  /**
   * 参谋读完这份预研之后的那段话 —— 建议 / 判断 / 洞察。
   *
   * 它在屏幕上是对话里的**第一条回复**，不是一块「摘要」面板。差别不在版面：摘要是
   * 材料，回复是有人在跟他说话，而他接下来要做的正是追问 —— 追问一段话是自然的，
   * 追问一块面板不是。
   */
  take: string;
  /** 查到了什么。两三句，每句带溯源 */
  finding: Statement[];
  /** 这一轮还答不上来的 —— 也就是「升级深研会去查什么」 */
  openQuestion: Statement[];
  /** 所以呢。一句话，落在「值不值得升级」上，不是内容总结 */
  soWhat: string;
  byAgentLabel: string;
  assembledFrom: ManifestItem[];
  /** 预研跑完的时刻。屏幕上要写出来 —— 它是自动跑的，他没等过。 */
  at: string;
  /**
   * 这一轮从起到落花了多久。取 `AgentRunRecord.latencyMs`，**不另起一个时钟**。
   *
   * 它和 `at` 是两件事：`at` 答的是「什么时候查的」，这个答的是「查了多久」。第二个
   * 问题是他判断参谋这一档值不值这个钱时唯一的量 —— 而它跑完就再也算不出来了，
   * 所以必须跟着产出一起落盘。
   *
   * `undefined` = 这份预研跑在有这个字段之前。不默认成 0：0 秒是一个假事实。
   */
  durationMs?: number;
  /**
   * v2 七段流水的各段产物。**这个字段在不在，就是「这一份跑的是 v2 还是 v1」的答案**
   * —— 照 `ResearchDoc.blocks` 的先例，不加版本号字段。
   */
  stages?: PreResearchStages;
}

/** 潜在议题详情页要的全部。 */
export interface SignalDetail {
  card: Card;
  issue: Issue;
  pre: PreResearchDoc | null;
  /** 它动摇的那几条判断的原文。分诊时他要拿这条去比对。 */
  judgments: Judgment[];
}

/**
 * 判断陈述的成色。
 *
 * 「不成熟」是这张图的起点，必须是一个能写在屏幕上的状态：参谋读完报告先给方向，
 * 它自己知道那几句还没站住。把没站住的话说成结论，是这个产品最容易犯也最贵的错。
 */
export type ProbeStanding =
  /** 刚从报告里读出来的方向。参谋明说它还不成熟。 */
  | "raw"
  /** 聊过之后开始立得住 */
  | "firming"
  /**
   * **这场研讨的落点** —— 一条对这件议题有战略方向指导意义的判断。
   *
   * 这一档过去叫「已带上会」。改掉是因为那个名字把落点定义成了「进了某个会议的议程」——
   * 一件事的价值变成了它有没有被排上日程。研讨真正的产物是**判断本身**：它立住了，
   * 它意味着什么，它的边界在哪。至于哪天在哪个会上被谁讨论，那是日程的事，不是这个
   * 系统要记的账。
   */
  | "direction"
  /** 已确认、写回本体 */
  | "confirmed"
  /** 放下了。**留在图上** —— 「为什么放下」和「为什么留下」同样是路径的一部分。 */
  | "dropped";

/** 节点的来源锚点。`doc` 指报告某节的第几句 —— 划线句机制的数据面。 */
export type ProbeAnchor =
  | {
      kind: "doc";
      section: "judgment" | "keyEvidence" | "counters" | "unknowns";
      index: number;
    }
  | { kind: "talk"; round: number }
  | { kind: "manual" };

/**
 * 一条已经立住的判断，在系统里的**运行后果**。
 *
 * 原来这里有第五项 `meeting`（送会前准备、会上拍板）。删掉了：会上谈什么是日程的事，
 * 不是这个系统要记的账。剩下的四项都是**系统真的会做的事**（M1-A 原则 05：确认永远
 * 有运行后果）—— 判断真的翻版、靶点真的布控、建议真的落给 DRI。没有「已确认但什么
 * 都没发生」这种状态。
 */
export type ProbeRoute = "ontology" | "strategy" | "mission" | "evidence";

/**
 * 探讨链路上的一个节点 —— 一句判断陈述。
 *
 * 它同时是**研究阶段唯一的产出物**：成熟到可以拍板的那几句，带着去向、要翻的判断、
 * 接受的风险和边界走进会前准备。所以这个对象既要读得懂（`text` / `flag` / `knowledge`），
 * 又要装得进闭环单（`route` / `revisesJudgmentId` / `arms` / `boundaryNote`）。
 */
export interface ProbeNode {
  id: string;
  issueId: string;
  /**
   * 判断陈述本身。一句话，有方向性 —— 不是标题，是它敢说的那句话。
   *
   * ## 写法：向人汇报，不是向模型自己汇报
   *
   * 人和模型把一个大问题聊深之后，模型的话会开始不说人话：缩写、简写、省略主语、自造
   * 词、把上一轮的结论压成一个代号接着用。它对模型自己是省事的（上下文里都有），对读
   * 的人是灾难 —— 一条链路聊到第八轮，前面七条他已经读不懂了，而他恰恰要在这个时候
   * 回头检查这个结论是怎么长出来的。
   *
   * 所以每一条 point 落到图上时都**重写成向人汇报的一句话**：主语补齐、代号还原成它
   * 指的东西、上一轮的结论不许用简称回指。判据很土但很硬：**这一句单独摘出来发给一个
   * 没读过前七轮的人，他能不能读懂**。读不懂就不许落到图上。
   */
  text: string;
  /**
   * 这一条为什么紧扣这件议题。
   *
   * 图上每一支延伸都必须扣着议题走，否则一场深聊会自己长成一棵跑题的树 —— 而跑题在
   * 屏幕上是看不见的：每一步单看都合理，只有拿它跟议题原题比一比才发现已经飘出去了。
   * 把这句话变成节点的必填内容，是让「扣题」成为一件写得出来、因而也检查得出来的事。
   *
   * 它折在细节里、不在图面上：读图的时候他要的是判断本身，扣不扣题是他起疑时才去核的。
   */
  whyOnTopic?: string;
  /**
   * 忽略它会怎样。
   *
   * 一条判断的份量不写在它自己身上，写在**不理它的后果**上。没有这句，图上九条看起来
   * 一样重，他只能凭措辞的强弱猜哪条要紧 —— 而措辞强弱是参谋的文风，不是事实。
   */
  ifIgnored?: string;
  /** 谁提出的。图上必须分得开：参谋说的和他自己说的，不是一回事。 */
  by: "agent" | "ceo";
  at: string;
  standing: ProbeStanding;
  anchor: ProbeAnchor;
  /**
   * 这句话碰到了哪些知识。内部文件、外部事实、在版判断、参谋自己的推断 —— 用的是
   * 全站同一套溯源徽章，所以「内部/外部」在图上不是一个色块，是一个点得开的对象。
   */
  knowledge: Trace[];
  /**
   * 参谋在对话里发现的、值得他抬头看一眼的事。
   *
   * 挂在节点上而不是单独成条：一句提醒脱离了它所依附的判断，读者得自己找它在说谁。
   */
  flag?: string;
  detail?: string;
  /** 成熟到可以走的那几条才有去向。还在 raw 的没有 —— 没有去向本身就是一种状态。 */
  route?: ProbeRoute;
  routeNote?: string;
  /** route=ontology：确认后翻版哪条判断、新陈述是什么、布控哪些重开条件。 */
  revisesJudgmentId?: string;
  nextStatement?: string;
  revisionNote?: string;
  arms?: string[];
  /** route=evidence：布控在哪条判断上。 */
  targetJudgmentId?: string;
  /**
   * 「这不意味着什么」。
   *
   * 会后闭环单里，认知类结论必须带边界 —— 一条共识写回本体之后全公司 Agent 都会引用它，
   * **防止共识被过度解读，和防止决定被记错同样重要**。这句话在议题研究阶段就该写下来，
   * 因为写得出边界的人是当时想清楚的那个人，不是散会后整理纪要的那个人。
   */
  boundaryNote?: string;
  /** 确认后的回执。 */
  confirmedAt?: string;
  decisionId?: string;
  writeBack?: WriteBackTarget[];
  /**
   * 第几轮 agent 回复之后出现（0 = 随报告一起）。demo 的分幕机制：真实后端由
   * 萃取 Worker 实时产生，这个字段消失。
   */
  revealAfterRound: number;

  // ---- 判断演进链 ------------------------------------------------------
  //
  // 屏幕左栏不是聊天记录的副本，是**这条判断怎么被质疑、调查、收敛**的压缩。
  // 所以链上只有两种东西：一号位的关键追问，和参谋因此改口的新版本。
  // 普通讨论一条都不进 —— 进了，链就会无限膨胀成第二份聊天记录。

  /**
   * 主链上的版本号。0 = J₀（参谋通读报告后的第一个方向判断），此后每次**实质
   * 改口**加一。
   *
   * 只有主链的参谋节点有。一号位的追问节点没有版本号 —— 它不是一个判断，
   * 是导致判断变化的那一下。
   */
  version?: number;
  /**
   * 这一版相比上一版**改了什么**。
   *
   * 只写差量，不重述判断：「独立业务 → 主业能力升级」。这是这张图能被快速读完的
   * 关键 —— 一号位回头检查时问的是「哪一步变的」，不是「每一版说了什么」。
   */
  changeFrom?: string;
  changeTo?: string;
  /** 这次变化的性质，四到六个字：「范围收窄」「前提变了」「结论反转」。 */
  changeLabel?: string;
  /**
   * 在主链上，还是挂在旁边。
   *
   * `main` —— 判断本身的演进，一条线读到底。
   * `aside` —— 一号位读报告时自己划下来的、或者聊出来的另一个方向。它扣着这件议题，
   *   但不是当前这条判断的下一版。**保留它是有理由的**：图不是参谋的输出，是这场
   *   研讨的记录，他往里放东西和参谋往里放东西一样正当。但它的视觉权重必须低于
   *   主链，否则一条旁支就能把「这条判断走到哪了」这个主线索淹掉。
   */
  lane?: "main" | "aside";
  /** 旁支挂在主链的哪一版下面。lane=aside 时有意义。 */
  asideOf?: string;
}

// ===========================================================================
// 判断板 —— 议题研究左栏与首页右栏共用的那张板
// ===========================================================================

/**
 * 一条初步判断是**怎么来的**。三种，缺一不可：
 *
 *   research   参谋通读原始深研报告之后提炼的
 *   dialogue   后续对谈与参谋自己补的调研里长出来的
 *   meeting    某场会议上记下来、会后沉淀进来的
 *
 * 为什么必须分开：三种来源的**可信度和可反驳性完全不同**。研报提炼的可以回原文核；
 * 对谈长出来的背后是一号位自己的追问；会上沉淀的则牵着别人的话。混成一类之后，
 * 他想反驳一条判断时，第一步「这是谁说的」就答不出来。
 *
 * 一个议题会开不止一次会，所以 meeting 这一类会反复出现 —— 每条要能指回是哪一场。
 */
export type JudgementOrigin = "research" | "dialogue" | "meeting";

/**
 * 判断是**怎么被确认**的。三条路，都要求一号位真的表过态：
 *
 *   manual     他在判断板上直接按下的
 *   dialogue   在与参谋的对谈里确认（也包括他在外面拍完板、回来跟参谋报备的）
 *   meeting    在会上确认
 *
 * 没有「系统自动确认」这一档，而且永远不会有。判断从初步升到确认，是这个产品里
 * 唯一一处**权力转移** —— 从参谋的猜测变成公司的口径。这一步只能由人按下。
 *
 * `manual` 是板上那颗按钮记的。以前那颗按钮逼他先选「这是在对谈里认的还是会上认的」，
 * 而他手上正按着的这一下既不是对谈也不是会 —— 那个选择于是只能靠猜，猜出来的途径
 * 半年后比不记还糟。真在对谈里认的由萃取记 `dialogue`，会上的由会议那条路记 `meeting`。
 */
export type ConfirmChannel = "manual" | "dialogue" | "meeting";

/**
 * 判断板上的一条。
 *
 * 板分上下两层，层由 `confirmed` 在不在决定，不由字段值决定 —— 一条判断要么被人
 * 确认过（有时间、有途径、有理由），要么没有，中间没有「基本确认」这种状态。
 * 留了中间态的地方，最后都会堆满中间态。
 */
export interface BoardJudgement {
  id: string;
  issueId: string;
  /**
   * 判断全文。单独摘出来发给一个没读过这个议题的人，他要能读懂 —— 这条板上的
   * 每一句将来都可能被单独引用（写进材料、发给 DRI、进本体），带着上下文才成立的
   * 句子一旦离开这块屏幕就废了。
   */
  statement: string;
  /**
   * 六到十四个字的短标签（「企业采用逻辑」「我们的战略边界」）。板上一屏五条判断，
   * 每条都是一段密实的话；没有标签他只能一条条读完才知道哪条管哪一块。
   *
   * **可选，因为不是每条都有。** 对谈和会上沉淀的判断是一句话记下来的，当场逼着
   * 起一个标签只会得到「关于安全的判断」这种复述。参谋生成的那批（A5）必须有。
   */
  label?: string;
  origin: JudgementOrigin;
  /** meeting 来源的指回哪一场会。 */
  meetingLabel?: string;
  at: string;
  /**
   * 它引了哪些东西 —— 深研报告的某一节、本体里的某个对象、某份内部文档。
   *
   * 屏幕上是**极低存在感的 inline 小注**，不是徽章墙。判断本身才是要读的东西；
   * 引用是他起疑时才会去看的一层。做成显眼的徽章之后，一屏十几条判断就变成了
   * 一屏几十枚徽章，而判断本身反而读不出来。
   */
  notes: Trace[];
  /**
   * 凭什么这么判 —— 指回报告里的事实、数字、编号。
   *
   * 它是**确认这条判断的前提**：一号位要表态，先要看得见依据；而半年后重新打开
   * 一条在版判断时，要检查的恰恰是这一段还成不成立。所以它和 `confirmed.support`
   * 不是一回事 —— 那一句是「他为什么点头」，这一段是「参谋凭什么这么写」。
   */
  basis?: string;
  /**
   * 当前边界 —— 这条判断**不主张**什么。
   *
   * 一条没有边界的判断会被当成比它实际更强的东西用：「可放心授权是扩张条件」
   * 三个月后就会被引成「公司要做安全」。Package 04b 里这一段的原话是「这是
   * Research Result 基础上的阶段性 Judgment，不是 Agreement」。
   */
  boundary?: string;
  /**
   * 出现什么新证据，这条判断就该被重新打开。
   *
   * 和 `Judgment.reopenTriggers` 是同一个东西，只是这里还没结构化（那边是可以
   * 被「触发」的 `{armed, hitAt}`）—— 板上这一层是候选，还没有人守着它。
   * 写「情况有变化时」等于没写，质量门会挡。
   */
  reopenIf?: string;
  /** 这一版相比上一版改了什么。没演进过的就没有。 */
  changeFrom?: string;
  changeTo?: string;
  changeLabel?: string;
  /** 有值 = 它在下半层。 */
  confirmed?: {
    at: string;
    channel: ConfirmChannel;
    /**
     * 为什么它能被确认 —— 一句总结。
     *
     * 这一条是下半层存在的理由。只记「2026-07-15 会上确认」，半年后回头看只知道
     * **确认过**，不知道**凭什么**；而真正需要重新打开一条判断时，要检查的恰恰是
     * 当时那个「凭什么」还成不成立。
     */
    support: string;
  };
}

/**
 * 参谋读完深研报告之后交上来的一条判断候选（A5 的产出）。
 *
 * 它比 `BoardJudgement` 少的东西正是**这一步不该有的东西**：没有 id（编号由板给）、
 * 没有 `origin`（来源由推它上板的那条路决定）、没有 `confirmed`（确认只能由人按下，
 * 见 `ConfirmChannel`）。让模型自己填这三样里的任何一样，都等于让它替人表态。
 *
 * 五个字段一个都不能空，理由写在 `BoardJudgement` 对应字段上；质量门（`a5/validate.ts`）
 * 挡的就是这一点。
 */
export interface DraftJudgement {
  label: string;
  statement: string;
  basis: string;
  boundary: string;
  reopenIf: string;
  traces: Trace[];
}

/** 一个议题的判断板：上半层未确认，下半层已确认。 */
export interface JudgementBoard {
  issueId: string;
  /** 上半层 —— 参谋给的，还没经过他。 */
  draft: BoardJudgement[];
  /** 下半层 —— 他确认过的，已经是公司口径。 */
  confirmed: BoardJudgement[];
  /**
   * 参谋这一轮「把深研报告读成判断」跑到哪了。
   *
   * `running` = 在跑，或者报告在库里而那一轮还没起（读一次板会顺手起一轮）；
   * `failed` = 跑过没成，**不会自动重开**（重试要烧钱，且会把失败藏起来）；
   * `read-nothing` = 读完了，一条判断都没落住 —— 模型一条都没交，或者交的几条板上
   *   已经有了。这也是一次成功的读报告，而且**不会再有下一轮**（同一份报告只读一遍）；
   * `null` = 没有报告可读，或者判断已经在板上了。
   *
   * 这一栏存在的理由：空板有四种完全不同的原因 —— 报告还没到、正在读、读挂了、
   * 读完了没读出东西。屏幕上分不出来的话，一号位盯着一块空板，而它答不出自己什么
   * 时候会不空；最后那一种尤其要单独说，它是唯一一种「这块板不会再自己变了」。
   */
  pending: "running" | "failed" | "read-nothing" | null;
  /**
   * 上一轮深研没跑完、但**留下来能读的报告原件有几份**（见 `UnfinishedResearchRound`）。
   *
   * 空板那一档要靠它说人话：一轮深研可能在压四节那一步才挂，也可能是服务重启把它掐断的 ——
   * 那时几条链路的报告都在手上，板上却一条判断都没有。写「没有报告可读」就是假的，而这块板
   * 自己看不见报告那一栏
   * （它在另一个组件里，首页那一档根本没有报告栏），所以这个数跟着板一起给。
   *
   * `0`（或者没有）= 这一轮什么都没留下，那句「没有报告可读」是真的。
   */
  reportsKept?: number;
}

/**
 * J₀ —— 参谋通读报告之后给出的第一个方向判断，整条链的起点。
 *
 * ## 它为什么是从深研报告**算**出来的，不是再叫一次模型
 *
 * J₀ 的内容全部已经在 ResearchDoc 里：总判断就是 `judgment[0]`，三条原因就是
 * `keyEvidence`，「仍犹豫」就是最要紧的那条 `unknowns`。再叫一次模型只会得到一份
 * 换了措辞的同源结论 —— 而两份措辞不同的同源结论摆在一号位面前，他会以为那是两个
 * 独立判断。**那是在主动制造假的交叉验证。**
 *
 * 所以这里是投影，不是生成。代价是 J₀ 的措辞受 A4 的措辞约束；收益是它和报告永远
 * 一致，点「原文」跳过去能对得上。
 */
export interface InitialJudgment {
  issueId: string;
  /** 报告标题。点「原文」进的就是它。 */
  reportTitle: string;
  /** 报告规模，头部那一行：「12 份材料 · 2.1 万字 · 已通读」。 */
  reportScale: string;
  /** J₀ 全文。 */
  statement: string;
  /** 编号的原因。屏幕上是 01 / 02 / 03。 */
  reasons: Statement[];
  /**
   * 仍犹豫。
   *
   * **这一条不能空。** 一个读完报告就没有任何犹豫的参谋，不是想清楚了，是没在想。
   * 屏幕上它和三条原因并列，因为它和它们一样是这个判断的组成部分 —— 判断的强度
   * 由它最弱的地方定义。
   */
  hesitation: Statement | null;
  at: string;
}

/**
 * 一条箭头。
 *
 * **`because` 是整张图的全部价值。** 一条只连着两个点、什么也不说的箭头，等于把清单
 * 竖起来摆了一遍；写清「他追问了什么 / 参谋翻出了什么，所以才有了下一句」，这张图才
 * 变成他能核对的推理链 —— 他不是在批准结论，他是在检查这个结论是怎么长出来的。
 *
 * 所以这里不许出现「然后」「进一步」「基于此」。写不出具体是哪一句话推动了它，
 * 说明这条边本来就不该存在。
 */
export interface ProbeEdge {
  id: string;
  issueId: string;
  from: string;
  to: string;
  /** 是什么样的思考导致了 `to` 的出现。一句话，具体到那句话本身。 */
  because: string;
  /** 谁推动的这一步 */
  by: "agent" | "ceo";
  revealAfterRound: number;
}

/** 一次取图。节点与边一起给 —— 分两次取会出现「边指向一个还没到的点」。 */
export interface ProbeMap {
  /** 起点：那份深研报告。整张图从它长出来。 */
  rootLabel: string;
  /** J₀。报告还没好时为 null —— 那时链还没有起点，屏幕照实说。 */
  initial: InitialJudgment | null;
  nodes: ProbeNode[];
  edges: ProbeEdge[];
}

/**
 * 议题研究直接确认的决策回执 —— 会后确认里「一小一大」中的那张小卡。
 * 它与 Closure 走的是同一个终点（写回本体），只是没经过会议。
 */
export interface QuickDecision {
  decisionId: string;
  issueId: string;
  issueTitle: string;
  nodeId: string;
  nodeText: string;
  route: ProbeRoute;
  at: string;
  updatedObjects: WriteBackTarget[];
}

// ===========================================================================
// 决断包与命令 —— 一号位明确进入行动整理之后，那一屏和它按出去的账
// ===========================================================================

/**
 * 决断包的形状**在出稿那一侧**（`blocks/schema.ts`）—— 那里是模型交出来的东西被读进来的
 * 唯一入口，这里只是把它存下来。抄一份形状过来的话，两份漂开时编译器一个字都不会说
 * （结构相同的类型互相赋值合法），第一个发现的人是屏幕。
 */
import type { CommandBrief } from "@/lib/agent/a4/blocks/schema";
export type { CommandBrief };

/**
 * 一条下达出去的命令。批准决断包时由 `CommandBrief.proposedOrders` 逐条落成。
 *
 * **它是账，不是通知。** 落一条 `DecisionOrder` 只是把「这条命令发过了」记下来；真的
 * 去找那个人是另一件事，现在还不做（见 `api.approveCommandBrief` 的头注释）。
 */
export interface DecisionOrder {
  /** `DO-<决策编号>-<序号>`。序号跟着决断包里 `proposedOrders` 的顺序走。 */
  id: string;
  issueId: string;
  /**
   * 出自哪一份决断包 —— 存那份深研报告的装配时刻（`ResearchDoc.at`）。
   *
   * 存时刻而不是存报告 id：深研报告没有独立编号（`store.researchDocs` 按议题号存一份），
   * 而同一件议题可以重跑深研并覆盖掉那一份。半年后要答的问题是「这条命令是照哪一版
   * 决断包发的」—— 装配时刻答得出，`issueId` 答不出。
   */
  briefAt: string;
  /** 角色/领域。模型只写到这一层（理由见 `CommandBrief.proposedOrders`）。 */
  role: string;
  /**
   * 谁来担。批准时由一号位或秘书指定；没指定就空着。
   *
   * 空着的意思是**还没派人**，不是「派了但没记」—— 所以它可缺省而不是填一个占位串：
   * 填 `"待定"` 之类的东西，命令板上就再也分不出「他还没派」和「他派给了一个叫待定的人」。
   */
  driId?: string;
  outcome: string;
  /**
   * 期限，**一个真日期或者空串**（`YYYY-MM-DD`）。
   *
   * 空串 = 没有约定日期。以前这一栏是「模型写了什么就存什么」，于是「首访前」「两周内」
   * 这类相对时间被原样落进来 —— 而这一栏是会被日期解析器消费的（到期提醒、按期限排序、
   * 屏幕上那一列等宽数字）。一句读不成日期的话落在这里，下游要么解析失败，要么把它当成
   * 一个假的确定日期，两种都比空着坏。
   *
   * 相对时间去 `dueNote`。落库时分栏在 `splitDue`。
   */
  dueOn: string;
  /**
   * 说不成日期的那种期限：「首访前」「客户排期定下来之后两周内」。
   *
   * 它是**独立的相对时间说明**，不是 `dueOn` 的备份 —— 有它的时候 `dueOn` 就是空的，
   * 屏幕上照原话显示，不换算成任何一个具体日子。建议日期要标明是建议及其假设，
   * 不伪装成已约定。
   */
  dueNote?: string;
  acceptance: string[];
  /**
   * 下达时刻。**空串 = 还没发出去**（`decisionOrderState` 的 `draft` 一档）。
   *
   * 现在 `approveCommandBrief` 落库时就填上，所以库里暂时不会有空的；留这一档是因为
   * 「拟好了先不发」是命令这个东西天然有的一个状态，而状态一旦要靠字段有没有来分，
   * 后来补上的人只能改类型。
   */
  issuedAt: string;
  acknowledgedAt?: string;
  closedAt?: string;
  closeNote?: string;
}

/** 命令的四档。**推出来的，库里不存**（理由见 `decisionOrderState`）。 */
export type DecisionOrderState = "draft" | "issued" | "acknowledged" | "closed";

/**
 * 一条命令现在处在哪一档 —— **从三个时间戳推，不另维护一个 `status` 字段**。
 *
 * 为什么不存：状态和时间戳会成为两处真相，而两处真相一定会漂。真实的漂法就是回执那一下
 * 把 `acknowledgedAt` 写了、`status` 忘了改（或者反过来）：命令板上显示「已发」、详情页
 * 显示「已回执」，两边都是从库里读的，谁都不算 bug，也没有任何一处报错。更糟的是落盘 ——
 * 旧快照里那份写歪了的 `status` 会被当成事实读回来，而它已经没有对照物了。
 *
 * 三个时间戳本身是不可推翻的事实（关了就是关了，回执了就是回执了），从它们推出来的档
 * 只有一份真相。倒序判：关闭最重，其次回执，再次已发。
 *
 * **这个纯函数故意放在 `types.ts` 而不是 `store.ts`** —— 它是这个文件里唯一的运行时导出，
 * 破了「这个文件只有声明」那条惯例，但另一头更糟：`store.ts` 是服务端独占的（它 import
 * 落盘、种子、agent 那一摞），而这一档是命令板要显示的东西，视图那一侧也得推。放这里
 * 两侧都够得着，而且这个文件只 import 类型，带进客户端包里的就是这几行。
 */
export function decisionOrderState(order: {
  issuedAt: string;
  acknowledgedAt?: string;
  closedAt?: string;
}): DecisionOrderState {
  if (order.closedAt) return "closed";
  if (order.acknowledgedAt) return "acknowledged";
  if (order.issuedAt) return "issued";
  return "draft";
}

/** 一个真日期长这样：`2026-09-15`。 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 这串字是不是一个真日期。
 *
 * 屏幕上那一列期限用等宽数字竖着对齐（三条命令哪条先到，靠对齐看出来），而
 * 「首访前」对齐了也没有意义 —— 只有真日期进那一档。老数据里 `dueOn` 可能存着一句
 * 相对时间（分栏是这一版才有的），所以显示那一侧也要判一次，不能假设库里都干净。
 */
export const isDay = (v: string | undefined): boolean => DAY.test((v ?? "").trim());

/**
 * 拟制命令上那个期限该落进哪一栏。
 *
 * 模型写的可能是 `2026-09-15`，也可能是「首访前」，也可能什么都没写。三种要分开落：
 * 只有第一种进 `dueOn`（会被日期解析器消费的那一栏），第二种进 `dueNote` 原话照留，
 * 第三种两栏都空 —— 屏幕上是「时间待定」。
 *
 * **不替他把相对时间换算成日期。** 「首访前」换成哪一天取决于首访约在哪一天，而这个库
 * 不知道；换算出来的那个日子会以口径完全一样的样子摆在真日期旁边（HANDOVER §3.D）。
 */
export function splitDue(raw: string | undefined): { dueOn: string; dueNote?: string } {
  const text = (raw ?? "").trim();
  if (!text) return { dueOn: "" };
  if (DAY.test(text)) return { dueOn: text };
  return { dueOn: "", dueNote: text };
}

/** 屏幕上那一格期限写什么。没日期也没说明就是「时间待定」——不留空格。 */
export function dueLabel(order: { dueOn?: string; dueNote?: string }): string {
  return (order.dueOn ?? "").trim() || (order.dueNote ?? "").trim() || "时间待定";
}

/**
 * 一号位在批准那一屏上改过的地方。整个不带 = 原样批准并下达。
 *
 * 只收「改过的那几处」而不是收一份完整的决断包：收整份的话，屏幕上任何一次渲染口径的
 * 变化（把表格拉成句子、把空数组填成占位串）都会顺着这条路写回库里，而那些改动没有人
 * 按过确认。
 */
export interface CommandBriefEdits {
  /** 只覆盖列出来的那几栏，没列的保持参谋原文。 */
  recommendation?: Partial<CommandBrief["recommendation"]>;
  /** 整栏替换 —— 「请决断」是一张清单，他删掉一条和改一条一样常见。 */
  decisionsRequired?: CommandBrief["decisionsRequired"];
  /**
   * 逐条改命令，`index` 对齐 `CommandBrief.proposedOrders` 的下标。
   *
   * 用下标而不是给拟制命令编 id：那份命令是模型这一轮刚交出来的，还没落过库，除了
   * 在数组里排第几之外它没有任何身份。真发出去之后它才有 `DecisionOrder.id`。
   */
  orders?: {
    index: number;
    role?: string;
    driId?: string;
    outcome?: string;
    dueOn?: string;
    acceptance?: string[];
  }[];
}

/** 批准（或暂缓）一份决断包之后的回执。 */
export interface CommandBriefApproval {
  /**
   * 这次发的决策编号。**暂缓时是 `null`** —— 暂缓不是一个决定，不占编号。
   *
   * （编号的去重口径见 `store.ts` 的 `nextDecisionId`：它从账上算「哪些发过了」，
   * 而批准这一路把编号落在 `quickDecisions` 上，正是那三条来源之一。）
   */
  decisionId: string | null;
  issueId: string;
  at: string;
  /** true = 暂缓：只记了一条决策记忆，一条命令都没发。 */
  held: boolean;
  /** 这次真发出去的命令。暂缓时是空数组。 */
  orders: DecisionOrder[];
  /** 这次落的那条决策记忆的 id。 */
  memoryId: string;
  /** 议题落到了哪一档。暂缓时是它原来那一档 —— 暂缓不推状态。 */
  newState: IssueState;
  updatedObjects: WriteBackTarget[];
}

// ===========================================================================
// 会前准备 —— 压缩，不是汇总
// ===========================================================================

export interface Divergence {
  kind: "fact" | "hypothesis" | "value";
  text: string;
  /** "事实不足 · 可查证" / "判断分歧 · 可验证" / "价值取舍 · 只能您拍板" */
  note: string;
}

export interface Brief {
  issueId: string;
  /** 压缩后的那一句总判断。整份预审最上面的一行字。 */
  coreJudgment: string;
  problem: string;
  driRecommendation: Statement;
  keyEvidence: Statement[];
  /** 最强反证，独立区块，视觉权重不低于 DRI 推荐 */
  strongestCounter: Statement;
  divergences: Divergence[];
  suggestedQuestions: { q: string; implication: string }[];
  /** 哪个 DRI 的 Agent 装配的这份 Brief */
  byAgentId: string;
  /** 交接包默认脱敏：呈现「CEO 关注的问题」而非「CEO 的倾向」 */
  stanceRedacted: boolean;
  /**
   * `byAgentId` 解析出来的 Agent 与它背后的人，由数据层填。
   *
   * 这两个字段决定了整份 Brief 该怎么读：下面那条推荐是**别人**的判断，不是
   * 系统的判断，也不是一号位自己想法的回声。署名放在最上面。
   */
  byAgent?: Agent;
  byPerson?: Person;
  /**
   * 这份 Brief 背后的议题正动摇的判断，由数据层填活对象。
   *
   * 进会议室之前，这场会赌的是哪句话必须已经摆在桌上；写回之后再打开同一份
   * Brief，版本号必须已经是新的。
   */
  judgments?: Judgment[];
}

// ===========================================================================
// 会后确认与写回
// ===========================================================================

/** 七要素，顺序固定 */
export interface Closure {
  choose: string;
  notChoose: string;
  why: string;
  keyHypothesis: string;
  riskAccepted: string;
  commitment: string;
  reopenTrigger: string;
}

export type ClosureField = keyof Closure;

/**
 * 四选一分流。没有「再研究研究」按钮 —— 那是决策疲劳的藏身处，M1-A 明文反对。
 *
 *   strategy — A 更新正式 Strategy，进 M1-B 持续管理
 *   mission  — B 形成独立 Task / Mission，进 M2 执行
 *   evidence — C 转为 Evidence Action，证据返回后重开
 *   close    — D 关闭并记录重开条件
 */
export type DecisionRoute = "strategy" | "mission" | "evidence" | "close";

/** 写回的一个落点。带 href 的点得开 —— 写回如果只是一行文字，就什么都没发生。 */
export interface WriteBackTarget {
  kind: "judgment" | "decision" | "evidence" | "trigger" | "issue";
  label: string;
  href?: string;
}

/**
 * 影响建议。M1-A 止于战略影响建议，持续推进交给 M1-B/M2 —— 所以这里只提示，
 * 不代表 TKOS 去改 Mission。
 */
export interface ImpactHint {
  targetLabel: string;
  text: string;
  suggestTo: string;
}

/** 确认后展示"写回了什么" */
export interface WriteBackResult {
  decisionId: string;
  /** 走的哪条分流 —— 回执上必须写，四条路的后果不一样 */
  route: DecisionRoute;
  updatedObjects: WriteBackTarget[];
  triggersArmed: number;
  evidenceActions: number;
  newState: IssueState;
  impactHints: ImpactHint[];
  /** 从提出到定下来多久。这句话只在这里出现一次，不做成每张卡上的徽章。 */
  elapsedLabel: string;
  /** 这类问题过去的中位耗时。null = 同类里一件都还没定过，回执上整半句不说。 */
  pastMedianLabel: string | null;
}

/**
 * Closure 草案的信封：会后几分钟、写回结果、要翻版的判断。七要素本身保持一个
 * 干净的对象（`fields`），写回调用只收它。
 */
export interface ClosureDraft {
  issueId: string;
  /** 哪一场会散了之后起的这份草案。空字符串 = 这件事没上会，读完研究就定。 */
  sourceMeetingId: string;
  /**
   * 散会到现在多少分钟。**算出来的，不是写死的**。
   *
   * `null` 是它的常态之一：没上会、或者那场会还没散，就没有「会后几分钟」这个量。
   * 写 0 顶上去会被读成「刚散会」—— 而这一栏唯一的用处正是「会后半小时内确认掉」
   * 这条规矩，读错方向比没有更糟。
   */
  minutesSinceMeeting: number | null;
  fields: Closure;
  /** null until the CEO confirms. */
  writeBack: WriteBackResult | null;
  /**
   * 确认后要把哪条判断翻到下一版，新陈述是什么。没有这一项，Closure 就只是一段
   * 写得漂亮的会议记录 —— 判断不动，产品的核心命题就没有实现。
   */
  revises: {
    judgmentId: string;
    nextStatement: string;
    note: string;
    /** 确认后在这条判断上布控的重开条件。回执里「Trigger ×2」的来源。 */
    arms: string[];
  }[];
  /** 这类问题过去的中位耗时，用于确认回执里那一句对比。null = 没有同类可比。 */
  pastMedianLabel: string | null;
}

/** 会后确认那一页的一行：议题 + 它的 Closure 草案（含写回状态）。 */
export interface DecisionEntry {
  issue: IssueSummary;
  draft: ClosureDraft;
}

/**
 * 待定事项头部那行「监测靶点」的一条：已布控的 Re-open Trigger 摊回 Sensor。
 * 写回一确认，这里就多一条 —— 会后确认回到待定事项的那条回环在屏幕上的样子。
 */
export interface SensorTarget {
  /** ReopenTrigger 的 id */
  id: string;
  text: string;
  judgmentId: string;
  href: string;
}

/** 一个观察域及它下面的 KIQ（关键情报问题）。文字是靶点策略里的原话。 */
export interface MonitorDomain {
  /** `D1`…`D6` */
  code: string;
  title: string;
  /** 这个域下的 KIQ 原文，每条一行。 */
  kiqs: string[];
}

/**
 * 一号位当面给的那句交代。
 *
 * **它不是靶点策略的一部分**，是「下一轮多盯着点什么」——`inputs[0].q`，抓取那一侧
 * 唯一为「这一轮」而不是「一直以来」准备的位置。抓取策略里写着：主题留空就按常备
 * 观察域全域扫，主题非空就优先与它相关的域。所以这句话真的会改变下一轮的取向，
 * 而且**只改取向** —— 时窗、过线阈值、每轮上限都在实验台，这句话动不了它们。
 *
 * 存在这一侧不违反「抓取参数只有实验台一份」：那条规矩管的是**配置**，而这是他本人
 * 此刻的**输入**，实验台里没有任何字段存着它。
 */
export interface MonitorFocus {
  /** 他的原话。屏幕上照登 —— 系统不替他改写，也不「理解成」关键词。 */
  text: string;
  /** 什么时候说的。 */
  at: string;
}

/**
 * 监控策略 —— **「你凭什么替我筛」这个问题的完整答案。**
 *
 * 它由三部分拼成，而这几部分的真源不在同一个地方：
 *
 * - **靶点策略**（观察域、KIQ、战略假设、时窗与阈值）在**实验台**。屏幕上这一份是
 *   现读的，不是这边存的一份副本 —— 抓取参数的唯一真源在实验台（`scan/run.ts` 顶上
 *   那条规矩），这边留副本就等于两份策略，而「线上按哪一份扫」立刻答不出来。
 * - **布控的触发条件**（`triggers`）在这一侧：每一条都是某次会后确认真的布控下去的
 *   Re-open Trigger。
 * - **一号位给的交代**（`focus`）也在这一侧，见 `MonitorFocus`。
 *
 * 实验台读不到时 `unavailable` 有值，`domains` / `hypotheses` / `limits` / `body`
 * 是空的，而 `triggers` 与 `focus` 照旧 —— 那两样和实验台没有关系。屏幕上照实说
 * 少了哪一半。
 */
export interface MonitorStrategy {
  /** 这一份从哪来，屏幕上照实写（「实验台 r-xxxx」或「实验台的默认策略」）。 */
  origin: string;
  /** 当前战略假设 —— 研判的靶心，动摇任一条就是高价值信号。 */
  hypotheses: string[];
  domains: MonitorDomain[];
  /** 能算的口径（时窗、过线阈值、每轮上限、搜索源），每条一句人话。 */
  limits: string[];
  /** 策略正文原文。详情页照登，一个字不改写。 */
  body: string;
  triggers: SensorTarget[];
  /** 他给的交代。没给就没有这一项 —— 那时候是按常备观察域全域扫。 */
  focus?: MonitorFocus;
  /** 什么时候从实验台读到的。缓存着的那一份也照这个时间说话。 */
  readAt?: string;
  /** 读不到实验台那一半的原因。一句人话，不带任何凭据。 */
  unavailable?: string;
}

// ===========================================================================
// 组合视图 —— 页面直接要的形状
// ===========================================================================

/** 判断详情页。一条判断的全部：现在是什么、怎么来的、什么在晃它。 */
export interface JudgmentDetail {
  judgment: Judgment;
  /** 它挂的那个域。**没有值 = 这条判断不属于任何域**（见 `Judgment.domainId`）。 */
  domain?: Domain;
  /**
   * 这个域的负责人。**没有值是一个合法状态** —— 有的域现在一个负责人都没有
   * （见 `Domain.driIds`），而那件事屏幕上要照实说，不是拿一个占位的岗位实体顶上。
   *
   * 名单不止一个人时，这里是**排第一个的那位**：这一栏和它旁边的 `driAgent` 是一对
   * （「某某 · 某某的 Agent」），而 Agent 是跟人走的，凑不出一个「两个人的 Agent」。
   * 整份名单在 `domain.driIds` 上，要念全的地方读那一份。
   */
  dri?: Person;
  driAgent?: Agent;
  /**
   * 保鲜期还剩几天，负数表示已经过期。由数据层按服务端的「今天」算 —— 前端拿
   * `new Date()` 去比，服务端与浏览器两次渲染就会得出不同的结论。
   */
  freshDaysLeft: number;
  /** 正在动摇它的议题 */
  shakingIssues: IssueSummary[];
  /** 曾经依据它做出的决定 */
  decidedIssues: IssueSummary[];
  /** 挂在同一个域下的 Mission，只读 */
  missions: MissionCard[];
}

// ===========================================================================
// 文档库
//
// 镜像自飞书/云盘的企业共享文档。一条判断的依据指向一份文档，那份文档必须在
// 这个产品里点得开，否则「有出处」只是一句话。
// ===========================================================================

export type DocSource = "feishu" | "drive" | "clark";

export interface Doc {
  id: string;
  title: string;
  /** 文档库里的分组 */
  folder: string;
  source: DocSource;
  /** 镜像自哪里，一行；写明它不是在这里写的 */
  mirrorOf: string;
  updatedAt: string;
  /** 正文。段落用空行分隔，`## ` 开头是小标题。 */
  body: string;
  /** 哪些判断的依据引用过它（判断 id） */
  citedBy: string[];
  /** 谁维护它 */
  ownerId?: string;
  /** `ownerId` 解析出来的名字，由数据层填。视图不自己查人名。 */
  ownerName?: string;
}

/** 代号解析结果 —— hover 一个 `01-J2` 时浮层里那三行。 */
export interface CodeRef {
  code: string;
  /** 判断 / Mission / 业务域 / 议题 / 文档 */
  kindLabel: string;
  /** 它到底是什么，一句原话 */
  text: string;
  /** 状态一行，没有就不显示 */
  standing?: string;
  /** 出处一行 */
  source?: string;
  /** 点得开的话 */
  href?: string;
}

// ===========================================================================
// 语音模式的数据依赖 —— 与 stage/* 一起封存
//
// 语音交互这一版不上（后续复用），代码保留且必须能编译。下面这些类型只有
// `lib/agent/transcript.ts`（ChatMessage → 模型轮次）和 `stage-map.tsx`
// （`api.getOutcomes()` 那棵全貌树）还在引用；语音模式重启时随它们一起复核。
// ===========================================================================

export type Tier = "own-agent" | "peer-agent" | "person";

/** 第二档的交换回执：带过去了什么、遮掉了什么、对方依据什么答的。 */
export interface ExchangeReceipt {
  peerAgentLabel: string;
  seconds: number;
  carried: string[];
  redacted: string[];
  basedOn: string[];
}

/** 装配清单 —— "我带了什么进来"的可见证明 */
export interface AssemblyManifest {
  total: number;
  groups: { label: string; items: ManifestItem[] }[];
}

/** Agent 说出来的一段东西。每一种都是可检视的物件，不是聊天蒸汽。 */
export type MessageBlock =
  | { type: "text"; statements: Statement[] }
  | { type: "manifest"; manifest: AssemblyManifest }
  | {
      type: "challenge";
      items: {
        conflict: string;
        basis: string;
        alternative: string;
        traces?: Trace[];
      }[];
    }
  | { type: "question"; text: string; suggestedDri: string; deadline: string }
  | { type: "receipt"; tier: Tier; receipt: ExchangeReceipt }
  | {
      type: "escalate";
      personId: string;
      personName: string;
      personTitle: string;
      why: string;
      draftQuestion: string;
      sentAt?: string;
    }
  | { type: "judgments"; judgmentIds: string[] };

export interface ChatMessage {
  id: string;
  threadId: string;
  role: "user" | "clark";
  at: string;
  blocks: MessageBlock[];
  /** 用户消息带的附件名。不真上传，chip 展示。 */
  attachments?: string[];
  /** 这一轮走的哪一档；用户轮次没有 */
  tier?: Tier;
  /** true = 这条刚从服务端回来，界面应当流式显现它。 */
  fresh?: boolean;
}

/** 一周一格。过去的每一周都要能翻回去看。 */
export interface OutcomeWeek {
  /** `2026-08-03`，那一周的周一 */
  startsOn: string;
  endsOn: string;
  /** 屏幕上那一行：「8 月 3 日 – 8 月 9 日」 */
  label: string;
  /** 今天落在这一周里 */
  current: boolean;
  /** 这一周定下来的事 */
  decided: OutcomeEntry[];
  /** 这一周判断动过的地方 */
  moved: OutcomeEntry[];
}

export interface OutcomeEntry {
  id: string;
  at: string;
  /** 域编号，让他一眼看出这一周的动静集中在哪儿 */
  domainCode?: string;
  headline: string;
  /** 谁做的 */
  actor?: string;
  href?: string;
}

export interface OutcomeScreen {
  period: Period;
  /** 公司总 Outcome，原文照录 */
  company: CompanyOutcome;
  /** 它是哪天定下来的 */
  setOn: string;
  daysLeft: number;
  domains: {
    code: string;
    name: string;
    /** Domain Outcome，原文照录 */
    outcome: string;
    driName: string;
    commitmentStatus: string;
    confirmed: number;
    total: number;
    shaking: string | null;
    href: string;
    /** 这个域下的 Mission，只读。 */
    missions: MissionCard[];
    /** 本期承诺的精简投影。没灌纲领就是 null。 */
    commitment: {
      id: string;
      status: Commitment["status"];
      version: number;
      rounds: number;
      items: number;
      changed: number;
      href: string;
    } | null;
  }[];
  /** 最近的一周在最上面 */
  weeks: OutcomeWeek[];
}

// ===========================================================================
// 排会 —— 一场会就是一个时间槽
//
// 这一段和下面那个 `Meeting` 是两件事，别混：`Meeting` 是**一个域一场**的战略会，
// 带状态机（准备 → 进行 → 已开完），是内容包里预置的那一套。这里的 `MeetingSlot`
// 是一号位在首页排会面板上自己排出来的一场会 —— 它没有状态机，只有**一个时间和一串
// 议题**。什么时候算开完由那个时间自己说：过了结束时刻就是开完了。
//
// 为什么不复用 `Meeting`：那个对象一个域只有一场、且与域强绑定，而排会要解决的恰好是
// 相反的事 —— **几件不同域的议题凑在同一个时间里**。硬塞进去就得给它加一个「这场会有
// 哪些议题」的数组，然后 `getMeetingPrep` 按域取的那一整套立刻对不上。
// ===========================================================================

/**
 * 一场会。**它的身份就是那个时间槽** —— 同一天、同一个起止时刻，就是同一场会。
 *
 * 这一条是整个排会面板的地基：一号位从来不「先建一场会再往里加议题」，他做的是给某件
 * 议题定一个时间；两件议题定到同一个时间，它们就在同一场会上。屏幕上那个聚类因此不是
 * 一种展示手法，**它就是数据本身** —— 也正因为如此，屏幕上不需要任何一句话去解释
 * 「这几件为什么画在一起」。
 */
/** 一天只分两格。战略会的粒度就到这里 —— 理由写在 `MeetingSlot` 上。 */
export type DayHalf = "am" | "pm";

export interface MeetingSlot {
  /** `MS-20260904-am`。由日期和半天生成，所以同一格只可能有一条。 */
  id: string;
  /** `YYYY-MM-DD` */
  date: string;
  half: DayHalf;
  /** 这场会上要过的议题，**顺序就是议程顺序**（日程板上拖出来的那个顺序）。 */
  issueIds: string[];
  /**
   * 议题之外还要请到场的业务域。
   *
   * 参会域**默认是算出来的**：这场会上那几件议题各自属于哪个域，并集就是参会域 ——
   * 排会时因此零操作，也不会出现「标了 FE、会上却没有 FE 的议题」这种对不上的状态。
   * 这个字段只补一种情况：某个域的 DRI 要到场，但他手上没有议题在这场会上。
   */
  extraDomainIds: string[];
  createdAt: string;
  /**
   * 「标记会议结束」按下的时刻。**没有 = 这场会还没开完。**
   *
   * 不由时钟推。粒度只到上午/下午之后，时钟根本答不出「散会了没有」——而这件事必须有
   * 一个确定的答案：会后那条链路（交录音、提炼、确认）整条挂在它后面。所以它是一个
   * 人按下去的动作，而不是一个到点自动翻的位。
   */
  endedAt?: string;
  /**
   * 录音或纪要转成文字、**并且提炼完**的时刻。
   *
   * 它不再等于「交没交过材料」：交上来的东西先要过一道判（`a7.intake`），判成对不上
   * 这场会的那一份不跑提炼，于是它有 `transcript` 和 `audioName`、没有这一格。要问
   * 「交过没有」看 `transcript`，要问「此刻走到哪一步」看 `api.slotIntakeState`。
   */
  transcribedAt?: string;
  /** 交上来的那份材料叫什么。屏幕上要说得出「提炼的是哪一份」。 */
  audioName?: string;
  /** 交上来那份材料的全文，原文照存、一个字不改。详细内容页第一项就是它。 */
  transcript?: string;
  /**
   * 上面那份材料被判成没用时，模型说的**那句原话**。有值 = 这一场停在被判没用那一步。
   *
   * 照登，不改写成「材料无效」——「这份是上周产品评审的记录，跟这场会的三件议题一件
   * 都对不上」告诉他下一步该传哪一份，而「材料无效」只告诉他重传一次。
   *
   * 存在库里而不是只留在任务表上：任务表跟着进程走（见 `agent/tasks.ts`），重启之后
   * 那一场会变成「交过材料、什么都没发生」——而它明明是被判掉的。下一次交材料时清掉。
   */
  intakeRejection?: string;
}

/**
 * 这一场会交上来的材料此刻走到哪一步了。**屏幕上那块流动的底靠它决定要不要动。**
 *
 * 两段分开报（`checking` / `summarizing`）不是为了好看：判材料有没有用是一次便宜的
 * 调用（几秒），按议题提炼是一次贵的（几十秒到几分钟）。合成一档「在跑」的话，前几秒
 * 那一下和后面那一大段在屏幕上长得一样，而它们值的钱差两个量级 —— 卡住的时候他分不出
 * 是哪一段卡住了。
 */
export type SlotIntakeState = {
  status: "idle" | "checking" | "summarizing" | "done" | "rejected" | "failed";
  /** `rejected` 时是模型判它没用的原话；`failed` 时是这一轮挂掉的原话。 */
  reason?: string;
  /** 这一份材料叫什么（`audioName`）。 */
  name?: string;
};

/**
 * 一件议题排在哪一场会上 —— 议题摘要上那一格。
 *
 * `seq` 是这场会在**所有已排的会**里按时间排第几（从 0 起）。它只有一个用处：给这场会
 * 挑一个颜色。放在数据层算而不是各屏自己数，是因为议题卡片和排会面板是两屏 —— 各数
 * 一遍的话，同一场会在两处会是两个颜色，而颜色在这里承担的正是「这几件是同一场」。
 */
export interface IssueSlot {
  slotId: string;
  date: string;
  half: DayHalf;
  /** 第几场（按时间先后），决定颜色。 */
  seq: number;
  /** 这场会上一共几件议题。 */
  size: number;
  /** 这件是这场会的第几件，从 1 起。 */
  index: number;
  /**
   * 这场会结束了没有 —— **到点了，或者他提前按了「标记会议结束」**（口径在 `slotPast`）。
   *
   * 抄一份到摘要上，是为了让议题卡片不必自己去问会议表、也不必各自在浏览器里推一遍
   * 时钟。屏幕上这一个布尔决定的是**这件议题坐在哪一栏**：还没结束的在议题栏、也还能在
   * 编排页上拖；结束了的整场挪到会后那一栏等纪要，编排页上再也见不到它。
   *
   * 原来它只是 `endedAt` 的投影 —— 那时他忘了按那一下，这场会就永远停在「还没开」，
   * 而屏幕上没有任何一处说得出这件事。
   */
  ended: boolean;
}

/**
 * 会上定下来的一条。**`text` 上卡面，`boundary` 只在展开里。**
 *
 * 这一对来自真实复盘的那张表（0715 会后复盘第二节：「要点 / 会议支持的判断 / 边界」）。
 * 边界之所以必须跟着这一条走、而不是并成另一段：一条没有边界的结论会在下一次被当成
 * 比它实际管得更宽的东西用 —— 而两者分家之后，读的人得自己把它们对回去。
 *
 * 卡面上不显示边界，是因为卡面要回答的是「这几条我认不认」；边界是他**追问**时才要的
 * 东西，而追问已经是展开之后的事了。
 */
export interface DebriefPoint {
  id: string;
  /** 会上定下来的那一条，一句。 */
  text: string;
  /** 它没说什么、在哪儿到头。会上没划出边界就没有 —— 不许替它补一个。 */
  boundary?: string;
  /**
   * 他把这一条勾过了。
   *
   * **勾不是确认，确认也不要求先勾完。** 这几条是一份 checklist：一场会谈出五条，他多半
   * 会一条一条过 —— 勾是给他自己留的记号（「这条我看过了、认了」），而不是一道闸。做成闸
   * 的话，一件五条要点的议题要按六下才能过完，而这一栏存在的全部理由是**扫一眼就能确认**。
   *
   * 反过来也成立：勾完全部并不自动确认。确认是一次处置（议题就此进入已部署），它只能由
   * 那颗键说了算。
   */
  checked?: boolean;
  /**
   * 这一条派给谁了。**只有他自己在卡上点过那一下才有** —— 提炼这一步不填它。
   *
   * 为什么不让模型填：会上点没点名，模型只能从转写里猜，而这条链路上最坏的错就是
   * 「把一件事安到一个没接过它的人头上」——屏幕上那一行看起来和真派过一模一样，
   * 而那个人根本不知道。会上真点了名的，进 `todos[].owner`（那是一条记录，不是一次指派）。
   *
   * 存 id 也存名字：id 是那条链（指回本体里的人），名字是**指派那一刻的快照**。这是一本账
   * ——半年后那个人换了岗、甚至从表里没了，这一行仍然要答得出「当时派给了谁」。
   */
  assignee?: { id: string; name: string };
}

/**
 * 一条 action item 归了谁。**这是从转写里读出来的事实，不是他在卡上亲手点的** ——
 * 那一格是 `DebriefPoint.assignee`，两者分工不同：`assignee` 只有他自己在卡上点过
 * 那一下才有，这一格只要会上真点了名字（`DebriefTodo.owner`）就现算得出来，用不着
 * 他再点一次确认。
 *
 * `confidence` 现在只有一档 `"explicit"`——这一版只判「是不是一号位自己」，判据是
 * `owner` 原文和他的真名或第一人称说法整条相等（见 `todo-assignee.ts`）。留着这个
 * 字段是为了将来要把一件事推给别人（不只是一号位）时，能分出「原文点了名」和
 * 「猜出来的」这两档，不用再改这份形状。
 */
export interface TodoAssignee {
  personId: string;
  name: string;
  confidence: "explicit";
}

/** 会后的一条待办。人和期限**只在录音里真说了才有** —— 编一个负责人是这条链路最坏的错。 */
export interface DebriefTodo {
  id: string;
  text: string;
  /** 谁的。会上没点名就没有。 */
  owner?: string;
  /**
   * `owner` 判成「这是一号位自己」之后的结果。**和 `DebriefPoint.assignee` 不是一回事**：
   * `assignee` 是他在卡片上**亲手点**的一次指派，这一格是从转写里**读出来**的事实 ——
   * 会上真点了名，这件事从那一刻起就已经是他的，不必等他再点一下才算数。
   */
  assignedTo?: TodoAssignee;
  /**
   * 这条要不要一号位拍板。**A7 提炼那一次判的**，带一句理由。
   *
   * 和 `assignedTo` 判的不是一回事，两样必须并排存着：`assignedTo` 答的是「这件事是
   * 谁的」（一个事实，会上点没点他的名），这一格答的是「这件事的性质是什么」——
   * 一个只有他能做的选择，还是一件照着做的执行。面板右栏就是按这两样分的上下两层：
   * 上层摆要他拍板的，下层摆点了他名的执行项。只有归属没有性质，那两层就并不出来，
   * 一屏上要么全是他的琐事、要么把一个待定的选择混在琐事里 —— 而后者正是这一相要
   * 防的事故。
   *
   * **可选的原因只有一个：相三之前落的库里没有这一格。** 不是「有时候可以不判」——
   * 判不出来也要写成「归他」（`resolvePrincipal` 的兜底）。缺字段的老记录在读口被兜
   * 底成同一件事（`listActionItems`），所以屏幕上永远不会出现一条没人判过的待办。
   */
  principal?: { needed: boolean; reason: string };
  /** 什么时候之前。会上没说就没有。 */
  due?: string;
  /** 他拍板的那一刻。没有 = 还等着他。 */
  decidedAt?: string;
  /**
   * 这条是什么 —— 模型读完内容后起的一句短标签，如「产品方向决策确认」。
   *
   * 卡面顶行，取代过去写死的「任务」两个字：那两个字答不出这条待办是什么，只说明它
   * 落在哪个容器里。**可选的原因同 `principal`**：这一格之前落的库里没有，读口兜底
   * 成一句能用的话（`resolveLabel`）。
   */
  label?: string;
}

/**
 * 一场会散了之后，落到**某一件议题**上的要点与待办。
 *
 * 单位是「议题 × 会」，不是「会」：一场会过了三件议题就出三份，各自只说自己那一件。
 * 合成一份的话，他在议题卡片上看到的是另外两件事的待办 —— 而他此刻正在决定的是这一件。
 *
 * `confirmedAt` 之前它是**待处理**的：首页那一叠摞着的卡片摊的就是这些。确认之后不再
 * 摊，但仍然留在议题卡片上 —— 那时它不再是一件待办，它是这件议题会后的样子。
 */
export interface MeetingDebrief {
  slotId: string;
  issueId: string;
  /**
   * 一句话：这件事在这场会上收敛到什么程度。**卡面上的第一行。**
   *
   * 对齐的是真实复盘里那个「核心观点」段（0715 会后复盘：「讨论焦点已从『要做一套什么
   * 系统』推进到灯塔项目如何证明一号位价值、项目交付和商业价格能否同时成立」）——
   * 一句就把这场会的位移说清，读完它就能决定要不要往下读。
   */
  summary: string;
  /** 会上定下来的那几条。卡面上摊开的就是它们的 `text`。 */
  points: DebriefPoint[];
  /** 谁在什么时候之前做什么。会上没定就是空的 —— 空着是一个诚实的结果，不是缺失。 */
  todos: DebriefTodo[];
  /**
   * 会上**没有**定下来的，以及下一轮要拿什么事实回来回答。
   *
   * 真实复盘里这是独立的一章（「未决事项」「潜在风险和需要校准的问题」），而且它恰恰是
   * 最容易在压缩中丢掉的一段 —— 丢了之后，一份读起来样样都定了的纪要会让人以为共识
   * 已经达成。卡面上不显示，展开才有。
   */
  open: string[];
  /**
   * 这场会在这件议题上有没有形成共识 —— **A7 判的，只用来决定卡上默认高亮哪一颗键。**
   *
   * 它不替他按。一件议题常常要开几次会才谈拢，而「这次谈拢了没有」是一个读完转写就能
   * 判的事实问题；把它判出来，他就不必为了决定「确认还是再谈一次」而把整份复盘读一遍。
   */
  consensus: { reached: boolean; reason: string };
  createdAt: string;
  /** 他扫过一眼、按下确认的那一刻。没有 = 还压在他那儿。 */
  confirmedAt?: string;
  /**
   * 他按下「还需再议」的那一刻 —— 这场会没谈拢，议题退回研究中等下一场。
   *
   * 和 `confirmedAt` 是并排的两个出口，不是一个布尔的两面：**两个都空**才是「还压在
   * 他那儿」。合成一个 `handledAt` 的话，屏幕上就分不出「这件事定了」和「这件事还要
   * 再谈一次」—— 而那正是他刚刚做出的那个判断。
   */
  reopenedAt?: string;
  /** 他改过字。屏幕上要分得出哪几句已经是他自己的话。 */
  editedAt?: string;
}

/**
 * 面板右栏一张卡的全部内容。**这是一份读出来的投影，不是库里存着的对象** ——
 * 没有对应的写口，改这几个字段要去改 `MeetingDebrief` 本身（`updateDebrief` 那一族
 * 方法），下一次 `listActionItems()` 会自己从新的 `MeetingDebrief` 算出新的样子。
 * 建两份分开维护的话，两份迟早会对不上，而对不上的那一份多半是这里。
 */
export interface ActionItem {
  /** 就是 `DebriefTodo.id`，全库唯一（`TD-<slotId>-<issueId>-<n>`）。 */
  id: string;
  text: string;
  assignedTo?: TodoAssignee;
  /**
   * 要不要他拍板。**这一格没有可选一说 —— 读口一定填得出来。**
   *
   * `DebriefTodo.principal` 是可选的（相三之前落的库里没有这一格），而这里不是：
   * `listActionItems()` 对缺字段的老记录会兜底成「没判出来 —— 先归到你这里」
   * （`resolvePrincipal`）。做成可选的话，面板那一侧就要自己再兜一次底，而那一层
   * 兜漏了的后果是一条要他拍板的事从两层里同时消失 —— 屏幕上看不出少了什么。
   * 兜底只兜一次，就兜在这里。
   */
  principal: { needed: boolean; reason: string };
  due?: string;
  /** 同 `DebriefTodo.decidedAt`。有它就该从「等他拍板」那一组里退出去。 */
  decidedAt?: string;
  /**
   * 卡面顶行。同 `principal`：**这一格没有可选一说** —— 卡的顶行不能再是写死的
   * 「任务」两个字，也没有别的字段能顶这一行，所以读口必须填满（`resolveLabel` 兜底）。
   * 默认仍然不提这条待办挂在哪个议题/mission 下面（一号位要专注的是这件事本身），
   * 只在提示词判断不提就说不清这条标签在说什么时才会出现，出现时必须是人话，不能是
   * 编号——后一半由 `resolveLabel` 里的 `CODE_LIKE` 挡住。
   */
  label: string;
  issueId: string;
  issueTitle: string;
  slotId: string;
  /** 人话的会次（`周三 9/3 · 上午`）。取不到那一场会时是 `已开完的会`。 */
  slotLabel: string;
  /** 这场会在这件议题上的第一行。sheet 上半用。 */
  debriefSummary: string;
  /** 同一场会同一件议题的其他 action item。sheet 的「它想到的」用。 */
  siblings: { id: string; text: string }[];
}

// ===========================================================================
// 会议
//
// 会议是「议题」之外的第二个大类。它只有三态，和一条不能跳的顺序：
// **准备 → 进行 → 已开完**。会后闭环单挂在「已开完」那一刻。
// ===========================================================================

export type MeetingState = "preparing" | "running" | "closed";

export interface Meeting {
  id: string;
  /** 这个域的第几次战略会。会议是有历史的东西，第几次要写在屏幕上。 */
  seq: number;
  domainId: string;
  /** 什么时候开，人话 */
  scheduledLabel: string;
  state: MeetingState;
  startedAt?: string;
  endedAt?: string;
}

/**
 * 会前准备一屏所需的全部东西。
 *
 * **议程不是一份存下来的清单**，是「哪些议题已经从议题研究里带了拆分点上会」算出来的。
 * 存一份清单就会出现「清单里有、议题里没带上会」这种对不上的状态。
 */
export interface MeetingPrepItem {
  issue: IssueSummary;
  /** 已从议题研究带上会的拆分点条数。0 = 还没提交。 */
  queued: number;
  /** 一页纸（Brief）装配好了没 */
  briefReady: boolean;
}

/**
 * 一件议题那场会 —— 会议与议题强绑定。
 *
 * 一件议题只开一次讨论会，所以「会前准备」准备的永远是**某一件议题**，「会后确认」
 * 确认的也是那一件。会议因此不是一个独立的目的地，而是议题的一段：从议题卡片进来，
 * 前半程读会前报告，后半程核会后记录。
 */
export interface IssueMeeting {
  issue: IssueSummary;
  meeting: Meeting | null;
  /** 会前报告是拿这几份东西出的 —— 收齐了才出报告 */
  intake: MeetingIntakeItem[];
  /** 会前报告装配好了没 */
  briefReady: boolean;
  /** 会后落到这件议题上的记录：会议纪要、会后复盘 */
  records: MeetingRecord[];
  /** 这件议题在闭环单上的条目。没开过会就是 null */
  closure: MeetingClosure | null;
}

/** 会前收进来的一份东西。材料、CEO Agent 的意见、DRI 的反馈，三类各自标出来。 */
export interface MeetingIntakeItem {
  kind: "material" | "agent" | "dri";
  label: string;
  /** 点得开的那一份 */
  docId?: string;
}

/** 会后的一份记录，全文。 */
export interface MeetingRecord {
  docId: string;
  title: string;
  body: string;
  updatedAt: string;
}

export interface MeetingPrep {
  meeting: Meeting;
  domain: { id: string; code: string; name: string; driName: string };
  items: MeetingPrepItem[];
}

// ---------------------------------------------------------------------------
// 会后闭环单
//
// 会后产物不是「纪要」，是**闭环单**：一张单子、四个分区（拍板 / 派发 / 未决 / 沉淀），
// 判定单位是**条**不是会。CEO 的动作不是「审批 AI 的作业」，是**签发已经发生的决定** ——
// 拍板在会上当众完成过了，系统要的只是一次公证。
// ---------------------------------------------------------------------------

export type ClosureItemKind = "decision" | "mission" | "open" | "writeback";

/**
 * 一个字段的来源。
 *
 * `confirmed` = 会上过了的（它来自会前带上会的那条拆分点，原文照录）；
 * `drafted` = **AI 补的**（期限、成功证据这类会上没说全的）。
 *
 * 两者必须在屏幕上分得出来。AI 会议纪要最常见的三种事故 —— 把「讨论了」写成「决定了」、
 * 编造责任人、编造期限 —— 都发生在这条界线被抹掉的时候。**AI 补的必须自首**，审阅因此
 * 从「通读全文」变成「核对例外」。
 */
export interface ClosureItemField {
  label: string;
  value: string;
  origin: "confirmed" | "drafted";
  /** 这一条从哪个对象来的 —— 点得开 */
  source?: { label: string; href?: string };
}

export interface ClosureItem {
  id: string;
  kind: ClosureItemKind;
  issueRef: string;
  issueTitle: string;
  title: string;
  fields: ClosureItemField[];
  /** 认知类结论必填：这不意味着什么 */
  boundary?: string;
  /** 有人明确反对但不阻挠 —— 记下来，重开条件命中时它会自己浮出来 */
  reservation?: { who: string; concern: string };
  /** 签发后写回哪些对象 */
  writeBack: WriteBackTarget[];
  /** 被圈除：这一条不签，转未决，其余照签 */
  excluded: boolean;
}

export interface MeetingClosure {
  meetingId: string;
  seq: number;
  domainId: string;
  domainName: string;
  endedAt: string;
  /** 散会到现在多少分钟 */
  minutesSince: number;
  attendees: string[];
  items: ClosureItem[];
  signedAt?: string;
  signedNo?: string;
}

/** 落章之后的回执。写回了什么，一条不落地列出来。 */
export interface ClosureReceipt {
  signedNo: string;
  signedAt: string;
  updated: WriteBackTarget[];
  /** 被圈除、转入未决的条数 */
  deferred: number;
}

/**
 * 一次 agent 运行的可复现记录。
 *
 * 这里的 trace / usage / check 三个类型**故意写成结构类型**，不从
 * `@/lib/graphknowledge` 或 `@/lib/models` import：数据层不认识那两层，
 * 反过来 import 会让「route 与 UI 不许直连 graphknowledge」这条边界从
 * types.ts 上被绕开。上层的具体类型（`TraceNode` / `Usage` / `Check`）
 * 结构上与这里一致，赋值不需要转换。
 */
export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
};

export type AgentTraceNode = {
  at: string;
  label: string;
  /** graph | anchor | context | model | local */
  kind: string;
  detail: Record<string, unknown>;
  ms?: number;
  usage?: AgentUsage;
  error?: string;
};

export type AgentCheck = { name: string; ok: boolean; detail: string };

export interface AgentRunRecord {
  id: string;
  /*
   * 写成字面量联合而不是 string：台账按这个字段分组统计，写成 string 之后
   * 「A10」和「a10」会各占一行，而两行看着都对。这里的取值与 harness 的
   * `HarnessAgent` 一致（数据层不 import 那一层，见上面那段）。
   */
  agent: "A1a" | "A3" | "A4" | "A5" | "A10" | "A6" | "A7";
  /**
   * `ignored` 是「判完了，什么都不该动」那条路：A1a 判信号是噪音、A6 判这一轮
   * 没有动摇判断。**产出为空是正确结果**，和 `failed` 完全两回事。混成一个值
   * 之后，「这条信号被判为噪音」和「这次跑挂了」在屏幕上长一个样，而 A6 那边
   * 「十四轮里有两轮落了图」这个比例也再算不出来。
   *
   * `running` 是**开跑那一下**就落的那条（`agentRunOpen`），跑完由 `agentRunSettle`
   * 原地换成上面那三档之一。没有这一档的那一版里，一轮跑到中途进程没了就什么都不留：
   * 2026-08-25 账单上那笔 57 万输入 token 的深研，运营台上一条记录都没有，而屏幕上
   * 那件议题一直写着「深度研究进行中」。
   *
   * `interrupted` 是那种记录的下场：进程起来时把还停在 `running` 的标成它
   * （`markInterruptedRuns`）。**不并进 `failed`** —— 「模型或图服务把这一轮弄挂了」和
   * 「没人再跑这一轮了，而钱已经花掉」要分开数，后者该查的是进程为什么没了。
   *
   * 这两档只在这一份台账里出现。屏幕上按 `status` 分档的那几处（提请台那条标注、
   * A1a 收件箱）读的都是已经落定的记录，不会碰到它们。
   */
  status: "ok" | "ignored" | "failed" | "running" | "interrupted";
  input: string;
  output: Record<string, unknown> | null;
  route?: "update_issue" | "new_issue" | "ignore";
  /**
   * 空 = 连装上下文这一步都没走到（例如第一步就挂了）。
   *
   * `narrative` = 公司上下文来自本体叙述接口（`TKOS_ONTOLOGY_SOURCE` 默认那一支）。
   * **它必须和另外两档分开落账**：那一支没有锚点、没有可引编号，所以事后按这个字段
   * 筛「哪几轮的报告应该带内部编号」时，把它并进任一档都会筛出一批错的。
   */
  contextMode: "anchored" | "external_only" | "narrative" | "";
  noAnchorReason?: string;
  trace: AgentTraceNode[];
  checks: AgentCheck[];
  checkSummary: { passed: number; total: number; allPassed: boolean; failed: string[] };
  usage: AgentUsage;
  /** A3/A4 的质量门违规原文，超了重修上限时和 `degraded` 一起落。 */
  violations?: string[];
  degraded?: boolean;
  /**
   * 第一轮就被质量门挡下来的违规原文。**重修成功也留着。**
   *
   * `violations` 只在重修失败时才有值，所以只看它，台账上就只剩「重修都救不回来」
   * 那几条 —— 而绝大多数违规是第一轮犯、第二轮改对的，那部分全部消失了。于是
   * 「哪条规则老是被违反」答不出来，prompt 该调哪一句就只能靠猜。
   *
   * 一轮就过的运行不写这个字段（不是写空数组）：空数组和「没记」在统计时分不开。
   */
  firstRoundViolations?: string[];
  /**
   * 这一次跑完，手上**一条外部证据都没有** —— 那句声明的第一行（见 `NoExternalEvidence`）。
   *
   * 不用 `status` 也不用 `degraded` 表示它：`status` 是字面量联合、台账按它分组统计，多一个
   * 取值会让每一处统计悄悄少算一类；`degraded` 一路上的意思是「有阻断级违规」，而查不到东西
   * 不是违规。所以单独一位，名字直说它是什么。
   *
   * 只存那一行标题：台账列表要的是「这一条能不能一眼看出来」，整段理由在报告文档上。
   */
  noExternalEvidence?: string;
  // ---- 复现坐标：照这几个值能把同一次运行再跑一遍 ----
  slot: string;
  modelAlias: string;
  providerModelId: string;
  depth: string;
  snapshotId: string;
  /**
   * `snapshotId` 有值、但按它已经取不回快照（被上限挤掉了）。**读的时候现判，不落盘。**
   *
   * 没有这一位的话，记录里只分得出两种状态：空串（纯外部路，从来没有快照）和
   * `ctx-...`（锚定路）。第三种「曾经有、现在没了」和第二种长得一模一样，于是翻到
   * 一条旧的锚定运行、点进去报错，只能理解成「坏了」。
   */
  snapshotEvicted?: boolean;
  contextRecipe: string;
  contextAnchor: string;
  contextViewer: string;
  contextAsOf: string;
  graphknowledgeBaseUrl: string;
  /** q 被裁、语义段降级、TLS 未校验…… */
  warnings: string[];
  error?: string;
  createdAt: string;
  finishedAt: string;
  latencyMs: number;
}

/**
 * A1a 调研之后判为噪音时留在信号卡上的标注。
 *
 * **卡不因此消失。** 被 CEO 递上来的信号哪怕被判定为没价值也要留在信号列表里，
 * 只是标注出来 —— 删除或归档是他自己的动作。自动收走的话，他会以为系统漏了
 * 这条，而系统其实是判过的。
 */
export type CardAgentVerdict = {
  route: "ignore";
  /** 模型原样给的判词，照录。下游按这句话识别分支。 */
  verdict: string;
  reason: string;
  /** 什么情况下它会重新值得处理。说不出这一条的是搁置，不是判断。 */
  reasonToRevisit: string;
  runId: string;
  at: string;
};

/**
 * 待挑的信号：抓取作业（`tkos-lab/scripts/catch.py`）投进来的一条过线信号。
 *
 * 和 `Card` 分开：卡是**已经进了提请台**的东西，一号位对它的每一次点击都落成组织
 * 动作；这一批是「机器觉得值得看，还没有人挑过」。混进 `cards` 之后，首屏那几张
 * 卡里会混着没人看过的机器产出 —— 而提请台的克制正是它的全部价值。
 *
 * 字段是跨仓库契约（rollout design §4.3）的驼峰版。蛇形转驼峰只在
 * `src/lib/data/inbox.ts` 里发生一次。**这一侧不做任何研判**：score / dimensions /
 * kiq / why / suggestedIssue 全是作业那边算完的，这里只展示与排序。
 */
/**
 * 待挑的信号：**两种来源，共享一张待挑页。**
 *
 * 抓取作业（`tkos-lab/scripts/catch.py`）投进来的那一支可信来自「有人在外面盯着
 * 变化」；一个 DRI 报上来的那一支可信来自「一个具体的人把名字押在上面」——
 * `CardSource` 上那段注释已经说过为什么这两样必须分开。
 *
 * 共享的部分就是「一条线索」本身。分数、维度、KIQ、Run id 只有抓取那一支有：
 * 一个人报上来的东西没有这些，**照抓取的形状塞就必须编一个分数和一个 Run id**。
 * 缺的字段不给，不给 0。
 */
export interface InboxSignalCommon {
  /**
   * 幂等键。抓取那一支 = 归一化后的 URL（去 utm 与 fragment，作业那边由
   * `sources.normalize_url` 算）；人报那一支有 URL 就同上，没有就取
   * 「姓名 + 一句话 + 日期」的哈希（`src/lib/data/store.ts` 的 `reportedKey`）。
   */
  dedupeKey: string;
  title: string;
  /** 抓不到就是空串。人报的「出处」是一句话时也可以为空 —— 空串照样收。 */
  url: string;
  /** 正文或摘要。这边不再加工，只截长度。 */
  text: string;
  /** ISO 8601。抓不到就是空串，不猜一个时间填上去。 */
  publishedAt: string;
  /** 源的备注名或域名；人报的那一支写他填的「出处」。 */
  source: string;
  /** 抓取那一支是作业算的；人报那一支是「为什么是现在」。 */
  why: string;
}

/** 抓取作业独有的那七个字段。**这一侧不做任何研判**，只展示与排序。 */
export interface CrawledSignalInput extends InboxSignalCommon {
  kind: "crawled";
  origin: "pinned" | "discovered";
  /** 1–5，作业那边按 rubric 打的。**区间不在这边校验**（见 inbox.ts 里的注释）。 */
  score: number;
  dimensions: Record<string, number>;
  /** 命中的关键情报问题编号，例如 `KIQ2.2`。它是「为什么值得看」的可追溯锚。 */
  kiq: string;
  suggestedIssue: string;
  /** 产出它的那次扫描（实验台 Run 的 id）。追「线上跑的是哪套参数」从这里进。 */
  runId: string;
  scannedAt: string;
}

/** 一个 DRI 报上来的。四个字段，没有分数。 */
export interface ReportedSignalInput extends InboxSignalCommon {
  kind: "reported";
  /** 谁报的，姓名。这一支的全部可信度在这三个字上。 */
  by: string;
  /**
   * 他觉得这条动摇哪条判断（判断 id）。**允许为空是刻意的**：要求上报人先答出
   * 「动摇哪条判断」等于把上报门槛提到没人愿意报。那道门槛属于出卡侧，不属于收件侧。
   */
  shakes?: string;
}

export type InboxSignalInput = CrawledSignalInput | ReportedSignalInput;

/**
 * 「主动开始扫描」那一轮现在什么样。屏幕上那行小字全部来自这里。
 *
 * `step` 是**实验台给的原话**（harness 的 `describe_step` 的 label），不是这一侧照
 * 步骤表编的 —— 编一份的后果是实验台改了流程、屏幕上的字还是旧的，而一号位无从
 * 分辨。同理 `unavailable`：这条路走不通就照实说走不通，不做「看起来在扫」的假动作。
 */
export type ScanState = {
  status: "idle" | "running" | "done" | "failed";
  /** 这一轮在实验台的 Run id。追「刚才那一轮到底跑了什么」从这里进。 */
  runId?: string;
  /** 当前这一步的名字，第几步 / 共几步。跑起来之后才有。 */
  step?: string;
  no?: number;
  total?: number;
  /** 收下了多少。`droppedNoUrl` = 没有 URL 因而算不出幂等键、只能丢的条数。 */
  got?: { received: number; inserted: number; updated: number; droppedNoUrl: number };
  /**
   * 这一轮什么时候收工的。**由服务端盖**（`scan/run.ts` 收下那一批的时候），
   * 屏幕上只显示到分钟。
   *
   * 不让前端拿 `new Date()` 当完成时间：那一下量的是「他这台机器什么时候看到结果的」——
   * 他刷新一次页面，同一轮扫描的完成时间就会往后跳一次。
   */
  finishedAt?: string;
  /** 上一轮为什么没跑成。 */
  error?: string;
  /** 这条路现在根本走不通的原因（没配实验台、或者是演示档）。有值就不给按。 */
  unavailable?: string;
};

/**
 * 一轮扫描本身的账。**过线零条的那一轮也在这里** —— 这就是它存在的全部理由。
 *
 * 扫描记录那一页原来是从收下来的信号反推批次的（按 `runId` 分组），于是「这一轮扫过
 * 但什么都没过线」在屏幕上和「这一轮压根没跑」长得一模一样。而这两件事对一号位的
 * 意思正好相反：前者是雷达按时看过一遍、外面确实没有值得他看的东西（那是合格输出）；
 * 后者是雷达没转。所以扫完就落一条，收下几条是另一回事。
 */
export type ScanRound = {
  /** 这一轮在实验台的 Run id。同一轮重投只更新这一条，不追加。 */
  runId: string;
  /** 这一轮扫描的时刻，抓取那一侧盖的（契约里的 `scanned_at`）。 */
  scannedAt: string;
  /**
   * 这一轮**收下**了几条过线信号。没过线的从来没到这一侧，所以它不是「抓了多少」。
   *
   * 它和屏幕上那一组底下真正列出来的条数可能不一样：收件柜封顶 200 条会把老信号
   * 挤掉，而这个数字留着 —— 「那一轮提名过 5 条，现在一条都不在了」说得出来。
   */
  nominated: number;
  /** 这条记录写进来的时刻。同一个 `runId` 重投时会更新。 */
  at: string;
  /**
   * 这一轮是谁起的：`auto` = 抓取作业定时推过来的，`manual` = 他在屏幕上
   * 按了「主动开始扫描」。
   *
   * **可选，而且缺省不作数。** 库里已有的历史轮次没有这一格，它们的真实来路
   * 我们不知道 —— 所以算节奏时那些轮次一律排除（见 `scanCadence`），不得当成自动的：
   * 把他手点的那几轮混进去，算出来的「节奏」会变成几分钟。
   */
  trigger?: "auto" | "manual";
};

/** 一号位对一条待挑信号做的处置。`issue` = 开成议题（去跑 A1a）。 */
export type InboxDisposition = "issue" | "watch" | "dismiss";

/** 落库之后多出来的那几样。两支共用。 */
export interface InboxSignalMeta {
  /** 收件时间。同一个 `dedupeKey` 再来一次**不改**它。 */
  receivedAt: string;
  /** 空 = 还在等他挑。**v1 只记不读**（rollout §7）。 */
  disposedAs?: InboxDisposition;
  disposedAt?: string;
  /**
   * 处置成议题时开出来的那一条。**这一格和 `judged.issueId` 不是一回事。**
   *
   * `judged` 那一整块说的是 A1a 那次运行（哪次、什么状态、什么时候、开出了什么），
   * 四格同生共死；而一号位在待挑页上确认升级的那一下**不等模型**：议题当场就建出来
   * 了，那时还没有任何一次运行可言。把编号记进 `judged` 就得给另外三格编值，而编出来
   * 的 runId 指不到任何一次真实运行。
   *
   * 所以升级那条路记这里，A1a 自己开出来的仍然记 `judged.issueId`。读的时候两处都要
   * 看（`issueOfSignal`）—— 只看一处会漏掉另一条路开出来的议题，表现成「这条信号
   * 明明升级过，屏幕上却说它没有议题」。
   */
  issueId?: string;
  /**
   * 「开成议题」那一下的结果。和处置分开存：处置是他的动作，这个是 A1a 的结论，
   * A1a 跑挂了不该让「他挑过这一条」这件事跟着消失。
   */
  judged?: {
    runId: string;
    status: AgentRunRecord["status"];
    route?: AgentRunRecord["route"];
    at: string;
    /**
     * 开成的是哪一条议题。**开不出来就没有这个字段** —— A1a 判为噪音、模型挂了、
     * 或者产出里没有议题正文，三种情况下都不该有一个指向不存在对象的编号。
     * `DriReportedSignal.issueId` 取的就是这里。
     *
     * 还有一种有值的情形：A1a 判为噪音之后**一号位不采纳这条判断、自己开成了议题**
     * （`api.openIssueAnyway`）。那条议题确实是这条信号开出来的，所以编号记在这里；
     * 「参谋判了什么、他决定了什么」记在那条议题的时间线上。
     */
    issueId?: string;
  };
}

export type InboxSignal =
  | (CrawledSignalInput & InboxSignalMeta)
  | (ReportedSignalInput & InboxSignalMeta);

/**
 * 「我上报的被怎么处置了」那一行。**只有他自己那几条**，而且只给他该看的四样：
 * 报的是什么、什么时候报的、有没有被挑过、挑成了什么。
 *
 * 不给分数（人报的那一支没有）、不给一号位在那条上写的任何东西。
 */
export interface DriReportedSignal {
  dedupeKey: string;
  title: string;
  receivedAt: string;
  disposedAs?: InboxDisposition;
  disposedAt?: string;
  /** 开成了议题的话，是哪一件。开不出来（A1a 挂了）就没有这个字段。 */
  issueId?: string;
}

/**
 * 派给我的一件研究任务。**只有交接包正文那一层**（HANDOFF §10 分层）——
 * 一号位在这件议题上的对谈记录、判断板、他自己的倾向都不在这里。
 */
export interface DriHandoff {
  issueId: string;
  title: string;
  /** 定过的题（Decision Question）。没定题就是空串 —— 不猜一句给他看。 */
  question: string;
  deadline: string;
  assignedAt: string;
  /**
   * 交接包正文。**可能为 null** —— 交接包是从深研四节装配出来的，还没有深研报告
   * 时它装配不出来（见 `escalate` 里 synthBrief 那段注释）。null 就在屏幕上照实说
   * 「这件事还没有交接包正文，只有问题本身」。
   */
  brief: string | null;
  /** 我已经回传过了。回传之后仍然能看到这一件，也仍然能覆盖提交。 */
  submitted: boolean;
  /**
   * 最后一次回传的时间。**从时间线事件算出来的，不是另存一份** —— 每次 `submitDriReport`
   * 都会 pushEvent 一条 id 以 `E-${issueId}-dri-report-` 开头的事件，取最后一条的 `at`。
   * 从未回传过就不给这个字段（undefined），不要回落到任何别的时间。
   */
  submittedAt?: string;
}
