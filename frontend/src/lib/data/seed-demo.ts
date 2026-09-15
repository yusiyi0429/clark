/**
 * Demo 内容种子 —— 王总场。
 *
 * ## 这个文件的唯一规矩
 *
 * **每一个字都来自那八份 Word 包，没有一句是这里写的。** 包与本文件的对应关系：
 *
 *   Package 01   四条潜在议题 + Oasis 管理层研究报告（→ 预研）+ 潜在议题阶段对谈
 *   Package 02   首页：三件当前战略议题 + 三件已部署战略事项
 *   Package 03   词元云集整体战略：Strategic Issue、七条历史决策、四轮对谈、当前判断
 *   Package 04a  Oasis 深研报告（四节）
 *   Package 04b  深研之后的判断、对谈、四条待确认判断
 *   Package 05   会前预审（词元云集总体战略定位与阶段路径）
 *   Package 06   0715 管理层会议纪要
 *   Package 07   0715 会后复盘
 *
 * 需要造词的地方只有**接线**：id、时间戳、以及每条卡挂在本体哪条判断上
 * （`strategyRef`）。判断本身是本体里真实存在的对象，不是这里编的 —— 见
 * `seed-tokenking.ts`。接线之外一律照录，标点和全半角都不动。
 *
 * ## 为什么 Oasis 同时是潜在议题和战略议题
 *
 * Package 01 把它当潜在议题完整展开（预研 + 对谈），对谈的最后一句是一号位说
 * 「把它作为一个战略议题继续研究」；Package 02 的首页清单里它已经是当前战略议题。
 * 两份材料不矛盾 —— 后者是前者那次升级**之后**的状态。
 *
 * 所以这里把它种成**潜在议题**，深研报告与判断板预先备好。演示时点进去、读预研、
 * 追问几句、按「升级为议题」，它当场进入中间那一列并且立刻有报告可读。种成已升级的
 * 状态会省事，代价是把演示里最重要的那一下（一号位自己按下去）变成一张截图。
 */

import type {
  AdvisorMessage,
  AdvisorPreset,
  BoardJudgement,
  Brief,
  Card,
  Doc,
  Issue,
  Meeting,
  MeetingClosure,
  PreResearchDoc,
  ResearchDoc,
  Statement,
  Trace,
} from "./types";
import { TODAY } from "./shared";

// ---------------------------------------------------------------------------
// 小工具。只为了让下面几百行内容读起来是内容，不是标点。
// ---------------------------------------------------------------------------

const ext = (source: string, href?: string): Trace =>
  href ? { kind: "ext", source, href } : { kind: "ext", source };
const int = (source: string, href?: string): Trace =>
  href ? { kind: "int", source, href } : { kind: "int", source };
const agent = (source: string): Trace => ({ kind: "agent", source });
const S = (text: string, ...traces: Trace[]): Statement => ({ text, traces });

const AGENT_LABEL = "您的 Agent";

// ===========================================================================
// 01｜潜在议题（Package 01）
// ===========================================================================

/**
 * 四条潜在议题。
 *
 * `what` / `why` / `headline` 三拍分别对应包里的「1｜事实」「2｜为什么值得判断」和
 * 标题行。`refs` 是「3｜来源」。三拍的顺序在卡片上就是读下来的顺序，不加小标题。
 */
export const cards: Card[] = [
  {
    id: "CARD-D1",
    issueId: "ISS-D1",
    headline: "字节收拢飞书、豆包与火山：词元云集应在哪一层与大厂竞争？",
    source: { kind: "radar" },
    what: [
      S(
        "2026 年 7 月 30 日，字节启动面向 AI 业务的组织调整：飞书产品团队与豆包产品团队整合，飞书 GTM 与火山引擎团队整合为新的 To B GTM 组织；飞书现有产品与服务保持不变。其变化不只是汇报线调整，而是把 AI 产品、企业协同入口、云 / 模型能力和商业化体系拉进更统一的组织体系。",
        ext("第一财经 / 经济观察网《字节跳动 To B 战略升级：飞书产品与 GTM 团队分别并入豆包与火山引擎》，2026-07-30"),
        ext("凤凰科技《字节跳动启动 AI 业务组织调整：飞书与豆包火山团队整合》，2026-07-30")
      ),
    ],
    why: "如果头部平台开始以「模型 / Agent + 协同入口 + 云服务 + GTM」一体化竞争，通用 Agent、办公协同和企业 AI 平台的中间价值层可能被快速压缩。对词元云集而言，在大厂开始收拢上述能力后，词元云集是否需要进一步上移竞争边界，把资源更集中在企业战略与经营系统，并主动弱化通用 Agent / 办公平台能力？",
    strategyRef: { id: "01-J12", statement: "TKOS 总体定义" },
    suggestion: S(
      "词元云集是否需要进一步上移竞争边界，把资源更集中在企业战略与经营系统，并主动弱化通用 Agent / 办公平台能力？",
      agent("您的 Agent · 待您判断")
    ),
    refs: [
      ext("第一财经 / 经济观察网《字节跳动 To B 战略升级：飞书产品与 GTM 团队分别并入豆包与火山引擎》，2026-07-30"),
      ext("凤凰科技《字节跳动启动 AI 业务组织调整：飞书与豆包火山团队整合》，2026-07-30"),
    ],
    domainIds: ["BIZ-TK"],
    createdAt: "2026-07-30T09:10:00+08:00",
    preResearchAt: "2026-07-30T09:26:00+08:00",
  },
  {
    id: "CARD-D2",
    issueId: "ISS-D2",
    headline: "Agent 组织管理正在基础设施化：TKOS 还靠什么形成长期壁垒？",
    source: { kind: "radar" },
    what: [
      S(
        "Paperclip 将自己定义为「管理 AI Agent 团队」的开源公司级运行层：用户可把不同 Agent / 运行环境组织成团队，并直接管理组织关系、目标、预算、治理和协作。它明确强调自己不是 Agent 框架或工作流架构师，而是在建模和运行「由 Agent 构成的公司」。",
        ext("Paperclip 官方 GitHub｜paperclipai/paperclip", "https://github.com/paperclipai/paperclip"),
        ext("Paperclip 官方文档｜What is Paperclip?")
      ),
    ],
    why: "这意味着「组织架构 + 目标 + 预算 + 基础治理 + Agent 协同」已经开始从前沿概念变成可复用、可开源的通用能力。如果多 Agent 的组织与治理层快速商品化，TKOS 是否应进一步把差异化集中到企业战略判断、经营 Context、真实责任与结果闭环，而不是把通用组织 / 编排能力本身当作长期壁垒？",
    strategyRef: { id: "01-J13", statement: "TKOS 四组成部分及职责边界" },
    suggestion: S(
      "TKOS 是否应进一步把差异化集中到企业战略判断、经营 Context、真实责任与结果闭环，而不是把通用组织 / 编排能力本身当作长期壁垒？",
      agent("您的 Agent · 待您判断")
    ),
    refs: [
      ext("Paperclip 官方 GitHub｜paperclipai/paperclip", "https://github.com/paperclipai/paperclip"),
      ext("Paperclip 官方文档｜What is Paperclip?"),
    ],
    domainIds: ["BIZ-TK"],
    createdAt: "2026-08-02T10:20:00+08:00",
    preResearchAt: "2026-08-02T10:35:00+08:00",
  },
  {
    id: "CARD-D3",
    issueId: "ISS-D3",
    headline:
      "AI 原生与转型客户 AI 成熟度不同、管理短板趋同：词元云集应如何形成差异化进入路径？",
    source: { kind: "dri", by: "内部经营扫描" },
    what: [
      S(
        "近期客户沟通中出现一个共性：无论传统企业还是 AI-native 企业，真正阻碍 AI 进一步创造企业价值的，都不只是技术能力，而是现有管理与组织方式没有同步升级。对传统企业而言，AI 应用本身仍在导入期，管理层首先需要回答的是：未来企业如何经营、组织如何重构、管理者与 Agent 如何重新分工，以及如何从现有状态逐步迁移到新的运行方式。单点工具的 bottom-up 推广很难解决这些问题，因此更需要从一号位开始的自上而下重构。",
        int("近期客户沟通与项目记录扫描；内部客户需求归纳")
      ),
      S(
        "对 AI-native 企业而言，产品、研发甚至交付已经高度 AI-native，但组织仍大量沿用为「人」设计的传统管理逻辑：目标如何传递、责任如何划分、人和 Agent 如何协同、管理者如何管理越来越多数字劳动力、AI 产生的判断和行动如何进入正式经营体系。技术已经跑在前面，管理能力反而成为新的瓶颈。",
        int("近期客户沟通与项目记录扫描；内部客户需求归纳")
      ),
    ],
    why: "这意味着两类客户可能对应的并不是两套完全不同的生意，而是同一个「AI 时代企业经营重构」命题的两个不同起点：传统企业需要从旧范式迁移到 AI-native，AI-native 企业则需要让管理范式追上已经 AI-native 的业务和产品。真正需要管理层进一步判断的是：词元云集应该建立什么统一的自上而下价值主张和方法底座，同时针对「AI 转型企业」与「AI-native 企业」分别设计怎样的进入路径、首要问题和价值证明。如果这一判断成立，它会直接影响目标客户分层、Re-arch 的方法、首个销售场景、TKOS 的共用能力以及未来案例复制方式。",
    strategyRef: {
      id: "01-J5",
      statement: "FDE 第一层 ｜ 战略重构——从老板认知与决策支持破冰",
    },
    suggestion: S(
      "词元云集应该建立什么统一的自上而下价值主张和方法底座，同时针对「AI 转型企业」与「AI-native 企业」分别设计怎样的进入路径、首要问题和价值证明？",
      agent("您的 Agent · 待您判断")
    ),
    refs: [int("近期客户沟通与项目记录扫描；内部客户需求归纳")],
    domainIds: ["BIZ-TK"],
    createdAt: "2026-08-11T16:40:00+08:00",
    preResearchAt: "2026-08-11T16:58:00+08:00",
  },
  {
    id: "CARD-D4",
    issueId: "ISS-D4",
    headline: "AI 开始拥有行动权：词元云集是否需要把「可信行动」纳入核心价值？",
    source: { kind: "ceo" },
    what: [
      S(
        "2026 年 7 月 28 日，Oasis Security 宣布已签署由 Cyera 收购的意向文件；外部报道将交易规模置于约 10 亿美元。更值得关注的是双方对交易逻辑的解释：AI Agent 正从试点进入生产并在关键系统中采取行动，企业需要同时控制「谁 / 什么获得访问」和「它能接触什么数据」。GES 的产业观察也将其概括为：AI 从聊天工具变成数字员工后，企业必须重新回答身份、权限、审计与责任。",
        ext("Oasis Security｜Building The Next-Generation AI Security Platform，2026-07-28"),
        ext("The Times of Israel｜Cyera / Oasis 约 10 亿美元交易报道，2026-07-28"),
        int("《Oasis - GES venture ref》")
      ),
    ],
    why: "这笔交易真正值得词元云集关注的，不是 AI Security 本身，而是 Agent 的角色正在从「提供答案」进入「代表人采取行动」。一旦 Agent 真正进入 CRM、财务、代码、审批和其他经营系统，企业采用 AI 的前提可能从「它够不够聪明」增加一层「我是否敢把行动权交给它」。对词元云集而言，企业 AI 规模化的核心门槛是否正在转向「企业敢不敢授权其行动」？如果是，词元云集是否需要把「可信、可控地让 AI 获得行动权」纳入 TKOS 的长期核心价值，而不是仅把它视为外部安全能力？",
    strategyRef: {
      id: "01-J7",
      statement: "FDE 第三层 ｜ 运营重构——部门人+Agent 新运营方式与数字岗位沉淀",
    },
    suggestion: S(
      "词元云集是否需要把「可信、可控地让 AI 获得行动权」纳入 TKOS 的长期核心价值，而不是仅把它视为外部安全能力？",
      agent("您的 Agent · 待您判断")
    ),
    refs: [
      ext("Oasis Security｜Building The Next-Generation AI Security Platform，2026-07-28"),
      int("《Oasis - GES venture ref》"),
      ext("The Times of Israel｜Cyera / Oasis 约 10 亿美元交易报道，2026-07-28"),
    ],
    domainIds: ["BIZ-TK"],
    createdAt: "2026-07-28T21:05:00+08:00",
    preResearchAt: "2026-07-28T21:41:00+08:00",
  },
];

export const digests = [
  { date: TODAY, cardIds: cards.map((c) => c.id) },
];

// ===========================================================================
// 02｜议题（Package 01 / 02）
// ===========================================================================

/**
 * 九件议题，三档。
 *
 *   Candidate    四条潜在议题（Package 01）—— 只出现在左上角那扇窗里
 *   Exploring    两件当前战略议题（Package 02 §01）
 *   Monitoring   三件已部署战略事项（Package 02 §02）—— 方向定了，现在压在 DRI 身上
 *
 * Package 02 §01 列的是三件当前战略议题，这里只种了两件：第三件就是 Oasis，而它要在
 * 演示当场由一号位从潜在议题升上来。升级之后中间那一列正好是三件。
 */
export const issues: Issue[] = [
  {
    id: "ISS-D1",
    title: "字节收拢飞书、豆包与火山：词元云集应在哪一层与大厂竞争？",
    state: "Candidate",
    origin: "signal",
    domainId: "BIZ-TK",
    judgmentRefs: ["01-J12"],
    nextActionForUser: null,
    raisedAt: "2026-07-30T09:10:00+08:00",
    updatedAt: "2026-07-30T09:26:00+08:00",
  },
  {
    id: "ISS-D2",
    title: "Agent 组织管理正在基础设施化：TKOS 还靠什么形成长期壁垒？",
    state: "Candidate",
    origin: "signal",
    domainId: "BIZ-TK",
    judgmentRefs: ["01-J13"],
    nextActionForUser: null,
    raisedAt: "2026-08-02T10:20:00+08:00",
    updatedAt: "2026-08-02T10:35:00+08:00",
  },
  {
    id: "ISS-D3",
    title:
      "AI 原生与转型客户 AI 成熟度不同、管理短板趋同：词元云集应如何形成差异化进入路径？",
    state: "Candidate",
    origin: "signal",
    domainId: "BIZ-TK",
    judgmentRefs: ["01-J5"],
    nextActionForUser: null,
    raisedAt: "2026-08-11T16:40:00+08:00",
    updatedAt: "2026-08-11T16:58:00+08:00",
  },
  {
    /*
     * Oasis —— 这场 demo 的主线，走的是**完整那条路**：
     *
     *   左上角雷达里的一张潜在议题卡
     *     → 点进去读预研、和参谋聊几句
     *     → 按「升级为议题」
     *     → 它落进「进行中」，进去就是对谈记录 + 沉淀下来的判断板
     *
     * 所以它种成 `Candidate`。报告、判断板、对谈记录全部预先备好 —— 升级那一下不跑
     * 任何模型，他一进去东西就在那儿。种成已升级会省事，代价是把这条路上最重要的
     * 那一下（一号位自己按下去）变成一张截图。
     *
     * 议题题目用 Package 02 首页清单里的那一句 —— 卡面标题是信号的措辞（「AI 开始
     * 拥有行动权」），议题标题是它作为战略议题的措辞，两者本来就不是一句话。
     */
    id: "ISS-D4",
    title:
      "Agent 规模化进入企业后，「企业敢不敢把权力交给 AI」是否会成为新的核心采用门槛？",
    state: "Candidate",
    origin: "signal",
    domainId: "BIZ-TK",
    judgmentRefs: ["01-J7"],
    nextActionForUser: null,
    raisedAt: "2026-07-28T21:05:00+08:00",
    updatedAt: "2026-08-13T17:25:00+08:00",
  },

  // --- 当前战略议题（Package 02 §01）------------------------------------
  {
    id: "ISS-D5",
    title:
      "002 客户｜下一轮客户沟通应如何设计，才能验证真实决策需求并推动项目进入下一阶段？",
    state: "Exploring",
    origin: "manual",
    domainId: "BIZ-TK",
    judgmentRefs: ["01-J5"],
    nextActionForUser: null,
    monitoringNote:
      "002 已完成初步客户研究，但下一轮沟通的目标、切入问题和信息深度仍需判断。",
    raisedAt: "2026-08-06T10:00:00+08:00",
    updatedAt: "2026-08-12T15:30:00+08:00",
  },
  {
    id: "ISS-D6",
    title:
      "组织激励｜下一阶段应采用什么期权方案，才能同时支撑核心人才长期绑定与公司后续扩张？",
    state: "Exploring",
    origin: "manual",
    domainId: "BIZ-TK",
    /*
     * 空的。本体里 07「人才与组织能力」域下还没有在版判断，包里也没说这件事在晃
     * 哪一句 —— 随手挂一条相近的，屏幕上就会出现一条根本没人押过的关联。
     */
    judgmentRefs: [],
    nextActionForUser: null,
    monitoringNote:
      "随着团队和核心责任逐步成型，需要确定期权池、授予对象、差异化原则与兑现机制。",
    raisedAt: "2026-08-04T09:20:00+08:00",
    updatedAt: "2026-08-11T11:05:00+08:00",
  },

  // --- 已部署战略事项（Package 02 §02）----------------------------------
  {
    id: "ISS-D7",
    /*
     * 短题。完整那一问（从哪里切入、经营什么业务、掌握哪些控制点）留在 `issueScopes`
     * 里当题设范围 —— 清单上的标题是**认领这件事用的名字**，和另外两件（TKOS 研发深化、
     * 灯塔项目推进）要一样长；一条横穿整行的问句摆在它们旁边，读起来像三件不同类的东西。
     */
    title: "整体战略定位",
    state: "Monitoring",
    origin: "manual",
    domainId: "BIZ-TK",
    judgmentRefs: ["01-J1", "01-J11"],
    nextActionForUser: null,
    monitoringNote: "总体战略定位与阶段路径已确认，进入闭环验证。",
    raisedAt: "2026-05-26T09:00:00+08:00",
    decidedAt: "2026-07-15T18:00:00+08:00",
    updatedAt: "2026-07-15T18:00:00+08:00",
  },
  {
    id: "ISS-D8",
    title: "TKOS 研发深化",
    state: "Monitoring",
    origin: "manual",
    domainId: "BIZ-TK",
    judgmentRefs: ["01-J13"],
    nextActionForUser: null,
    monitoringNote: "总体产品框架已确认，进入真实场景驱动的能力深化。",
    raisedAt: "2026-06-10T09:00:00+08:00",
    decidedAt: "2026-07-15T18:00:00+08:00",
    updatedAt: "2026-07-15T18:00:00+08:00",
  },
  {
    id: "ISS-D9",
    title: "灯塔项目推进",
    state: "Monitoring",
    origin: "manual",
    domainId: "BIZ-TK",
    judgmentRefs: ["01-J5"],
    nextActionForUser: null,
    monitoringNote: "总体方案与阶段路径已确认，进入首阶段方案形成与真实运行验证。",
    raisedAt: "2026-06-20T09:00:00+08:00",
    decidedAt: "2026-07-15T18:00:00+08:00",
    updatedAt: "2026-07-15T18:00:00+08:00",
  },
];

