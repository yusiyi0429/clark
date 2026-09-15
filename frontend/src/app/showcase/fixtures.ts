/**
 * `/showcase` 的全部内容。真实数据链路还没接完,这个文件是自包含的演示素材——
 * 不读 seed-tokenking.ts,不读 store.ts,只借它们的人名、域名和真实议题当底色。
 */

export type ShowcaseKind = "outcome" | "meeting" | "research" | "issue" | "signal";

export type ShowcaseItem = {
  id: string;
  kind: ShowcaseKind;
  time: string; // 人话的时间,如「12 分钟前」「今天上午」
  from: string; // 来源,如「白田田 · Method」
  title: string; // 卡面主标题,一句
  summary: string; // 卡面副行,一句
  body: string[]; // 详情层正文,2-4 段
  related: { kind: string; title: string; why: string }[]; // 详情层「它想到的」
  detailHref?: string; // 只有 research 有:通往那件议题的细节页
};

export type ShowcaseMeeting = {
  when: string; // 如「今天上午 10:00」
  topics: { ref: string; title: string; round: number }[]; // round = 第几次讨论
  confirmed: string[]; // 他已认可的判断
  toDiscuss: string[]; // Agent 认为会上要谈的关键点
};

/** 优先级从高到低。交互区按这个顺序排,前两档底色更深。 */
export const KIND_ORDER: ShowcaseKind[] = ["outcome", "meeting", "research", "issue", "signal"];

export const KIND_LABEL: Record<ShowcaseKind, string> = {
  outcome: "使命回传",
  meeting: "会后待确认",
  research: "调研回传",
  issue: "潜在议题",
  signal: "外部信号",
};

export const KIND_GLYPH: Record<ShowcaseKind, string> = {
  outcome: "果",
  meeting: "会",
  research: "研",
  issue: "议",
  signal: "信",
};

