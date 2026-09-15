/**
 * 词元云集的经营本体种子。**这个文件是生成的，不要手改。**
 *
 *   node scripts/gen-seed-from-ontology.mjs ../Ontology-API-main1 > src/lib/data/seed-tokenking.ts
 *
 * 数据源是本体仓库的 data/instances/*.trig，也就是 agent 运行时读的同一份事实。
 * 手改这里会让屏幕和 agent 说的话对不上 —— 要改内容，改本体。
 *
 * 本体里没有产品运行态对象（对话、Point、研究报告、闭环单），那些由 agent 运行时
 * 产生，所以这里生成不出来，也不该生成。
 */

import type {
  Agent, Card, Company, CompanyOutcome, Doc, Domain, Issue, Judgment, JudgmentChange,
  MissionCard,
  Period, Person, Project,
} from "./types";

// TODAY 是全站的「今天」，提请台按它筛当日摊开哪几张。
import { TODAY } from "./shared";

/** 生成时刻的本体版本，用于排查「屏幕和 agent 对不上」。 */
export const ONTOLOGY_SOURCE = "9 个实例文件";

export const company: Company = { id: "CMP-tk", name: "北京词元云集人工智能科技有限公司", shortName: "词元云集" };

export const projects: Project[] = [
  { id: "PRJ-tkos", companyId: "CMP-tk", name: "TKOS", intent: "让企业的判断成为可持续运行的对象，而不是活在人脑和聊天记录里。" },
];

export const periods: Period[] = [
  { id: "PRD-2026-08", projectId: "PRJ-tkos", label: "2026 年 8 月", startsOn: "2026-08-01", endsOn: "2026-08-31" },
];

export const companyOutcomes: CompanyOutcome[] = [
  { id: "CO-company-outcome-au", periodId: "PRD-2026-08", statement: "8 月底完成词元云集第一次公司成型", dueOn: "2026-08-31" },
  { id: "CO-company-outcome-tk", periodId: "PRD-2026-08", statement: "TKOS 在词元云集自身和灯塔项目中进入真实战略运行", dueOn: "2026-08-29" },
  { id: "CO-outcome-lighthouse", periodId: "PRD-2026-08", statement: "让灯塔项目常态化高质量使用 CEO Agent", dueOn: "2026-08-29" },
  { id: "CO-outcome-native-age", periodId: "PRD-2026-08", statement: "产品 1.0 网页版本上线", dueOn: "2026-08-31" },
];

/** 这块屏幕是给谁看的。 */
export const VIEWER_ID = "PSN-01";

export const people: Person[] = [
  { id: "PSN-01", name: "刘明华", role: "ceo", title: "刘明华" },
  { id: "PSN-02", name: "白田田", role: "dri", title: "白田田" },
  { id: "PSN-03", name: "孙铭泽", role: "dri", title: "孙铭泽" },
  { id: "PSN-04", name: "CEO", role: "dri", title: "以 CEO 岗位作为直接责任承担方，在位人待确认。用于 Domain 01 方向与经营选择、Domain 02 Transformation（当前 DRI）。" },
  { id: "PSN-05", name: "业务负责人", role: "dri", title: "以业务负责人岗位作为直接责任承担方，在位人待确认。用于 Method、TokenHub 等域（候选映射，详见各 Domain）。" },
  { id: "PSN-06", name: "产品负责人", role: "dri", title: "以产品负责人岗位作为直接责任承担方，在位人待确认。用于 Domain 04 Agents。" },
  { id: "PSN-07", name: "数据负责人", role: "dri", title: "以数据负责人岗位作为直接责任承担方，在位人待确认。用于 Domain 05 Engine & Ontology（候选映射）。" },
  { id: "PSN-08", name: "财务负责人", role: "dri", title: "以财务负责人岗位作为直接责任承担方，在位人待确认。用于 Domain 08 公司运营与保障。" },
  { id: "PSN-09", name: "人力负责人", role: "dri", title: "以人力负责人岗位作为直接责任承担方，在位人待确认。用于 Domain 07 人才与组织能力。" },
  { id: "PSN-10", name: "刘人豪", role: "dri", title: "刘人豪" },
  { id: "PSN-11", name: "唐巨杰", role: "dri", title: "唐巨杰（2026-08-31 在位人校准带进来，本体里还没有这个人）" },
  { id: "PSN-12", name: "秦梦怡", role: "dri", title: "秦梦怡（2026-08-31 在位人校准带进来，本体里还没有这个人）" },
  { id: "PSN-13", name: "于斯一", role: "dri", title: "于斯一（2026-08-31 在位人校准带进来，本体里还没有这个人）" },
  { id: "PSN-14", name: "陈溪南", role: "dri", title: "陈溪南（2026-08-31 在位人校准带进来，本体里还没有这个人）" },
];

export const agents: Agent[] = people.map((p) => ({
  id: p.id.replace("PSN-", "AGT-"), personId: p.id, kind: p.role, label: `${p.name} 的 Agent`,
}));