/**
 * 「进行中」那几件，自动深研都开着。
 *
 * `etaSeconds: 0` = **在跑，但给不出预估**。这两件的报告不在包里，所以没有一个真实的
 * 交付时刻可写；编一个倒计时，它会在演示中途走到 100% 然后什么也不发生。
 *
 * ISS-D4 不在这里：它的深研报告已经在包里（`researchDocs`），屏幕上写「已完成」。
 */
export const runningResearch: Record<string, { etaSeconds: number; elapsedAtLoad: number }> = {
  "ISS-D5": { etaSeconds: 0, elapsedAtLoad: 0 },
  "ISS-D6": { etaSeconds: 0, elapsedAtLoad: 0 },
};

/** 议题的题设范围。深研装配时带给模型，也是研究页头部那一行。 */
export const issueScopes: Record<string, string> = {
  "ISS-D4":
    "随着 Agent 从提供建议走向替企业完成真实工作，「企业是否敢把工作和责任交给 AI」会不会成为规模化部署的关键门槛？如果会，词元云集应把什么纳入自身长期能力，什么交给外部生态？",
  "ISS-D7":
    "在系统性 Token 工厂的长期愿景下，词元云集当前应从哪里切入、经营什么业务，并掌握哪些关键控制点，才能兼顾近期商业成立与长期战略价值？",
};

// ===========================================================================
// 03｜预研（Package 01）
// ===========================================================================

/**
 * 每条潜在议题一进来就自动跑一份预研，所以四条都有。
 *
 * Oasis 那份来自包里的《管理层研究报告》全文；另外三条包里只给到「事实 + 为什么值得
 * 判断 + 来源」，预研就照这三段装配 —— **不补一句包里没有的话**。三条读起来比 Oasis
 * 薄，那是材料本身的厚度差，不是这里省了工。
 */
export const preResearch: Record<string, PreResearchDoc> = {
  "ISS-D1": {
    issueId: "ISS-D1",
    status: "valid",
    statusReason: "",
    question: "词元云集应在哪一层与大厂竞争？",
    take: "字节这次调整不是汇报线变动，而是把 AI 产品、企业协同入口、云 / 模型能力和商业化体系拉进更统一的组织体系。\n\n如果头部平台开始以「模型 / Agent + 协同入口 + 云服务 + GTM」一体化竞争，通用 Agent、办公协同和企业 AI 平台的中间价值层可能被快速压缩。\n\n反问：在大厂开始收拢这些能力之后，我们还要不要留在这一层？",
    finding: [
      S(
        "2026 年 7 月 30 日，字节启动面向 AI 业务的组织调整：飞书产品团队与豆包产品团队整合，飞书 GTM 与火山引擎团队整合为新的 To B GTM 组织；飞书现有产品与服务保持不变。",
        ext("第一财经 / 经济观察网，2026-07-30"),
        ext("凤凰科技，2026-07-30")
      ),
    ],
    openQuestion: [
      S(
        "词元云集是否需要进一步上移竞争边界，把资源更集中在企业战略与经营系统，并主动弱化通用 Agent / 办公平台能力？",
        agent("您的 Agent · 预研未答")
      ),
    ],
    soWhat:
      "中间价值层是否会被压缩，决定我们把资源放在哪一层 —— 值得升级为议题。",
    byAgentLabel: AGENT_LABEL,
    assembledFrom: [
      { label: "第一财经 / 经济观察网，2026-07-30", kind: "ext" },
      { label: "凤凰科技，2026-07-30", kind: "ext" },
      { label: "01-J12 TKOS 总体定义", kind: "judgment", href: "/judgments/01-J12" },
    ],
    at: "2026-07-30T09:26:00+08:00",
  },

  "ISS-D2": {
    issueId: "ISS-D2",
    status: "valid",
    statusReason: "",
    question: "TKOS 还靠什么形成长期壁垒？",
    take: "「组织架构 + 目标 + 预算 + 基础治理 + Agent 协同」已经开始从前沿概念变成可复用、可开源的通用能力。\n\nPaperclip 明确强调自己不是 Agent 框架或工作流架构师，而是在建模和运行「由 Agent 构成的公司」—— 这正是我们过去默认属于自己的那一层。\n\n反问：如果这一层被开源商品化，我们的差异化还剩什么？",
    finding: [
      S(
        "Paperclip 将自己定义为「管理 AI Agent 团队」的开源公司级运行层：用户可把不同 Agent / 运行环境组织成团队，并直接管理组织关系、目标、预算、治理和协作。",
        ext("Paperclip 官方 GitHub｜paperclipai/paperclip", "https://github.com/paperclipai/paperclip"),
        ext("Paperclip 官方文档｜What is Paperclip?")
      ),
    ],
    openQuestion: [
      S(
        "TKOS 是否应进一步把差异化集中到企业战略判断、经营 Context、真实责任与结果闭环，而不是把通用组织 / 编排能力本身当作长期壁垒？",
        agent("您的 Agent · 预研未答")
      ),
    ],
    soWhat:
      "多 Agent 的组织与治理层如果快速商品化，壁垒的位置要重新划 —— 值得升级为议题。",
    byAgentLabel: AGENT_LABEL,
    assembledFrom: [
      { label: "Paperclip 官方 GitHub", kind: "ext", href: "https://github.com/paperclipai/paperclip" },
      { label: "Paperclip 官方文档｜What is Paperclip?", kind: "ext" },
      { label: "01-J13 TKOS 四组成部分及职责边界", kind: "judgment", href: "/judgments/01-J13" },
    ],
    at: "2026-08-02T10:35:00+08:00",
  },

  "ISS-D3": {
    issueId: "ISS-D3",
    status: "valid",
    statusReason: "",
    question: "词元云集应如何形成差异化进入路径？",
    take: "两类客户可能对应的并不是两套完全不同的生意，而是同一个「AI 时代企业经营重构」命题的两个不同起点：传统企业需要从旧范式迁移到 AI-native，AI-native 企业则需要让管理范式追上已经 AI-native 的业务和产品。\n\n如果这一判断成立，它会直接影响目标客户分层、Re-arch 的方法、首个销售场景、TKOS 的共用能力以及未来案例复制方式。\n\n反问：统一的价值主张和分开的进入路径，能不能同时成立？",
    finding: [
      S(
        "对传统企业而言，AI 应用本身仍在导入期，管理层首先需要回答的是：未来企业如何经营、组织如何重构、管理者与 Agent 如何重新分工，以及如何从现有状态逐步迁移到新的运行方式。单点工具的 bottom-up 推广很难解决这些问题，因此更需要从一号位开始的自上而下重构。",
        int("近期客户沟通与项目记录扫描")
      ),
      S(
        "对 AI-native 企业而言，产品、研发甚至交付已经高度 AI-native，但组织仍大量沿用为「人」设计的传统管理逻辑。技术已经跑在前面，管理能力反而成为新的瓶颈。",
        int("内部客户需求归纳")
      ),
    ],
    openQuestion: [
      S(
        "词元云集应该建立什么统一的自上而下价值主张和方法底座，同时针对「AI 转型企业」与「AI-native 企业」分别设计怎样的进入路径、首要问题和价值证明？",
        agent("您的 Agent · 预研未答")
      ),
    ],
    soWhat:
      "它会直接影响目标客户分层、Re-arch 的方法、首个销售场景与案例复制方式 —— 值得升级为议题。",
    byAgentLabel: AGENT_LABEL,
    assembledFrom: [
      { label: "近期客户沟通与项目记录扫描", kind: "int" },
      { label: "内部客户需求归纳", kind: "int" },
      {
        label: "01-J5 FDE 第一层｜战略重构",
        kind: "judgment",
        href: "/judgments/01-J5",
      },
    ],
    at: "2026-08-11T16:58:00+08:00",
  },

  "ISS-D4": {
    issueId: "ISS-D4",
    status: "valid",
    statusReason: "",
    question:
      "企业 AI 规模化的关键约束是否正在从模型能力转向「可信授权与责任控制」；如果这一变化成立，词元云集应该把什么纳入长期核心能力、什么留给安全生态？",
    take: "当前证据支持把「可信、可控地让 AI 获得行动权」纳入 TKOS 的长期价值主张与核心控制原则，但不支持词元云集进入机器身份安全赛道。\n\nOasis 与 Cyera 的结合说明：当 Agent 从问答进入跨系统行动，企业采用的关键约束开始从「AI 是否够聪明」转向「谁授权、谁负责、能否追溯」。词元云集应掌握与经营 Context 相连的授权逻辑与行动证据，底层身份、安全凭证与威胁检测优先依赖成熟生态。\n\n反问：如果客户现有平台已经能完整回答「谁能让 AI 做什么」，我们这一层还剩什么？",
    finding: [
      S(
        "Oasis / Cyera 的价值不在一笔安全并购，而在「身份 + 数据」正被组合成 Agent 时代的信任基础设施。过去权限主要绑定员工和长期账号；Agent 则可能在短时间内被创建、执行跨系统任务并退出，传统静态身份模型很难完整解释这种行动。",
        ext("Oasis Security, Building The Next-Generation AI Security Platform, 2026-07-28"),
        ext("CRN, 2026")
      ),
      S(
        "企业部署 Agent 的瓶颈正在从「能力不足」转向「组织无法放心授权」。CSA 与 Oasis 的 2026 调研覆盖 383 名 IT 与安全专业人士：78% 的组织尚未建立正式的 AI Identity 创建 / 删除政策，92% 的受访者对传统 IAM 能否有效管理 AI 与非人类身份风险缺乏信心。",
        ext("Cloud Security Alliance / Oasis Security, The State of Non-Human Identity and AI Security, 2026-01")
      ),
      S(
        "这与词元云集直接相关，但公司的机会在「经营授权」，不是复制安全产品。Oasis 的强项是非人类身份发现、权限治理、凭证生命周期与安全控制；词元云集更独特的位置，是理解一次行动为什么发生：它服务哪个 Strategic Issue / Mission，由谁负责，对什么经营对象产生影响，何时必须由人确认，结果如何沉淀为 Evidence。",
        ext("Oasis AAM 官方材料"),
        int("TKOS Method / Agents / Engine&Ontology")
      ),
    ],
    openQuestion: [
      S(
        "最强反方不是「安全不重要」，而是这层能力可能被大平台标准化：Microsoft、云厂商和 IAM / Security 平台可能快速把 Agent Identity、短期授权与审计做成企业基础设施；如果这些平台还能承载足够的业务 Context，词元云集需要自建的控制层可以进一步变薄。",
        agent("您的 Agent · 预研未答")
      ),
      S(
        "未来 6–12 个月大量企业 Agent 仍可能停留在研究、建议与人工确认阶段；如果真实客户并不把「授权 AI 行动」视为近期采用瓶颈，提前重投入会造成阶段性过度建设。",
        agent("您的 Agent · 预研未答")
      ),
    ],
    soWhat:
      "现阶段最合理的选择不是「做或不做安全」，而是把受控行动确立为长期产品原则，同时让真实经营场景决定建设深度 —— 值得升级为议题。",
    byAgentLabel: AGENT_LABEL,
    assembledFrom: [
      { label: "Oasis Security, Building The Next-Generation AI Security Platform, 2026-07-28", kind: "ext" },
      { label: "CSA / Oasis, The State of Non-Human Identity and AI Security, 2026-01", kind: "ext" },
      { label: "《Oasis - GES venture ref》", kind: "int" },
      { label: "《Oasis_Security_管理层研究报告》", kind: "int" },
      {
        label: "01-J7 FDE 第三层｜运营重构",
        kind: "judgment",
        href: "/judgments/01-J7",
      },
    ],
    at: "2026-07-28T21:41:00+08:00",
  },
};

// ===========================================================================
// 04｜深研报告（Package 04a）
// ===========================================================================

/**
 * Package 04a 全文，一字未改。
 *
 * 一份原文，两处用：`researchDocs["ISS-D4"].sourceText`（报告原文页签默认给的就是它）
 * 与 `DOC-D4`（文档库里的那份）。抽成常量而不是抄两遍 —— 抄两遍之后，改一处就会
 * 出现「报告里是这么写的、文档库里不是」，而这正是「原文」这个东西存在的意义要防的事。
 *
 * 段落用空行分隔，`## ` 开头是小标题。
 */
