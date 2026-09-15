/**
 * 假模型交的那份**区块报告**（`TKOS_DR_BLOCKS=1` 那一支）。
 *
 * 区块那一支交上来的不是中文正文，是一份 JSONL。拿散文那几份罐头去跑它，`parseBlocks`
 * 一个块都读不出来 —— 屏幕上表现成「模型没按格式交」，而真实情况是这条路（排结构 → 逐节
 * 出稿 → 收口 → 装配 → 逐块校验 → 返修 → 跨链路对账 → 判断板取块）一行都没被执行过。
 *
 * ## 一条链路要三份罐头，不是一份
 *
 * 区块那一支的出稿是**三段**（`a4/run.ts` 的 `writeStaged`）：排结构一次（交 JSON 大纲）、
 * 每节各一次（交那一节的几行块）、收口一次（交横幅、最终判断、证据清单那几块）。三次调用
 * 各带自己的 hint（`<链路>.outline` / `.section` / `.closing`），所以罐头也按这三个键登记。
 * 写成一份整篇的罐头是**认不出来的**：那个键这一支永远不会去查，而屏幕上看起来就像模型
 * 交了一份读不出块的东西。
 *
 * 四条链路各一套（`run.ts` 的 `LANES`）。少写一条的表现不是报错，是那一栏在离线跑里拿到
 * 兜底对象，然后那一栏永远是空的 —— 而这几栏的全部用处是对照。
 *
 * ## 为什么这几份罐头是函数，不是字符串
 *
 * A4-B11（证据利用率对账）要求证据包里每一条编号要么被用上，要么带一句弃用理由。而编号是
 * 这一轮真跑出来的 —— 假检索抓到几页、逐字定位过了几条，都得跑完才知道。**一份写死的
 * JSONL 不可能知道该对哪几个编号交账**，于是离线每一轮都挂着一条 A4-B11 的 p0，而那条 p0
 * 是罐头的问题、不是链路的问题，混在一起之后真违规就没人看了。
 *
 * 所以罐头收下这一次的 prompt：从证据包那几行里读出真编号（`packIds`），分节那一次还要读出
 * 这一次写的是哪一节（`sectionIdOf` 认提示词里的「节号：」那一行）。这是假模型唯一「读」它
 * 收到的东西的地方 —— 在这之前它只按 hint 认罐头。
 *
 * ## 它不修东西
 *
 * 返修那一轮（`buildA4BlockRepair`）它把被拒的那几行**原样交回去**：它不懂那几条违规，
 * 编一份「改好了」的出来只会让离线跑永远是绿的。原样交回去的价值是返修那条路照样跑完
 * （对齐、贴回、重新装配、重新校验），而第二遍报出来的还是同一条违规 —— 那就是这条路在
 * 离线下的正确表现。Claude 那一条第二节的第二个判断**故意缺了证伪条件**，为的就是让这一轮
 * 每次离线跑都真的发生一次（见那一处注释）。
 *
 * 数字全是构造的。除了编号引到的那两条，每一句「本轮取到什么」都写明它不是这一轮取回来的
 * —— 一份自称取过证的假报告比一份明显是假的更难发现。
 */

/** 一条消息。和 `callModel` 收的那个形状一样，只取这两栏。 */
export type MockMsg = { role: string; content: string };

type Line = Record<string, unknown>;

/**
 * 模型既有知识那一条的编号。
 *
 * 得是数字：`normalizeRef` 只认 `/^E?\d+$/`，写成 `EOWN` 会原样留下来，然后正文里那枚
 * 芯片指不到任何东西。取一个大过任何一轮包编号的数 —— 撞上台账编号的话，这一条会被
 * `registry.ts` 当成台账里那一页，于是屏幕上一条模型的记忆挂着一个可点开的地址。
 */
const MODEL_REF = "E90";

/** 内部文档那一条。只出现在「对我们的当前含义」那一节和 `internalValidationHooks` 里（A4-B04）。 */
const INTERNAL_REF = "E91";

/** 材料截止日期。三段里只有收口那一次交 `report_meta`，所以只在那里用得上。 */
const CUTOFF = "2026-08-20";

/**
 * 证据包里那几行的编号。形状见 `a4/prompt.ts` 的 `buildEvidencePack`：
 * `E1　【支持　B 级　example0.com】`，行首编号后面跟一个全角空格再跟【。
 *
 * 认行首而不是满篇抓 `E\d+`：命题、企业上下文、上一稿里都可能出现编号，抓过来的话
 * 罐头会替一批不在包里的编号交账，而 A4-B11 的 `outside` 那一条正好拦这个。
 *
 * 分节那一次递进去的包**已经被 `run.ts` 切成这一节自己那几条**，所以同一个函数在那一次
 * 读出来的就是本节的编号 —— 罐头因此不会引到别节正在展开的那几条。
 */
const PACK_ID = /^(E\d+)\s*【/gm;