export const domains: Domain[] = [
  { id: "D-03", projectId: "PRJ-tkos", code: "D-03", name: "Method", outcome: "Outcome-Mission-DRI 标准方法形成并真实运行", driIds: ["PSN-02"], commitmentStatus: "待确认" },
  { id: "D-04", projectId: "PRJ-tkos", code: "D-04", name: "Agents", outcome: "首批 TKOS Agents 形成并进入词元云集自身及灯塔项目真实使用", driIds: ["PSN-14", "PSN-03"], commitmentStatus: "待确认" },
  { id: "D-05", projectId: "PRJ-tkos", code: "D-05", name: "Engine & Ontology", outcome: "FE 支撑两条真实战略决策闭环", driIds: ["PSN-10", "PSN-13"], commitmentStatus: "待确认" },
  { id: "D-06", projectId: "PRJ-tkos", code: "D-06", name: "TokenOps", outcome: "TokenHub 第一版 MVP 完成并稳定承接核心调用", driIds: [], commitmentStatus: "待确认" },
  { id: "D-07", projectId: "PRJ-tkos", code: "D-07", name: "Organization & Talent", outcome: "核心团队实质搭建完成并形成第一版期权激励体系", driIds: ["PSN-12"], commitmentStatus: "待确认" },
  { id: "D-08", projectId: "PRJ-tkos", code: "D-08", name: "Finance & Compliance", outcome: "公司正式运行所需的财务、办公、采购、研发环境与合规基本到位", driIds: ["PSN-11"], commitmentStatus: "待确认" },
];