const OASIS_REPORT_SOURCE = [
      "## 企业 AI 的下一道门槛，是企业是否愿意把真实工作交给 Agent",
      "Strategic Issue｜随着 Agent 从提供建议走向替企业完成真实工作，「企业是否敢把工作和责任交给 AI」会不会成为规模化部署的关键门槛？如果会，词元云集应把什么纳入自身长期能力，什么交给外部生态？",
      "## Executive Summary｜核心观点",
      "核心观点｜Oasis 的真正信号不是出现了一个新的安全赛道，而是企业 AI 正从「会不会用」进入「敢不敢把真实工作交给 AI」的阶段。当 Agent 只是给建议，企业主要关心效果；当 Agent 开始代表员工和管理者完成真实工作，企业就必须同时管理责任、授权边界和结果追溯。对词元云集而言，这意味着「受控地把工作交给 AI」应成为 TKOS 的长期设计原则，但目前不构成进入安全业务的理由。",
      "1｜数字劳动力的扩张取决于企业愿意交出多少真实工作，而不只取决于模型有多聪明｜2026 年多项企业调研显示，Agent 使用正在加速，但企业对「有哪些 Agent 在工作、谁负责、发生问题如何追溯」仍缺乏成熟机制。[1][2][3] 这会直接限制企业把更重要的工作交给 AI。",
      "2｜Cyera 约 10 亿美元收购 Oasis，反映企业开始为「控制数字劳动力」付出真实预算｜Oasis 解决的不是模型效果，而是让企业知道有哪些非人工作主体、由谁负责、能做什么、何时停止，以及出了问题能否追溯；Cyera 将其与数据安全结合，说明「让 AI 做事」和「确保企业仍有控制权」正在成为同一类管理问题。[4][5]",
      "3｜这首先是行业机会，不自动等于词元云集应进入安全赛道｜Microsoft、Google、Okta 都在把 Agent 身份与治理纳入自身平台。[6][7][8] 通用身份、安全和访问管理大概率会快速基础设施化；词元云集没有必要复制这部分能力。",
      "4｜词元云集的公司机会在更靠近经营的一层：让客户知道「哪些工作可以交给 AI、由谁授权、何时必须由人接管」｜这与词元云集从一号位向管理者和数字劳动力扩展的战略直接相关。若 TKOS 只能让 Agent 更聪明，却不能让企业放心扩大其工作范围，产品就容易停留在助手层；反之，若能把组织责任、经营任务与 Agent 行动连接起来，TKOS 才有机会成为企业持续运行系统。",
      "需持续观察的变化｜如果未来 6–12 个月企业仍主要把 Agent 用于研究、建议和内容生成，真正阻碍部署的仍是效果与投入产出，而不是责任和授权；或者客户现有平台已经能够完整解决「谁能让 AI 做什么」的经营问题，那么词元云集应继续缩小该能力的自建范围。",
      "管理层需要判断｜是否确认「受控地把工作交给 AI」是 TKOS 的长期产品原则；是否确认词元云集只掌握经营层的授权与责任关系，不进入完整安全赛道；是否同意近期仅用真实客户场景验证，而不设立独立安全产品线。",
      "## 01｜企业正在从「试用 AI」进入「交付真实工作」，责任与授权开始限制部署深度",
      "核心判断｜企业真正扩大 Agent 使用的关键，不只是模型效果继续提升，而是能否把工作交出去之后仍保持管理控制。",
      "过去，AI 出错通常意味着一份错误答案；未来，AI 出错可能意味着客户被误联系、业务数据被改动、审批被错误推进或关键流程被中断。因此，一旦 Agent 开始承担真实工作，管理层会自然追问：谁让它做、它代表谁、哪些事可以自己决定、哪些必须让人接手，以及结果能否被复盘。",
      "公开调研已经显示：Agent 增长速度快于企业对其责任和边界的管理成熟度。92% 的受访者对现有身份体系管理 AI / 非人工作主体风险缺乏信心；78% 的组织尚无正式 AI 身份创建与退出政策。[1] 很多企业已经开始使用 Agent，但没有形成与员工类似的「谁负责、何时进入、何时退出」的管理规则 —— 企业可能愿意试用，但不会轻易把关键工作持续交给 AI。",
      "73% 的组织预计 Agent 未来一年会变得重要；68% 仍无法清楚区分某项操作来自人还是 Agent。[2] Agent 正从实验走向日常工作，但管理者对实际行动主体仍缺乏透明度 —— 责任不清会限制 Agent 从辅助工作进入需要承担后果的工作。",
      "82% 的企业报告存在未知 AI Agent；65% 报告过去一年发生过 Agent 相关事件。[3] 企业内部 Agent 的增长已经出现「先使用、后治理」的特征 —— 越是扩大使用，越需要把 Agent 纳入企业正常的责任、授权和复盘机制。",
      "关键洞察｜数字劳动力不会因为模型成熟就自然进入企业。更可能的路径是：企业先验证效果，再逐步交出工作；每扩大一层工作范围，都要求更清楚的责任和边界。",
      "注：上述调研以 IT / 安全专业人士为主要样本，本报告将其作为方向性 Evidence，不用于估算整体市场规模。",
      "## 02｜Oasis 的 10 亿美元信号，本质是企业开始为「数字劳动力可控」付出真实预算",
      "核心判断｜Oasis 的商业价值不是给 Agent 增加一个账号，而是把快速增长、难以看见的「数字工作主体」重新放回企业正常的责任与控制体系。",
      "从业务视角看，Oasis 帮企业回答五件事：[4] 企业里究竟有哪些 Agent、自动化程序和机器身份正在工作；每一个由谁负责、服务于什么业务用途；它被允许接触哪些数据和系统，权限是否过大或长期不再需要；任务结束、人员变化或风险出现后，权限能否及时收回；出现问题时，企业能否追到责任人、行动过程与影响范围。",
      "2026 年 7 月，Oasis 宣布已签署被 Cyera 收购的意向文件；公开报道的交易规模约 10 亿美元。[5] Cyera 关注企业敏感数据在哪里、是否被暴露；Oasis 关注哪些非人工作主体正在使用这些数据、由谁负责。两者结合说明，企业开始把「AI 能做什么」和「企业如何继续掌控重要数据与行动」视为同一个经营风险。",
      "关键洞察｜这笔交易不能证明词元云集应该做安全，也不能单独证明市场规模；它更重要的意义是：当 AI 从软件工具变成数字劳动力，企业愿意为「控制权」付出独立预算。",
      "但行业机会不等于词元云集机会：通用安全能力正在被平台厂商快速标准化。Microsoft 已将 Agent 身份与治理纳入 Entra[6] —— 大型企业会优先沿用已有企业身份与安全体系，底层身份与安全不是词元云集应重复建设的差异化。Google Cloud 推出 Agent Identity / Agent Gateway[7] —— 云平台正在把 Agent 纳入企业既有治理边界，基础控制能力会越来越像标准基础设施。Okta 推出面向 AI Agent 的治理能力[8] —— 专业身份厂商也在快速补齐 Agent 场景，词元云集更应把资源放在其最了解的经营与组织层。",
      "## 03｜词元云集真正需要掌握的是「企业如何把工作交给 AI」，而不是「如何做安全」",
      "核心判断｜如果词元云集要从一号位 Agent 扩展到管理者和数字劳动力，就必须把「工作如何被授权、责任如何落到人、什么时候人必须介入、结果如何回到经营闭环」掌握在自己手里。这是企业经营系统的一部分；身份认证、凭证、威胁检测等通用安全能力可以由外部生态提供。",
      "从 CEO 视角，真正需要控制的是四个经营问题。谁可以代表公司把这项工作交给 AI？词元云集必须知道责任人、角色、业务目标，以及谁最终对结果负责；人员与 Agent 的基础身份确认可由外部生态承接。",
      "这次到底允许 AI 做到什么程度？词元云集必须知道这项工作为什么要做、允许完成到哪一步、什么情况必须让人接手；对底层系统和数据的访问控制可由外部生态承接。",
      "什么后果不能由 AI 自主承担？词元云集必须知道重要风险、审批和人类确认边界；基础安全策略与异常拦截可由外部生态承接。",
      "做完之后管理层怎么知道结果？词元云集必须知道行动是否完成、产生什么结果、是否需要调整原有判断或任务；系统日志与基础审计记录可由外部生态承接。",
      "这对词元云集的经营价值，是把 AI 从「辅助工具」推进到「可持续承担真实工作」。经营对象：企业把哪些真实工作交给 AI，以及这些工作边界如何随着信任逐步扩大。客户价值：客户能够在不失去管理控制的前提下，把更多重复、跨系统或跨角色工作交给数字劳动力。收入模式：不单独销售「安全产品」；通过更深的 TKOS 部署、更多管理角色与业务单元扩展、持续使用形成收入。核心能力：理解客户组织责任和经营任务；把谁能授权、AI 能做到哪一步、何时需要人介入、结果如何复盘连成同一套经营规则。经营指标：客户愿意交给 Agent 的真实工作范围和业务重要性是否扩大；从一号位向管理者 / 数字劳动力的部署是否扩展；重大异常是否可复盘。长期壁垒：长期积累的企业经营关系、责任分工、任务判断和真实行动记录，会比通用身份技术更贴近客户日常经营，也更难脱离 TKOS 单独替换。",
      "## 04｜最佳路径是「经营控制自有、安全能力生态化」，当前只做真实场景验证",
      "核心判断｜词元云集既不应把这一问题完全交给外部安全系统，也不应建立新的安全产品线；应保留与客户经营和组织责任直接相关的控制，并复用成熟安全基础设施。",
      "A｜全部交给安全生态。现实价值：投入最小、部署快。停留于此的局限：外部系统能控制「能不能访问」，但 TKOS 难以掌握「为什么允许这项工作、谁对结果负责」；产品容易停在助手层。判断：不建议。",
      "B｜自建完整安全能力。现实价值：控制最完整。停留于此的局限：偏离核心业务，并与 Microsoft、Google、Okta 和专业安全公司正面竞争。判断：不建议。",
      "C｜经营控制自有 + 安全生态承接。现实价值：既保留 TKOS 与经营责任的连接，又利用成熟安全能力。停留于此的局限：需要真实客户证明，这层经营控制确实决定客户是否愿意把更多工作交给 AI。判断：推荐。",
      "当前阶段不需要「做一套安全产品」，只需要验证两个战略假设。H1｜「敢不敢授权」是否真的限制客户扩大 Agent 使用。所需证据：选择一个业务价值明确、Agent 能力也已基本满足，但客户仍不愿交给 AI 自主完成的真实工作；追问阻力来源。通过标准：责任、授权和追溯被客户明确列为扩大 Agent 工作范围的前置条件。下一步决策：提升为近期产品优先级；否则仅保留长期原则。",
      "H2｜词元云集掌握的经营信息和责任关系是否具有独立价值。所需证据：用同一个真实工作验证 —— 仅靠已有安全体系，管理者是否仍无法回答「为什么让 AI 做、谁负责、什么情况下暂停」。通过标准：加入组织责任和经营任务后，客户愿意扩大授权范围，且管理者能清楚复盘。下一步决策：确认该层是 TKOS 控制点；否则进一步依赖生态。",
      "## 05｜管理层建议：确认长期原则和公司边界，暂不新增独立业务投入",
      "建议｜确认「受控地把工作交给 AI」是 TKOS 的长期产品原则；词元云集掌握与经营目标、组织责任和结果复盘相关的控制，通用身份与安全能力由生态承接。近期仅用一个真实高价值场景验证，不成立独立安全产品线，也不以 Oasis 为竞品目标。",
      "最强反方与关键未知：客户真正限制 Agent 的原因可能仍是效果、投入产出和系统可用性；责任与授权只是上线后的合规要求，而不是扩大部署的核心门槛。大型平台未来可能不仅提供身份和安全，也直接吸收更多业务流程与责任信息，使词元云集可掌握的独立控制层变薄。客户是否会为这层能力单独付费尚无证据 —— 更合理的近期判断标准是：它是否帮助 TKOS 从一号位向更多角色和真实工作扩展，而不是先假设新的收入品类。",
      "需要 CEO / 管理层判断：是否认可，企业 AI 下一阶段的重要竞争之一，是谁能让企业放心把更多真实工作交给 AI，而不仅是谁的 Agent 更聪明？是否认可，词元云集应把「受控地把工作交给 AI」纳入 TKOS 长期产品原则，但不进入完整安全赛道？是否认可，近期只做一个真实场景验证；只有客户明确把责任、授权和可追溯视为扩大 Agent 使用的前置条件，才升级投入？",
      "## 附录：信息来源",
      "[1] CSA / Oasis Security, The State of Non-Human Identity and AI Security, 2026-01.",
      "[2] CSA, More Than Two-Thirds of Organizations Cannot Clearly Distinguish AI Agent from Human Actions, 2026-03.",
      "[3] CSA, 82% of Enterprises Have Unknown AI Agents in Their Environments, 2026-04.",
      "[4] Oasis Security, What Is / Introducing Agentic Access Management, 2025-11.",
      "[5] Oasis Security, Building The Next-Generation AI Security Platform; WSJ / CRN acquisition coverage, 2026-07.",
      "[6] Microsoft, Entra Agent ID official documentation and GA announcement, 2026-05/06.",
      "[7] Google Cloud, Agent Identity / Agent Gateway official announcements, 2026-04/05.",
      "[8] Okta, Okta for AI Agents official product and GA announcement, 2026-04.",
      "公司内部资料｜TKOS Core、Strategy Overview、Business Model Overview、M1-A Content Quality 101（2026-08-12）及原 Oasis Security 研究稿。",
].join("\n\n");


/**
 * Oasis 深研，整份照录。
 *
 * ## 四节装不下一份九节的报告，所以先说清楚哪一节收了什么
 *
 *   judgment      Executive Summary 的核心观点与四条要点，加 §03 / §04 的核心判断。
 *                 每条保留包里「小标题｜正文」的双段结构 —— 拆开之后正文会失去主语。
 *   keyEvidence   §01 的三行调研、§02 的 Oasis 五问与 Cyera 交易、平台厂商三行、
 *                 §03 的 CEO 四问与经营价值六维度。
 *   counters      §05「最强反方与关键未知」三条，一字未改。
 *   unknowns      §04 的 H1 / H2（含所需证据、通过标准、下一步决策）与 Exec Summary
 *                 的「需持续观察的变化」。
 *   route         §05 的管理层建议。
 *
 * 装不进这五格的部分 —— A/B/C 三条路径的完整对照、「需要 CEO 判断」那三问、八条
 * 参考来源 —— 在 `DOC-D4` 里，报告的装配清单第一条就是它，点得开。**没有任何一段
 * 被丢掉**：四节是给一号位读的压缩面，全文是他起疑时翻的东西。
 */