export const SHOWCASE_ITEMS: ShowcaseItem[] = [
  {
    id: "SHOW-OUTCOME-01",
    kind: "outcome",
    time: "23 分钟前",
    from: "白田田 · Method",
    title: "8 月使命改了一版,等你点头",
    summary: "『标准方法形成并真实运行』的验收线,他想收窄成『跑通一次完整 Review 闭环』",
    body: [
      "白田田把 Method 域 8 月 Outcome 的验收线从『标准方法形成并真实运行』收窄成一句更能验的:『8 月内在词元云集自身走完一次完整的 Outcome-Mission-DRI-Review 闭环,并留下可复用的 Mission Card 模板』。",
      "改动理由:原来那句谁都点头、谁都验不了。上一版 Mission Card 标准发下去后,两个域已经各自理解出不同的『唯一 DRI』边界(见下方潜在议题),说明『标准形成』这四个字需要一次真跑通来兜底,不是文档齐了就算数。",
      "他把改动挂了回来,不是走完流程知会你——这条线动了,后面几个域的 Mission Card 打分标准都要跟着挪一次,他想在这个动作发生之前听你一句。",
    ],
    related: [
      { kind: "issue", title: "两个域对『唯一 DRI』边界理解不一致", why: "促成这次改口的直接原因" },
      { kind: "judgment", title: "03-J2 · Mission 是基本经营单元", why: "他这版收窄就是在往这条原则上靠" },
    ],
  },
  {
    id: "SHOW-MEETING-01",
    kind: "meeting",
    time: "今天 10:52",
    from: "Domain DRI 复盘会 · 第 4 周",
    title: "渠道那单,你说要自己去谈——确认是否启动",
    summary: "会上没把 ISS-009 甩给业务负责人,是你自己说『这轮我来见』",
    body: [
      "今天上午的 Domain DRI 复盘会上,渠道扩张追加投入(ISS-009)绕了两圈:业务负责人给不出候选伙伴的基线数据,白田田提出先按现有项目收入的节奏走、别现在加码。",
      "会议记录里这句是你自己说的,不是安排给谁:『这个先别定,下一步我自己见一见候选方,回来再定要不要追加』。这类会上明确说了『自己做』的条目,不派给任何 DRI,直接落你这。",
      "还没约见名单——这条先摆着,等你确认是否真启动、见谁。",
    ],
    related: [
      { kind: "issue", title: "ISS-009 · 是否在本季度追加渠道扩张投入", why: "这场会要处置的原始议题" },
      { kind: "judgment", title: "01-J11 · 两类业务分别贡献不同输入", why: "会上有人引它来说渠道不该单独判断" },
    ],
  },
  {
    id: "SHOW-RESEARCH-01",
    kind: "research",
    time: "1 小时前",
    from: "刘人豪 · Engine & Ontology",
    title: "『1.0 上线 vs 灯塔交付』的预研回来了",
    summary: "结论:两件事不该抢同一批 Context 资源,建议错开验收而非同时冲线",
    body: [
      "刘人豪就 ISS-008(是否在本季度同时完成产品 1.0 上线和灯塔项目交付)跑完了预研。关键发现:两条真实战略决策闭环(MC-01 词元云集自身、MC-02 灯塔项目)当前共用同一批 FE 追溯与 Context 校准人力,8 月内同时冲线会让两条闭环都只能做到『能跑』而不是『可信』。",
      "判断结论:建议把『产品 1.0 网页版上线』和『灯塔项目高质量采用』在验收时间上错开 1-2 周,优先保证灯塔那条——外部客户在看,失真代价更高;词元云集自身那条可以带着已知缺口先上线,内部使用者能容忍。",
      "证伪条件:如果灯塔项目本周的候选客户会谈明确把上线时间点写成硬性商务条款,这条判断要重新算。",
    ],
    related: [
      { kind: "mission", title: "MC-01 / MC-02 · 两条真实战略决策闭环", why: "两条闭环共用的资源正是判断的落点" },
      { kind: "judgment", title: "01-J11 · 两类业务分别贡献不同输入", why: "预研引它支持『分开验收不冲突』" },
    ],
    detailHref: "/issues/ISS-008",
  },
  {
    id: "SHOW-ISSUE-01",
    kind: "issue",
    time: "今天上午",
    from: "复盘会纪要 · 自动摘录",
    title: "两个域对『唯一 DRI』的边界理解不一致",
    summary: "服务的正是白田田那版 8 月使命——标准不统一,他那条验收线就验不动",
    body: [
      "0810 Domain DRI 复盘会 Week 1 纪要里,Agents 域和 Engine & Ontology 域在填各自 Mission Card 时,对『唯一 DRI』的适用范围给出了两种读法:一种认为协作方也可以联署 DRI(两人共担),另一种坚持结果责任只能落一个人,协作方只是被咨询。",
      "这不是个别域的操作失误——它直接测出 Method 域『标准方法形成并真实运行』这条 Outcome 还没真正形成:标准如果两个域能读出两种意思,就还不是标准。它服务的正是白田田这版 8 月使命(见上方使命回传):这条议题不确认,他收窄后的验收线也验不动。",
      "还没有 DRI 领走。建议先由白田田带回去对齐口径,再决定是否正式立案。",
    ],
    related: [
      { kind: "outcome", title: "白田田 · Method 8 月使命改动", why: "这条议题正是促成那版改动的证据" },
      { kind: "judgment", title: "03-J3 · 唯一 DRI 承担结果责任", why: "两种读法都在争这条原则的边界" },
    ],
  },
  {
    id: "SHOW-SIGNAL-01",
    kind: "signal",
    time: "今天凌晨",
    from: "市场信号 · 模型定价",
    title: "两家头部云厂商同日下调长上下文模型价格",
    summary: "降幅均超三成,TokenHub 的路由成本基线本周就该重新跑一次",
    body: [
      "今天凌晨,两家主要云厂商各自公告长上下文(128K+)模型的调用价格下调,降幅均超过 30%,理由都指向自研芯片成本下降。这不是常规的候选信号——它直接牵动 TokenHub(D-06)现在用的路由与成本基线。",
      "TokenHub 第一版 MVP 的选型测算是按降价前的价格跑的。如果新价格站得住,原来『高价值场景优先用大模型、高频负载压去小模型』的路由策略可能要重新算一次成本线——降价后大模型直接跑高频负载也许比路由更省。",
      "还没有 DRI 认领去验证价格是否稳定(有没有限时条款)。值得你现在看一眼,不必等下次 TokenOps 汇报。",
    ],
    related: [
      { kind: "domain", title: "D-06 · TokenOps · TokenHub 第一版 MVP", why: "路由成本基线正是被这条信号动摇的对象" },
      { kind: "judgment", title: "01-J11 · 两类业务分别贡献不同输入", why: "高频真实负载的成本假设被这条信号动摇" },
    ],
  },
];

export const SHOWCASE_MEETING: ShowcaseMeeting = {
  when: "今天上午 10:00",
  topics: [
    { ref: "ISS-008", title: "产品 1.0 上线与灯塔交付是否同月冲线", round: 1 },
    { ref: "ISS-009", title: "是否在本季度追加渠道扩张投入", round: 2 },
    { ref: "MC-01", title: "词元云集自身 Context 闭环进度", round: 3 },
  ],
  confirmed: [
    "灯塔项目的验收标准以真实客户使用为准,不以功能齐全度打分",
    "TokenHub 这一版不追加新客户接入,先稳住现有调用",
  ],
  toDiscuss: [
    "白田田收窄后的 8 月使命验收线要不要在会上正式过一遍",
    "渠道扩张要不要真启动、你打算见谁",
    "1.0 上线和灯塔交付的验收顺序要不要现在定下来",
  ],
};