export const judgments: Judgment[] = [
  {
    id: "01-J1", domainId: "", kind: "strategy",
    statement: "AI 时代企业经营范式重构的核心判断",
    version: 1, standing: "unverified",
    confirmedBy: "", confirmedAt: "2026-07-01T00:00:00+08:00", freshUntil: "2026-10-31",
    basis: [{ text: "支撑旧经营范式的三个底层前提同时松动：外部变化从相对可预判变为不可预测；行业边界从稳定变为不断重组；组织能力从主要来自人变为人+智能杠杆共同构成。未来竞争将体现为不同经营范式之间的综合效率竞争；不改变者的效率代差会成为新竞争压力，可能是 2-5 倍甚至更高的综合竞争效率差。", traces: [{ kind: "int", source: "AI 时代企业经营范式重构（对外路演文字稿）", href: "/docs/DOC-13" }] }],
    revisions: [], reopenTriggers: [], shakenBy: [], verifiedByTasks: 0,
  },
  {
    id: "01-J5", domainId: "", kind: "strategy",
    statement: "FDE 第一层 ｜ 战略重构——从老板认知与决策支持破冰",
    version: 1, standing: "unverified",
    confirmedBy: "", confirmedAt: "2026-07-01T00:00:00+08:00", freshUntil: "2026-10-31",
    basis: [{ text: "起点是老板：围绕老板自身战略判断与管理问题建立直观可用的 AI 决策支持入口。产品形态候选：老板 AI 高参、老板决策支持 Agent、老板战略知识库/数字分身。目的是让老板形成对 AI 的真实感知，并把战略思考与管理意图沉淀为组织可调用资产。", traces: [{ kind: "int", source: "词元云集 AI FDE 商业模型战略讨论稿", href: "/docs/DOC-08" }] }],
    revisions: [], reopenTriggers: [], shakenBy: [], verifiedByTasks: 0,
  },
  {
    id: "01-J7", domainId: "", kind: "strategy",
    statement: "FDE 第三层 ｜ 运营重构——部门人+Agent 新运营方式与数字岗位沉淀",
    version: 1, standing: "unverified",
    confirmedBy: "", confirmedAt: "2026-07-01T00:00:00+08:00", freshUntil: "2026-10-31",
    basis: [{ text: "每个组织单元在人+Agent 共同工作的新条件下重新设计职能、流程、岗位与管理方法。数字岗位不凭空定义，而从部门运营重构中自然生成：高频、重复、可标准化的任务由 Agent 承担，必须由人判断的留在人，需人机协同的明确协同方式。部门负责人从管理人做流程转向管理人+Agent 共同完成业务结果。", traces: [{ kind: "int", source: "词元云集 AI FDE 商业模型战略讨论稿", href: "/docs/DOC-08" }] }],
    revisions: [], reopenTriggers: [], shakenBy: [], verifiedByTasks: 0,
  },
  {
    id: "01-J11", domainId: "", kind: "strategy",
    statement: "两类业务分别贡献不同输入，训练同一套核心能力",
    version: 1, standing: "unverified",
    confirmedBy: "", confirmedAt: "2026-07-01T00:00:00+08:00", freshUntil: "2026-10-31",
    basis: [{ text: "高价值场景（企业经营上下文、Agent/数字劳动力部署经验、长期客户关系与业务结果）与高频真实负载（模型选择与调用链、成本质量稳定性数据、路由与优化实验）共同输入 Agent Foundry/Ontology 引擎与路由模型，并由 TokenHub 平台承载。能力提升反过来降低交付成本、改善客户效果，推动更多场景部署与更多真实负载。", traces: [{ kind: "int", source: "词元云集总体战略定位与阶段路径（董事长汇报版｜2026 年 7 月）", href: "/docs/DOC-14" }] }],
    revisions: [], reopenTriggers: [], shakenBy: [], verifiedByTasks: 0,
  },
  {
    id: "01-J12", domainId: "", kind: "strategy",
    statement: "TKOS 总体定义",
    version: 1, standing: "unverified",
    confirmedBy: "", confirmedAt: "2026-07-01T00:00:00+08:00", freshUntil: "2026-10-31",
    basis: [{ text: "TKOS（TokenKing Operating System）是一套面向人和 Agent 混合组织的企业经营操作系统。它将经营方法、企业本体、Agent 运行引擎和角色化 Agents 整合在一起，以 Outcome 和 Mission 为核心，连接战略、责任、决策、执行、Review 与组织学习，使企业能够由人和 Agent 共同持续运行。产品灵魂：TKOS 管理的不是人，也不是 Agent，而是企业结果如何由人和 Agent 共同实现。", traces: [{ kind: "int", source: "TKOS 总体定义（高管讨论稿 v0.2）", href: "/docs/DOC-09" }] }],
    revisions: [], reopenTriggers: [], shakenBy: [], verifiedByTasks: 0,
  },
  {
    id: "01-J13", domainId: "", kind: "strategy",
    statement: "TKOS 四组成部分及职责边界",
    version: 1, standing: "unverified",
    confirmedBy: "", confirmedAt: "2026-07-01T00:00:00+08:00", freshUntil: "2026-10-31",
    basis: [{ text: "Method（规则与组织宪法，缺失则退化为普通 Agent 平台）、Ontology（事实、关系与上下文底座）、Engine（运行、编排与控制中枢）、Agents（角色化智能体与工作入口）。四部分不是平行产品：Method 规定应如何经营，Ontology 表达当前状态，Engine 推动持续运行，Agents 让角色参与使用。", traces: [{ kind: "int", source: "TKOS 总体定义（高管讨论稿 v0.2）", href: "/docs/DOC-09" }] }],
    revisions: [], reopenTriggers: [], shakenBy: [], verifiedByTasks: 0,
  },
  {
    id: "03-J1", domainId: "D-03", kind: "strategy",
    statement: "原则一：Outcome 先于任务",
    version: 1, standing: "unverified",
    confirmedBy: "", confirmedAt: "2026-07-01T00:00:00+08:00", freshUntil: "2026-10-31",
    basis: [{ text: "先定义阶段性结果，再讨论动作。没有清晰 Outcome 的任务只会制造忙碌。", traces: [{ kind: "int", source: "词元云集 TKOS 方法论框架（内部讨论版 v1.0）", href: "/docs/DOC-10" }] }],
    revisions: [], reopenTriggers: [], shakenBy: [], verifiedByTasks: 0,
  },
  {
    id: "03-J2", domainId: "D-03", kind: "strategy",
    statement: "原则二：Mission 是基本经营单元",
    version: 1, standing: "unverified",
    confirmedBy: "", confirmedAt: "2026-07-01T00:00:00+08:00", freshUntil: "2026-10-31",
    basis: [{ text: "Mission 不是待办事项，而是围绕一个关键结果，由唯一 DRI 牵引人、Agent 和资源共同完成的经营承诺。", traces: [{ kind: "int", source: "词元云集 TKOS 方法论框架（内部讨论版 v1.0）", href: "/docs/DOC-10" }] }],
    revisions: [], reopenTriggers: [], shakenBy: [], verifiedByTasks: 0,
  },
  {
    id: "03-J3", domainId: "D-03", kind: "strategy",
    statement: "原则三：唯一 DRI 承担结果责任",
    version: 1, standing: "unverified",
    confirmedBy: "", confirmedAt: "2026-07-01T00:00:00+08:00", freshUntil: "2026-10-31",
    basis: [{ text: "协作可以多人参与，但结果责任只能唯一。DRI 有权提出路径、资源、边界和风险，而不是被动接收任务。", traces: [{ kind: "int", source: "词元云集 TKOS 方法论框架（内部讨论版 v1.0）", href: "/docs/DOC-10" }] }],
    revisions: [], reopenTriggers: [], shakenBy: [], verifiedByTasks: 0,
  },
  {
    id: "03-J4", domainId: "D-03", kind: "strategy",
    statement: "原则四：Agent 是运行主体而非外挂工具",
    version: 1, standing: "unverified",
    confirmedBy: "", confirmedAt: "2026-07-01T00:00:00+08:00", freshUntil: "2026-10-31",
    basis: [{ text: "Agent 应正式承担检索、分析、生成、执行、记录、追踪与预警等工作，并被赋予清晰权限、质量标准与可回退机制。", traces: [{ kind: "int", source: "词元云集 TKOS 方法论框架（内部讨论版 v1.0）", href: "/docs/DOC-10" }] }],
    revisions: [], reopenTriggers: [], shakenBy: [], verifiedByTasks: 0,
  },
  {
    id: "03-J5", domainId: "D-03", kind: "strategy",
    statement: "原则五：Context 必须统一且可更新",
    version: 1, standing: "unverified",
    confirmedBy: "", confirmedAt: "2026-07-01T00:00:00+08:00", freshUntil: "2026-10-31",
    basis: [{ text: "组织成员与 Agent 必须围绕同一套被确认的战略、决策、角色与 Mission 工作。Context 需要版本、确认、冲突与失效管理。", traces: [{ kind: "int", source: "词元云集 TKOS 方法论框架（内部讨论版 v1.0）", href: "/docs/DOC-10" }] }],
    revisions: [], reopenTriggers: [], shakenBy: [], verifiedByTasks: 0,
  },
  {
    id: "03-J6", domainId: "D-03", kind: "strategy",
    statement: "原则六：Review 处理异常与判断",
    version: 1, standing: "unverified",
    confirmedBy: "", confirmedAt: "2026-07-01T00:00:00+08:00", freshUntil: "2026-10-31",
    basis: [{ text: "经营 Review 不应是流水汇报，而应集中处理风险、依赖、资源冲突、关键选择与 Mission 调整。", traces: [{ kind: "int", source: "词元云集 TKOS 方法论框架（内部讨论版 v1.0）", href: "/docs/DOC-10" }] }],
    revisions: [], reopenTriggers: [], shakenBy: [], verifiedByTasks: 0,
  },
  {
    id: "03-J7", domainId: "D-03", kind: "strategy",
    statement: "原则七：每次运行都要形成资产",
    version: 1, standing: "unverified",
    confirmedBy: "", confirmedAt: "2026-07-01T00:00:00+08:00", freshUntil: "2026-10-31",
    basis: [{ text: "一个 Mission 结束后不只留下结果，还应沉淀判断、数据、模板、Agent 能力与 Work Pattern。", traces: [{ kind: "int", source: "词元云集 TKOS 方法论框架（内部讨论版 v1.0）", href: "/docs/DOC-10" }] }],
    revisions: [], reopenTriggers: [], shakenBy: [], verifiedByTasks: 0,
  },
  {
    id: "03-J8", domainId: "D-03", kind: "strategy",
    statement: "治理原则：Human accountable, Agent enabled",
    version: 1, standing: "unverified",
    confirmedBy: "", confirmedAt: "2026-07-01T00:00:00+08:00", freshUntil: "2026-10-31",
    basis: [{ text: "人承担责任，Agent 增强能力。每个 Mission 必须有明确的人类 DRI；关键 Mission 的设立、调整与关闭需由人确认；Agent 可识别 Decision/Risk/Evidence/Lesson 候选，但重要资产进入正式上下文前应有确认机制；权限以 Domain/Mission/角色为基础；所有关键变化必须可追溯。", traces: [{ kind: "int", source: "TKOS 本体建模设计（内部高管研讨稿 v0.2）", href: "/docs/DOC-11" }] }],
    revisions: [], reopenTriggers: [], shakenBy: [], verifiedByTasks: 0,
  },
];