export const researchDocs: Record<string, ResearchDoc> = {
  "ISS-D4": {
    issueId: "ISS-D4",
    judgment: [
      S(
        "核心观点｜Oasis 的真正信号不是出现了一个新的安全赛道，而是企业 AI 正从「会不会用」进入「敢不敢把真实工作交给 AI」的阶段。当 Agent 只是给建议，企业主要关心效果；当 Agent 开始代表员工和管理者完成真实工作，企业就必须同时管理责任、授权边界和结果追溯。对词元云集而言，这意味着「受控地把工作交给 AI」应成为 TKOS 的长期设计原则，但目前不构成进入安全业务的理由。",
        int("《Oasis Security 对词元云集的战略含义｜管理层研究版》Executive Summary", "/docs/DOC-D4")
      ),
      S(
        "1｜数字劳动力的扩张取决于企业愿意交出多少真实工作，而不只取决于模型有多聪明｜2026 年多项企业调研显示，Agent 使用正在加速，但企业对「有哪些 Agent 在工作、谁负责、发生问题如何追溯」仍缺乏成熟机制。这会直接限制企业把更重要的工作交给 AI。",
        ext("CSA / Oasis Security, The State of Non-Human Identity and AI Security, 2026-01"),
        ext("CSA, More Than Two-Thirds of Organizations Cannot Clearly Distinguish AI Agent from Human Actions, 2026-03"),
        ext("CSA, 82% of Enterprises Have Unknown AI Agents in Their Environments, 2026-04")
      ),
      S(
        "2｜Cyera 约 10 亿美元收购 Oasis，反映企业开始为「控制数字劳动力」付出真实预算｜Oasis 解决的不是模型效果，而是让企业知道有哪些非人工作主体、由谁负责、能做什么、何时停止，以及出了问题能否追溯；Cyera 将其与数据安全结合，说明「让 AI 做事」和「确保企业仍有控制权」正在成为同一类管理问题。",
        ext("Oasis Security, What Is / Introducing Agentic Access Management, 2025-11"),
        ext("Oasis Security, Building The Next-Generation AI Security Platform；WSJ / CRN 收购报道, 2026-07")
      ),
      S(
        "3｜这首先是行业机会，不自动等于词元云集应进入安全赛道｜Microsoft、Google、Okta 都在把 Agent 身份与治理纳入自身平台。通用身份、安全和访问管理大概率会快速基础设施化；词元云集没有必要复制这部分能力。",
        ext("Microsoft, Entra Agent ID official documentation and GA announcement, 2026-05/06"),
        ext("Google Cloud, Agent Identity / Agent Gateway official announcements, 2026-04/05"),
        ext("Okta, Okta for AI Agents official product and GA announcement, 2026-04")
      ),
      S(
        "4｜词元云集的公司机会在更靠近经营的一层：让客户知道「哪些工作可以交给 AI、由谁授权、何时必须由人接管」｜这与词元云集从一号位向管理者和数字劳动力扩展的战略直接相关。若 TKOS 只能让 Agent 更聪明，却不能让企业放心扩大其工作范围，产品就容易停留在助手层；反之，若能把组织责任、经营任务与 Agent 行动连接起来，TKOS 才有机会成为企业持续运行系统。",
        int("TKOS Core / Strategy Overview / Business Model Overview，2026-08-12")
      ),
      S(
        "§03 核心判断｜如果词元云集要从一号位 Agent 扩展到管理者和数字劳动力，就必须把「工作如何被授权、责任如何落到人、什么时候人必须介入、结果如何回到经营闭环」掌握在自己手里。这是企业经营系统的一部分；身份认证、凭证、威胁检测等通用安全能力可以由外部生态提供。",
        int("《Oasis Security 对词元云集的战略含义》§03", "/docs/DOC-D4")
      ),
      S(
        "§04 核心判断｜词元云集既不应把这一问题完全交给外部安全系统，也不应建立新的安全产品线；应保留与客户经营和组织责任直接相关的控制，并复用成熟安全基础设施。三条路径对照下来：A 全部交给安全生态，投入最小、部署快，但外部系统只能控制「能不能访问」，TKOS 难以掌握「为什么允许这项工作、谁对结果负责」，产品容易停在助手层 —— 不建议；B 自建完整安全能力，控制最完整，但偏离核心业务，并与 Microsoft、Google、Okta 和专业安全公司正面竞争 —— 不建议；C 经营控制自有 + 安全生态承接，既保留 TKOS 与经营责任的连接，又利用成熟安全能力，代价是需要真实客户证明这层经营控制确实决定客户是否愿意把更多工作交给 AI —— 推荐。",
        int("《Oasis Security 对词元云集的战略含义》§04 路径对照表", "/docs/DOC-D4")
      ),
    ],
    keyEvidence: [
      S(
        "92% 的受访者对现有身份体系管理 AI / 非人工作主体风险缺乏信心；78% 的组织尚无正式 AI 身份创建与退出政策。说明很多企业已经开始使用 Agent，但没有形成与员工类似的「谁负责、何时进入、何时退出」的管理规则 —— 企业可能愿意试用，但不会轻易把关键工作持续交给 AI。",
        ext("CSA / Oasis Security, The State of Non-Human Identity and AI Security, 2026-01")
      ),
      S(
        "73% 的组织预计 Agent 未来一年会变得重要；68% 仍无法清楚区分某项操作来自人还是 Agent。说明 Agent 正从实验走向日常工作，但管理者对实际行动主体仍缺乏透明度 —— 责任不清会限制 Agent 从辅助工作进入需要承担后果的工作。",
        ext("CSA, More Than Two-Thirds of Organizations Cannot Clearly Distinguish AI Agent from Human Actions, 2026-03")
      ),
      S(
        "82% 的企业报告存在未知 AI Agent；65% 报告过去一年发生过 Agent 相关事件。说明企业内部 Agent 的增长已经出现「先使用、后治理」的特征 —— 越是扩大使用，越需要把 Agent 纳入企业正常的责任、授权和复盘机制。",
        ext("CSA, 82% of Enterprises Have Unknown AI Agents in Their Environments, 2026-04")
      ),
      S(
        "从业务视角看，Oasis 帮企业回答五件事：企业里究竟有哪些 Agent、自动化程序和机器身份正在工作；每一个由谁负责、服务于什么业务用途；它被允许接触哪些数据和系统，权限是否过大或长期不再需要；任务结束、人员变化或风险出现后，权限能否及时收回；出现问题时，企业能否追到责任人、行动过程与影响范围。",
        ext("Oasis Security, What Is / Introducing Agentic Access Management, 2025-11")
      ),
      S(
        "2026 年 7 月，Oasis 宣布已签署被 Cyera 收购的意向文件；公开报道的交易规模约 10 亿美元。Cyera 关注企业敏感数据在哪里、是否被暴露；Oasis 关注哪些非人工作主体正在使用这些数据、由谁负责。两者结合说明，企业开始把「AI 能做什么」和「企业如何继续掌控重要数据与行动」视为同一个经营风险。",
        ext("Oasis Security, Building The Next-Generation AI Security Platform；WSJ / CRN 收购报道, 2026-07")
      ),
      S(
        "通用安全能力正在被平台厂商快速标准化：Microsoft 已将 Agent 身份与治理纳入 Entra —— 大型企业会优先沿用已有企业身份与安全体系，底层身份与安全不是词元云集应重复建设的差异化；Google Cloud 推出 Agent Identity / Agent Gateway —— 云平台正在把 Agent 纳入企业既有治理边界，基础控制能力会越来越像标准基础设施；Okta 推出面向 AI Agent 的治理能力 —— 专业身份厂商也在快速补齐 Agent 场景，词元云集更应把资源放在其最了解的经营与组织层。",
        ext("Microsoft Entra Agent ID, 2026-05/06"),
        ext("Google Cloud Agent Identity / Agent Gateway, 2026-04/05"),
        ext("Okta for AI Agents, 2026-04")
      ),
      S(
        "从 CEO 视角，真正需要控制的是四个经营问题：谁可以代表公司把这项工作交给 AI —— 词元云集必须知道责任人、角色、业务目标以及谁最终对结果负责，人员与 Agent 的基础身份确认可由生态承接；这次到底允许 AI 做到什么程度 —— 必须知道这项工作为什么要做、允许完成到哪一步、什么情况必须让人接手，对底层系统和数据的访问控制由生态承接；什么后果不能由 AI 自主承担 —— 必须知道重要风险、审批和人类确认边界，基础安全策略与异常拦截由生态承接；做完之后管理层怎么知道结果 —— 必须知道行动是否完成、产生什么结果、是否需要调整原有判断或任务，系统日志与基础审计记录由生态承接。",
        int("《Oasis Security 对词元云集的战略含义》§03 CEO 四问表", "/docs/DOC-D4")
      ),
      S(
        "这对词元云集的经营价值，是把 AI 从「辅助工具」推进到「可持续承担真实工作」：经营对象是企业把哪些真实工作交给 AI，以及这些工作边界如何随着信任逐步扩大；客户价值是客户能够在不失去管理控制的前提下，把更多重复、跨系统或跨角色工作交给数字劳动力；收入模式不单独销售「安全产品」，通过更深的 TKOS 部署、更多管理角色与业务单元扩展、持续使用形成收入；核心能力是理解客户组织责任和经营任务，把谁能授权、AI 能做到哪一步、何时需要人介入、结果如何复盘连成同一套经营规则；经营指标是客户愿意交给 Agent 的真实工作范围和业务重要性是否扩大、从一号位向管理者 / 数字劳动力的部署是否扩展、重大异常是否可复盘；长期壁垒是长期积累的企业经营关系、责任分工、任务判断和真实行动记录，会比通用身份技术更贴近客户日常经营，也更难脱离 TKOS 单独替换。",
        int("《Oasis Security 对词元云集的战略含义》§03 经营价值表", "/docs/DOC-D4")
      ),
      S(
        "关键洞察｜数字劳动力不会因为模型成熟就自然进入企业。更可能的路径是：企业先验证效果，再逐步交出工作；每扩大一层工作范围，都要求更清楚的责任和边界。注：上述调研以 IT / 安全专业人士为主要样本，本报告将其作为方向性 Evidence，不用于估算整体市场规模。",
        int("《Oasis Security 对词元云集的战略含义》§01", "/docs/DOC-D4")
      ),
    ],
    counters: [
      S(
        "客户真正限制 Agent 的原因可能仍是效果、投入产出和系统可用性；责任与授权只是上线后的合规要求，而不是扩大部署的核心门槛。",
        int("《Oasis Security 对词元云集的战略含义》最强反方与关键未知", "/docs/DOC-D4")
      ),
      S(
        "大型平台未来可能不仅提供身份和安全，也直接吸收更多业务流程与责任信息，使词元云集可掌握的独立控制层变薄。",
        ext("Microsoft / Google / Okta 的同步动作")
      ),
      S(
        "客户是否会为这层能力单独付费尚无证据。更合理的近期判断标准是：它是否帮助 TKOS 从一号位向更多角色和真实工作扩展，而不是先假设新的收入品类。",
        int("《Oasis Security 对词元云集的战略含义》最强反方与关键未知", "/docs/DOC-D4")
      ),
    ],
    unknowns: [
      S(
        "H1｜「敢不敢授权」是否真的限制客户扩大 Agent 使用。所需证据：选择一个业务价值明确、Agent 能力也已基本满足，但客户仍不愿交给 AI 自主完成的真实工作，追问阻力来源。通过标准：责任、授权和追溯被客户明确列为扩大 Agent 工作范围的前置条件。下一步决策：提升为近期产品优先级；否则仅保留长期原则。",
        int("《Oasis Security 对词元云集的战略含义》§04 待验证假设", "/docs/DOC-D4")
      ),
      S(
        "H2｜词元云集掌握的经营信息和责任关系是否具有独立价值。所需证据：用同一个真实工作验证 —— 仅靠已有安全体系，管理者是否仍无法回答「为什么让 AI 做、谁负责、什么情况下暂停」。通过标准：加入组织责任和经营任务后，客户愿意扩大授权范围，且管理者能清楚复盘。下一步决策：确认该层是 TKOS 控制点；否则进一步依赖生态。",
        int("《Oasis Security 对词元云集的战略含义》§04 待验证假设", "/docs/DOC-D4")
      ),
      S(
        "需持续观察的变化｜如果未来 6–12 个月企业仍主要把 Agent 用于研究、建议和内容生成，真正阻碍部署的仍是效果与投入产出，而不是责任和授权；或者客户现有平台已经能够完整解决「谁能让 AI 做什么」的经营问题，那么词元云集应继续缩小该能力的自建范围。",
        int("《Oasis Security 对词元云集的战略含义》Executive Summary", "/docs/DOC-D4")
      ),
    ],
    routeSuggestion:
      "确认「受控地把工作交给 AI」是 TKOS 的长期产品原则；词元云集掌握与经营目标、组织责任和结果复盘相关的控制，通用身份与安全能力由生态承接。近期仅用一个真实高价值场景验证，不成立独立安全产品线，也不以 Oasis 为竞品目标。",
    // 报告原文页签默认给的就是这一份 —— 四节是压缩面，原件在这里，一字未改。
    sourceText: OASIS_REPORT_SOURCE,
    byAgentLabel: AGENT_LABEL,
    assembledFrom: [
      {
        label: "《Oasis Security 对词元云集的战略含义｜管理层研究版》全文",
        kind: "int",
        href: "/docs/DOC-D4",
      },
      { label: "《Oasis_Security_管理层研究报告》", kind: "int", href: "/docs/DOC-D1" },
      { label: "《Oasis - GES venture ref》", kind: "int" },
      { label: "CSA / Oasis, The State of Non-Human Identity and AI Security, 2026-01", kind: "ext" },
      { label: "CSA, 2026-03 / 2026-04 两份 Agent 可见性调研", kind: "ext" },
      { label: "Microsoft Entra Agent ID / Google Agent Identity / Okta for AI Agents", kind: "ext" },
      { label: "TKOS Core / Strategy Overview / Business Model Overview, 2026-08-12", kind: "int" },
      { label: "01-J7 FDE 第三层｜运营重构", kind: "judgment", href: "/judgments/01-J7" },
    ],
  },
};

// ===========================================================================
// 05｜判断板（Package 02 / 03 / 04b）
// ===========================================================================

/**
 * 判断板：上半层是参谋给的、还没经过一号位的；下半层是他确认过的公司口径。
 *
 * 下半层最要紧的字段是 `support` —— 半年后回头看，「确认过」不解决任何问题，
 * 「凭什么确认的」才是重新打开一条判断时要检查的东西。词元云集整体战略那一串的
 * `support` 用的是 Package 03 每条历史决策的「简短描述」原文。
 */
const meetingJ = (
  id: string,
  issueId: string,
  at: string,
  statement: string,
  support: string,
  meetingLabel: string,
  notes: Trace[] = []
): BoardJudgement => ({
  id,
  issueId,
  statement,
  origin: "meeting",
  meetingLabel,
  at,
  notes,
  confirmed: { at, channel: "meeting", support },
});

export const boards: Record<string, BoardJudgement[]> = {
  /*
   * Oasis —— 这场 demo 里「未关闭的议题」长什么样。
   *
   * 五条全在上半层，一条都没确认过。Package 04b 写得很清楚：这是「建议提交 CEO 确认的
   * Judgment」，CEO 确认后才写入本轮 Judgment；只有相关责任人共同确认成熟结论时，
   * 才形成 Agreement。演示时当场确认一条，它就落到下半层，带上确认时间、途径和理由。
   *
   * 排序按时间倒序，所以第一条是读完报告之后的**当前判断**（总口径），下面四条是
   * 讨论之后长出来的候选判断。次序不是装饰：一号位先要知道参谋现在站在哪，才谈得上
   * 逐条处置。
   */
  "ISS-D4": [
    {
      /*
       * Package 04b §01「基于 Research 的当前 Judgment」。
       *
       * 它不是第五条判断，是前四条的总口径 —— 所以时间戳排在最后一轮对谈之后，
       * 在板上落在最上面。包里跟着的「判断依据」与「当前边界」两段在 DOC-D5 全文里。
       */
      id: "BJ-D4-0",
      issueId: "ISS-D4",
      statement:
        "企业 AI 的下一阶段不只是提高智能水平，更取决于企业愿意把多少真实工作和责任交给 AI；「可放心授权」很可能成为数字劳动力扩张的重要条件。对词元云集而言，这应进入 TKOS 的长期设计原则，但当前证据不足以支持进入安全赛道或设立新的独立业务。",
      origin: "research",
      at: "2026-08-13T17:25:00+08:00",
      notes: [
        int("Package 04b｜基于 Research 的当前 Judgment", "/docs/DOC-D5"),
        int("《Oasis Security 对词元云集的战略含义｜管理层研究版》", "/docs/DOC-D4"),
      ],
    },
    {
      id: "BJ-D4-1",
      issueId: "ISS-D4",
      statement:
        "企业 AI 规模化的重要变化之一，是管理层愿意把多少真实工作和责任交给 AI；「可放心授权」是数字劳动力扩张的重要条件，但不是替代效果和投入产出的独立购买理由。",
      origin: "research",
      at: "2026-08-13T16:40:00+08:00",
      notes: [
        int("Judgment 1｜企业采用逻辑"),
        ext("CSA / Oasis, The State of Non-Human Identity and AI Security, 2026-01"),
      ],
    },
    {
      id: "BJ-D4-2",
      issueId: "ISS-D4",
      statement:
        "词元云集应把「受控地把工作交给 AI」纳入 TKOS 的长期产品原则，因为它决定产品能否从一号位助手继续扩展到管理者和数字劳动力；但公司不进入完整机器身份或安全赛道。",
      origin: "research",
      at: "2026-08-13T16:40:00+08:00",
      notes: [int("Judgment 2｜词元云集的战略边界"), int("TKOS Method / Agents / Engine&Ontology")],
    },
    {
      id: "BJ-D4-3",
      issueId: "ISS-D4",
      statement:
        "词元云集需要掌握的是与经营目标和组织责任直接相关的授权关系：谁可以把什么工作交给 AI、AI 能做到哪一步、什么情况必须由人接手、结果如何回到经营复盘；通用身份与安全能力优先由生态承接。",
      origin: "dialogue",
      at: "2026-08-13T17:12:00+08:00",
      notes: [int("Judgment 3｜必须掌握的控制点"), agent("对谈第 2 轮")],
    },
    {
      id: "BJ-D4-4",
      issueId: "ISS-D4",
      statement:
        "现阶段不新增独立安全产品线，也不提前重投入。先选择一个真实高价值工作验证：当效果与投入产出基本成立后，责任、授权和可追溯是否仍然是客户扩大 Agent 工作范围的前置条件；只有证据成立，才升级后续产品投入。",
      origin: "dialogue",
      at: "2026-08-13T17:20:00+08:00",
      notes: [int("Judgment 4｜当前阶段"), agent("对谈第 4 轮")],
    },
  ],

  /*
   * 词元云集整体战略。
   *
   * 下半层是 Package 03 的七条历史决策 —— 它们不是版本记录，是同一个战略判断在
   * 连续讨论里逐步收敛的过程，所以每条都带确认那天的日期和当时的理由。
   * 上半层只有一条：Package 03 结尾的「当前判断」，参谋在四轮对谈之后给的。
   */
  "ISS-D7": [
    meetingJ(
      "BJ-D7-1",
      "ISS-D7",
      "2026-05-26T18:00:00+08:00",
      "正式启动 Token 工厂业务探索：先从客户 Token 消费倒推，而非从 AIDC 重资产出发",
      "决定把 Token 工厂作为新的创业方向正式启动；优先验证客户需求、Token 质量与成本、模型入口和业务封装，底层 AIDC 与算力资产待真实负载形成后再进入。",
      "Token 工厂第一次讨论",
      [int("Token 工厂第一次讨论纪要")]
    ),
    meetingJ(
      "BJ-D7-2",
      "ISS-D7",
      "2026-05-27T18:00:00+08:00",
      "战略切口收敛到中层模型运营与商业化平台：先掌握 Token 消纳主导权",
      "不再同时推进完整价值链，明确以「模型运营公司 + 商业化平台公司」为当前切口；先掌握客户、调用、成本、质量与合同数据，再反向牵引 AIDC 和算力资产。",
      "Token 工厂第二次讨论",
      [int("Token 工厂第二次讨论纪要")]
    ),
    meetingJ(
      "BJ-D7-3",
      "ISS-D7",
      "2026-05-28T18:00:00+08:00",
      "TokenHub 不能停留在模型中转：核心壁垒转向「最佳匹配 + 持续优化」",
      "确认模型接入、统一 API 与计费只是基础能力；真正的壁垒来自对模型供给与客户任务的理解，以及质量、成本与场景的持续最佳匹配，TokenHub 应成为模型运营中枢。",
      "Token 工厂第三次讨论",
      [int("Token 工厂第三次讨论纪要")]
    ),
    meetingJ(
      "BJ-D7-4",
      "ISS-D7",
      "2026-06-26T18:00:00+08:00",
      "资源策略从单一 TokenHub 扩展到 Token 工厂「三次调优」",
      "明确机会不只在 Token 分发，而在场景价值调优、Token 分发调优、算力效率调优三个控制环节；资源开始围绕可积累、可复用、可放大的能力重新配置。",
      "《词元云集战略讨论》2026.06.26",
      [int("《词元云集战略讨论》2026.06.26")]
    ),
    meetingJ(
      "BJ-D7-5",
      "ISS-D7",
      "2026-06-29T18:00:00+08:00",
      "集团二次转型明确系统性 Token 工厂方向：词元云集获得中上层战略位置",
      "集团确认二次转型不是「地产 + AI」，而是以 Token 工厂作为新的战略起点；不同主体纵向承接完整价值链，词元云集重点承担模型/推理运营、Token 分发及 Agent/场景封装等中上层能力。",
      "6.29 集团二次转型及 Token 工厂业务布局讨论",
      [int("6.29 集团二次转型及 Token 工厂业务布局讨论")]
    ),
    meetingJ(
      "BJ-D7-6",
      "ISS-D7",
      "2026-07-12T18:00:00+08:00",
      "核心业务从 Token 消纳进一步上移到「一号位驱动的企业经营范式重构」",
      "确认长期 Token 工厂愿景与当前业务必须拆开表达；主体资源从一号位战略与经营问题进入并向管理者、数字劳动力扩展，TokenOps / 技术型 FDE 转为获取真实负载和训练底层能力的轻量路径。",
      "7.12 公司业务战略会议",
      [int("7.12 公司业务战略会议逐字稿")]
    ),
    meetingJ(
      "BJ-D7-7",
      "ISS-D7",
      "2026-07-15T18:00:00+08:00",
      "总体战略正式确认并进入部署：长期 Token 工厂、当前一主一副、五个控制点、先灯塔验证",
      "将长期愿景、当前商业模式和阶段路径统一：AI 企业智能决策网络建立高价值经营入口，TokenOps 获取真实负载；公司重点掌握五个关键控制点，并先通过内部灯塔验证真实使用、真实调用、真实反馈与可复制方案。",
      "7.15 战略定位与商业模型讨论",
      [int("7.15 战略定位与商业模型讨论"), int("0715 管理层会议纪要")]
    ),
    {
      id: "BJ-D7-8",
      issueId: "ISS-D7",
      statement:
        "战略已进入部署，但仍应由真实客户使用、组织扩展、Token 负载与五个控制点的增强持续验证；出现持续反证时，重新打开 Strategic Issue。",
      origin: "dialogue",
      at: "2026-08-12T10:30:00+08:00",
      notes: [agent("对谈第 4 轮 · 当前判断"), int("7.15 战略定位与商业模型讨论")],
    },
  ],

  "ISS-D8": [
    meetingJ(
      "BJ-D8-1",
      "ISS-D8",
      "2026-07-15T18:00:00+08:00",
      "TKOS 已统一为 Method / Agents / Engine&Ontology；当前不追求完整平台，而是围绕 M1、M2 和真实 Agent 使用，逐步确定必须自建的核心能力与系统边界。",
      "总体产品框架已确认，进入真实场景驱动的能力深化。",
      "7.15 管理层会议",
      [int("0715 管理层会议纪要")]
    ),
  ],

  "ISS-D9": [
    meetingJ(
      "BJ-D9-1",
      "ISS-D9",
      "2026-07-15T18:00:00+08:00",
      "当前围绕目标组织规划、决策机制规划推进，并以真实事项运行 M1-A，验证后续实施、Products&Applications 与 Engine&Ontology 的最低需求。",
      "总体方案与阶段路径已确认，进入首阶段方案形成与真实运行验证。",
      "7.15 管理层会议",
      [int("0715 管理层会议纪要"), int("灯塔项目沟通会")]
    ),
  ],
};