export function packIds(messages: MockMsg[]): string[] {
  const text = messages.map((m) => m.content ?? "").join("\n");
  const out: string[] = [];
  for (const m of text.matchAll(PACK_ID)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * 这一次写的是哪一节。认的是分节提示词里那一行「节号：S2」（`buildA4SectionUser`）。
 *
 * 一条链路的几节共用同一个 hint（`<链路>.section`），所以只有从提示词里读才分得出这一次
 * 该交哪一节。读不出来时退回第一节 —— 交错一节的报告读起来是乱的，但交不出东西那一节
 * 在屏幕上直接消失，后者更难查。
 */
const SECTION_ID = /^节号：\s*(\S+)/m;

function sectionIdOf(messages: MockMsg[]): string {
  for (const m of [...messages].reverse()) {
    const hit = SECTION_ID.exec(m.content ?? "");
    if (hit) return hit[1];
  }
  return "";
}

/** 返修那一轮的提示词开头（`buildA4BlockRepair`）。 */
const REPAIR_HEAD = "## 出口校验没过";
/** 每一块原样那一行贴在这句话后面。 */
const REPAIR_LINE = /原样交上来的是：\s*(\{.*)/g;

/**
 * 这一次是不是返修那一轮。是的话原样把被拒的那几行交回去。
 *
 * 顺序就是对齐方式（`spliceRepair`），而提示词里列的顺序就是这里读出来的顺序 —— 所以
 * 原样交回去一定对得齐，`notes` 是空的。少交一行、多交一行那两种对不齐的情形由
 * `report.test.ts` 直接测 `spliceRepair`，不靠罐头来演。
 *
 * 缺 `report_meta` 那一种这里交不出来：那一行的标题在这一轮的 prompt 里没有。真发生时
 * `spliceRepair` 会拿上一稿那一行补上并记一条账 —— 而收口那份罐头的第一行本来就是合法的
 * `report_meta`，所以这条路在离线下走不到。
 */
function repairEcho(messages: MockMsg[]): string | undefined {
  const last = [...messages].reverse().find((m) => (m.content ?? "").includes(REPAIR_HEAD));
  if (!last) return undefined;
  const lines = [...last.content.matchAll(REPAIR_LINE)].map((m) => m[1].trim());
  return lines.length ? `${lines.join("\n")}\n` : undefined;
}

/** 一份 JSONL。**以换行收尾** —— 收尾那一次最后一行必须是完整的（见 `parse.ts`）。 */
const jsonl = (lines: Line[]): string => `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`;

/**
 * 手上这几个编号里第 i 个。给不出就退回最后一个，一个都没有时退回模型既有知识那一条 ——
 * 那种情形下正文里一枚台账编号都没有，而这是对的：这一轮什么都没取到。
 */
const at = (ids: string[], i: number): string => ids[i] ?? ids[ids.length - 1] ?? MODEL_REF;

/** 去重。两处退回同一个编号时（包里只有一条）判断块上不该出现两枚一样的芯片。 */
const refsOf = (...ids: string[]): string[] => [...new Set(ids)];

/** 正文真的引到的那几条：整份大纲派给前两节的就是这两条。 */
const usedOf = (ids: string[]): string[] => [...new Set(ids.slice(0, 2))];

/** 第三条起的弃用理由。写具体的那一句 —— 「未使用」这条规矩永远过得去，而它要拦的正是那种。 */
const unassignedReason = (ids: string[]): string =>
  `和 ${at(ids, 0)} 出自同一句离线占位正文，换一个域名不构成第二个来源，所以正文里只留前两条`;

/* -------------------------------------------------------------------------- */
/* 三段各自的形状                                                              */
/* -------------------------------------------------------------------------- */

interface SectionSpec {
  id: string;
  title: string;
  question: string;
  expected: string[];
  min: number;
  /** 收到的是**这一节自己那几条**编号，不是整包。 */
  blocks: (ids: string[]) => Line[];
}

interface Stance {
  /** 标题句。大纲那一次交它当 `thesis_draft`，收口那一次交它当 `report_meta.title`。 */
  thesis: string;
  confidence: string;
  banner: { text: string; boundary: string };
  sections: SectionSpec[];
  /** 收口那一条最终判断。 */
  final: (ids: string[]) => Line;
  unverified: Line;
  /** 证据清单里那条模型既有知识改变了哪一条判断。 */
  knowledgeTarget: string;
  /** 带不带内部文档那一条。**只有主源带** —— A4-B04 在离线下的唯一靶子是它。 */
  internalDoc?: boolean;
  falsify: (ids: string[]) => Line;
}

/**
 * 大纲那一次交的 JSON（形状见 `buildA4OutlineUser`）。
 *
 * 分配按「一节一条」：第一节拿 `ids[0]`，第二节拿 `ids[1]`，第三条起进 `unassigned` 并各带
 * 一句真理由。这一步的分配就是 A4-B11 那张账的上半截 —— 漏派的编号后面没有任何一次调用
 * 会读到它，而 `readOutline` 会把它补进最后一节并记一条账（那一条也该在离线下被走到，
 * 所以这里不刻意把它凑齐：包里只有两条时 `unassigned` 本来就是空的）。
 */
const outlineOf = (s: Stance, ids: string[]): string =>
  JSON.stringify({
    thesis_draft: s.thesis,
    sections: s.sections.map((x, i) => ({
      id: x.id,
      title: x.title,
      question: x.question,
      evidence_ids: ids.slice(i, i + 1),
      expected_blocks: x.expected,
      min_blocks: x.min,
    })),
    unassigned: ids.slice(s.sections.length).map((id) => ({ id, reason: unassignedReason(ids) })),
  });

/**
 * 一节交上来的几行。最后一行是本节的账（`a4SectionSystem` 第 1 条）。
 *
 * 本节一条证据都没分到时**不出那一行**：`used` 和 `discarded` 两边都空的那一行 `readBlock`
 * 会拒，于是屏幕上多一条「有一行没解析出来」，而真实情况是这一节没有账可对。
 */
function sectionOf(s: Stance, messages: MockMsg[]): string {
  const ids = packIds(messages);
  const want = sectionIdOf(messages);
  const spec = s.sections.find((x) => x.id === want) ?? s.sections[0];
  const lines = [...spec.blocks(ids)];
  /*
   * 大纲那一次没跑成时 `readOutline` 会折成一节、把整包塞给它。那时正文只引得到第一条，
   * 剩下几条既没被引也没有理由 —— 补一段把它们引上，理由是它们确实同源。这一段在正常的
   * 一节一条下不出现。
   */
  if (ids.length > 1) {
    lines.push({
      type: "prose",
      md:
        `这一节手上还有几条同源材料，各自只多给一个时间点，不另开一段展开：${ids
          .slice(1)
          .map((id) => `[${id}]`)
          .join("")}。`,
    });
  }
  if (ids.length) lines.push({ type: "evidence_usage", used: ids, discarded: [] });
  return jsonl(lines);
}

/** 台账那两条进证据清单。清单里那句 claim 是模型写的（`registry.ts` 以它为准）。 */
const packItems = (ids: string[]): Line[] =>
  usedOf(ids).map((id, i) => ({
    id,
    claim:
      i === 0
        ? "本轮唯一一条带统计期间的示例数字 —— 它证明检索、抓页、逐字定位这条链路是通的"
        : "取回的那一页自称是离线自测用的占位件",
    updateDirection: {
      target: i === 0 ? "本轮取回的材料能不能进经营结论" : "上面那条数字的可用范围",
      effect: "限定",
    },
  }));

/** 模型既有知识那一条。**必须列进清单** —— 不列的话 A4-B06 会判「引了证据表里没有的编号」。 */
const knowledgeItem = (target: string): Line => ({
  id: MODEL_REF,
  claim: "招标文件里技术评分的权重从四成降到两成五（模型既有知识，本轮没有核验）",
  sourceName: "既有的行业招标口径",
  sourceType: "模型既有知识",
  updateDirection: { target, effect: "强化" },
});

/** 内部文档那一条。只有主源那一份带。 */
const internalItem = (): Line => ({
  id: INTERNAL_REF,
  claim: "我们自己那份投标记录里，这两家历年招标文件的模板版本都在",
  sourceName: "内部投标记录",
  sourceType: "内部DOC",
  updateDirection: { target: "对我们的当前含义", effect: "限定" },
});

/**
 * 收口那一次交的几块，顺序照 `a4ClosingSystem` 那七条。
 *
 * 它交的 `evidence_usage` **会被 `assembleStaged` 摘掉**，换成代码合出来的那一张（各节和
 * 收口各自只看得见自己那一段，拼在一起会出现几块互相矛盾的对账）。照样交一份是为了让那条
 * 摘除路径在离线下真的被走一遍 —— 不交的话它永远没被执行过。
 */
const closingOf = (s: Stance, ids: string[]): string =>
  jsonl([
    { type: "report_meta", title: s.thesis, confidence: s.confidence, dataCutoff: CUTOFF },
    {
      type: "verdict_banner",
      text: s.banner.text,
      confidence: s.confidence,
      boundary: s.banner.boundary,
    },
    s.final(ids),
    s.unverified,
    {
      heading: "这一份用到的证据",
      type: "evidence_list",
      items: [
        ...packItems(ids),
        knowledgeItem(s.knowledgeTarget),
        ...(s.internalDoc ? [internalItem()] : []),
      ],
    },
    ...(ids.length
      ? [
          {
            heading: "取回来的证据都去哪儿了",
            type: "evidence_usage",
            used: usedOf(ids),
            discarded: ids.slice(2).map((id) => ({ id, reason: unassignedReason(ids) })),
          },
        ]
      : []),
    s.falsify(ids),
  ]);

/* -------------------------------------------------------------------------- */
/* 四条链路的立场                                                              */
/* -------------------------------------------------------------------------- */

/*
 * 立场照散文那四份罐头（`mock.ts` 的 `a4.report*`）：决策权已经转移 / 尚未定论 / 行业性
 * 模板改版 / 预算归属在动。**不许写成互相的改写** —— 同时出四份的全部用处
 * 是对照，而对照的前提是它们真的可能不一致；四份一致的罐头把「跨链路对账」这一步验成了
 * 一句空话。
 *
 * 十四种块（`divergence_view` 那一种由对账那一步折，不由链路交）分摊在四份里：一轮离线跑
 * 下来每个组件都渲染过一次。
 *
 * 每一条判断引的是**一条台账编号加一条既有知识**：那是两个独立来源组（`dom:` 和 `own:`），
 * 所以 A4-B05 那条「共源当独立源」的 p0 在离线下不会被误触发。把握一律停在「当前更支持」
 * 或「初步提示」——「较强支持」以上要两组独立来源，而离线那一轮只有一个域名。
 */

const deepseek: Stance = {
  thesis: "采购决策权不是仍在技术评估侧，而是已经移到业务线负责人手上",
  confidence: "当前更支持",
  banner: {
    text: "在我们已投标的两个客户处，决策人已经换成业务线负责人，技术评分不再是主要门槛。",
    boundary: "只对这两个已投标客户、同一个行业、近一个季度成立；别的行业与更早的项目不在此列。",
  },
  knowledgeTarget: "决策权已经转移",
  sections: [
    {
      id: "S1",
      title: "技术评分权重的下降不是评审口径的微调，而是决策人换了",
      question: "权重下降和决策人更换是同一件事的两个表现，还是两条各自的来路？",
      expected: ["kpi_cards", "funnel", "prose", "judgment"],
      min: 4,
      blocks: (ids) => [
        {
          heading: "技术评分权重的下降不是评审口径的微调，而是决策人换了",
          type: "kpi_cards",
          cards: [
            {
              value: "1590",
              unit: "EFLOPS",
              label: "本轮唯一带统计期间的外部数字",
              caliberNote:
                "离线自测的占位来源给出的示例口径，统计截至上一年末；只用来验证链路连不连得上，不进经营结论",
              evidenceRefs: [at(ids, 0)],
            },
            {
              value: "四成 → 两成五",
              label: "技术评分权重的变化",
              caliberNote: "来自模型既有知识里的招标口径，不是本轮取回的材料；两个客户、一个季度",
              delta: "同一个季度内",
              evidenceRefs: [MODEL_REF],
            },
          ],
        },
        {
          heading: "从接触到中标，掉量最大的一级已经不是技术评审",
          type: "funnel",
          stages: [
            { label: "接触到的项目", value: 100, note: `这一级取 100 为基数，不是取回来的数字 [${MODEL_REF}]` },
            { label: "入围", value: 64, note: `模型既有知识里的常见比例，本轮没有取到 [${MODEL_REF}]` },
            { label: "技术评审通过", value: 52, note: `同上，非本轮取回 [${MODEL_REF}]` },
            { label: "最终中标", value: 18, note: `同上，非本轮取回 [${MODEL_REF}]` },
          ],
        },
        {
          type: "prose",
          md:
            "公开招标文件里技术评分的权重从四成降到两成五，与决策人更换发生在同一个季度。两件事同期发生，更像同一件事的两个表现，而不是两条各自的来路。\n\n" +
            `本轮取回的外部材料只给出一条带统计期间的示例数字 [${at(ids, 0)}]，那一页自己也写明是离线占位件。所以上面这一段的依据是内部投标记录与既有知识，不是本轮的外部检索。`,
        },
        {
          type: "judgment",
          claim: "权重下降与决策人更换是同一件事的两个表现",
          confidence: "当前更支持",
          direction: "支持",
          reasoningSummary: `两件事落在同一个季度，而评分口径的改动和拍板人的更换在这两家是同一批人经手的；本轮外部材料只证明取证链路是通的 [${at(ids, 0)}]。`,
          upgradeCondition: "客户内部的人事说明显示换人与评分口径改动出自同一次决定",
          falsifyCondition: "换人与口径改动被证明各有来路，或者两者不在同一个季度",
          evidenceRefs: refsOf(at(ids, 0), MODEL_REF),
          internalValidationHooks: ["两个已投标客户的决策链记录", "近四个季度的投标评分表"],
        },
      ],
    },
    {
      id: "S2",
      title: "靠模型能力带动成单的那条链断了一环",
      question: "门槛移走之后，我们那条「能力更强所以会被选中」的链还剩哪一环？",
      expected: ["prose", "judgment"],
      min: 2,
      blocks: (ids) => [
        {
          heading: "靠模型能力带动成单的那条链断了一环",
          type: "prose",
          md:
            "「能力更强所以会被选中」这条链依赖一件事：技术评估是主要门槛。门槛移走之后，能力仍然是必要条件，但不再是胜负手。\n\n" +
            `本轮取回的材料裁不开这一条，它只证明检索链路是通的 [${at(ids, 0)}]；能裁开它的是我们自己那几次投标里技术分与结果的对应关系。`,
        },
        {
          type: "judgment",
          claim: "靠模型能力带动成单这条链断了一环",
          confidence: "初步提示",
          direction: "限定",
          reasoningSummary:
            "门槛移走之后能力仍是必要条件，但它不再自动兑现成订单；这一条不依赖决策权归属，所以比标题那句更硬。",
          upgradeCondition: "在下一次投标里直接看到业务线负责人否决了技术评分更高的一方",
          falsifyCondition: "出现一次由技术评分直接定标的投标",
          evidenceRefs: refsOf(at(ids, 0), MODEL_REF),
          internalValidationHooks: ["最近三次投标里技术分与中标结果的对应关系"],
        },
      ],
    },
  ],
  final: (ids) => ({
    type: "judgment",
    claim: "采购决策权已经从技术评估侧移到业务线负责人手上",
    confidence: "当前更支持",
    direction: "支持",
    reasoningSummary: `两个已投标客户的决策人在同一个季度换人，评分权重同期下降；本轮外部材料只证明取证链路是通的 [${at(ids, 0)}]，所以这一条主要靠内部投标记录撑着。`,
    upgradeCondition: "另外两个行业的招标口径出现同向变化",
    falsifyCondition: "这两个客户的下一次投标仍由技术评估侧拍板，或者评分权重回到四成",
    evidenceRefs: refsOf(at(ids, 0), MODEL_REF),
    internalValidationHooks: ["两个已投标客户的决策链记录", "近四个季度的投标评分表"],
  }),
  unverified: {
    heading: "这两条本轮没能核实",
    type: "unverified_panel",
    items: [
      {
        statement: "另外两个行业同期的招标口径",
        whyMatters: "缺它，标题那句只能按这一个行业成立，跨行业推广要打对折",
        whatWouldSettle: "另外两个行业同期的公开招标文件，口径可比",
        impactIfTrue: "若同向下降，这条判断升一档，并且可以跨行业用",
        impactIfFalse: "若没有下降，本轮所见退回成一个行业的局部现象",
      },
      {
        statement: "客户内部决策人更换的原因",
        whyMatters: "缺它，「同期」和「同因」分不开",
        whatWouldSettle: "客户内部的人事说明，或者投标接口人的一次确认",
        impactIfTrue: "若与评分口径同源，这条判断的机制说得通",
        impactIfFalse: "若只是常规人事安排，同期就只是巧合",
      },
    ],
  },
  falsify: (ids) => ({
    heading: "什么会推翻它",
    type: "falsify_card",
    conditions: [
      "这两个客户的下一次投标仍由技术评估侧拍板",
      "另外两个行业的技术评分权重没有同向变化",
      `本轮取回的材料被证明与这个议题无关 [${at(ids, 1)}]`,
    ],
    monitoringIndicators: [
      "下一次投标里的提问人与拍板人",
      "另外两个行业的招标文件更新",
      "我们自己投标记录里技术分与结果的对应",
    ],
  }),
};

const claude: Stance = {
  thesis: "决策权是否已经转移尚未定论，但技术评分不再是唯一门槛这一点已经可以确认",
  confidence: "初步提示",
  banner: {
    text: "按现有材料只能确认技术评分的权重在下降，还不足以确认采购决策权已经完成转移。",
    boundary: "两个客户、一个行业、近一个季度：这个样本撑得起前半句，撑不起后半句。",
  },
  knowledgeTarget: "技术评分已经不是唯一门槛",
  sections: [
    {
      id: "S1",
      title: "同期发生不等于同因",
      question: "本轮的材料能不能把「口径变了」和「人换了」这两条来路分开？",
      expected: ["caliber_map", "layered_table", "prose"],
      min: 3,
      blocks: (ids) => [
        {
          heading: "同期发生不等于同因",
          type: "caliber_map",
          rows: [
            {
              metric: "技术评分权重",
              answersWhat: "招标文件里这一项算几分",
              cannotAnswer: "谁在给分、谁最后拍板",
              handling: `只用来判断门槛的高低，不用来推断决策人是谁 [${MODEL_REF}]`,
            },
            {
              metric: "决策人是谁",
              answersWhat: "这两个客户此刻由谁拍板",
              cannotAnswer: "换人的原因，以及别的行业是不是也换了",
              handling: "只作内部投标记录里的一处观察，不当作行业结论",
            },
            {
              metric: "本轮取回的外部材料",
              answersWhat: "检索、抓页、逐字定位这条链路通不通",
              cannotAnswer: "招标口径本身的任何一个数",
              handling: `只用来验证链路 [${at(ids, 0)}]，不进经营结论`,
            },
          ],
        },
        {
          heading: "分层看：三句话各自撑到哪一步",
          type: "layered_table",
          columns: ["要判的那一句", "本轮取到什么", "撑得到哪一步"],
          rows: [
            ["技术评分权重在下降", `没取到公开文件，只有既有知识 [${MODEL_REF}]`, "只说得出方向"],
            ["决策权已经转移", "内部投标记录里两个客户都换了人", "只对这两个客户成立"],
            ["另外两个行业同向", "一条都没取到", "跨行业不成立"],
          ],
          rowGrade: ["C", "C", "E"],
          evidenceRefs: [at(ids, 0)],
        },
        {
          type: "prose",
          md:
            "权重下降与决策人更换都发生在近一个季度。可它们也可以各有来路：评分模板改版是行业层面的动作，决策人更换是客户内部的人事安排。\n\n" +
            `本轮取回的材料只有一条示例数字和一页自述 [${at(ids, 0)}]，把这两条来路分开所需要的材料一件都没有。`,
        },
      ],
    },
    {
      id: "S2",
      title: "真正被动摇的是「能力差可以自动兑现成订单」",
      question: "抛开决策权归属，本轮已经动摇了我们哪一条前提？",
      expected: ["prose", "judgment"],
      min: 3,
      blocks: (ids) => [
        {
          heading: "真正被动摇的是「能力差可以自动兑现成订单」",
          type: "prose",
          md:
            "无论决策权在谁手上，能力差要兑现都得经过一道翻译。以前那道翻译是技术评分，现在它至少不再是唯一的一道。\n\n" +
            `这一条不依赖决策权归属，所以它比标题那句更硬；而本轮取回的材料只够证明取证链路是通的 [${at(ids, 0)}]。`,
        },
        {
          type: "judgment",
          claim: "技术评分已经不是唯一门槛",
          confidence: "当前更支持",
          direction: "限定",
          reasoningSummary: `权重下降与决策人更换同期出现；本轮外部材料只证明取证链路是通的 [${at(ids, 0)}]，所以这一条主要靠内部投标记录。`,
          upgradeCondition: "另外两个行业的招标文件出现同向变化",
          falsifyCondition: "下一次投标里技术分重新成为唯一的入围条件",
          evidenceRefs: refsOf(at(ids, 0), MODEL_REF),
          internalValidationHooks: ["两个已投标客户的评分表", "近四个季度的投标决策链记录"],
        },
        /*
         * 这一条**故意缺 `falsifyCondition`** —— A4-B03 会为它报一条 p0，于是每一轮离线跑都
         * 真的发生一次返修：`rejectedFrom` 挑出这一块、`buildA4BlockRepair` 拼出那一轮的提示词、
         * 假模型把这一行原样交回去、`spliceRepair` 贴回原处、重新装配、重新校验。
         *
         * 所以离线跑完这一栏**仍然挂着这条 p0**，「写了几遍」是 2。那不是缺陷：假模型不会改
         * 东西（见文件头），而这一条 p0 是这条路唯一的触发器。删掉它的代价是返修那一整段在
         * 离线下一次都不被执行 —— 而它是这条链上出错概率最高的一段。
         */
        {
          type: "judgment",
          claim: "决策权是否已经完成转移，本轮判不出来",
          confidence: "初步提示",
          direction: "限定",
          reasoningSummary: "同期发生的两件事在本轮材料里分不开来路，两种解释都还站得住。",
          upgradeCondition: "拿到客户内部的人事说明，或者在下一次投标里直接看到谁拍板",
          evidenceRefs: refsOf(at(ids, 0), MODEL_REF),
          internalValidationHooks: ["两个已投标客户的决策链记录"],
        },
      ],
    },
  ],
  final: (ids) => ({
    type: "judgment",
    claim: "本轮能确认的是门槛变了，不是决策权换了人",
    confidence: "初步提示",
    direction: "限定",
    reasoningSummary: `两节合起来只支撑到「技术评分不再是唯一门槛」；决策权那一句要的材料本轮一件都没取到，外部只有一条验链路的示例数字 [${at(ids, 0)}]。`,
    upgradeCondition: "另外两个行业出现同向的权重下降，或者拿到客户内部的人事说明",
    falsifyCondition: "下一次投标里技术分重新成为唯一的入围条件",
    evidenceRefs: refsOf(at(ids, 0), MODEL_REF),
    internalValidationHooks: ["两个已投标客户的决策链记录", "近四个季度的投标评分表"],
  }),
  unverified: {
    heading: "这两条卡在同一处：本轮的材料只够验链路",
    type: "unverified_panel",
    items: [
      {
        statement: "另外两个行业同期的招标口径",
        whyMatters: "缺它，权重下降是行业性的还是这两家自己的，分不出来",
        whatWouldSettle: "另外两个行业同期的公开招标文件",
        impactIfTrue: "若同向下降，前半句升一档",
        impactIfFalse: "若没有下降，本轮所见只是这一个行业的调整",
      },
      {
        statement: "客户内部人事变动的原因",
        whyMatters: "缺它，「同期」抬不成「同因」",
        whatWouldSettle: "客户内部的人事说明，或者投标接口人的一次确认",
        impactIfTrue: "若与评分口径同源，决策权转移这条读法成立",
        impactIfFalse: "若是常规人事安排，这两件事各归各",
      },
    ],
  },
  falsify: (ids) => ({
    heading: "什么会推翻这一份",
    type: "falsify_card",
    conditions: [
      "下一次投标里技术分重新成为唯一的入围条件",
      "客户内部人事说明显示换人与招标口径无关",
      `本轮取回的材料被证明与这个议题无关 [${at(ids, 1)}]`,
    ],
    monitoringIndicators: ["下一次投标的提问人与拍板人", "另外两个行业的招标文件更新"],
  }),
};

/*
 * 主源（`run.ts` 的 `PRIMARY_SLOT = "synth"`）：判断板和四节从它压出来，跨链路对账折出的
 * `divergence_view` 也插进这一份。所以四份里**它的判断块要最齐** —— 板上那几条就是从这里取的。
 *
 * 它也是唯一带 `param_model` 和内部文档那一条的一份：成本结构类的话要能复算（A4-B07），
 * 而内部文档只许出现在「对我们的当前含义」那一节和 `internalValidationHooks` 里（A4-B04）——
 * 这两条规则在离线下的唯一靶子就是这一份。
 */
const gpt: Stance = {
  thesis: "技术评分权重的下降是招标模板的一次行业性改版，把它读成这两个客户的决策权转移会指错下一步",
  confidence: "当前更支持",
  banner: {
    text: "更站得住的读法是：评分权重下降来自招标模板的一次行业性改版，决策人更换是同期发生的另一件事。",
    boundary: "只对同一行业的招标口径成立；本轮只取到一条带统计期间的外部数字，「行业性」这个前提还没被钉死。",
  },
  knowledgeTarget: "权重下降来自模板改版",
  internalDoc: true,
  sections: [
    {
      id: "S1",
      title: "权重是模板项，不像单个客户能定的",
      question: "同一个幅度在两个不同客户身上同期出现，哪一层的解释最省假设？",
      expected: ["bar_compare", "prose", "judgment"],
      min: 3,
      blocks: (ids) => [
        {
          heading: "权重是模板项，不像单个客户能定的",
          type: "bar_compare",
          nonAdditive: true,
          items: [
            { label: "模板改版", value: 2, note: `缺模板维护方与近一年的改版记录 [${MODEL_REF}]` },
            { label: "决策权转移", value: 1, note: `缺客户内部的人事说明 [${MODEL_REF}]` },
            { label: "两件事同时发生", value: 3, note: `缺前两项，再加一份可比的跨行业口径 [${at(ids, 0)}]` },
          ],
        },
        {
          type: "prose",
          md:
            "评分权重是招标文件里的模板项。两个不同客户在同一个季度改出同一个幅度，比「两家各自决定这么改」更容易由一次模板改版解释，而这一条不需要知道谁在拍板就能成立。\n\n" +
            `本轮取回的材料只够证明检索链路是通的 [${at(ids, 0)}]；模板由谁维护、近一年改过几版，一条都没取到。`,
        },
        {
          type: "judgment",
          claim: "技术评分权重的下降来自招标模板的一次行业性改版",
          confidence: "当前更支持",
          direction: "支持",
          reasoningSummary: `同幅度、同期、跨客户三件一起出现，模板层的解释比两家各自决定更省假设；本轮外部材料只证明取证链路是通的 [${at(ids, 0)}]。`,
          upgradeCondition: "拿到模板维护方的改版说明，或另外两个行业同期的招标文件",
          falsifyCondition: "另外两个行业的评分权重没有同向变化，或者这两家的招标文件用的不是同一套模板",
          evidenceRefs: refsOf(at(ids, 0), MODEL_REF),
          internalValidationHooks: ["我们手上这两家历年招标文件的模板版本", "近四个季度的投标评分表"],
        },
      ],
    },
    {
      id: "S2",
      title: "权重回到四成时，净分差翻不翻得过来",
      question: "在这套评分口径下，我们的技术领先还能不能抵掉商务与交付上的落后？",
      expected: ["param_model", "scenario_cards", "prose", "judgment"],
      min: 4,
      blocks: (ids) => [
        {
          heading: "权重回到四成时，净分差翻不翻得过来",
          type: "param_model",
          layer: "招标评分层",
          params: [
            { id: "techWeight", label: "技术分权重", default: 0.25, min: 0.1, max: 0.5, step: 0.05 },
            { id: "techLead", label: "我们领先的技术分", default: 12, min: 0, max: 30, step: 1, unit: "分" },
            { id: "bizWeight", label: "商务与交付分权重", default: 0.45, min: 0.2, max: 0.7, step: 0.05 },
            {
              id: "bizLoss",
              label: "我们在商务与交付分上落后的分",
              default: 8,
              min: 0,
              max: 30,
              step: 1,
              unit: "分",
            },
          ],
          outputs: [
            { label: "折算后的净分差", expr: "techLead * techWeight - bizLoss * bizWeight", unit: "分" },
            { label: "权重回到四成时的净分差", expr: "techLead * 0.4 - bizLoss * bizWeight", unit: "分" },
          ],
          disclaimer:
            "只算技术分与商务交付分两项的加权净差，不含否决项、资质门槛与围标风险；这套算式属于招标评分这一层，" +
            "移到定价或交付那一层是错的。参数默认值是构造的，本轮没有一条外部材料支持它们。",
        },
        {
          heading: "三档情景下这件事会走成什么样",
          type: "scenario_cards",
          cards: [
            {
              name: "模板还会继续改",
              assumptions: ["权重按同一方向再降一档", "客户侧的决策人不再变动"],
              keyNumbers: [`技术分权重降到两成上下 [${MODEL_REF}]`, "净分差按上面那套算式转负"],
              triggerIndicators: ["同一行业新一批招标文件的评分表", "模板维护方发布改版说明"],
            },
            {
              name: "这一轮改完就停",
              assumptions: ["权重停在两成五", "商务与交付分的权重不再上升"],
              keyNumbers: [`技术分权重停在两成五 [${MODEL_REF}]`, "净分差在默认参数下接近零"],
              triggerIndicators: ["下一批招标文件的评分表与本轮一致"],
            },
            {
              name: "其实是这两家自己改的",
              assumptions: ["另外两个行业的权重没有变化", "换人与口径无关"],
              keyNumbers: ["行业性这个前提不成立", "适用范围收回到这两个客户"],
              triggerIndicators: ["另外两个行业同期的招标文件", "客户内部的人事说明"],
            },
          ],
        },
        {
          heading: "对我们的当前含义",
          type: "prose",
          md:
            `要问的不是「决策权在谁手上」，而是「这份模板还会不会继续改、由谁改」。前者在下一次投标里就看得到，但看到了也只是这两家的事；后者决定我们要不要在行业标准这一层投人 [${INTERNAL_REF}]。\n\n` +
            `我们自己那份投标记录是这一问唯一能裁决的材料 [${INTERNAL_REF}]，它同时也说明：这两家用的是不是同一套模板，我们手上本来就有答案。`,
        },
        {
          type: "judgment",
          claim: "决策人换成业务线负责人可能是结果而不是原因",
          confidence: "初步提示",
          direction: "限定",
          reasoningSummary:
            "模板改版之后技术分不再是主要区分项，采购的重心自然移到预算与交付上，而那两样本来就归业务线。若是这个次序，针对决策权做的任何应对都会晚一个季度。",
          upgradeCondition: "客户内部的人事说明显示换人发生在模板改版之后",
          falsifyCondition: "换人发生在模板改版之前，或者两者在时间上无法排序",
          evidenceRefs: refsOf(at(ids, 0), MODEL_REF),
          internalValidationHooks: ["两个已投标客户的决策链记录与时间点"],
        },
      ],
    },
  ],
  final: (ids) => ({
    type: "judgment",
    claim: "该盯的是这份招标模板的下一版，不是这两家的拍板人",
    confidence: "当前更支持",
    direction: "支持",
    reasoningSummary: `模板层的解释同时说得通两节看到的东西，而决策权那一条要多一个假设；本轮外部材料只证明取证链路是通的 [${at(ids, 0)}]，模板那一层一条都没取到。`,
    upgradeCondition: "拿到模板维护方的改版说明，或另外两个行业同期的招标文件",
    falsifyCondition: "这两家的招标文件用的不是同一套模板，或者另外两个行业的权重没有同向变化",
    evidenceRefs: refsOf(at(ids, 0), MODEL_REF),
    internalValidationHooks: ["我们手上这两家历年招标文件的模板版本", "近四个季度的投标评分表"],
  }),
  unverified: {
    heading: "模板那一层本轮一条都没取到",
    type: "unverified_panel",
    items: [
      {
        statement: "招标模板由谁维护、近一年改过几版",
        whyMatters: "缺它，「模板改版」只是一个更省事的解释，不是有依据的结论",
        whatWouldSettle: "模板维护方的改版说明，或者同一行业连续两年的招标文件对照",
        impactIfTrue: "若确有一次统一改版，标题那句升一档并且指得出下一步该找谁",
        impactIfFalse: "若没有统一改版，这份报告的主解释退回成这两家各自的调整",
      },
      {
        statement: "另外两个行业同期的评分权重",
        whyMatters: "缺它，「行业性」这个前提无从判断",
        whatWouldSettle: "另外两个行业同期的公开招标文件，口径可比",
        impactIfTrue: "若同向下降，行业性成立",
        impactIfFalse: "若没有下降，适用范围收回到这两个客户",
      },
    ],
  },
  falsify: (ids) => ({
    heading: "什么会推翻这一份",
    type: "falsify_card",
    conditions: [
      "另外两个行业同期的评分权重没有同向变化",
      "这两家的招标文件用的不是同一套模板",
      `本轮取回的材料被证明与这个议题无关 [${at(ids, 1)}]`,
    ],
    monitoringIndicators: [
      "同一行业新一批招标文件的评分表",
      "模板维护方的改版说明",
      "另外两个行业同期的招标文件",
    ],
  }),
};

/**
 * 三条链路各一套罐头。键是 `run.ts` 里 `LANES` 那一栏的 `hint` —— 那张表是几条链路唯一的
 * 出处，这里跟着它写，不另起一套。
 */
const STANCES: Record<string, Stance> = {
  "a4.report": deepseek,
  "a4.report.claude": claude,
  "a4.report.gpt": gpt,
};

/* -------------------------------------------------------------------------- */
/* 跨链路对账那一步                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 对账那一步交的东西（`a4.divergence`）。
 *
 * 链路名用代号：递进去的是甲乙丙丁（`divergence.ts` 的 `ALIASES` 那一排的前四个，四条链路
 * 一条一个），映射由代码做。**不带证据编号** —— 编号是各条链路自己台账里的，跨链路引不通
 * （那边一律 `stripRefs`）。
 *
 * 四处里有三处是真的分歧，第四处是**故意写坏的**，各自钉住一段代码：
 *
 *   · 第一处「欠定 + 事实核查」→ `adjudicate` 就地改成「需内部数据」并记一条账。不改的话
 *     A4-B09 会判一条 p0，而这一支没有返修轮，那条 p0 会一直挂着。
 *   · 第三处「已裁决」带 note → A4-B09 那条 p1（已裁决却没说怎么裁的）不该被触发。
 *   · 第四处写了一个**「戊」**→ 那是 `ALIASES` 里空着的那个余量代号，四条链路只发到「丁」，
 *     所以 `laneOf` 认不出来，那一方被丢掉，只剩一方的那一处整个丢掉，两条都进 notes。离线跑
 *     因此每次都在 trace 里留两行对不上的账，那是预期结果：这一段是丢弃路径唯一的靶子。
 *     **认不出的那一方不许拿甲乙丙丁里的任何一个来演** —— 那四个都是真链路的代号，写它们
 *     等于把一条真链路的立场丢掉。
 */
const divergenceBlocks = (): Line[] => [
  {
    heading: "决策权到底转移了没有，四条各说了一种",
    type: "divergence_view",
    topic: "采购决策权是否已经完成转移",
    positions: [
      {
        lane: "甲",
        verdict: "已经转移",
        keyBasis: "两个已投标客户的决策人在同一个季度换人，评分权重同期下降",
        confidence: "当前更支持",
      },
      {
        lane: "乙",
        verdict: "尚未定论，只能确认门槛变了",
        keyBasis: "同期发生的两件事在本轮材料里分不开来路，两个客户一个行业撑不起后半句",
        confidence: "初步提示",
      },
      {
        lane: "丙",
        verdict: "是模板改版的下游现象，不是原因",
        keyBasis: "权重是模板项，同幅度跨客户出现更像一次统一改版；换人发生在其后",
        confidence: "当前更支持",
      },
      {
        lane: "丁",
        verdict: "拍板人变了，但上游是预算并盘",
        keyBasis: "换人和口径改动各自解释不了对方，预算归属一件事同时推得出两个结果",
        confidence: "初步提示",
      },
    ],
    adjudication: {
      status: "欠定",
      method: "事实核查",
      note: "四条都缺另外两个行业的可比口径，本轮公开材料到此为止；要客户内部的决策链记录才裁得开。",
    },
  },
  {
    heading: "权重为什么降，这一处一次公开检索就能定",
    type: "divergence_view",
    topic: "技术评分权重下降的成因",
    positions: [
      {
        lane: "甲",
        verdict: "决策人换了，口径跟着换",
        keyBasis: "两件事同期发生，内部投标记录里换人在先",
        confidence: "初步提示",
      },
      {
        lane: "丙",
        verdict: "招标模板的一次行业性改版",
        keyBasis: "同幅度、同期、跨客户三件一起出现，模板层的解释更省假设",
        confidence: "当前更支持",
      },
      {
        lane: "丁",
        verdict: "预算并盘之后技术分不再需要区分供应商",
        keyBasis: "谁掌钱谁定评分口径，这一条在招标文件的付款方那一栏查得到",
        confidence: "初步提示",
      },
    ],
    adjudication: {
      status: "待裁决",
      method: "事实核查",
      note: "查招标模板的维护方与近一年的改版记录，再看一眼招标文件里的付款方，一次公开检索就能定。",
    },
  },
  {
    heading: "这两家的样本能不能推到行业，这一处不用再查",
    type: "divergence_view",
    topic: "这两个客户的样本能不能推到整个行业",
    positions: [
      {
        lane: "乙",
        verdict: "不能，样本撑不起",
        keyBasis: "两个客户、一个行业、一个季度，本轮没有第二个行业的口径",
        confidence: "初步提示",
      },
      {
        lane: "丙",
        verdict: "只要模板是行业性的就能推",
        keyBasis: "推广的依据是模板的适用范围，不是客户数",
        confidence: "初步提示",
      },
    ],
    adjudication: {
      status: "已裁决",
      method: "程序执行",
      note: "两边说的是两件事：本轮结论按这两个客户记，跨行业那一条挂在模板适用范围上等材料。这一处不用再查，是记账口径的问题。",
    },
  },
  {
    heading: "这一处故意写坏：链路名认不出来",
    type: "divergence_view",
    topic: "本轮取回的外部材料能不能进经营结论",
    positions: [
      {
        lane: "戊",
        verdict: "能，至少能当一个时间点",
        keyBasis: "四条链路只发到「丁」，「戊」是空着的余量代号，所以这一方会被丢掉",
        confidence: "初步提示",
      },
      {
        lane: "丁",
        verdict: "不能，那一页自称是占位件",
        keyBasis: "取回的那一页写明是离线自测用的占位正文",
        confidence: "当前更支持",
      },
    ],
    adjudication: {
      status: "待裁决",
      method: "事实核查",
      note: "丢掉这一方之后只剩一方，整处会被丢掉 —— 这一处存在的意义就是让那条丢弃路径每轮都跑一次。",
    },
  },
];

/* -------------------------------------------------------------------------- */
/* 罐头入口                                                                    */
/* -------------------------------------------------------------------------- */

/** 三段各自的 hint 后缀（`run.ts` 里那三次调用拼的就是这几个）。 */
const STAGE = /^(.+)\.(outline|section|closing)$/;

/**
 * 区块那一支要的罐头。认不出来时交回 `undefined` —— 那时 `mockText` 走散文那张表，
 * 而散文那几份是另一支（`TKOS_DR_BLOCKS` 关掉时）真正要用的东西。
 *
 * 链路自己那个 hint（`a4.report` 这一类）在这里**只用来接返修那一轮**：区块那一支的正稿
 * 走三段，只有返修那一次用的是链路 hint（`write()`）。所以这里先看这一轮的提示词里有没有
 * 「出口校验没过」那一段：有就把被拒的那几行原样交回去，没有就交回 `undefined` 让散文罐头
 * 接着 —— 那正是没开区块开关时该发生的事。
 */
export function blockCanned(hint: string | undefined, messages: MockMsg[]): string | undefined {
  if (!hint) return undefined;
  if (hint === "a4.divergence") return jsonl(divergenceBlocks());

  const stage = STAGE.exec(hint);
  if (stage) {
    const s = STANCES[stage[1]];
    if (!s) return undefined;
    if (stage[2] === "outline") return outlineOf(s, packIds(messages));
    if (stage[2] === "section") return sectionOf(s, messages);
    return closingOf(s, packIds(messages));
  }

  return STANCES[hint] ? repairEcho(messages) : undefined;
}