/** 判断的变更流水。本体里还没有 —— 判断被改写会由 A10 写回时产生。 */
export const judgmentChanges: JudgmentChange[] = [];

export const missionCards: MissionCard[] = [
  { id: "MC-01", domainId: "D-05", code: "MC-01", name: "词元云集的一条真实战略决策闭环由连续企业 Context 支撑运行", driId: "PSN-07", status: "pending", milestone: "8 月" },
  { id: "MC-02", domainId: "D-05", code: "MC-02", name: "灯塔项目的一条真实战略决策闭环由可迁移 Context 支撑运行", driId: "PSN-07", status: "pending", milestone: "8 月" },
  { id: "MC-03", domainId: "D-05", code: "MC-03", name: "两条真实闭环沉淀为最小可复用 FE 能力", driId: "PSN-07", status: "pending", milestone: "8 月" },
];

/**
 * 战略议题。本体里全是 Candidate —— 已识别、待一号位确认是否值得投入认知资源。
 * 产品里就是 `Candidate`：还在提请台上等他按三个键，一件在办的都没有。
 *
 * **没有 domainId。** 本体的 StrategicIssue 上没有「属于哪个域」这层关系（ISS-009
 * 的原文自己写着「当前材料未给出具体 Domain」）。所以议题落在哪个域，是他在提请台
 * 上采信那一刻由卡片带过去的（`disposeCard`），不是这里编出来的。
 *
 * judgmentRefs 来自 scripts/issue-judgment-links.json：本体没有「议题动摇哪条判断」这层关系，那一条
 * 由模型提案、待人确认。空数组是诚实的空 —— 有议题确实不动摇任何在版判断。
 *
 * **`store.ts` 上线第一天不装这一批。** 生成器照本体如实生成，那是它的职责；
 * 装不装是产品决定，写在 `store.ts` 的初始化里。第一天连潜在议题那一屏也是空的：
 * 每一件进来的事都得有一条真实的来路（雷达抓的 / DRI 押上名字递的 / 他自己提的），
 * 预置九条「已经摊在提请台上」等于替这三条来路各编了一次来历。
 */
export const issues: Issue[] = [
  {
    id: "ISS-001", title: "词元云集工作方法建设",
    state: "Candidate", origin: "signal",
    judgmentRefs: [],
    nextActionForUser: null,
    raisedAt: "2026-08-11T00:00:00+08:00", updatedAt: "2026-08-11T00:00:00+08:00",
  },
  {
    id: "ISS-002", title: "房懂懂业务本体设计选择",
    state: "Candidate", origin: "signal",
    judgmentRefs: [],
    nextActionForUser: null,
    raisedAt: "2026-08-11T00:00:00+08:00", updatedAt: "2026-08-11T00:00:00+08:00",
  },
  {
    id: "ISS-003", title: "TKOS 首要目标客户应锁定哪一类",
    state: "Candidate", origin: "signal",
    judgmentRefs: [],
    nextActionForUser: null,
    raisedAt: "2026-07-01T00:00:00+08:00", updatedAt: "2026-07-01T00:00:00+08:00",
  },
  {
    id: "ISS-004", title: "TKOS 第一阶段最小闭环应聚焦哪类经营场景",
    state: "Candidate", origin: "signal",
    judgmentRefs: [],
    nextActionForUser: null,
    raisedAt: "2026-07-01T00:00:00+08:00", updatedAt: "2026-07-01T00:00:00+08:00",
  },
  {
    id: "ISS-005", title: "是否确认企业经营范式重构与 Token 运营中枢为长期身份",
    state: "Candidate", origin: "signal",
    judgmentRefs: ["01-J1"],
    nextActionForUser: null,
    raisedAt: "2026-07-01T00:00:00+08:00", updatedAt: "2026-07-01T00:00:00+08:00",
  },
  {
    id: "ISS-006", title: "收入结构由项目部署向系统持续使用与 Token 运营迁移的节奏",
    state: "Candidate", origin: "signal",
    judgmentRefs: [],
    nextActionForUser: null,
    raisedAt: "2026-07-01T00:00:00+08:00", updatedAt: "2026-07-01T00:00:00+08:00",
  },
  {
    id: "ISS-007", title: "831 定位为闭环验证节点而非大平台完成节点",
    state: "Candidate", origin: "signal",
    judgmentRefs: [],
    nextActionForUser: null,
    raisedAt: "2026-07-01T00:00:00+08:00", updatedAt: "2026-07-01T00:00:00+08:00",
  },
  {
    id: "ISS-008", title: "是否在本季度同时完成产品 1.0 上线和灯塔项目交付",
    state: "Candidate", origin: "signal",
    judgmentRefs: ["01-J11"],
    nextActionForUser: null,
    raisedAt: "2026-08-11T00:00:00+08:00", updatedAt: "2026-08-11T00:00:00+08:00",
  },
  {
    id: "ISS-009", title: "是否在本季度追加渠道扩张投入",
    state: "Candidate", origin: "signal",
    judgmentRefs: [],
    nextActionForUser: null,
    raisedAt: "2026-08-11T00:00:00+08:00", updatedAt: "2026-08-11T00:00:00+08:00",
  },
];