// ===========================================================================
// 06｜对谈（Package 03 / 04b）
// ===========================================================================

const talk = (issueId: string, at: string, rows: [("user" | "agent"), string][]): AdvisorMessage[] =>
  rows.map(([role, text], i) => ({
    id: `MSG-${issueId}-${i + 1}`,
    role,
    text,
    // 同一场对谈里每轮相隔两分钟 —— 时间戳只用来排序和显示，不参与任何计算。
    at: new Date(new Date(at).getTime() + i * 120_000).toISOString(),
    /*
     * 耗时按答案长度算。真实运行时这个数是**测出来的**（从发问到最后一个 token），
     * 这里是包里的历史记录，没有秒表可查 —— 按长度给一个成比例的值，是这份数据能
     * 给出的最接近真相的形状：长答案确实更慢。全部写成同一个数才是假的。
     */
    ...(role === "agent" ? { elapsedMs: 7_000 + text.length * 95 } : {}),
  }));

/**
 * 已落库的对谈。
 *
 * `<议题>:signal` 那一支是**分诊阶段**的对谈：他在潜在议题那一页读完参谋的判断之后
 * 追问的那几轮。它是历史记录，不是快捷条 —— 一号位再点进这张卡，看到的应该是上次
 * 聊到哪，而不是一排等着他点的预设问题。（新问的仍然接真模型，且不写回这一支。）
 *
 * 议题研究页那一支反过来：那条路径他要负责，所以每一轮都落库。
 */
export const threads: Record<string, AdvisorMessage[]> = {
  /*
   * 两类客户那一条的分诊对谈。
   *
   * 五轮，全部从这条信号自己的预研里长出来：`take` 的那个反问（统一价值主张和分开的
   * 进入路径能不能同时成立）、两段 `finding`（传统企业卡在迁移、AI-native 卡在管理
   * 范式），以及预研没答上来的那一条。**没有引入包外的新事实** —— 参谋在这一栏里
   * 说的每一句，都要在左栏那份预研里找得到出处。
   */
  "ISS-D3:signal": talk("ISS-D3", "2026-08-11T17:05:00+08:00", [
    ["user", "这两类客户差得这么远，凭什么说是同一门生意？"],
    [
      "agent",
      "差的是**起点**，不是命题。传统企业的 AI 应用还在导入期，管理层要回答的是「未来怎么经营、组织怎么重构、管理者和 Agent 怎么重新分工」；AI-native 企业产品和交付已经跑在前面，卡住的是组织仍在用为「人」设计的那套管理逻辑。\n\n两边最后要的是同一样东西：让管理范式跟上 AI 之后的业务。所以是一个命题的两个起点，不是两门生意。",
    ],
    ["user", "那我们的进入路径要不要也分成两套？"],
    [
      "agent",
      "价值主张和方法底座应该是一套，进入路径必须分开。合成一套的代价是第一次沟通就说不清「你要解决我什么问题」—— 转型企业听到的是迁移，AI-native 听到的是管理补课，同一句话对两边都只对一半。\n\n反问：如果连首个销售场景都要分开设计，那所谓「统一底座」到底统一在哪一层？这一条现在还没有答案，它恰恰是要判断的东西。",
    ],
    ["user", "这跟我们已经定下来的东西有没有冲突？"],
    [
      "agent",
      "不冲突，而且是同一条判断往下走。01-J5「FDE 第一层｜战略重构 —— 从老板认知与决策支持破冰」说的就是从一号位进入；两类客户的差别不在要不要从一号位进，而在进去之后**第一件事谈什么**。\n\n这条信号真正动摇的不是 01-J5 本身，是它下面还没写的那一层：分层之后各自的首要问题和价值证明。",
    ],
    ["user", "先不升级，让它再攒一阵证据行不行？"],
    [
      "agent",
      "可以，但代价要说清楚：这条判断一旦成立，会直接影响目标客户分层、Re-arch 的方法、首个销售场景、TKOS 的共用能力和案例复制方式。这几件事现在都在往前推 —— 推得越久，回头改分层的成本越高。\n\n攒证据也不用等外面：下一轮客户沟通里，两类客户各问一句「你现在最想先解决哪一件」，答案分不分得开，这条就成不成立。",
    ],
    ["user", "那升级之后深研会去查什么？"],
    [
      "agent",
      "查预研没答上来的那一条：统一的自上而下价值主张和方法底座应该是什么，以及针对「AI 转型企业」和「AI-native 企业」分别的进入路径、首要问题和价值证明。\n\n这一条答不出来，分层就只是一句口号；答出来了，它直接变成销售那一侧可以用的东西。",
    ],
  ]),

  /* 分诊阶段（Package 01 §05）—— 六轮，包里的原话。 */
  "ISS-D4:signal": talk("ISS-D4", "2026-07-28T21:50:00+08:00", [
    ["user", "这不还是网络安全吗？为什么和我们有关？"],
    [
      "agent",
      "如果 Agent 永远只做研究和建议，关系确实不大。真正和我们有关的是：词元云集最终希望 Agent 进入真实经营并承担行动。只要 Agent 开始更新系统、调用数据或推动业务状态变化，客户首先需要的就不只是「它够不够聪明」，而是「我敢不敢把这件事交给它」。",
    ],
    ["user", "一笔十亿美元左右的并购，能证明这个问题已经这么重要了吗？"],
    [
      "agent",
      "不能单靠并购证明。并购只是强 Signal。更值得看的是方向一致性：Oasis 从非人类身份延伸到 Agentic Access；Cyera 本来控制数据；CSA 的调研又显示企业在 AI Identity 的政策、责任和传统 IAM 适配上存在明显缺口。\n\n三类 Evidence 共同指向一个问题 —— Agent 进入生产的速度，正在超过企业现有的授权与责任机制。",
    ],
    ["user", "那我们应该做 Oasis 做的东西吗？"],
    [
      "agent",
      "不建议。Oasis 解决的是安全基础设施问题，我们没有必要再做一套 IAM、密钥或威胁检测。\n\n我们真正可能必须掌握的是「经营上为什么允许这次行动」：这个 Agent 代表谁、服务什么 Mission、对什么业务对象采取什么动作、谁承担结果、什么情况下必须由人确认，以及结果如何回到 Evidence。",
    ],
    ["user", "为什么这层东西不能全部交给微软或者安全厂商？"],
    [
      "agent",
      "底层身份和权限完全可以交给它们，但业务语义未必可以。安全系统可以知道一个 Agent 有没有 Salesforce 权限，却未必知道它为什么要改这条客户记录、这次动作服务哪个经营目标、谁是 DRI、什么结果算完成。\n\n只要 TKOS 要成为企业经营系统，这层 Context 就需要由我们掌握或至少由我们定义。",
    ],
    ["user", "那现在需要投入多少？"],
    [
      "agent",
      "现在不建议重投入。更合理的是先把「受控行动」作为长期原则设计进去，保证 Agent 身份、责任、授权边界、人工确认和行动 Evidence 在模型里有位置。\n\n等真实客户或内部场景出现跨系统写入、高风险动作并反复被这些问题阻塞，再决定要不要把运行时控制升级为独立能力。",
    ],
    ["user", "什么会让你改变这个判断？"],
    [
      "agent",
      "两种 Evidence 会削弱它。第一，如果大平台很快把任务级授权做成事实标准，并且能承载足够的业务 Context，我们可以进一步缩小自建范围。第二，如果未来半年真实客户仍主要把 Agent 当研究和建议工具，授权行动不是采用瓶颈，就不应该提前工程化。",
    ],
  ]),

  /*
   * Oasis：Package 04b §02 的四轮，**落库成历史**。
   *
   * 上一版把它放在快捷条里让人当场点。改了：一号位升级完议题走进来，这件事在他脑子里
   * 已经**讨论过一轮**了 —— 他要看的是「上次聊到哪、结论怎么长出来的」，不是从空白
   * 开始再演一遍。对谈记录和判断板并排放，才看得出板上那几条是从哪几句话里收敛出来的
   * （每条判断的小注写着「对谈第 N 轮」）。
   *
   * 想接着聊照样可以：输入框接真模型。
   */
  "ISS-D4": talk("ISS-D4", "2026-08-13T17:00:00+08:00", [
    ["user", "Oasis 这件事和我们到底有什么关系？安全本来就应该是安全公司的事情。"],
    [
      "agent",
      "安全产品本身不是我们的机会。对我们真正重要的是：如果客户只敢让 AI 给建议，TKOS 最后就会停在「高级助手」；只有客户愿意把真实工作交给 AI，我们才可能从一号位扩展到管理者和数字劳动力。\n\nOasis 提醒我们，企业能不能继续交出工作，开始取决于责任、边界和可追溯是否清楚。",
    ],
    ["user", "那是不是意味着我们现在就要把这部分做进产品？"],
    [
      "agent",
      "需要把原则设计进去，但不建议现在做一套完整安全产品。外部平台已经在快速覆盖身份与安全，词元云集不需要和它们竞争。\n\n我们更应该掌握的是经营层的问题：谁有权把这项工作交给 AI、AI 能做到哪一步、什么情况必须让人接手、结果最后由谁复盘。",
    ],
    ["user", "什么证据能证明这真是客户的核心问题，而不是我们想得太远？"],
    [
      "agent",
      "最直接的证据不是再看行业报告，而是找一个真实高价值工作：如果 Agent 的效果和业务价值已经基本成立，但客户仍不愿让它自主完成，而且原因集中在责任不清、授权范围不敢放、出了问题难追溯，那么这个判断成立。\n\n反过来，如果客户主要卡在效果、投入产出或使用习惯，就说明现在还不该重投入。",
    ],
    ["user", "那当前我们应该怎么处理？"],
    [
      "agent",
      "我建议把「受控地把工作交给 AI」确认成 TKOS 的长期原则，但暂不把它变成独立业务。近期只用真实客户场景验证：它是否决定客户愿不愿从一号位助手进一步扩大到管理者和数字劳动力。",
    ],
  ]),

  "ISS-D7": talk("ISS-D7", "2026-08-12T10:00:00+08:00", [
    [
      "user",
      "我们现在把核心业务越来越往一号位、企业经营这边走，会不会走着走着变成一家咨询公司，反而离最早的 Token 工厂越来越远？",
    ],
    [
      "agent",
      "从过去几轮决策看，不是「离 Token 工厂更远」，而是进入路径发生了变化。5 月先确定从 Token 消纳和模型运营切入，6 月扩展到三次调优；到 7 月进一步判断，仅掌握 Token 调用不足以建立长期客户关系，真正高价值的入口在企业经营问题。\n\n现在是核心业务掌握客户与场景、企业智能运行入口，TokenOps 获得真实 Token 负载，两端训练同一套中上层能力。",
    ],
    ["user", "那这个战略下一步最需要证明什么？我不想再听平台建到什么程度。"],
    [
      "agent",
      "最需要证明的不是平台，而是两个入口能否形成同一个闭环。核心业务要证明：从一号位进入后，能否扩展到管理者和数字劳动力，并从一次项目变成持续使用；TokenOps 要证明：真实负载确实能提升路由、评测和调优能力，而不是演变成独立的低价 Token 生意。\n\n两件事同时成立，「一主一副」才真正成立。",
    ],
    ["user", "什么情况下你会建议我重新打开这个战略？你现在的判断又是什么？"],
    [
      "agent",
      "如果客户只买项目、不持续使用或不向组织扩展；TokenOps 有收入和调用量却没有沉淀成核心业务可复用能力；或持续投入产品技术但五个控制点没有增强，就应重新讨论战略。\n\n当前不建议改战略，建议继续收窄验证：先用少量灯塔客户跑通「一号位进入—组织扩展—持续使用—真实调用—结果反馈」，同时验证 TokenOps 是否真正反哺共同能力。",
    ],
  ]),
};

/**
 * 快捷条 = 剧本。
 *
 * `q` 是 Package 01 / 04b 里一号位问的那一句，`reply` 是包里参谋的原话。演示时点
 * 快捷条走的就是包里的原文，不靠模型现编 —— 自己打字仍然接真模型。
 */
export const presets: Record<string, AdvisorPreset> = {
  // 词元云集整体战略（Package 03）—— 对谈已落库，这里留最后一问当追问入口
  "ISS-D7": {
    opening: "",
    scripted: true,
    chips: [
      {
        q: "什么情况下你会建议我重新打开这个战略？",
        reply:
          "如果客户只买项目、不持续使用或不向组织扩展；TokenOps 有收入和调用量却没有沉淀成核心业务可复用能力；或持续投入产品技术但五个控制点没有增强，就应重新讨论战略。\n\n当前不建议改战略，建议继续收窄验证。",
      },
    ],
  },
};

// ===========================================================================
// 07｜文档（作为溯源落点）
// ===========================================================================

/**
 * 判断板与报告里点得开的那几份。正文只放包里已有的段落 —— 文档库不是这一版
 * demo 的重点，它存在的理由只有一个：判断上的小注点下去要有东西。
 */
