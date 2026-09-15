/**
 * 预载案例 —— 词元云集自己那条链上的二十件事，每一环各摆几件。
 *
 * ## 一、这是预载的示例数据，不是跑出来的
 *
 * 这个文件里没有一件事是产品真的跑出来的：没有哪一张卡真的过了雷达，没有哪一份深研
 * 报告真的调用过模型，没有哪一场会真的散过。它存在的理由只有一个 —— **让每一栏都有
 * 真东西可看**：提请台上有卡、议题栏里有在办的、排会面板上有「可以开会了」的、日程
 * 板上有两场排好的会、会后那一叠有等确认的、最右边那两颗点后面有已部署的。
 *
 * 所以它只导出**纯数据和纯函数**：不 import `store.ts`，不做任何副作用，装不装、
 * 什么时候装，由装它的那一侧决定。
 *
 * ## 二、内容照的是哪两份材料
 *
 * 全部内容来自 2026-07-15 那一天的两份真实材料：
 *
 *   · 0715 管理层会议纪要《词元云集战略定位、CEO Agent 会前预审与灯塔项目推进》
 *   · 0715 会后复盘《战略定位、会前预审与灯塔项目》
 *
 * 这两份在内容包里也有对象（`seed-demo.ts` 的 `DOC-D2` / `DOC-D3`），但这个文件
 * **不给 href**：那一包只有 demo 那一档才装，而这个文件不该假设它装了 —— 一个点开
 * 404 的溯源徽章比没有徽章更糟，它把「可核对」这件事变成了一句谎。接线的一侧如果确认
 * 两份文档在库里，把 href 补上是一行的事。
 *
 * 人名只用本体里真有名字的那三个 DRI（白田田、孙铭泽、刘人豪）。八个域里另有五个的
 * DRI 是**岗位占位**（「以业务负责人岗位作为直接责任承担方，在位人待确认」），拿岗位名
 * 去填「谁上报的」等于凭空造一个具体的人把名字押在上面 —— 而那正是 `CardSource.dri`
 * 这一档的全部可信度所在。
 *
 * 域 07 / 08 按新名字理解：07 管人才、组织与激励；08 管财务、办公、采购、研发环境与合规。
 *
 * ## 三、为什么每一条都必须有出处
 *
 * 这个产品的全部可信度押在一句话上：**屏幕上每一个数都核得动。** 一号位看到一条陈述，
 * 第一个反问永远是「你从哪看到的」；答不出来的那一条，会连着它旁边所有答得出来的一起
 * 失效 —— 怀疑是会扩散的。
 *
 * 落到这个文件上就是两条硬规矩：
 *
 *   1. **每个 `Statement` 都带 `traces`**，指名道姓说出是哪一份材料的哪一段。
 *   2. **没有出处的量一律不写。** 金额、百分比、客户数、资源占比、工期 —— 这两份材料
 *      里没有的，这里就写「还没查」。唯一一个数字是「约 70 分」，因为纪要里就是这么
 *      写的（而且它自己带着「约」字）。编一个没人核得动的数，比留一个诚实的空贵得多：
 *      空的那一格他会去问，编的那一格他会拿去做决定。
 *
 * ## 四、时间全部从 `today` 算
 *
 * `seededCases(today)` 的 `today` 是 `shared.ts` 的 `TODAY`（`YYYY-MM-DD`）。所有
 * 时间戳、会议日期、议题年龄都是它加减出来的。写死日期的代价很具体：过几天再打开，
 * 「明天上午那场会」会变成上个月的，而一号位一眼就会看出来，然后开始怀疑屏幕上每一个
 * 日期（这条教训写在 `shared.ts` 的 `TODAY` 头上）。
 *
 * 但**正文里出现的 2026-07-15 不动** —— 那是材料本身的日期，是一个固定的事实。对象上
 * 的时间戳（什么时候立的项、什么时候排的会）是接线，跟着今天走。两者不是一回事，混在
 * 一起才是错的。
 */

import type {
  Card,
  DayHalf,
  Issue,
  ManifestItem,
  MeetingDebrief,
  MeetingSlot,
  ResearchDoc,
  Statement,
  TimelineEvent,
  Trace,
} from "./types";

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 日期加减。**自己写，不 import `agenda.ts` 的** —— 那边正在改，而这个文件只需要
 * 「一个 YYYY-MM-DD 加 n 天还是 YYYY-MM-DD」这一件事。
 *
 * 用 `Date.UTC` 而不是本地时区的 `new Date(y, m, d)`：后者在跨夏令时的时区里加一天
 * 可能加出 23 或 25 小时，日期字符串因此会跳一天。UTC 上每天恰好 86400000 毫秒。
 */
const shiftDay = (day: string, delta: number): string => {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86_400_000);
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
};

/** `2026-08-30` + `09:10` → `2026-08-30T09:10:00+08:00`。全站时间戳都带 +08:00。 */
const at = (day: string, hhmm: string): string => `${day}T${hhmm}:00+08:00`;

/** `MS-20260901-am`。会议号由日期和半天生成，所以同一格只可能有一条。 */
const slotId = (day: string, half: DayHalf): string => `MS-${day.replace(/-/g, "")}-${half}`;

const int = (source: string): Trace => ({ kind: "int", source });
const agent = (source: string): Trace => ({ kind: "agent", source });
const S = (text: string, ...traces: Trace[]): Statement => ({ text, traces });

/** 两份材料的名字。到处要写，写错一次就有一条溯源指向一份不存在的东西。 */
const MINUTES = "0715 管理层会议纪要《词元云集战略定位、CEO Agent 会前预审与灯塔项目推进》";
const REVIEW = "0715 会后复盘《战略定位、会前预审与灯塔项目》";

const AGENT_LABEL = "您的 Agent";

/** 深研报告的装配清单公共头两项 —— 九份报告装配自同一对材料。 */
const baseManifest: ManifestItem[] = [
  { label: MINUTES, kind: "int" },
  { label: REVIEW, kind: "int" },
];

export type SeededCases = {
  issues: Issue[];
  cards: Card[];
  /** 今天那一批摊在提请台上的卡（`Card.id` 的列表）。 */
  todayCardIds: string[];
  /** 按议题号存的深研报告 —— 有它才算「前期调研做完」。 */
  researchDocs: Record<string, ResearchDoc>;
  meetingSlots: MeetingSlot[];
  /** 键是 `${slotId}::${issueId}`。 */
  debriefs: Record<string, MeetingDebrief>;
  /** 按议题号存的时间线。每件至少有一条「立项」。 */
  timelines: Record<string, TimelineEvent[]>;
};