/**
 * 潜在议题卡，一条议题一张。来路是 `ceo`（这些议题萃自他自己的战略材料）——
 * 不是 `radar`：自动抓取还没接，写 radar 就是伪造「有人在外面盯着变化」这个可信度。
 *
 * 和 `issues` 一样，`store.ts` 上线第一天不装 —— 见上面那段注释。
 */
export const cards: Card[] = [
  {
    id: "CARD-001", issueId: "ISS-001",
    headline: "词元云集工作方法建设",
    source: { kind: "ceo" },
    what: [{ text: "DRI 指定的首批词元云集验证场景。需在实际运行中明确 CEO Agent 如何承接 Outcome-Mission-DRI、战略议题、判断、Decision 与 Review 的工作方法。", traces: [{ kind: "int", source: "DRI 对 CEO Agent 入口、组件状态与首批验证场景的更新", href: "/docs/DOC-03" }] }],
    why: "预研还在跑。跑完这里会写清楚为什么是现在。",
    strategyRef: { id: "", statement: "本体里暂未关联到在版判断" },
    suggestion: { text: "等预研跑完再给处置建议。", traces: [{ kind: "agent", source: "您的 Agent · 预研中" }] },
    refs: [],
    domainIds: [],
    createdAt: "2026-08-11T00:00:00+08:00",
  },
  {
    id: "CARD-002", issueId: "ISS-002",
    headline: "房懂懂业务本体设计选择",
    source: { kind: "ceo" },
    what: [{ text: "DRI 指定的首批房懂懂验证场景。需围绕真实业务材料形成候选经营对象、关系、Context 边界与设计选择，并由项目授权人员确认事实与选择。", traces: [{ kind: "int", source: "DRI 对 CEO Agent 入口、组件状态与首批验证场景的更新", href: "/docs/DOC-03" }] }],
    why: "预研还在跑。跑完这里会写清楚为什么是现在。",
    strategyRef: { id: "", statement: "本体里暂未关联到在版判断" },
    suggestion: { text: "等预研跑完再给处置建议。", traces: [{ kind: "agent", source: "您的 Agent · 预研中" }] },
    refs: [],
    domainIds: [],
    createdAt: "2026-08-11T00:00:00+08:00",
  },
  {
    id: "CARD-003", issueId: "ISS-003",
    headline: "TKOS 首要目标客户应锁定哪一类",
    source: { kind: "ceo" },
    what: [{ text: "需高管确认：TKOS 首要目标客户是 AI 原生公司、正在开展 AI 转型的大型企业，还是先从词元云集自身运行开始验证。", traces: [{ kind: "int", source: "TKOS 总体定义（高管讨论稿 v0.2）", href: "/docs/DOC-09" }] }],
    why: "预研还在跑。跑完这里会写清楚为什么是现在。",
    strategyRef: { id: "", statement: "本体里暂未关联到在版判断" },
    suggestion: { text: "等预研跑完再给处置建议。", traces: [{ kind: "agent", source: "您的 Agent · 预研中" }] },
    refs: [],
    domainIds: [],
    createdAt: "2026-07-01T00:00:00+08:00",
  },
  {
    id: "CARD-004", issueId: "ISS-004",
    headline: "TKOS 第一阶段最小闭环应聚焦哪类经营场景",
    source: { kind: "ceo" },
    what: [{ text: "需高管确认：第一阶段最小闭环聚焦战略经营、Mission 管理、管理者 Agent 网络，还是一号位决策与推动。", traces: [{ kind: "int", source: "TKOS 总体定义（高管讨论稿 v0.2）", href: "/docs/DOC-09" }] }],
    why: "预研还在跑。跑完这里会写清楚为什么是现在。",
    strategyRef: { id: "", statement: "本体里暂未关联到在版判断" },
    suggestion: { text: "等预研跑完再给处置建议。", traces: [{ kind: "agent", source: "您的 Agent · 预研中" }] },
    refs: [],
    domainIds: [],
    createdAt: "2026-07-01T00:00:00+08:00",
  },
  {
    id: "CARD-005", issueId: "ISS-005",
    headline: "是否确认企业经营范式重构与 Token 运营中枢为长期身份",
    source: { kind: "ceo" },
    what: [{ text: "需管理层确认：以企业经营范式重构与 Token 运营中枢作为词元云集长期身份，AI 企业智能决策网络为主体资源方向、TokenOps 仅保持轻量验证。", traces: [{ kind: "int", source: "词元云集总体战略定位与阶段路径（董事长汇报版｜2026 年 7 月）", href: "/docs/DOC-14" }] }],
    why: "预研还在跑。跑完这里会写清楚为什么是现在。",
    strategyRef: { id: "01-J1", statement: "AI 时代企业经营范式重构的核心判断" },
    suggestion: { text: "等预研跑完再给处置建议。", traces: [{ kind: "agent", source: "您的 Agent · 预研中" }] },
    refs: [],
    domainIds: [],
    createdAt: "2026-07-01T00:00:00+08:00",
  },
  {
    id: "CARD-006", issueId: "ISS-006",
    headline: "收入结构由项目部署向系统持续使用与 Token 运营迁移的节奏",
    source: { kind: "ceo" },
    what: [{ text: "需管理层确认：短期以项目与部署收入为主，中长期向系统持续使用与 Token 运营收入迁移；当前不能把 Token 消纳设为唯一牵引。", traces: [{ kind: "int", source: "词元云集总体战略定位与阶段路径（董事长汇报版｜2026 年 7 月）", href: "/docs/DOC-14" }] }],
    why: "预研还在跑。跑完这里会写清楚为什么是现在。",
    strategyRef: { id: "", statement: "本体里暂未关联到在版判断" },
    suggestion: { text: "等预研跑完再给处置建议。", traces: [{ kind: "agent", source: "您的 Agent · 预研中" }] },
    refs: [],
    domainIds: [],
    createdAt: "2026-07-01T00:00:00+08:00",
  },
  {
    id: "CARD-007", issueId: "ISS-007",
    headline: "831 定位为闭环验证节点而非大平台完成节点",
    source: { kind: "ceo" },
    what: [{ text: "需确认：831 的成功标准是真实客户、真实使用、真实调用、真实反馈、可复制方案与明确 Owner 同时成立，而非大平台完成。", traces: [{ kind: "int", source: "词元云集总体战略定位与阶段路径（董事长汇报版｜2026 年 7 月）", href: "/docs/DOC-14" }] }],
    why: "预研还在跑。跑完这里会写清楚为什么是现在。",
    strategyRef: { id: "", statement: "本体里暂未关联到在版判断" },
    suggestion: { text: "等预研跑完再给处置建议。", traces: [{ kind: "agent", source: "您的 Agent · 预研中" }] },
    refs: [],
    domainIds: [],
    createdAt: "2026-07-01T00:00:00+08:00",
  },
  {
    id: "CARD-008", issueId: "ISS-008",
    headline: "是否在本季度同时完成产品 1.0 上线和灯塔项目交付",
    source: { kind: "ceo" },
    what: [{ text: "用户指定 FE 为责任锚点。该事项涉及 Agents 的产品上线、Transformation 的灯塔采用与价值验证，以及 FE 的企业 Context、追溯和运行能力，应通过公司级 Mission Portfolio 明确资源取舍、风险控制与验收路径。", traces: [{ kind: "int", source: "DRI 提供的 FE 真实议题与当前 Outcome", href: "/docs/DOC-19" }] }],
    why: "预研还在跑。跑完这里会写清楚为什么是现在。",
    strategyRef: { id: "01-J11", statement: "两类业务分别贡献不同输入，训练同一套核心能力" },
    suggestion: { text: "等预研跑完再给处置建议。", traces: [{ kind: "agent", source: "您的 Agent · 预研中" }] },
    refs: [],
    domainIds: [],
    createdAt: "2026-08-11T00:00:00+08:00",
  },
  {
    id: "CARD-009", issueId: "ISS-009",
    headline: "是否在本季度追加渠道扩张投入",
    source: { kind: "ceo" },
    what: [{ text: "飞书方案第十章提出的首个验证议题。用户将该材料指定为 FE-M1 的真实议题材料；当前材料未给出具体 Domain、基线数据、备选投入方案、正式 Decision 或验收责任分工。", traces: [{ kind: "int", source: "TKOS 企业事项与个人决策本体方案（第 508 版）", href: "/docs/DOC-18" }] }],
    why: "预研还在跑。跑完这里会写清楚为什么是现在。",
    strategyRef: { id: "", statement: "本体里暂未关联到在版判断" },
    suggestion: { text: "等预研跑完再给处置建议。", traces: [{ kind: "agent", source: "您的 Agent · 预研中" }] },
    refs: [],
    domainIds: [],
    createdAt: "2026-08-11T00:00:00+08:00",
  },
];