export const docs: Doc[] = [
  {
    id: "DOC-D1",
    title: "Oasis_Security_管理层研究报告",
    folder: "议题研究",
    source: "clark",
    mirrorOf: "Package 01｜Potential Issues & Oasis Research",
    updatedAt: "2026-07-28T21:41:00+08:00",
    body: [
      "## 企业 AI 的下一道门槛正在从「能不能做」转向「敢不敢授权」",
      "Strategic Question｜企业 AI 规模化的关键约束是否正在从模型能力转向「可信授权与责任控制」；如果这一变化成立，词元云集应该把什么纳入长期核心能力、什么留给安全生态？",
      "一句话结论｜当前 Evidence 支持把「可信、可控地让 AI 获得行动权」纳入 TKOS 的长期价值主张与核心控制原则，但不支持词元云集进入机器身份安全赛道。",
      "## 词元云集应把「受控行动」作为长期原则，但当前不应重投入安全基础设施",
      "长期价值主张｜从「AI 能辅助判断」升级为「企业可以放心让 AI 承担真实行动」。可信授权不是独立卖点，而是数字劳动力能够进入真实经营的前提。",
      "必须掌握的核心控制｜掌握与经营 Context 相连的行动主体、责任人、任务目的、授权边界、关键人工确认与行动 Evidence，使每次重要行动都能被业务解释和追溯。",
      "不应自建的安全能力｜传统 IAM / SSO、凭证与密钥管理、NHI 发现、威胁检测等成熟安全能力优先通过客户现有系统或专业生态承接。",
      "当前阶段｜先把「受控行动」设计进 TKOS 的对象与原则；只有当灯塔或内部真实场景出现跨系统写入、高风险操作等 Evidence 时，再决定是否升级运行时控制能力。",
      "商业结果｜如果成立，它会增强客户从 Agent 试用转向持续 TKOS 使用与组织扩展的信心，而不是形成一条独立的 Security SKU。",
    ].join("\n\n"),
    citedBy: ["01-J7"],
  },
  {
    id: "DOC-D2",
    title: "0715 管理层会议纪要｜战略定位、会前预审与灯塔项目",
    folder: "会议",
    source: "clark",
    mirrorOf: "Package 06｜管理层会议纪要 2026-07-15",
    updatedAt: "2026-07-15T20:00:00+08:00",
    body: [
      "会议主题｜公司总体战略与商业模式、CEO Agent 会前预审验证、灯塔项目工作计划与定价。会议性质｜管理层决策与行动纪要。资料依据｜7 月 15 日三场原始讨论记录，按「战略 → 会前预审 → 灯塔项目」顺序整理。",
      "## 一、三场讨论完成了从战略确认到产品验证，再到首个真实项目部署的连续收敛",
      "会议结论｜词元云集长期继续承接系统性 Token 工厂，但当前主体资源聚焦一号位企业经营范式重构；TokenOps 作为真实负载与底层能力训练路径。CEO Agent 的会前预审方向性通过，灯塔项目被明确为首个正式验证载体，首版必须「小而完整」，并同步完成工作计划和定价设计。",
      "本次已确认的关键事项",
      "1 公司当前经营主线｜主体资源从一号位的战略与经营问题切入，先贯通「战略形成—执行—反馈」，再向管理者和数字劳动力扩展。",
      "2 TokenOps 的角色｜用于获得真实高频 Token 负载并训练路由、评测和调优能力，可补充现金流，但不作为与核心业务等权的第二主业。",
      "3 共同底座｜Foundry / 企业本体、引擎与路由、TokenHub 作为两类业务共享的长期能力持续沉淀。",
      "4 CEO Agent 会前预审反馈｜当前版本方向基本正确，王总评价约 70 分；下一阶段重点提升系统性、结构和稳定性。",
      "5 灯塔项目产品原则｜首版可控制范围和成熟度，但必须具备完整的端到端形态；后续通过真实使用持续迭代并沉淀为产品。",
      "6 灯塔项目推进原则｜按正式商业项目推进，尽快形成完整工作计划并高频迭代；定价研究与项目方案同步完成。",
      "## 二、公司战略已从长期 Token 工厂愿景收敛到当前可经营的主业务与能力边界",
      "核心判断｜长期愿景继续服务系统性 Token 工厂，但团队当前必须围绕一个可独立成立的企业 AI 业务组织资源：从一号位真实经营问题进入，建立企业战略与执行闭环；TokenOps 只承担真实负载和底层能力训练的辅助作用。",
      "长期愿景与当前经营必须分开。长期目标说明公司最终要去哪里；当前业务必须回答客户为什么付费、公司如何形成持续关系和能力积累。",
      "核心业务从一号位开始。优先进入战略制定、组织传导、执行反馈等高杠杆环节，再逐步扩展到管理层、中后台职能和数字劳动力。",
      "TokenOps 的价值是训练能力，不是把公司带向低价 Token 转售。真实负载用于沉淀模型选择、路由、质量、成本和稳定性数据，并反哺核心业务。",
      "两条业务必须共享底座。Foundry / 企业本体、引擎与路由、TokenHub 承载企业 Context、调用、权限和持续调优能力，形成跨项目复用。",
      "收入结构按阶段演进。短期可通过项目 / 部署收入进入；中期提高系统持续使用收入；长期再放大 Token 与数字劳动力运营收入。具体收费组合仍需后续定价验证。",
      "本场仍需继续判断的事项｜目标客户选择：王总提出金融、证券 / 投行等知识密集型行业值得优先研究，团队同时认为「一号位是否真正牵引」可能比行业本身更重要，尚未形成最终筛选标准。对外命名：会议对「企业 AI 决策系统」等表达进行了讨论，但未确认最终产品 / 业务名称。定价与收入组合：部署费、持续使用费、Token 费如何组合，以及长期部署是否免费，仍需结合竞争和客户价值进一步验证。",
      "## 三、CEO Agent 会前预审方向性通过，下一阶段重点是稳定、系统且真正降低决策负载",
      "验证结果｜王总对当前会前预审给出约 70 分评价，确认其讨论方向与自身核心判断基本一致；下一阶段不再只验证「能否理解」，而要验证材料是否足够系统、结构是否低负载、不同会议中能否稳定复用。",
      "方向正确是当前最重要的通过项。预审已能在竞争与壁垒等问题上反映此前确认的战略意图。",
      "尚未验证的是系统性与结构：信息是否完整、重点是否足够聚焦、有没有遗漏 CEO 真正需要判断的问题。",
      "王总的战略意图、竞争哲学和判断原则需要持续维护为 Agent Context，使会前预审随着使用逐步稳定。",
      "会后复盘原则上不应长期增加 CEO 审阅负担；当前仍处于验证阶段，录音和转写质量会直接影响 Judgment 的准确沉淀。",
      "## 四、灯塔项目被明确为首个正式验证载体，首版必须「小而完整」而不是局部功能 Demo",
      "项目原则｜灯塔项目既验证产品，也验证工作方法和商业模式。第一版可以范围小、成熟度低，但必须从一开始具备完整产品形态；通过真实客户、真实材料和真实会议持续迭代，并最终沉淀为可复制产品。",
      "首版要求「小而完整」。不能先交一个孤立功能、以后再拼成产品；可以能力浅，但端到端形态要成立。",
      "灯塔按正式商业项目推进。需要明确工作计划、阶段交付和验证结果，并与王总高频迭代，而不是按内部体验项目降低标准。",
      "项目最终要形成可复制资产。做完单一客户不是终点，真实运行中形成的方法、产品和 Context 应能沉淀并用于下一客户。",
      "定价是项目设计的一部分。需研究同行部署、战略 / 组织变革类项目的收费逻辑，再结合一号位价值与长期持续使用形成自己的报价。",
      "## 五、未决事项集中在客户选择、定价和产品边界，不应在后续执行中被默认成已确认结论",
      "目标客户优先级｜金融 / 证券等知识密集行业是否应优先于其他行业；「行业优先」与「一号位牵引优先」需要进一步比较。",
      "核心业务对外命名｜当前讨论过多个名称，尚未确认正式业务 / 产品名称。",
      "收费结构｜项目费、系统持续使用费、Token 使用费的组合与阶段切换条件尚未确定。",
      "CEO Agent 预审结构｜最终模块、信息密度、阅读形式需结合王总进一步使用反馈确定。",
      "灯塔首版边界｜首版完整形态具体覆盖到什么深度、如何验收，需要在灯塔工作计划中明确。",
      "## 六、下一步以「固化战略—跑通灯塔—验证 Agent」三条主线推进",
      "1 固化战略原则｜将本次确认的核心业务 / TokenOps 关系、共同底座和阶段收入逻辑更新到标准战略材料与公司 Agent。责任侧：战略 / 公司运营。时间：下一版标准材料前。",
      "2 形成灯塔工作计划｜明确项目目标、首版完整形态、阶段交付、参与角色和验证标准，并与王总快速迭代。责任侧：灯塔项目团队。时间：立即启动。",
      "3 完成定价研究与初步报价｜研究同行部署及战略 / 组织变革项目收费，形成词元云集的价值定价框架。责任侧：商业 / 项目团队。时间：下一轮项目讨论前。",
      "4 优化会前预审｜基于王总反馈调整结构、信息密度和系统性，并在下一次真实会议前使用。责任侧：产品 / Method。时间：下一次真实会前。",
      "5 改善会议记录质量｜优化录音与转写，验证会后能否稳定沉淀 Judgment / Agreement，降低后续人工校正。责任侧：项目 / 产品团队。时间：下一次会议起。",
      "6 研究目标客户选择｜比较「金融 / 证券优先」与「一号位牵引优先」，形成首批外部客户筛选标准。责任侧：战略 / 商业团队。时间：下一轮客户策略讨论前。",
    ].join("\n\n"),
    citedBy: ["01-J1", "01-J11"],
  },
  {
    id: "DOC-D3",
    title: "0715 会后复盘｜战略定位、会前预审与灯塔项目",
    folder: "会议",
    source: "clark",
    mirrorOf: "Package 07｜0715 会后复盘",
    updatedAt: "2026-07-16T10:00:00+08:00",
    body: [
      "复盘范围｜会议输入：战略定位与商业模型讨论、会前预审材料反馈、灯塔项目沟通会三份逐字稿。事实边界：本复盘严格区分会议直接表达、工作口径、商业假设和待验证事项；未出现正式授权或经营数据的内容，不写成既成结果。复盘目的：明确本次会议真正收敛了什么，下一轮需要拿什么事实来继续判断。",
      "## 核心观点",
      "本次会议完成了一个重要转向。讨论焦点已从「要做一套什么系统」推进到灯塔项目如何证明一号位价值、项目交付和商业价格能否同时成立。战略方向已经更清楚，验证设计和商业证据仍需要尽快补齐。",
      "## 一、核心判断",
      "会议把主线、辅助业务、产品表达和灯塔项目放到了同一张经营账上。主线要从一号位的高价值判断进入组织，辅助业务要服务于真实负载和能力训练，灯塔项目要以完整交付、真实使用和可讨论的价格去证明这套安排。",
      "当前最关键的缺口｜战略方向已经有了，首期如何验证仍缺少明确的组织范围、真实事项、参与角色、验收证据和价格推荐。下一轮会议应围绕这一组具体选择收敛。",
      "## 二、会议核心决策要点",
      "资源优先级｜面向企业经营与决策的主线应占主体资源；TokenOps 提供辅助性的真实负载和训练机会。边界：辅助业务的扩张条件、资源上限与让位机制尚未明确。",
      "公司表达｜「企业 AI 决策系统」比「企业智能决策网络」更易被用户理解，材料需要继续精简。边界：名称属于表达方向，尚未形成正式命名决定。",
      "商业定价｜项目价值主要来自一号位获得的判断支持及其带动组织的作用，定价应按贡献设计。边界：约七成至八成为会议中的价值判断，尚未转化为报价模型或客户接受证据。",
      "灯塔交付｜首个项目需要完整可用，能够被当作真实项目成果交付，再逐步提升品质和产品化程度。边界：完整交付的范围、验收标准、客户配合和费用仍待项目方案明确。",
      "办公地点｜迁往 AI 资本与生态集聚区域的方向已被明确。边界：具体地点、成本、时间和负责人未在逐字稿中形成完整记录。",
      "## 三、达成的战略共识",
      "企业价值从一号位开始。当前切口是帮助一号位看清问题、形成判断、把判断传给管理层并持续接收反馈。这个切口决定了公司后续产品、服务和项目设计的起点。",
      "项目收入是当前进入方式。短期通过部署和项目服务进入真实场景，后续持续服务和运营收入需要由实际使用、角色扩展和交付效率证明。",
      "长期能力围绕控制点形成。客户与场景、企业 AI 运行、调用与路由、模型选择和结果反馈被视为需要逐步掌握的位置。",
      "材料本身是经营工具。一份材料若不能让用户迅速理解差异、价值与下一步，就无法支撑销售、招人和组织协作。材料需要像产品一样持续打磨。",
      "AI 需要吸收经营者的判断。团队的工程实现能力与一号位长期积累的经营经验要共同进入系统。产品效果取决于问题如何被提出、背景如何被说明、反馈如何被修正。",
      "原文依据｜以上共识来自会议直接表达，属于当前工作口径。其长期有效性仍需由灯塔项目和后续客户验证。",
      "## 四、潜在风险和需要校准的问题",
      "首期验证被缩成产品试用｜会议已提出真实使用与反馈，但尚未明确组织范围和跨层承接，单一 Agent 使用不能说明组织运行改变。下一轮需要回答：选择一个真实事项，明确二至三层管理者、行动、反馈和验收证据。",
      "价格逻辑停在价值判断｜按贡献定价方向明确，客户愿意为什么价值付费、如何比较替代方案仍无证据。下一轮需要回答：给出价格区间、计价单位、客户收益假设、交付成本和推荐方案。",
      "共同能力投入过早｜本体、引擎、路由等被寄予长期期待，当前哪些能力阻塞项目尚未逐项证明。下一轮需要回答：列出每项能力解决的具体问题，自建理由与暂缓条件。",
      "叙事超过可验证事实｜「企业 AI 决策系统」表达更清楚，产品实际能否改善判断质量、战略一致性和时间仍待验证。下一轮需要回答：用灯塔项目记录起点、使用过程、反馈、例外和阶段结果。",
      "材料来源影响复盘可信度｜逐字稿存在录音质量、会议标识和日期不一致问题。下一轮需要回答：建立会议编号、原始录音、转写版本、确认人和修改记录。",
      "## 五、建议沉淀进入战略材料的要点",
      "建议沉淀的主句｜词元云集从一号位的真实经营问题进入，帮助判断穿过管理层进入行动，并把执行中的进展、偏差和问题带回决策者。",
      "最高主线｜AI 时代企业经营方式的变化，从一号位判断、战略传导、行动反馈和人机协作开始。（当前工作口径）",
      "当前业务｜以企业 AI 决策系统作为面向客户的表达方向，服务于一号位和管理层的经营判断。（表达方向，待命名确认）",
      "辅助业务｜TokenOps 用于获得真实负载，训练模型选择、调用成本、质量、稳定性和路由能力。（辅助业务口径）",
      "阶段验证｜灯塔项目要在明确组织范围内跑通一次判断、承接、行动和反馈，并留下可复核证据。（需补齐验证设计）",
      "收入叙事｜项目部署收入先建立真实关系；持续服务和运营收入在持续使用、角色扩展与交付效率出现后再逐步成立。（商业假设，待验证）",
      "定价原则｜以一号位获得的判断支持和组织带动价值为核心，结合项目范围、部署深度、使用方式和风险设计价格。（原则已形成，模型待研究）",
      "## 六、下一轮推进建议",
      "下一轮会议建议只聚焦灯塔项目的完整方案，避免再次被名称、架构和零散功能带走。项目团队需要自行带来选项、推荐与后果。",
      "灯塔项目方案｜客户与组织范围、真实事项、阶段目标、交付物、客户配合、验收方式和负责人。",
      "报价与定价研究｜同行比较、成本结构、价值假设、至少两套价格选择及各自后果。",
      "验证看板｜起始状态、使用频率、调用、管理层承接、行动反馈、问题与例外。",
      "产品范围｜本期必须可用的完整能力、暂不做的能力、每项能力的验收标准。",
      "材料改稿｜一页讲清客户为什么现在需要、一页讲清首期怎么验证、一页讲清价格与推进方式。",
      "复盘结语｜这次会议已经给出了方向和要求。团队下一步需要拿出完整项目方案、报价推荐和真实验证证据，让战略从判断走到可以检验的经营动作。本复盘没有新增公司决定；涉及正式战略、价格、投入和对外承诺的事项，仍需在后续材料中由有权主体确认。",
    ].join("\n\n"),
    citedBy: ["01-J1"],
  },
  {
    id: "DOC-D4",
    title: "Oasis Security 对词元云集的战略含义｜管理层研究版",
    folder: "议题研究",
    source: "clark",
    mirrorOf: "Package 04a｜Oasis Security Deep Research",
    updatedAt: "2026-08-13T16:30:00+08:00",
    body: OASIS_REPORT_SOURCE,
    citedBy: ["01-J7"],
  },
  {
    id: "DOC-D5",
    title: "Oasis Security｜Research 后的 Judgment 与 CEO × Agent 讨论模拟",
    folder: "议题研究",
    source: "clark",
    mirrorOf: "Package 04b｜Oasis Security Judgment & Discussion",
    updatedAt: "2026-08-13T17:25:00+08:00",
    body: [
      "## Oasis Security｜Research 后的 Judgment 与 CEO × Agent 讨论模拟",
      "用途｜展示 Research Result 如何进入 CEO 讨论，并形成可继续演进、待 CEO 确认的 Judgment。",
      "Issue Context｜Strategic Issue：随着 Agent 从提供建议走向替企业完成真实工作，「企业是否敢把工作和责任交给 AI」会不会成为规模化部署的关键门槛？如果会，词元云集应把什么纳入自身长期能力，什么交给外部生态？",
      "## 01｜基于 Research 的当前 Judgment",
      "Current Judgment｜企业 AI 的下一阶段不只是提高智能水平，更取决于企业愿意把多少真实工作和责任交给 AI；「可放心授权」很可能成为数字劳动力扩张的重要条件。对词元云集而言，这应进入 TKOS 的长期设计原则，但当前证据不足以支持进入安全赛道或设立新的独立业务。",
      "判断依据｜一方面，外部企业已出现 Agent 责任不清、不可见和治理滞后的现实问题；另一方面，Oasis 被约 10 亿美元收购及 Microsoft、Google、Okta 的同步动作说明，通用身份与安全能力会快速成熟。词元云集真正相关的机会，是让客户在组织责任清楚的前提下，把更多真实工作交给数字劳动力。",
      "当前边界｜这是 Research Result 基础上的阶段性 Judgment，不是 Agreement。后续 CEO 讨论可以确认、修改或推翻该判断。",
      "## 02｜CEO × CEO Agent 讨论模拟",
      "CEO｜Oasis 这件事和我们到底有什么关系？安全本来就应该是安全公司的事情。",
      "CEO Agent｜安全产品本身不是我们的机会。对我们真正重要的是：如果客户只敢让 AI 给建议，TKOS 最后就会停在「高级助手」；只有客户愿意把真实工作交给 AI，我们才可能从一号位扩展到管理者和数字劳动力。Oasis 提醒我们，企业能不能继续交出工作，开始取决于责任、边界和可追溯是否清楚。",
      "CEO｜那是不是意味着我们现在就要把这部分做进产品？",
      "CEO Agent｜需要把原则设计进去，但不建议现在做一套完整安全产品。外部平台已经在快速覆盖身份与安全，词元云集不需要和它们竞争。我们更应该掌握的是经营层的问题：谁有权把这项工作交给 AI、AI 能做到哪一步、什么情况必须让人接手、结果最后由谁复盘。",
      "CEO｜什么证据能证明这真是客户的核心问题，而不是我们想得太远？",
      "CEO Agent｜最直接的证据不是再看行业报告，而是找一个真实高价值工作：如果 Agent 的效果和业务价值已经基本成立，但客户仍不愿让它自主完成，而且原因集中在责任不清、授权范围不敢放、出了问题难追溯，那么这个判断成立。反过来，如果客户主要卡在效果、投入产出或使用习惯，就说明现在还不该重投入。",
      "CEO｜那当前我们应该怎么处理？",
      "CEO Agent｜我建议把「受控地把工作交给 AI」确认成 TKOS 的长期原则，但暂不把它变成独立业务。近期只用真实客户场景验证：它是否决定客户愿不愿从一号位助手进一步扩大到管理者和数字劳动力。",
      "## 03｜讨论后，建议提交 CEO 确认的 Judgment",
      "以下为 Research + 讨论形成的 4 条候选判断。CEO 确认后写入本轮 Judgment；只有相关责任人共同确认成熟结论时，才形成 Agreement。",
      "Judgment 1｜企业采用逻辑。企业 AI 规模化的重要变化之一，是管理层愿意把多少真实工作和责任交给 AI；「可放心授权」是数字劳动力扩张的重要条件，但不是替代效果和投入产出的独立购买理由。",
      "Judgment 2｜词元云集的战略边界。词元云集应把「受控地把工作交给 AI」纳入 TKOS 的长期产品原则，因为它决定产品能否从一号位助手继续扩展到管理者和数字劳动力；但公司不进入完整机器身份或安全赛道。",
      "Judgment 3｜必须掌握的控制点。词元云集需要掌握的是与经营目标和组织责任直接相关的授权关系：谁可以把什么工作交给 AI、AI 能做到哪一步、什么情况必须由人接手、结果如何回到经营复盘；通用身份与安全能力优先由生态承接。",
      "Judgment 4｜当前阶段。现阶段不新增独立安全产品线，也不提前重投入。先选择一个真实高价值工作验证：当效果与投入产出基本成立后，责任、授权和可追溯是否仍然是客户扩大 Agent 工作范围的前置条件；只有证据成立，才升级后续产品投入。",
      "CEO 确认后建议的状态处理：确认 / 小幅修改，写入本轮 Judgment，并保留需继续验证的关键假设；认为证据不足，继续围绕同一 Strategic Issue 补充真实客户 Evidence，不强行形成 Agreement；明确否定，更新 Judgment，并记录什么新 Evidence 才需要重新打开。",
      "Research → Judgment 边界｜Research Result 是研究输入；Judgment 是讨论后形成的当前组织判断；Agreement 只有在相关责任人确认 Judgment 已成熟时形成。",
    ].join("\n\n"),
    citedBy: ["01-J7"],
  },
];