export const seededCases = (today: string): SeededCases => {
  const yesterday = shiftDay(today, -1);
  const tomorrow = shiftDay(today, 1);
  const d = (n: number) => shiftDay(today, -n);

  /* 三场会。开完的那场在昨天下午，今天上午一场，明天上午一场。 */
  const heldSlot = slotId(yesterday, "pm");
  const nextSlot = slotId(tomorrow, "am");

  // =========================================================================
  // 一｜潜在议题 —— 还摊在提请台上，等他按那三个键
  //
  // 四条各有各的来路，因为可信度的来源完全不同：一号位自己提的不需要谁背书，DRI 上报
  // 的可信来自「一个具体的人把名字押在上面」，研讨衍生的可信来自「它从哪场讨论里长
  // 出来」。
  //
  // **一条雷达抓的都没有**，这是有意的。雷达是外部信号的入口，而这两份材料通篇是内部
  // 的会议记录；要凑一条 `radar`，就得编一条外部新闻和它的出处 —— 那正是这个文件头一
  // 条规矩禁止的事。少一种来路是诚实的空，编一条外部信号是往可信度的地基上掺沙子。
  //
  // 四张卡都**没有 `preResearchAt`**：没有哪一轮预研真的跑过。给了它，卡面就会写
  // 「预研已完成 · 进去追问 →」，而点进去是空的 —— 这个产品最不该撒的谎，就是让屏幕
  // 上一句话代表一件根本没发生的事。三个预研字段全空时卡面说的是「没人在跑」，那句话
  // 是真的。
  // =========================================================================

  const candidates: Issue[] = [
    {
      id: "ISS-203",
      title: "会后沉淀的判断建立在一份自己都对不上号的转写上，还能不能当依据用？",
      state: "Candidate",
      origin: "signal",
      domainId: "D-03",
      judgmentRefs: ["03-J5"],
      nextActionForUser: null,
      raisedAt: at(d(1), "11:40"),
      updatedAt: at(d(1), "11:40"),
    },
    {
      id: "ISS-204",
      title: "迁址方向定了、地点成本时间负责人一样没定，这件事此刻归谁？",
      state: "Candidate",
      origin: "derived",
      domainId: "D-08",
      judgmentRefs: [],
      nextActionForUser: null,
      raisedAt: at(today, "08:55"),
      updatedAt: at(today, "08:55"),
    },
  ];

  const cards: Card[] = [
    {
      id: "CARD-203",
      issueId: "ISS-203",
      headline: "会后沉淀的判断建立在一份自己都对不上号的转写上，还能不能当依据用？",
      source: { kind: "dri", by: "白田田" },
      what: [
        S(
          "复盘把「材料来源影响复盘可信度」列为需要校准的风险，原因写得很直：逐字稿存在录音质量、会议标识和日期不一致问题。下一轮要回答的是「建立会议编号、原始录音、转写版本、确认人和修改记录」。",
          int(`${REVIEW} · 四、潜在风险和需要校准的问题`)
        ),
        S(
          "纪要第三节已经把同一件事说过一次：当前仍处于验证阶段，录音和转写质量会直接影响 Judgment 的准确沉淀。第六节据此派了一条任务 —— 改善会议记录质量，责任侧项目 / 产品团队，时间「下一次会议起」。",
          int(`${MINUTES} · 三 / 六、下一步任务 5`)
        ),
      ],
      why: "会后确认这条链路的产物会直接写回判断 —— 一条判断一旦翻版，后面每一次引用都以它为准。如果那条链路的输入是一份日期和会议标识都对不上的转写，写回的不是判断，是一个没人能复核的结论。而它错的时候不会报错：屏幕上一份格式完整的会后要点，和一份提炼自错误转写的会后要点，长得一模一样。",
      strategyRef: { id: "03-J5", statement: "原则五：Context 必须统一且可更新" },
      refs: [int(`${REVIEW} · 四`), int(`${MINUTES} · 三 / 六`)],
      domainIds: ["D-03", "D-04"],
      suggestion: S(
        "建议升级深研：先把「一场会的原始记录该有哪几样才算数」定下来（编号、录音、转写版本、确认人、修改记录），再谈会后提炼的质量 —— 提炼质量是下游，输入是上游。",
        agent(`${AGENT_LABEL} · 待您判断`)
      ),
      createdAt: at(d(1), "11:40"),
    },
    {
      id: "CARD-204",
      issueId: "ISS-204",
      headline: "迁址方向定了、地点成本时间负责人一样没定，这件事此刻归谁？",
      // 研讨衍生：它是从 ISS-214（研发环境与模型资源保障）的研究里掉出来的 —— 那件
      // 要算研发环境的成本口径，而成本要落在某一个办公地点上，于是撞见了这个空洞。
      // 标成 DRI 上报会好看一点，代价是把「谁把名字押在上面」这件事伪造出来。
      source: {
        kind: "probe",
        issueId: "ISS-214",
        title: "研发环境与模型资源保障，本月要保障到什么程度",
      },
      what: [
        S(
          "复盘把「办公地点」列进会议核心决策要点：迁往 AI 资本与生态集聚区域的方向已被明确。同一行的边界写着：具体地点、成本、时间和负责人未在逐字稿中形成完整记录。",
          int(`${REVIEW} · 二、会议核心决策要点 · 办公地点`)
        ),
        S(
          "8 月纲领里 08 域有一条「完成办公场地与办公环境建设」，与「完成研发环境与模型资源保障」并列。前者的成本口径落在哪个地点上没定，后者的预算就算不出来 —— 这是 ISS-214 的研究里撞见的。",
          agent(`${AGENT_LABEL} · ISS-214 研讨衍生`)
        ),
      ],
      why: "一个只有方向、没有负责人的事项在执行里等于没有：它不会推进，也不会失败，只会在下一次复盘时以同样的样子再出现一次。而它压着的不止是办公室 —— 招人谈的是哪个地址、研发环境的成本算在哪一笔、什么时候搬，三件事都挂在它后面。",
      strategyRef: { id: "", statement: "原来关联的那条判断已随 01 / 02 域一起去掉" },
      refs: [int(`${REVIEW} · 二`)],
      domainIds: ["D-08"],
      suggestion: S(
        "建议深研并指派：这件事缺的不是判断，是一个承接的人和四个具体的数（地点、成本、时间、负责人）。指派出去之后，回来的应该是选项和后果，不是一段现状描述。",
        agent(`${AGENT_LABEL} · 待您判断`)
      ),
      createdAt: at(today, "08:55"),
    },
  ];

  // =========================================================================
  // 二｜研究中 —— 已经采信进来了，深研还没到手
  //
  // 这四件**没有 `researchDocs` 里的条目**，所以在排会面板上它们是「前期调研未完成」，
  // 排不了会。这是有意的分层：没有这一档，排会面板上每一件都能排，那一栏的判据也就不
  // 存在了。
  // =========================================================================

  const researching: Issue[] = [
    {
      id: "ISS-207",
      title: "会前预审拿了约 70 分，下一版要补的是系统性还是理解力？",
      state: "Researching",
      origin: "signal",
      domainId: "D-04",
      judgmentRefs: [],
      nextActionForUser: null,
      monitoringNote: "深研在跑。在盯的是下一次真实会前 —— 纪要给这条任务定的时间就是那一刻。",
      raisedAt: at(d(7), "09:05"),
      updatedAt: at(d(1), "10:30"),
    },
    {
      id: "ISS-208",
      title: "验证看板要记哪几样，才能证明组织运行真的变了而不只是有人在用？",
      state: "Researching",
      origin: "derived",
      domainId: "D-03",
      judgmentRefs: ["03-J6"],
      nextActionForUser: null,
      monitoringNote: "深研在跑。要研究的是验收证据先有地方记 —— 光有人用说明不了组织运行变了。",
      raisedAt: at(d(4), "17:25"),
      updatedAt: at(d(1), "14:00"),
    },
  ];

  // =========================================================================
  // 三｜前期调研已完成、还没排会 —— 排会面板上「这件可以开会了」的那一档
  // =========================================================================

  const readyToSchedule: Issue[] = [
    {
      id: "ISS-209",
      title: "TokenOps 扩张到什么条件为止、占多少资源、和主线撞车时怎么让位？",
      state: "Researching",
      origin: "derived",
      domainId: "D-06",
      judgmentRefs: [],
      nextActionForUser: "前期调研已完成 · 可以排会了",
      raisedAt: at(d(9), "11:00"),
      updatedAt: at(d(1), "18:40"),
    },
  ];

  // =========================================================================
  // 四｜已经排了会 —— 一场，两件
  //
  //   明天上午（跨域那一场）  ISS-214 在 D-08、ISS-215 在 D-07 —— 两个域一起开。
  //
  // 原来这里还有「今天上午的灯塔专场」（ISS-212 项目方案 + ISS-213 报价推荐）。那两件
  // 挂在 D-02 上，2026-08-31 那个域连同挂在它下面的议题一起去掉了，于是那一场没有议题
  // 可开 —— 一场排好了、点进去什么都没有的会，比少一场更难读。
  //
  // 明天上午那一场是这个产品要证明的事：迁址（08）和核心团队到位（07）本来在两条线
  // 上，但「搬去哪儿」直接改变「能招到谁」，分两场开就是让同一个取舍被讨论两遍、而且
  // 两遍的结论未必一致。参会域不用标 —— 议题各自属于哪个域，并集就是参会域。
  // =========================================================================

  const scheduled: Issue[] = [
    {
      id: "ISS-214",
      title: "研发环境与模型资源保障，本月要保障到什么程度？",
      state: "Researching",
      origin: "signal",
      domainId: "D-08",
      judgmentRefs: [],
      nextActionForUser: null,
      monitoringNote: "已排会。它和迁址（ISS-204）绑着：成本口径落在哪个地点上还没定。",
      raisedAt: at(d(11), "16:00"),
      updatedAt: at(today, "09:30"),
    },
    {
      id: "ISS-215",
      title: "第一版期权方案：给谁、给多少、按什么兑现？",
      state: "Researching",
      origin: "manual",
      domainId: "D-07",
      // 07 域下没有在版判断，纲领里也只有「完成期权与长期激励体系」这一条候选 Mission。
      // 挂 01-J27 是诚实的：这件事此刻押的就是那份纲领，没有别的。
      judgmentRefs: [],
      nextActionForUser: null,
      monitoringNote: "已排会。和迁址同场 —— 搬去哪儿会改变能招到谁，两件事的取舍是同一个。",
      raisedAt: at(d(11), "16:20"),
      updatedAt: at(today, "09:35"),
    },
  ];

  // =========================================================================
  // 五｜开完会、等他确认会后要点
  //
  // 昨天下午那一场过了两件。两份会后要点都还压在他那儿（`confirmedAt` 没有值），首页
  // 那一叠摞着的卡片摊的就是这两份。
  //
  // `consensus` 判成「还需再议」是有意的：ISS-217 收敛的只是角色定位，而运行规则一条
  // 没定 —— 那一格该默认高亮。判成谈拢的话，它就不再是一个判断，而是一个装饰。
  // =========================================================================

  const awaitingDebrief: Issue[] = [
    {
      id: "ISS-217",
      title: "TokenOps 到底是什么位置：真实负载与能力训练，还是第二条主业？",
      state: "Researching",
      origin: "signal",
      domainId: "D-06",
      judgmentRefs: [],
      nextActionForUser: "会后要点已提炼 · 等您确认",
      raisedAt: at(d(14), "09:30"),
      updatedAt: at(yesterday, "18:40"),
    },
  ];

  // =========================================================================
  // 五之二｜MVP 模型底座选型 —— 单独一场会，不进上面那段处置循环
  //
  // 不并进 `awaitingDebrief` 那个数组：下面 `heldNotes` 那段循环把「会已开完」「已
  // 提炼」两条时间线硬编成 `heldSlot` / `meetingSlots[0]`，两件不同的会混在同一个
  // 数组里会把这件的会次指到 TokenOps 那一场上。单独开一段，各自接各自的会次。
  //
  // 这是眼下唯一一条**点了一号位名字**的待办：owner 写「刘明华」，`listActionItems()`
  // 读的时候会把它判成他自己的事（`resolveTodoAssignee`），而 `principal.needed` 是
  // true —— 用哪家模型是公司押注的方向，不是一件照着执行的事，只有他能定。首页那块
  // 面板上摊的第一条就是它。
  // =========================================================================

  const modelSlotDay = d(2);
  const modelSlot = slotId(modelSlotDay, "am");

  const modelSelection: Issue = {
    id: "ISS-221",
    title: "MVP 版天枢系统的调研能力是否使用海外模型作为推理模型？",
    state: "Researching",
    origin: "signal",
    domainId: "D-04",
    judgmentRefs: [],
    nextActionForUser: "会后要点已提炼 · 等您确认",
    raisedAt: at(d(6), "09:20"),
    updatedAt: at(modelSlotDay, "12:10"),
  };

  // =========================================================================
  // 六｜已部署 —— 方向定了，现在压在 DRI 身上
  //
  // 这三件的 `nextActionForUser` 一律是 null：不需要他做任何事。所以每一件都必须有
  // `monitoringNote` —— 安静的状态要说出声，否则「没有待办」在屏幕上和「被忘了」长得
  // 一模一样。
  // =========================================================================

  const deployed: Issue[] = [
    {
      id: "ISS-218",
      title: "共同底座",
      state: "Monitoring",
      origin: "signal",
      domainId: "D-05",
      judgmentRefs: [],
      nextActionForUser: null,
      monitoringNote:
        "0715 已确认 Foundry / 企业本体、引擎与路由、TokenHub 作为两条业务共享的长期能力。在盯的是复盘划出的那条风险：每一项能力要能说出它此刻在解开灯塔的哪一个具体阻塞，说不出的先不投。",
      raisedAt: at(d(30), "09:00"),
      decidedAt: at(d(15), "18:00"),
      updatedAt: at(d(15), "18:00"),
    },
    {
      id: "ISS-220",
      title: "首版产品形态",
      state: "Monitoring",
      origin: "signal",
      domainId: "D-04",
      judgmentRefs: [],
      nextActionForUser: null,
      monitoringNote:
        "0715 已确认首版可以能力浅，但端到端形态要成立。在盯的是它会不会在执行里退回成一个孤立功能 —— 首版覆盖到什么深度、怎么验收，仍是未决事项。",
      raisedAt: at(d(30), "09:40"),
      decidedAt: at(d(15), "18:00"),
      updatedAt: at(d(15), "18:00"),
    },
  ];

  const issues: Issue[] = [
    ...candidates,
    ...researching,
    ...readyToSchedule,
    ...scheduled,
    ...awaitingDebrief,
    modelSelection,
    ...deployed,
  ];

  // =========================================================================
  // 深研报告 —— 九份
  //
  // 有报告才算「前期调研做完」。所以这九份对应的正好是三、四、五那三档：可以排会的
  // 三件、已经排了会的四件、开完会等确认的两件。研究中那四件没有 —— 它们的报告还没
  // 到手，这件事必须在屏幕上分得出来。
  //
  // 四节的分工照类型上的定义：judgment 是当前判断，keyEvidence 是撑住它的事实，
  // counters 是主动找的反证，unknowns 是答不出来的老实列出来。**没有 `sourceText`** ——
  // 没有哪一份正式报告真的被写出来过，塞一段自己编的正文进「报告原文」那一栏，等于在
  // 一个写着「一个字都不动」的地方放一份假原件。
  // =========================================================================

  const researchDocs: Record<string, ResearchDoc> = {
    "ISS-209": {
      issueId: "ISS-209",
      judgment: [
        S(
          "TokenOps 的角色 0715 已经定了 —— 获得真实高频 Token 负载、训练路由与评测调优能力、可补充现金流，但不作为与核心业务等权的第二主业。这一条不用再议。",
          int(`${MINUTES} · 一、本次已确认的关键事项 2`)
        ),
        S(
          "真正没定的是三样运行规则：扩张到什么条件为止、占用资源的上限是多少、和主线撞车时怎么让位。复盘把这三样一起写在「资源优先级」那一行的边界里 —— 会上确认的是方向，不是规则。",
          int(`${REVIEW} · 二、会议核心决策要点 · 资源优先级`)
        ),
      ],
      keyEvidence: [
        S(
          "纪要的口径是「用于获得真实高频 Token 负载并训练路由、评测和调优能力，可补充现金流，但不作为与核心业务等权的第二主业」—— 三个动词（获得、训练、补充）之外没有第四个。",
          int(`${MINUTES} · 一、本次已确认的关键事项 2`)
        ),
        S(
          "纪要第二节把边界说得更硬：TokenOps 的价值是训练能力，不是把公司带向低价 Token 转售；真实负载用于沉淀模型选择、路由、质量、成本和稳定性数据，并反哺核心业务。",
          int(`${MINUTES} · 二、公司战略`)
        ),
        S(
          "在版判断 01-J10 已经把一种情况写成失败信号：「TokenOps 为追求收入退化成低价 API 分销」。它给的是下限，没有给上限 —— 收得太紧算不算失败信号，材料里没有。",
        ),
      ],
      counters: [
        S(
          "反证一｜此刻不写规则未必出事。团队规模还小、两条线共用同一批人，冲突会先在人身上显形（谁这周被抽走了），未必需要一条提前写死的让位规则。",
          agent(`${AGENT_LABEL} · 反证复核`)
        ),
        S(
          "反证二｜写死资源上限可能提前掐掉一条现金流。纪要明确说 TokenOps「可补充现金流」，而公司当前的收入结构还停在项目 / 部署那一档 —— 上限定低了，等于在唯一一条辅助现金流上先加一道闸。",
          int(`${MINUTES} · 一 2 / 二、收入结构按阶段演进`)
        ),
      ],
      unknowns: [
        S(
          "让位按什么单位度量：人、算力预算、还是一号位的时间？两份材料都没有给口径，而没有单位的「上限」是一句无法执行的话。",
          agent(`${AGENT_LABEL} · 两份材料均无相关表述`)
        ),
        S(
          "TokenOps 此刻实际占了多少资源 —— **还没查**。没有这个数，任何一个上限都是拍出来的；这一条要向 TokenHub 那一侧要真实占用数据，本轮没有取到。",
          agent(`${AGENT_LABEL} · 未取到数据`)
        ),
      ],
      routeSuggestion:
        "建议排一次会，只定三件事：扩张的停止条件、资源占用的度量单位、与主线冲突时的让位规则。不要在这次会上重开 TokenOps 的角色 —— 那一条 0715 已经收敛，重开会把一场规则会变成一场定位会。",
      byAgentLabel: AGENT_LABEL,
      assembledFrom: [
        ...baseManifest,
      ],
    },
    "ISS-214": {
      issueId: "ISS-214",
      judgment: [
        S(
          "研发环境与模型资源保障是 8 月纲领里 08 域的一条候选 Mission（08-3），与办公场地建设、设备采购、财务体系、合规建设并列。纲领自己写着：本纲领不替代各 Mission DRI 进一步形成的 Mission Card 与执行计划 —— 所以此刻它只有一个名字。",
        ),
        S(
          "保障到什么程度，取决于两条线要跑多少真实调用：核心业务那一侧是灯塔的真实使用，TokenOps 那一侧是真实高频负载。这两条的量此刻都没有数。",
          int(`${MINUTES} · 一、本次已确认的关键事项 2 / 二`)
        ),
      ],
      keyEvidence: [
        S(
          "纪要确认 TokenOps 用于获得真实高频 Token 负载并训练路由、评测和调优能力 —— 这句话本身就是对研发环境的一条要求：路由和评测跑不起来，这条辅助业务的全部理由就不成立。",
          int(`${MINUTES} · 一、本次已确认的关键事项 2`)
        ),
        S(
          "在版判断 01-J11 把 TokenHub 定成两类业务共同的承载平台。也就是说研发环境不是某一条线自己的事，它同时压着 05 和 06 两个域。",
        ),
        S(
          "复盘把「共同能力投入过早」列为风险，要求列出每项能力解决的具体问题、自建理由与暂缓条件。这条要求同样适用于研发环境：它要能说出自己在解开哪一个具体阻塞。",
          int(`${REVIEW} · 四、潜在风险 · 共同能力投入过早`)
        ),
      ],
      counters: [
        S(
          "反证一｜环境按峰值备会先花掉一笔没人核得动的钱。复盘要求的是逐项证明阻塞，而「以后可能不够用」不是一个阻塞。",
          int(`${REVIEW} · 四、潜在风险 · 共同能力投入过早`)
        ),
        S(
          "反证二｜这件事可能不该在 08 域判。模型资源的选择直接连着路由与评测能力（06 域），放在财务与采购口径下讨论，容易变成一次比价而不是一次能力判断。",
          agent(`${AGENT_LABEL} · 反证复核`)
        ),
      ],
      unknowns: [
        S(
          "当前实际调用量、峰值和成本 —— **三样都还没查**。任何一个容量或预算数字在拿到它们之前都是拍的。",
          agent(`${AGENT_LABEL} · 未取到数据`)
        ),
        S(
          "成本口径落在哪个办公地点上 —— 迁址的地点、成本、时间和负责人都还没定（见 ISS-204），这一件的预算因此算不出来。",
          int(`${REVIEW} · 二、会议核心决策要点 · 办公地点`)
        ),
      ],
      routeSuggestion:
        "建议和期权那一件（ISS-215）同场：这场会上只判「本月保障到什么程度」的下限，并把调用量、峰值、成本三样派出去带期限地查。上限等迁址定了再谈。",
      byAgentLabel: AGENT_LABEL,
      assembledFrom: [
        ...baseManifest,
      ],
    },

    "ISS-215": {
      issueId: "ISS-215",
      judgment: [
        S(
          "8 月纲领在 07 域列了四条候选 Mission：锁定核心岗位与招聘优先级、完成核心候选人招募、完成核心团队到位、完成期权与长期激励体系。期权是第四条，也就是说它在纲领里的位置排在人到位之后。",
        ),
        S(
          "复盘里和这件事直接相关的只有一句：迁往 AI 资本与生态集聚区域的方向已被明确，而具体地点、成本、时间和负责人未在逐字稿中形成完整记录。地点会改变能招到谁，所以这两件是同一个取舍。",
          int(`${REVIEW} · 二、会议核心决策要点 · 办公地点`)
        ),
      ],
      keyEvidence: [
        S(
          "纪要和复盘都没有讨论过期权 —— 两份材料里没有池子大小、授予对象、兑现机制的任何表述。这一件的依据此刻只有 8 月纲领那一条候选 Mission。",
          agent(`${AGENT_LABEL} · 两份材料均无相关表述`)
        ),
        S(
          "复盘第三节的战略共识里有一条与它相关：AI 需要吸收经营者的判断 —— 团队的工程实现能力与一号位长期积累的经营经验要共同进入系统。要长期绑住的是这两类人，而不是同一类。",
          int(`${REVIEW} · 三、达成的战略共识`)
        ),
        S(
          "同一节还有一句可以当招人判据用的话：一份材料若不能让用户迅速理解差异、价值与下一步，就无法支撑销售、招人和组织协作。",
          int(`${REVIEW} · 三、达成的战略共识`)
        ),
      ],
      counters: [
        S(
          "反证一｜纲领把期权排在人到位之后，先定方案可能是倒序。核心岗位和招聘优先级都还没锁，授予对象因此还是空的。",
        ),
        S(
          "反证二｜先谈期权可能反而拖慢招人。候选人在没有确定地点、确定岗位的情况下拿到一份期权条款，问的第一个问题仍然是前两样。",
          agent(`${AGENT_LABEL} · 反证复核`)
        ),
      ],
      unknowns: [
        S(
          "期权池比例、授予对象、兑现机制 —— **一样都没有**，两份材料里没有任何可引用的数。这一件上会时带的应该是几套结构的对照，不是一个比例。",
          agent(`${AGENT_LABEL} · 两份材料均无相关数据`)
        ),
        S(
          "核心岗位清单与招聘优先级是否已经锁定 —— 还没查。纲领把它列为 07-1，但这一轮没有取到它的当前状态。",
          agent(`${AGENT_LABEL} · 未取到数据`)
        ),
      ],
      routeSuggestion:
        "建议和迁址 / 研发环境那一件（ISS-214）同场开：先定地点方向和核心岗位清单，期权这一件当场只定「几套结构、各自适合什么阶段」，不定比例。",
      byAgentLabel: AGENT_LABEL,
      assembledFrom: [
        ...baseManifest,
      ],
    },
    "ISS-217": {
      issueId: "ISS-217",
      judgment: [
        S(
          "TokenOps 的角色：用于获得真实高频 Token 负载并训练路由、评测和调优能力，可补充现金流，但不作为与核心业务等权的第二主业。",
          int(`${MINUTES} · 一、本次已确认的关键事项 2`)
        ),
        S(
          "两条业务必须共享底座：Foundry / 企业本体、引擎与路由、TokenHub 承载企业 Context、调用、权限和持续调优能力，形成跨项目复用。TokenOps 的价值因此是喂给底座的输入，不是一条独立的生意。",
          int(`${MINUTES} · 二、两条业务必须共享底座`)
        ),
      ],
      keyEvidence: [
        S(
          "在版判断 01-J11 已经把这层关系画好：高价值场景与高频真实负载共同输入 Agent Foundry / Ontology、引擎与路由模型，并由 TokenHub 平台承载；能力提升反过来降低交付成本。",
        ),
        S(
          "在版判断 01-J10 给了一条失败信号：TokenOps 为追求收入退化成低价 API 分销即视为失败。这条判断是这次定位的下限，不是它的补充说明。",
        ),
        S(
          "复盘第五节把它写进建议沉淀的材料位置「辅助业务」一栏：TokenOps 用于获得真实负载，训练模型选择、调用成本、质量、稳定性和路由能力，状态标为「辅助业务口径」。",
          int(`${REVIEW} · 五、建议沉淀 · 辅助业务`)
        ),
      ],
      counters: [
        S(
          "反证｜定位收敛了，运行规则一条没定。复盘明写：辅助业务的扩张条件、资源上限与让位机制尚未明确 —— 而一条没有让位机制的「辅助」，在缺现金的月份会自己变成主业。",
          int(`${REVIEW} · 二、会议核心决策要点 · 资源优先级`)
        ),
        S(
          "反证｜「可补充现金流」是这条定位里唯一带激励的词，也是它最可能被撑破的地方。纪要没有给这条现金流的上限，判断 01-J10 也只写了退化成低价分销这一种失败形态。",
          int(`${MINUTES} · 一、本次已确认的关键事项 2`)
        ),
      ],
      unknowns: [
        S(
          "让位机制、资源上限、扩张停止条件 —— 三样都没定，已单立为 ISS-209 继续研究。",
          int(`${REVIEW} · 二、会议核心决策要点 · 资源优先级`)
        ),
        S(
          "TokenOps 当前的真实负载量与它反哺回来的数据是否已经进了路由与评测 —— **还没查**。这一条是这次定位成不成立的唯一实测口径。",
          agent(`${AGENT_LABEL} · 未取到数据`)
        ),
      ],
      routeSuggestion:
        "建议按 C 路走：角色定位可以照会上口径写回，但把「让位机制」转成一条带期限的 Evidence Action（ISS-209），回来之前这条判断不标为已验证。",
      byAgentLabel: AGENT_LABEL,
      assembledFrom: [
        ...baseManifest,
      ],
    },
  };

  // =========================================================================
  // 会议 —— 三场
  //
  // 一场会的身份就是那个时间槽：同一天同一个半天，就是同一场会。所以不需要给会起名字，
  // 也不需要一句话解释「这几件为什么画在一起」—— 它们排在同一格里，这就是全部理由。
  // =========================================================================

  const meetingSlots: MeetingSlot[] = [
    {
      // 昨天下午那场：已经开完，材料也交了，两份会后要点还压在他那儿。
      id: heldSlot,
      date: yesterday,
      half: "pm",
      issueIds: ["ISS-217"],
      extraDomainIds: [],
      createdAt: at(d(4), "10:00"),
      endedAt: at(yesterday, "17:40"),
      transcribedAt: at(yesterday, "18:25"),
      audioName: "0715 主线与 TokenOps 定位 · 复核会录音.m4a",
    },
    {
      // 明天上午：横跨 07 和 08 的那一场。参会域是算出来的（D-07 ∪ D-08），不用标。
      id: nextSlot,
      date: tomorrow,
      half: "am",
      issueIds: ["ISS-214", "ISS-215"],
      extraDomainIds: [],
      createdAt: at(d(1), "15:30"),
    },
    {
      // 前天上午：MVP 模型底座选型，已经开完、材料也交了。
      id: modelSlot,
      date: modelSlotDay,
      half: "am",
      issueIds: ["ISS-221"],
      extraDomainIds: [],
      createdAt: at(d(6), "09:30"),
      endedAt: at(modelSlotDay, "11:20"),
      transcribedAt: at(modelSlotDay, "12:00"),
      audioName: "MVP 模型底座选型会录音.m4a",
    },
  ];

  // =========================================================================
  // 会后要点 —— 两份，都还没确认
  //
  // 骨架照 0715 会后复盘那一份：一句话说清这场会的位移（summary）、几条带边界的要点
  // （points）、谁在什么时候之前做什么（todos）、以及**没有定下来的那些**（open）。
  //
  // `boundary` 一条都不许替它补。一条没有边界的结论，会在下一次被当成比它实际管得更宽
  // 的东西用 —— 复盘那份材料自己就是靠「要点 / 判断 / 边界」三栏并排才没有滑成一份
  // 样样都定了的纪要。
  //
  // `todos` 的 `owner` 写的是材料里的原话（「战略 / 公司运营」这样的**责任侧**），不是
  // 一个人名。会上没点到个人，就照实写侧 —— 替它挑一个名字是这条链路最坏的错。
  // =========================================================================

  const debriefs: Record<string, MeetingDebrief> = {
    [`${heldSlot}::ISS-217`]: {
      slotId: heldSlot,
      issueId: "ISS-217",
      summary:
        "TokenOps 的位置说清楚了 —— 它是喂给底座的真实负载，不是第二条主业。但这场会没有定出任何一条能让这句话在执行里站住的规则，所以它此刻只是一个定位，不是一条纪律。",
      points: [
        {
          id: "P-217-1",
          text: "TokenOps 用于获得真实高频 Token 负载并训练路由、评测和调优能力，可补充现金流，但不作为与核心业务等权的第二主业。",
          boundary: "「可补充现金流」没有上限；纪要没有说补到多少为止。",
        },
        {
          id: "P-217-2",
          text: "两条业务共享 Foundry / 企业本体、引擎与路由、TokenHub，形成跨项目复用。",
          boundary: "复盘同时把「共同能力投入过早」列为风险：哪些能力此刻真的阻塞项目，尚未逐项证明。",
        },
        {
          id: "P-217-3",
          text: "TokenOps 的价值是训练能力，不是把公司带向低价 Token 转售。",
          boundary: "这一条只划了下限（退化成低价分销即失败），没有划上限。",
        },
      ],
      todos: [
        {
          id: "T-217-1",
          text: "列出每项共同能力解决的具体问题、自建理由与暂缓条件。",
          owner: "产品 / Method",
          due: "下一轮会议前",
        },
      ],
      open: [
        "扩张条件：TokenOps 做到什么程度就该停下来 —— 会上没有讨论。",
        "资源上限：按人、按算力预算、还是按一号位的时间来度量，没有口径。",
        "让位机制：和主线撞车时谁让谁、由谁判 —— 一条都没定。",
      ],
      consensus: {
        reached: false,
        reason:
          "角色定位收敛了，但复盘列出的三样（扩张条件、资源上限、让位机制）会上一样都没碰。按这份要点写回，等于把一个定位当成一条纪律用。",
      },
      createdAt: at(yesterday, "18:35"),
    },
    [`${modelSlot}::ISS-221`]: {
      slotId: modelSlot,
      issueId: "ISS-221",
      summary:
        "经过对比不同旗舰模型后，决定采用 Claude 作为每次研究的主推理模型，配合 DeepSeek V4 Pro、ChatGPT 5.6 Sol high 以及 Qwen 完成报告。",
      points: [
        {
          id: "P-221-1",
          text: "团队对比了 Claude、DeepSeek V4 Pro、ChatGPT 5.6 Sol high、Qwen 四家旗舰模型在深度推理与工具调用上的表现，Claude 综合最稳，定为每一轮深度研究的主推理模型。",
          boundary: "对比的是当前这几版模型的公开效果，不是长期锁定；任何一家出新版本都要重新测一轮。",
        },
        {
          id: "P-221-2",
          text: "DeepSeek V4 Pro、ChatGPT 5.6 Sol high、Qwen 三家继续各跑一份原件，用于跨模型对照与报告补全，不作为主推理的替代。",
          boundary: "三家各自的取证范围、调用成本和失败率没有统一口径，这次没有展开。",
        },
      ],
      todos: [
        {
          id: "T-221-1",
          text: "确认天枢深度研究链路以 Claude 为主推理模型，配合 DeepSeek V4 Pro、ChatGPT 5.6 Sol high 与 Qwen 完成报告",
          owner: "刘明华",
          label: "产品方向决策确认",
          principal: {
            needed: true,
            reason:
              "用 Claude 做主推理是这次最站得住的选择——四家旗舰模型里，只有它在复杂推理和工具调用上稳定拿第一，配 DeepSeek V4 Pro、ChatGPT 5.6 Sol high、Qwen 三家分担报告，是眼下把端到端跑通最省成本的一组组合。推荐是有代价的：把每一轮判断的质量长期押在一家自己不掌控的第三方模型上，接入越深，日后换掉的成本就越高，这笔账现在就要认下。这个判断翻篇的信号很具体——不用等 Claude 掉到落后，只要 DeepSeek V4 Pro、ChatGPT 5.6 Sol high、Qwen 里有任意一家在复杂推理或工具调用任务上追平它，就该立刻重新选型。",
          },
        },
      ],
      open: [
        "换模型的代价没有量化：接入越深，日后换掉 Claude 的成本越难估。",
        "DeepSeek V4 Pro、ChatGPT 5.6 Sol high、Qwen 三家各自的调用成本与失败率，会上没有摆出实测数据。",
      ],
      consensus: {
        reached: false,
        reason: "四家模型的对比结果摆齐了，但把主推理长期押在哪一家上是一次方向判断，会上没人能替他拍这个板。",
      },
      createdAt: at(modelSlotDay, "12:10"),
    },
  };

  // =========================================================================
  // 时间线 —— 每件至少一条「立项」
  //
  // 立项归 `state` 不归 `talk`：那一刻没有任何对谈发生，把它记成对谈，「每件议题的
  // 每一步」这句话就不再是真的。
  // =========================================================================

  /** 立项那一条。四条来路各说各的话 —— 记录里也要分得出这件事是谁递上来的。 */
  const raised = (
    issue: Issue,
    headline: string,
    actor: string,
    detail?: string
  ): TimelineEvent => ({
    id: `E-${issue.id}-raised`,
    kind: "state",
    at: issue.raisedAt,
    headline,
    actor,
    detail,
    defaultOpen: true,
  });

  /**
   * 按 id 取那张潜在议题卡，**不按下标**。
   *
   * 下标那种写法（`candidates[2]`）在删掉一条之后会静默指到别人身上 —— 屏幕上那条时间线
   * 于是挂着另一件事的提出理由，而没有任何一处会报错。2026-08-31 去掉两个域时就撞到了。
   */
  const cand = (id: string): Issue => {
    const found = candidates.find((c) => c.id === id);
    if (!found) throw new Error(`预载案例里没有 ${id}`);
    return found;
  };

  const timelines: Record<string, TimelineEvent[]> = {};
  const push = (issueId: string, ...events: TimelineEvent[]) => {
    timelines[issueId] = [...(timelines[issueId] ?? []), ...events];
  };

  push(
    "ISS-203",
    raised(
      cand("ISS-203"),
      "议题提出（白田田 上报的信号）· 待处置",
      "白田田",
      "复盘自己把「材料来源影响复盘可信度」列成了风险：逐字稿的录音质量、会议标识和日期不一致。"
    )
  );
  push(
    "ISS-204",
    raised(
      cand("ISS-204"),
      "议题提出（ISS-214 研讨衍生）· 待处置",
      AGENT_LABEL,
      "算研发环境成本时撞见的：成本要落在某一个办公地点上，而地点、成本、时间、负责人四样都不在记录里。"
    )
  );

  const researchingNotes: Record<string, [string, string]> = {
    "ISS-207": ["议题立项（0715 未决事项转入）· 直接进研究中", "会前预审拿了约 70 分；纪要要求下一阶段验证系统性、结构和跨会议的稳定复用。"],
    "ISS-208": ["议题立项（0715 复盘第六节转入）· 直接进研究中", "复盘第六节列了验证看板要记的六样：起始状态、使用频率、调用、管理层承接、行动反馈、问题与例外。"],
  };
  for (const issue of researching) {
    const [headline, detail] = researchingNotes[issue.id];
    push(issue.id, raised(issue, headline, "刘明华", detail));
    push(issue.id, {
      id: `E-${issue.id}-deep`,
      kind: "deep",
      at: issue.updatedAt,
      headline: "深度研究进行中 · 报告未到手",
      actor: AGENT_LABEL,
      detail: "报告落库之前这件不进排会面板 —— 排会的判据是前期调研做完，不是有人想开会。",
      defaultOpen: false,
    });
  }

  const readyNotes: Record<string, [string, string]> = {
    "ISS-209": ["议题立项（ISS-217 会后未决转入）· 直接进研究中", "0715 收敛的是 TokenOps 的角色；扩张条件、资源上限、让位机制三样一条没定。"],
  };
  for (const issue of readyToSchedule) {
    const [headline, detail] = readyNotes[issue.id];
    push(issue.id, raised(issue, headline, "刘明华", detail));
    push(issue.id, {
      id: `E-${issue.id}-deep-done`,
      kind: "deep",
      at: issue.updatedAt,
      headline: "深研报告已装配 · 可以排会了",
      actor: AGENT_LABEL,
      defaultOpen: false,
    });
  }

  const scheduledNotes: Record<string, [string, string, string]> = {
    "ISS-214": ["议题立项（8 月纲领 08-3 转入）· 直接进研究中", "纲领只给了名字：完成研发环境与模型资源保障。程度、口径、预算都还没有。", nextSlot],
    "ISS-215": ["议题立项（您自己提的）· 直接进研究中", "8 月纲领 07-4：完成期权与长期激励体系。两份 0715 材料里没有任何相关表述。", nextSlot],
  };
  for (const issue of scheduled) {
    const [headline, detail, slot] = scheduledNotes[issue.id];
    push(issue.id, raised(issue, headline, "刘明华", detail));
    push(issue.id, {
      id: `E-${issue.id}-deep-done`,
      kind: "deep",
      at: issue.updatedAt,
      headline: "深研报告已装配",
      actor: AGENT_LABEL,
      defaultOpen: false,
    });
    push(issue.id, {
      id: `E-${issue.id}-slotted`,
      kind: "state",
      at: issue.updatedAt,
      headline: `已排会 · ${slot}`,
      actor: "刘明华",
      detail:
        slot === nextSlot
          ? "和另一个域的一件议题排在同一格里：搬去哪儿会改变能招到谁，两件事的取舍是同一个。"
          : undefined,
      defaultOpen: true,
    });
  }

  const heldNotes: Record<string, [string, string]> = {
    "ISS-217": ["议题立项（0715 确认事项 2 复核）· 直接进研究中", "TokenOps 的角色已定，要复核的是它有没有可执行的边界。"],
  };
  for (const issue of awaitingDebrief) {
    const [headline, detail] = heldNotes[issue.id];
    push(issue.id, raised(issue, headline, "刘明华", detail));
    push(issue.id, {
      id: `E-${issue.id}-deep-done`,
      kind: "deep",
      at: at(d(2), "16:00"),
      headline: "深研报告已装配",
      actor: AGENT_LABEL,
      defaultOpen: false,
    });
    push(issue.id, {
      id: `E-${issue.id}-met`,
      kind: "decision",
      at: at(yesterday, "17:40"),
      headline: `会已开完 · ${heldSlot}`,
      actor: "刘明华",
      defaultOpen: true,
    });
    push(issue.id, {
      id: `E-${issue.id}-debrief`,
      kind: "decision",
      at: issue.updatedAt,
      headline:
        issue.id === "ISS-217"
          ? "会后要点已提炼 · 参谋判为没谈拢，等您确认"
          : "会后要点已提炼 · 等您确认",
      actor: AGENT_LABEL,
      detail: `提炼自「${meetingSlots[0].audioName}」。共识与否只决定卡上默认高亮哪一颗键，它不替您按。`,
      defaultOpen: true,
    });
  }

  push(
    "ISS-221",
    raised(
      modelSelection,
      "议题提出（孙铭泽 上报的信号）· 直接进研究中",
      "孙铭泽",
      "天枢的深度研究链路要不要以 Claude、ChatGPT 这类第三方海外模型做主推理，还是等国产或自研能力追上来。"
    )
  );
  push("ISS-221", {
    id: "E-ISS-221-met",
    kind: "decision",
    at: at(modelSlotDay, "11:20"),
    headline: `会已开完 · ${modelSlot}`,
    actor: "刘明华",
    defaultOpen: true,
  });
  push("ISS-221", {
    id: "E-ISS-221-debrief",
    kind: "decision",
    at: modelSelection.updatedAt,
    headline: "会后要点已提炼 · 等您确认",
    actor: AGENT_LABEL,
    detail: `提炼自「${meetingSlots.find((s) => s.id === modelSlot)!.audioName}」。这是团队的评估结论，用不用由您来点头。`,
    defaultOpen: true,
  });

  const deployedNotes: Record<string, string> = {
    "ISS-218": "0715 确认事项 3：Foundry / 企业本体、引擎与路由、TokenHub 作为两类业务共享的长期能力持续沉淀。",
    "ISS-220": "0715 确认事项 5：首版可控制范围和成熟度，但必须具备完整的端到端形态。",
  };
  for (const issue of deployed) {
    push(
      issue.id,
      raised(issue, "议题立项（0715 之前提出）· 直接进研究中", "刘明华", deployedNotes[issue.id])
    );
    push(issue.id, {
      id: `E-${issue.id}-decided`,
      kind: "decision",
      at: issue.decidedAt ?? issue.updatedAt,
      headline: "会后确认 · 状态迁移 → 已部署",
      actor: "刘明华",
      detail: deployedNotes[issue.id],
      defaultOpen: true,
    });
    push(issue.id, {
      id: `E-${issue.id}-armed`,
      kind: "trigger",
      at: issue.decidedAt ?? issue.updatedAt,
      headline: "已布控重开条件",
      actor: AGENT_LABEL,
      detail: issue.monitoringNote,
      defaultOpen: false,
    });
  }

  return {
    issues,
    cards,
    todayCardIds: cards.map((c) => c.id),
    researchDocs,
    meetingSlots,
    debriefs,
    timelines,
  };
};