/** 提请台那一天摊开哪几张。跟上面 `issues` / `cards` 一样，live 那一档不装 —— 见 `issues` 的注释。 */
export const digests = [{ date: TODAY, cardIds: ["CARD-001", "CARD-002", "CARD-003", "CARD-004", "CARD-005", "CARD-006", "CARD-007", "CARD-008", "CARD-009"] }];

/** 议题的范围与背景。喂给 A3 预研，不进 Issue 类型（那是屏幕对象）。 */
export const issueScopes: Record<string, string> = {
  "ISS-001": "DRI 指定的首批词元云集验证场景。需在实际运行中明确 CEO Agent 如何承接 Outcome-Mission-DRI、战略议题、判断、Decision 与 Review 的工作方法。",
  "ISS-002": "DRI 指定的首批房懂懂验证场景。需围绕真实业务材料形成候选经营对象、关系、Context 边界与设计选择，并由项目授权人员确认事实与选择。",
  "ISS-003": "需高管确认：TKOS 首要目标客户是 AI 原生公司、正在开展 AI 转型的大型企业，还是先从词元云集自身运行开始验证。",
  "ISS-004": "需高管确认：第一阶段最小闭环聚焦战略经营、Mission 管理、管理者 Agent 网络，还是一号位决策与推动。",
  "ISS-005": "需管理层确认：以企业经营范式重构与 Token 运营中枢作为词元云集长期身份，AI 企业智能决策网络为主体资源方向、TokenOps 仅保持轻量验证。",
  "ISS-006": "需管理层确认：短期以项目与部署收入为主，中长期向系统持续使用与 Token 运营收入迁移；当前不能把 Token 消纳设为唯一牵引。",
  "ISS-007": "需确认：831 的成功标准是真实客户、真实使用、真实调用、真实反馈、可复制方案与明确 Owner 同时成立，而非大平台完成。",
  "ISS-008": "用户指定 FE 为责任锚点。该事项涉及 Agents 的产品上线、Transformation 的灯塔采用与价值验证，以及 FE 的企业 Context、追溯和运行能力，应通过公司级 Mission Portfolio 明确资源取舍、风险控制与验收路径。",
  "ISS-009": "飞书方案第十章提出的首个验证议题。用户将该材料指定为 FE-M1 的真实议题材料；当前材料未给出具体 Domain、基线数据、备选投入方案、正式 Decision 或验收责任分工。",
};