// ===========================================================================
// 08｜会前预审（Package 05）
// ===========================================================================

/**
 * 《词元云集总体战略定位与阶段路径》的会前预审。
 *
 * Brief 这个对象的定义是**压缩，不是汇总** —— 所以包里九节没有平铺进来，而是按
 * 一号位进会议室之前真正要用的顺序重排：
 *
 *   coreJudgment        包里的「核心观点」。整份预审最上面那一行。
 *   problem             预审对象 / 关联材料 / 报告定位 —— 这份东西是给什么会写的。
 *   driRecommendation   包里的「会前结论」。
 *   keyEvidence         战略一致性判断 + 四个校准维度 + 四条积极信号。
 *   strongestCounter    风险一。五条风险里只有它直接打在「客户为什么付钱」上。
 *   divergences         风险二到五，按可查证 / 可验证 / 只能您拍板分三类。
 *   suggestedQuestions  包里「重点可追问问题」五条，原文照录。
 *
 * 「下一步推进建议」那一节没有单独字段，它并进 `driRecommendation` 的后半段 ——
 * 结论和它要求的动作分开写，读的人得自己接上。
 */
const PREBRIEF_0715: Omit<Brief, "issueId"> = {
    coreJudgment:
      "建议修改后提交。材料已经形成「长期愿景—当前战略—阶段路径」的基本骨架；提交前最应补强的是把客户价值与首期组织闭环放到叙事中心，使会议能够确认方向与验证边界，而非陷入名词、架构和平台讨论。",
    problem:
      "预审对象：《词元云集总体战略定位与阶段路径》董事长汇报版（2026 年 7 月）。关联材料：2026 年 7 月 12 日公司业务战略、报告优化及办公地点相关讨论逐字稿。报告定位：顾问会前预审；用于识别需校准的判断与会议追问，不替代管理层决策。",
    driRecommendation: S(
      "这份材料当前最关键的问题，是业务组合已经出现，客户价值和首期组织验证仍未成为故事主轴；最优先的动作，是把「从一号位判断到组织行动与反馈」的完整链路置于材料中心。提交前：重写首页中心判断，明确当前以企业经营范式重构为主线，从一号位真实经营问题进入，Token 工厂是长期愿景、TokenOps 是轻量辅助；在业务组合之前补一页商业理由，说明传统组织的判断、传导与反馈为何失效，以及首期怎样形成可运行的闭环；重写第 8、10 页 —— 第 8 页从产出清单转为组织运行验证，第 10 页区分方向、验证原则与待验证假设。会上：优先收敛方向与验证边界，把 Foundry、Ontology、TokenHub 的产品架构留作支撑说明。",
      int("Package 05｜会前预审报告 六、会前结论；五、下一步推进建议")
    ),
    keyEvidence: [
      S(
        "整体方向与既有战略口径基本一致：以 AI 企业智能决策网络为主线，以 TokenOps 获取真实负载并训练底层能力，收入从项目与部署起步，再争取持续使用和运营收入。材料也已把「831」界定为闭环验证节点。关键判断：当前版本把「业务组合与共同底座」讲得较清楚；「从一号位真实经营问题进入，经管理层承接、行动与反馈回流，形成组织级运行」的主线仍未成为故事主轴。",
        int("战略材料第 1—10 页"),
        int("7.12 讨论逐字稿关于「结论先行」「短期见利见效，长期具有战略意义」「从一号位开始」的直接要求")
      ),
      S(
        "四个维度的会前校准重点。长期定位：材料以企业经营范式与 Token 运营中枢为长期愿景 —— 应把 Token 工厂放在长期愿景与产业承接位置，避免成为当前商业身份。当前主线：AI 企业智能决策网络为核心业务、TokenOps 为辅助业务 —— 保持一主一辅，明确资源冲突时主线优先。首期验证：已提出真实议题、报价、CEO Agent 初版与最小底座 —— 需补齐组织边界、2—3 层管理者、真实事项、承接—行动—反馈闭环。收入路径：项目与部署收入指向持续使用和 Token 运营收入 —— 需写清迁移成立条件：持续使用、角色扩展、复用与边际人力下降。",
        int("战略材料第 2、5、7、8 页")
      ),
      S(
        "长期、当前、阶段被主动拆开。第 2 页直接回答「长期去哪、当前做什么、短期怎么见效」，较好回应上次会议对开头与结论的要求。",
        int("战略材料第 2 页")
      ),
      S(
        "一主一辅关系更明确。第 5 页清楚标出 AI 企业智能决策网络承担长期公司身份，TokenOps 提供真实负载与能力训练。",
        int("战略材料第 5 页")
      ),
      S(
        "控制点意识高于产品清单。第 4 页将客户与场景入口、企业智能运行入口、调用关系、路由权、结果反馈列为长期控制点。",
        int("战略材料第 4 页")
      ),
      S(
        "平台建设有阶段边界。第 8 页没有把 831 写成大平台完成节点，为用真实阻塞决定最小建设范围留下空间。",
        int("战略材料第 8 页")
      ),
    ],
    strongestCounter: S(
      "风险一：客户为什么必须购买尚未被说透。材料从公司愿景进入产业层级、控制点与业务组合，读者知道公司想做什么，却不易复述客户今天的痛点和购买理由。校准：在业务组合之前增加一页 —— 一号位的判断难以快速、准确地穿透组织并进入行动；词元云集从这一问题进入，连接判断、承接、行动与反馈。",
      int("战略材料第 2—6 页"),
      int("7.12 讨论逐字稿中关于「结论」「传播力」和经营范式变化的讨论")
    ),
    divergences: [
      {
        kind: "hypothesis",
        text:
          "风险二：共同底座被写成战略成立本身。Foundry、Ontology、引擎、路由与 TokenHub 已出现，但尚未说明它们分别支撑什么组织变化、哪些必须自建。校准：将其表述为能力与壁垒假设；用真实运行、跨项目复用、边际交付成本下降证明，避免以 API 接入、功能或原型替代壁垒。",
        note: "判断分歧 · 可验证",
      },
      {
        kind: "value",
        text:
          "风险三：831 成功标准过宽，难以判定。「真实客户、真实使用、真实调用、真实反馈、可复制方案、明确 Owner」方向正确，但无法区分一次 Agent 使用与组织运行闭环。校准：把成功标准改为 —— 在明确组织范围内，一号位真实判断被 2—3 层管理者承接并进入行动，进展、偏差与问题能够返回管理层，客户团队可以继续运行。",
        note: "价值取舍 · 只能您拍板",
      },
      {
        kind: "fact",
        text:
          "风险四：收入迁移被视觉上表达为自然发生。项目收入、持续使用收入和 Token 运营收入之间使用箭头连接，容易造成商业模式会自动转换的理解。校准：增加前提 —— 只有客户持续使用、扩展角色与场景，且新增交付不再同比增加人力时，收入迁移才成立。",
        note: "事实不足 · 可查证",
      },
      {
        kind: "value",
        text:
          "风险五：第 10 页混合了不同成熟度的确认事项。战略方向、能力假设、验证设计与收入假设被并列为六项「确认」，会议容易被迫对尚无数据支撑的内容做过早判断。校准：拆为三类 —— 本次确认方向；本次确认验证原则；暂不确认、继续验证的假设。",
        note: "价值取舍 · 只能您拍板",
      },
    ],
    suggestedQuestions: [
      {
        q: "词元云集现在以什么客户问题切入？",
        implication:
          "是部署更强的 Agent，还是让一号位判断成为管理层能够承接、行动并反馈的组织运行方式？",
      },
      {
        q: "831 验证的最小完整单元是什么？",
        implication:
          "涉及哪个组织边界、哪 2—3 层管理者、哪一件真实经营事项；出现什么事实才算进入组织运行？",
      },
      {
        q: "主线与 TokenOps 的资源冲突如何处理？",
        implication: "什么条件下 TokenOps 可以扩大，什么情况下必须让位于主线？",
      },
      {
        q: "项目收入如何转成持续收入？",
        implication:
          "哪些持续使用、角色扩展、复用或边际交付数据，能证明客户购买的是持续运行关系？",
      },
      {
        q: "五个控制点中哪些必须自己掌握？",
        implication: "哪些可以采购或合作；每项自建是否都有真实业务阻塞支撑？",
      },
    ],
    byAgentId: "AGT-01",
    stanceRedacted: false,
};

/**
 * **只有灯塔项目推进有会前报告。**
 *
 * 会前报告是「这场会准备好了」的唯一凭据 —— 材料收齐、CEO Agent 与 DRI 的反馈都到了，
 * 才出得来这一份。别的议题现在都还没走到那一步，所以它们的会议入口是灰的：给一个点得
 * 进去、里面却什么都没有的按钮，比不给按钮更糟。
 */
export const briefs: Record<string, Brief> = {
  "ISS-D9": { issueId: "ISS-D9", ...PREBRIEF_0715 },
};

/**
 * 会前收进来的材料（Package 05 表头的「预审对象 / 关联材料」两栏），加上出报告
 * 之前必须先到的两份反馈。
 *
 * 屏幕上先写「文档已收集」再给报告，是因为顺序本身就是这套机制的说明：报告不是
 * 凭空写的，它是这几份东西齐了之后才出的。
 */
export const meetingIntake: Record<string, { kind: "material" | "agent" | "dri"; label: string; docId?: string }[]> = {
  "ISS-D9": [
    { kind: "material", label: "《词元云集总体战略定位与阶段路径》董事长汇报版（2026 年 7 月）" },
    { kind: "material", label: "7 月 12 日公司业务战略、报告优化及办公地点讨论逐字稿" },
    { kind: "agent", label: "CEO Agent 预审意见" },
    { kind: "dri", label: "DRI 反馈" },
  ],
};

/** 会后落在这件议题上的记录：会议纪要与会后复盘，全文进屏幕。 */
export const meetingRecords: Record<string, string[]> = {
  "ISS-D9": ["DOC-D2", "DOC-D3"],
};

// ===========================================================================
// 09｜会后闭环单（Package 06 纪要 + Package 07 复盘）
// ===========================================================================

/**
 * 7 月 15 日那场会。
 *
 * 排一场 `closed` 的会，是因为这场会**真的开过了** —— 纪要和复盘都在包里。会前预审
 * 挂在同一个域上，所以「会前准备 / 会后确认」两挡各有真东西：前一挡是进会议室之前
 * 那一页纸，后一挡是散会之后要签发的闭环单。
 */
export const meetings: Meeting[] = [
  {
    id: "MTG-D1",
    seq: 1,
    domainId: "BIZ-TK",
    scheduledLabel: "7 月 15 日 · 战略定位、会前预审与灯塔项目",
    state: "closed",
    startedAt: "2026-07-15T14:00:00+08:00",
    endedAt: "2026-07-15T18:00:00+08:00",
  },
];

/**
 * 闭环单。**判定单位是条，不是会。**
 *
 * 四个分区各有出处，混在一起就分不清哪条是会上真过了的、哪条只是复盘时提出来的：
 *
 *   拍板   Package 06「本次已确认的关键事项」六条。边界一栏取自 Package 07 §二 ——
 *          那份复盘对同一批决定补了「这不意味着什么」，而边界正是认知类结论的必填项。
 *   派发   Package 06 §六 六项任务，带完成要求、责任侧与时间。
 *   未决   Package 06 §五 五条未决事项 + Package 07 §四 五条待校准风险。
 *   沉淀   Package 07 §五「建议沉淀进入战略材料的要点」六条，每条带状态。
 *
 * 每个字段的 `origin` 全是 `confirmed`：这些话都在包里，没有一处是 AI 补的。真实运行
 * 时 AI 补的那些要标成 `drafted` 并在屏幕上自首 —— 审阅因此从「通读全文」变成
 * 「核对例外」。这一版一个例外都没有，那一行提示也就不该出现。
 */
export const closures: Record<string, MeetingClosure> = {
  "MTG-D1": {
    meetingId: "MTG-D1",
    seq: 1,
    domainId: "BIZ-TK",
    domainName: "词元云集",
    endedAt: "2026-07-15T18:00:00+08:00",
    // 由数据层按真实时钟重算，这里的值只是占位。
    minutesSince: 0,
    attendees: ["王总", "词元云集团队相关成员"],
    items: [
    {
      id: "CI-D1-1",
      kind: "decision",
      issueRef: "ISS-D7",
      issueTitle: "整体战略定位",
      title: "公司当前经营主线",
      fields: [
        { label: "会议结论", value: "主体资源从一号位的战略与经营问题切入，先贯通「战略形成—执行—反馈」，再向管理者和数字劳动力扩展。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "会议支持的判断", value: "面向企业经营与决策的主线应占主体资源；TokenOps 提供辅助性的真实负载和训练机会。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
      ],
      boundary: "辅助业务的扩张条件、资源上限与让位机制尚未明确 —— 这一条确认的是资源优先级，不是 TokenOps 的边界已经划定。",
      writeBack: [{ kind: "judgment", label: "01-J1 AI 时代企业经营范式重构的核心判断" }, { kind: "issue", label: "ISS-D7 整体战略定位" }],
      excluded: false,
    },
    {
      id: "CI-D1-2",
      kind: "decision",
      issueRef: "ISS-D7",
      issueTitle: "整体战略定位",
      title: "TokenOps 的角色",
      fields: [
        { label: "会议结论", value: "用于获得真实高频 Token 负载并训练路由、评测和调优能力，可补充现金流，但不作为与核心业务等权的第二主业。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
      ],
      boundary: "这不意味着 TokenOps 的规模已被限定 —— 扩张条件和让位机制仍是未决事项。",
      writeBack: [{ kind: "judgment", label: "01-J11 两类业务分别贡献不同输入，训练同一套核心能力" }],
      excluded: false,
    },
    {
      id: "CI-D1-3",
      kind: "decision",
      issueRef: "ISS-D7",
      issueTitle: "整体战略定位",
      title: "共同底座",
      fields: [
        { label: "会议结论", value: "Foundry / 企业本体、引擎与路由、TokenHub 作为两类业务共享的长期能力持续沉淀。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
      ],
      boundary: "「持续沉淀」不等于现在就投入自建 —— 每项能力解决什么具体问题、自建理由与暂缓条件，下一轮才逐项证明。",
      writeBack: [{ kind: "judgment", label: "01-J13 TKOS 四组成部分及职责边界" }],
      excluded: false,
    },
    {
      id: "CI-D1-4",
      kind: "decision",
      issueRef: "ISS-D8",
      issueTitle: "TKOS 研发深化",
      title: "CEO Agent 会前预审反馈",
      fields: [
        { label: "会议结论", value: "当前版本方向基本正确，王总评价约 70 分；下一阶段重点提升系统性、结构和稳定性。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "尚未验证的", value: "信息是否完整、重点是否足够聚焦、有没有遗漏 CEO 真正需要判断的问题；不同会议中能否稳定复用。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
      ],
      boundary: "方向性通过不等于可交付 —— 下一阶段验证的是系统性与结构，不再只是「能否理解」。",
      writeBack: [{ kind: "issue", label: "ISS-D8 TKOS 研发深化" }],
      excluded: false,
    },
    {
      id: "CI-D1-5",
      kind: "decision",
      issueRef: "ISS-D9",
      issueTitle: "灯塔项目推进",
      title: "灯塔项目产品原则",
      fields: [
        { label: "会议结论", value: "首版可控制范围和成熟度，但必须具备完整的端到端形态；后续通过真实使用持续迭代并沉淀为产品。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "会议支持的判断", value: "首个项目需要完整可用，能够被当作真实项目成果交付，再逐步提升品质和产品化程度。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
      ],
      boundary: "完整交付的范围、验收标准、客户配合和费用仍待项目方案明确 —— 这一条定的是形态，不是范围。",
      writeBack: [{ kind: "issue", label: "ISS-D9 灯塔项目推进" }],
      excluded: false,
    },
    {
      id: "CI-D1-6",
      kind: "decision",
      issueRef: "ISS-D9",
      issueTitle: "灯塔项目推进",
      title: "灯塔项目推进原则",
      fields: [
        { label: "会议结论", value: "按正式商业项目推进，尽快形成完整工作计划并高频迭代；定价研究与项目方案同步完成。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "定价方向", value: "项目价值主要来自一号位获得的判断支持及其带动组织的作用，定价应按贡献设计。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
      ],
      boundary: "约七成至八成为会议中的价值判断，尚未转化为报价模型或客户接受证据。",
      writeBack: [{ kind: "issue", label: "ISS-D9 灯塔项目推进" }],
      excluded: false,
    },
    {
      id: "CI-D1-7",
      kind: "mission",
      issueRef: "ISS-D7",
      issueTitle: "整体战略定位",
      title: "固化战略原则",
      fields: [
        { label: "完成要求", value: "将本次确认的核心业务 / TokenOps 关系、共同底座和阶段收入逻辑更新到标准战略材料与公司 Agent。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "责任侧", value: "战略 / 公司运营", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "时间", value: "下一版标准材料前", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
      ],
      writeBack: [{ kind: "decision", label: "派发 · 固化战略原则" }],
      excluded: false,
    },
    {
      id: "CI-D1-8",
      kind: "mission",
      issueRef: "ISS-D9",
      issueTitle: "灯塔项目推进",
      title: "形成灯塔工作计划",
      fields: [
        { label: "完成要求", value: "明确项目目标、首版完整形态、阶段交付、参与角色和验证标准，并与王总快速迭代。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "责任侧", value: "灯塔项目团队", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "时间", value: "立即启动", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
      ],
      writeBack: [{ kind: "decision", label: "派发 · 形成灯塔工作计划" }],
      excluded: false,
    },
    {
      id: "CI-D1-9",
      kind: "mission",
      issueRef: "ISS-D9",
      issueTitle: "灯塔项目推进",
      title: "完成定价研究与初步报价",
      fields: [
        { label: "完成要求", value: "研究同行部署及战略 / 组织变革项目收费，形成词元云集的价值定价框架。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "责任侧", value: "商业 / 项目团队", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "时间", value: "下一轮项目讨论前", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
      ],
      writeBack: [{ kind: "decision", label: "派发 · 完成定价研究与初步报价" }],
      excluded: false,
    },
    {
      id: "CI-D1-10",
      kind: "mission",
      issueRef: "ISS-D8",
      issueTitle: "TKOS 研发深化",
      title: "优化会前预审",
      fields: [
        { label: "完成要求", value: "基于王总反馈调整结构、信息密度和系统性，并在下一次真实会议前使用。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "责任侧", value: "产品 / Method", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "时间", value: "下一次真实会前", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
      ],
      writeBack: [{ kind: "decision", label: "派发 · 优化会前预审" }],
      excluded: false,
    },
    {
      id: "CI-D1-11",
      kind: "mission",
      issueRef: "ISS-D8",
      issueTitle: "TKOS 研发深化",
      title: "改善会议记录质量",
      fields: [
        { label: "完成要求", value: "优化录音与转写，验证会后能否稳定沉淀 Judgment / Agreement，降低后续人工校正。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "责任侧", value: "项目 / 产品团队", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "时间", value: "下一次会议起", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
      ],
      writeBack: [{ kind: "decision", label: "派发 · 改善会议记录质量" }],
      excluded: false,
    },
    {
      id: "CI-D1-12",
      kind: "mission",
      issueRef: "ISS-D7",
      issueTitle: "整体战略定位",
      title: "研究目标客户选择",
      fields: [
        { label: "完成要求", value: "比较「金融 / 证券优先」与「一号位牵引优先」，形成首批外部客户筛选标准。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "责任侧", value: "战略 / 商业团队", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
        { label: "时间", value: "下一轮客户策略讨论前", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
      ],
      writeBack: [{ kind: "decision", label: "派发 · 研究目标客户选择" }],
      excluded: false,
    },
    {
      id: "CI-D1-13",
      kind: "mission",
      issueRef: "ISS-D7",
      issueTitle: "整体战略定位",
      title: "目标客户优先级",
      fields: [
        { label: "当前状态 / 下一步判断", value: "金融 / 证券等知识密集行业是否应优先于其他行业；「行业优先」与「一号位牵引优先」需要进一步比较。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
      ],
      writeBack: [],
      excluded: false,
    },
    {
      id: "CI-D1-14",
      kind: "mission",
      issueRef: "ISS-D7",
      issueTitle: "整体战略定位",
      title: "核心业务对外命名",
      fields: [
        { label: "当前状态 / 下一步判断", value: "当前讨论过多个名称，尚未确认正式业务 / 产品名称。「企业 AI 决策系统」比「企业智能决策网络」更易被用户理解，但属于表达方向，尚未形成正式命名决定。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
      ],
      writeBack: [],
      excluded: false,
    },
    {
      id: "CI-D1-15",
      kind: "mission",
      issueRef: "ISS-D7",
      issueTitle: "整体战略定位",
      title: "收费结构",
      fields: [
        { label: "当前状态 / 下一步判断", value: "项目费、系统持续使用费、Token 使用费的组合与阶段切换条件尚未确定。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
      ],
      writeBack: [],
      excluded: false,
    },
    {
      id: "CI-D1-16",
      kind: "mission",
      issueRef: "ISS-D8",
      issueTitle: "TKOS 研发深化",
      title: "CEO Agent 预审结构",
      fields: [
        { label: "当前状态 / 下一步判断", value: "最终模块、信息密度、阅读形式需结合王总进一步使用反馈确定。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
      ],
      writeBack: [],
      excluded: false,
    },
    {
      id: "CI-D1-17",
      kind: "mission",
      issueRef: "ISS-D9",
      issueTitle: "灯塔项目推进",
      title: "灯塔首版边界",
      fields: [
        { label: "当前状态 / 下一步判断", value: "首版完整形态具体覆盖到什么深度、如何验收，需要在灯塔工作计划中明确。", origin: "confirmed", source: { label: "Package 06｜0715 管理层会议纪要" } },
      ],
      writeBack: [],
      excluded: false,
    },
    {
      id: "CI-D1-18",
      kind: "mission",
      issueRef: "ISS-D9",
      issueTitle: "灯塔项目推进",
      title: "首期验证被缩成产品试用",
      fields: [
        { label: "为什么当前仍不稳", value: "会议已提出真实使用与反馈，但尚未明确组织范围和跨层承接。单一 Agent 使用不能说明组织运行改变。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
        { label: "下一轮需要回答", value: "选择一个真实事项，明确二至三层管理者、行动、反馈和验收证据。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
      ],
      writeBack: [],
      excluded: false,
    },
    {
      id: "CI-D1-19",
      kind: "mission",
      issueRef: "ISS-D9",
      issueTitle: "灯塔项目推进",
      title: "价格逻辑停在价值判断",
      fields: [
        { label: "为什么当前仍不稳", value: "按贡献定价方向明确，客户愿意为什么价值付费、如何比较替代方案仍无证据。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
        { label: "下一轮需要回答", value: "给出价格区间、计价单位、客户收益假设、交付成本和推荐方案。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
      ],
      writeBack: [],
      excluded: false,
    },
    {
      id: "CI-D1-20",
      kind: "mission",
      issueRef: "ISS-D8",
      issueTitle: "TKOS 研发深化",
      title: "共同能力投入过早",
      fields: [
        { label: "为什么当前仍不稳", value: "本体、引擎、路由等被寄予长期期待，当前哪些能力阻塞项目尚未逐项证明。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
        { label: "下一轮需要回答", value: "列出每项能力解决的具体问题，自建理由与暂缓条件。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
      ],
      writeBack: [],
      excluded: false,
    },
    {
      id: "CI-D1-21",
      kind: "mission",
      issueRef: "ISS-D9",
      issueTitle: "灯塔项目推进",
      title: "叙事超过可验证事实",
      fields: [
        { label: "为什么当前仍不稳", value: "「企业 AI 决策系统」表达更清楚，产品实际能否改善判断质量、战略一致性和时间仍待验证。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
        { label: "下一轮需要回答", value: "用灯塔项目记录起点、使用过程、反馈、例外和阶段结果。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
      ],
      writeBack: [],
      excluded: false,
    },
    {
      id: "CI-D1-22",
      kind: "mission",
      issueRef: "ISS-D8",
      issueTitle: "TKOS 研发深化",
      title: "材料来源影响复盘可信度",
      fields: [
        { label: "为什么当前仍不稳", value: "逐字稿存在录音质量、会议标识和日期不一致问题。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
        { label: "下一轮需要回答", value: "建立会议编号、原始录音、转写版本、确认人和修改记录。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
      ],
      writeBack: [],
      excluded: false,
    },
    {
      id: "CI-D1-23",
      kind: "writeback",
      issueRef: "ISS-D7",
      issueTitle: "整体战略定位",
      title: "最高主线",
      fields: [
        { label: "建议写入内容", value: "AI 时代企业经营方式的变化，从一号位判断、战略传导、行动反馈和人机协作开始。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
        { label: "状态", value: "当前工作口径", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
      ],
      writeBack: [{ kind: "judgment", label: "01-J1 AI 时代企业经营范式重构的核心判断" }],
      excluded: false,
    },
    {
      id: "CI-D1-24",
      kind: "writeback",
      issueRef: "ISS-D7",
      issueTitle: "整体战略定位",
      title: "当前业务",
      fields: [
        { label: "建议写入内容", value: "以企业 AI 决策系统作为面向客户的表达方向，服务于一号位和管理层的经营判断。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
        { label: "状态", value: "表达方向，待命名确认", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
      ],
      writeBack: [{ kind: "judgment", label: "01-J1 AI 时代企业经营范式重构的核心判断" }],
      excluded: false,
    },
    {
      id: "CI-D1-25",
      kind: "writeback",
      issueRef: "ISS-D7",
      issueTitle: "整体战略定位",
      title: "辅助业务",
      fields: [
        { label: "建议写入内容", value: "TokenOps 用于获得真实负载，训练模型选择、调用成本、质量、稳定性和路由能力。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
        { label: "状态", value: "辅助业务口径", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
      ],
      writeBack: [{ kind: "judgment", label: "01-J1 AI 时代企业经营范式重构的核心判断" }],
      excluded: false,
    },
    {
      id: "CI-D1-26",
      kind: "writeback",
      issueRef: "ISS-D7",
      issueTitle: "整体战略定位",
      title: "阶段验证",
      fields: [
        { label: "建议写入内容", value: "灯塔项目要在明确组织范围内跑通一次判断、承接、行动和反馈，并留下可复核证据。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
        { label: "状态", value: "需补齐验证设计", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
      ],
      writeBack: [{ kind: "judgment", label: "01-J1 AI 时代企业经营范式重构的核心判断" }],
      excluded: false,
    },
    {
      id: "CI-D1-27",
      kind: "writeback",
      issueRef: "ISS-D7",
      issueTitle: "整体战略定位",
      title: "收入叙事",
      fields: [
        { label: "建议写入内容", value: "项目部署收入先建立真实关系；持续服务和运营收入在持续使用、角色扩展与交付效率出现后再逐步成立。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
        { label: "状态", value: "商业假设，待验证", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
      ],
      writeBack: [{ kind: "judgment", label: "01-J1 AI 时代企业经营范式重构的核心判断" }],
      excluded: false,
    },
    {
      id: "CI-D1-28",
      kind: "writeback",
      issueRef: "ISS-D7",
      issueTitle: "整体战略定位",
      title: "定价原则",
      fields: [
        { label: "建议写入内容", value: "以一号位获得的判断支持和组织带动价值为核心，结合项目范围、部署深度、使用方式和风险设计价格。", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
        { label: "状态", value: "原则已形成，模型待研究", origin: "confirmed", source: { label: "Package 07｜0715 会后复盘" } },
      ],
      writeBack: [{ kind: "judgment", label: "01-J1 AI 时代企业经营范式重构的核心判断" }],
      excluded: false,
    },
    ],
  },
};