export const docs: Doc[] = [
  { id: "DOC-01", title: "0810 TKOS Domain DRI 复盘会议 Week 1 纪要", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:business-document:0810-week1-review", updatedAt: "2026-08-10T09:25:00+08:00", body: "", citedBy: [] },
  { id: "DOC-02", title: "CEO Agent 网页入口 HTTP 可访问性检查", folder: "本体来源", source: "clark", mirrorOf: "https://meeting-green-phi.vercel.app/", updatedAt: "2026-08-11T14:31:45+08:00", body: "", citedBy: [] },
  { id: "DOC-03", title: "DRI 对 CEO Agent 入口、组件状态与首批验证场景的更新", folder: "本体来源", source: "clark", mirrorOf: "conversation://current-thread/2026-08-11#ceoagent-and-scenarios", updatedAt: "2026-08-11T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-04", title: "CEO Agent 会前会后产物反馈", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:ceo-agent-artifacts:feedback", updatedAt: "2026-08-11T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-05", title: "房懂懂推理 Agent 执行计划", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:ceo-agent-artifacts:fangdongdong-reasoning-agent-plan", updatedAt: "2026-08-11T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-06", title: "房懂懂重塑传统房产销售行业资本市场报告", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:ceo-agent-artifacts:fangdongdong-capital-market-report", updatedAt: "2026-08-11T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-07", title: "DRI 对产品 1.0 产出与 CEO 验证路径的更新", folder: "本体来源", source: "clark", mirrorOf: "conversation://current-thread/2026-08-11#product1-validation-update", updatedAt: "2026-08-11T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-08", title: "词元云集 AI FDE 商业模型战略讨论稿", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:business-document:ai-fde-business-model-strategy-2026-07", updatedAt: "2026-08-12T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-09", title: "TKOS 总体定义（高管讨论稿 v0.2）", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:business-document:tkos-overall-definition-v0-2-2026-07", updatedAt: "2026-08-12T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-10", title: "词元云集 TKOS 方法论框架（内部讨论版 v1.0）", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:business-document:tkos-methodology-framework-v1-0-2026-07", updatedAt: "2026-08-12T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-11", title: "TKOS 本体建模设计（内部高管研讨稿 v0.2）", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:business-document:tkos-ontology-modeling-design-v0-2-2026-07", updatedAt: "2026-08-12T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-12", title: "AI-Native Mission 工作方法（正式版 v1.1）", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:business-document:ai-native-mission-work-method-v1-1-2026-08", updatedAt: "2026-08-12T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-13", title: "AI 时代企业经营范式重构（对外路演文字稿）", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:business-document:paradigm-reconstruction-roadshow-2026-07", updatedAt: "2026-08-12T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-14", title: "词元云集总体战略定位与阶段路径（董事长汇报版｜2026 年 7 月）", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:business-document:strategy-positioning-and-phased-path-2026-07", updatedAt: "2026-08-12T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-15", title: "AI 企业智能决策网络商业模式（董事长汇报版｜2026 年 7 月）", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:business-document:ai-enterprise-decision-network-business-model-2026-07", updatedAt: "2026-08-12T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-16", title: "企业 AI 转型 TKOS 设计方案（管理层汇报版 vf）", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:business-document:tkos-design-management-report-vf-2026-08", updatedAt: "2026-08-12T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-17", title: "8 月 FE Domain Mission Card（CEO 对齐版 v2.0）", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:business-document:2026-08-fe-domain-mission-card-v2", updatedAt: "2026-08-11T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-18", title: "TKOS 企业事项与个人决策本体方案（第 508 版）", folder: "本体来源", source: "clark", mirrorOf: "https://tokenking.feishu.cn/docx/QRSLdn85zo2ujZxCblVc3e50n2c#revision-508", updatedAt: "2026-08-11T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-19", title: "DRI 提供的 FE 真实议题与当前 Outcome", folder: "本体来源", source: "clark", mirrorOf: "conversation://current-thread/2026-08-11#real-issue-brief", updatedAt: "2026-08-11T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-20", title: "2026 年 8 月 Outcome-Mission 展开纲领（正式版 v1.1）", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:business-document:2026-08-outcome-mission-v1.1", updatedAt: "2026-08-11T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-21", title: "灯塔项目工作计划 v10", folder: "本体来源", source: "clark", mirrorOf: "urn:tkos:source:business-document:lighthouse-work-plan-v10", updatedAt: "2026-08-11T00:00:00+08:00", body: "", citedBy: [] },
  { id: "DOC-22", title: "DRI 对 FE Domain Mission Card 蒸馏结构的初步确认", folder: "本体来源", source: "clark", mirrorOf: "conversation://current-thread/2026-08-11#confirmation", updatedAt: "2026-08-11T00:00:00+08:00", body: "", citedBy: [] },
];

/**
 * 短码 → 本体 member id。
 *
 * 屏幕和正文里用短码（01-J2 / ISS-003），因为 CEO 读的是句子不是 slug；本体那边
 * 用的是 slug。这张表让 lib/ontology 的压缩器能把 [member:xxx] 换回短码，也让
 * Point 的溯源能落回本体对象。
 */
export const ontologyRefs: Record<string, string> = {
  "01-J1": "strategy-content-paradigm-shift-thesis",
  "01-J2": "strategy-content-new-paradigm-mechanism",
  "01-J3": "strategy-content-why-start-from-ceo",
  "01-J4": "strategy-content-fde-three-layer",
  "01-J5": "strategy-content-fde-strategy-reconstruction",
  "01-J6": "strategy-content-fde-org-reconstruction",
  "01-J7": "strategy-content-fde-operation-reconstruction",
  "01-J8": "strategy-content-revenue-model-stages",
  "01-J9": "strategy-content-fde-commercial-path",
  "01-J10": "strategy-content-831-failure-signals",
  "01-J11": "strategy-content-dual-business-feedback-loop",
  "01-J12": "strategy-content-tkos-definition",
  "01-J13": "strategy-content-tkos-four-components",
  "01-J14": "strategy-content-tkos-five-layers",
  "01-J15": "strategy-content-operating-closed-loop",
  "01-J16": "strategy-content-three-layer-responsibility",
  "01-J17": "strategy-content-human-agent-division",
  "01-J18": "strategy-content-ontology-framework",
  "01-J19": "strategy-content-ontology-data-states",
  "01-J20": "strategy-content-context-asset-types",
  "01-J21": "strategy-content-mission-card-standard",
  "01-J22": "strategy-content-dri-commitment-conditions",
  "01-J23": "strategy-content-review-cadence",
  "01-J24": "strategy-content-method-landing-signs",
  "01-J25": "strategy-content-act-model",
  "01-J26": "strategy-content-tq-model",
  "01-J27": "strategy-content-august-mission-portfolio-baseline",
  "03-J1": "principle-outcome-before-task",
  "03-J2": "principle-mission-as-basic-unit",
  "03-J3": "principle-unique-dri",
  "03-J4": "principle-agent-as-runtime-subject",
  "03-J5": "principle-unified-context",
  "03-J6": "principle-review-handles-exception",
  "03-J7": "principle-every-run-forms-asset",
  "03-J8": "principle-human-accountable-agent-enabled",
  "ISS-001": "issue-tokenking-work-method-construction",
  "ISS-002": "issue-fangdongdong-business-ontology-design-choice",
  "ISS-003": "issue-tkos-first-target-customer",
  "ISS-004": "issue-tkos-first-minimum-loop",
  "ISS-005": "issue-long-term-identity-confirmation",
  "ISS-006": "issue-revenue-model-migration",
  "ISS-007": "issue-831-as-loop-validation-node",
  "ISS-008": "issue-product1-lighthouse-synchronous-delivery",
  "ISS-009": "issue-q3-channel-expansion-investment",
  "DOC-01": "source-week1-domain-dri-review-2026-08-10",
  "DOC-02": "source-ceoagent-endpoint-check-2026-08-11",
  "DOC-03": "source-dri-ceoagent-scenarios-update-2026-08-11",
  "DOC-04": "source-ceoagent-feedback-2026-08-11",
  "DOC-05": "source-fangdongdong-reasoning-agent-plan-2026-08-11",
  "DOC-06": "source-fangdongdong-capital-market-report-2026-08-11",
  "DOC-07": "source-dri-product1-validation-update-2026-08-11",
  "DOC-08": "source-fde-business-model-2026-07",
  "DOC-09": "source-tkos-overall-definition-v0-2",
  "DOC-10": "source-methodology-framework-v1-0",
  "DOC-11": "source-ontology-modeling-design-v0-2",
  "DOC-12": "source-ai-native-mission-method-v1-1",
  "DOC-13": "source-paradigm-reconstruction-roadshow-2026-07",
  "DOC-14": "source-strategy-positioning-2026-07",
  "DOC-15": "source-ai-decision-network-business-model-2026-07",
  "DOC-16": "source-tkos-design-management-report-2026-08",
  "DOC-17": "source-fe-domain-mission-card-2026-08",
  "DOC-18": "source-tkos-enterprise-persona-scheme-r508",
  "DOC-19": "source-dri-real-issue-brief-2026-08-11",
  "DOC-20": "source-august-outcome-mission-baseline-v1-1",
  "DOC-21": "source-lighthouse-project-plan-v10",
  "DOC-22": "source-dri-preliminary-confirmation-fe-card-2026-08-11",
  "MC-01": "mission-fe-m1-internal-context-loop",
  "MC-02": "mission-fe-m2-lighthouse-context-loop",
  "MC-03": "mission-fe-m3-reusable-capability",
  "CO-company-outcome-au": "company-outcome-august-first-formation-2026-08",
  "CO-company-outcome-tk": "company-outcome-tkos-real-strategy-loop-2026-08",
  "CO-outcome-lighthouse": "outcome-lighthouse-ceo-agent-routine-use-2026-08",
  "CO-outcome-native-age": "outcome-native-agent-1-0-launch-2026-08",
  "D-03": "domain-03-method-2026-08",
  "D-04": "domain-04-agents-2026-08",
  "D-05": "domain-fe-2026-08",
  "D-06": "domain-06-tokenhub-2026-08",
  "D-07": "domain-07-talent-org-2026-08",
  "D-08": "domain-08-operations-2026-08",
};
