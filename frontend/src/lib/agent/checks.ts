/**
 * 机器自检。对齐自 `tkos-lab/src/tkos_lab/checks/machine.py`。
 *
 * 只做**规则可判定**的那部分——字段齐全、数量区间、引用 ID 是否真实存在、
 * 是否踩了明令禁止的写法。「判断抽得准不准」「反证质量高不高」只能人评，
 * 不在这里。
 *
 * 与 `src/lib/agent/rules.ts`（A3/A4 的质量门）分工不同：那一套判「这份报告
 * 写得合不合规」并且不过就打回重生成；这一套判「这次运行有没有踩硬线」，
 * **只记不拦**，落进 Run 记录供评分的人看。
 */
import type { OpenedContext } from "@/lib/graphknowledge";

export type Out = Record<string, unknown>;

export type Check = { name: string; ok: boolean; detail: string };

export type CheckSummary = {
  passed: number;
  total: number;
  allPassed: boolean;
  failed: string[];
};

const c = (name: string, ok: boolean, detail = ""): Check => ({ name, ok: Boolean(ok), detail });

/** 取字符串字段。不是字符串就当没给 —— 下游一律按 `""` 处理，不抛。 */
const t = (o: Out, key: string): string => {
  const v = o[key];
  return typeof v === "string" ? v.trim() : "";
};

const list = (o: Out, key: string): string[] => {
  const v = o[key];
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
};

const nested = (o: Out, key: string): Out => {
  const v = o[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Out) : {};
};

/**
 * 句数。中英文句末标点都算，连续标点算一句。
 *
 * 英文句点只在**两侧都不是数字**时才算句末：正文里出现 `v1.5`、`3.5%`、`0.3 个点`
 * 是常事，把那个点当句末的话，一条本来合规的三句议题会在台账上被标成四句 ——
 * 而台账是给人评分用的唯一凭据，错误的红比没有这条检查更坏。
 */
const sentences = (text: string): number =>
  text.split(/[。！？!?;；\n]+|(?<!\d)\.(?!\d)/).filter((s) => s.trim()).length;

/** 去掉空白和标点，用来判两段话是不是同一句。改一个逗号不算改。 */
const squash = (text: string): string =>
  text.replace(/[\s，,。.、；;：:！!？?「」“”"'（）()]+/g, "");

function citedOk(cited: string[], memberIds: Set<string>): [boolean, string] {
  if (cited.length === 0) return [true, "未引用任何 member"];
  const bad = cited.filter((id) => !memberIds.has(id));
  return [
    bad.length === 0,
    bad.length ? `编造的 ID: ${bad.slice(0, 5).join(", ")}` : `${cited.length} 个引用全部真实`,
  ];
}

/*
 * A1a 两条「不产出议题」的路各有自己的判词，**不能共用一句**：
 * 前者是「公司里已经有议题在管这件事的位置，而这条信号不该动它们」，
 * 后者是「图谱里根本没有相关位置，光凭这条信号也不够分量」。
 * 两句话原样进 checks，是下游和评分人识别分支的唯一凭据。
 */
export const IGNORE_VERDICT = "此信号应被忽略，不改动也不新增议题";
export const NO_ISSUE_VERDICT = "此信号不值得转化为潜在议题";

export function a1aIsIgnore(out: Out): boolean {
  if (out.decision === "ignore") return true;
  if (out.relevant === false) return true;
  return [IGNORE_VERDICT, NO_ISSUE_VERDICT].includes(t(out, "verdict"));
}

/** 选路那一步的自检。只判「选得清不清楚」，不判「选得对不对」——后者要人看。 */
export function a1aTriage(out: Out, memberIds: Set<string>, raw: string): Check[] {
  const dec = t(out, "decision");
  const reading = t(out, "signal_reading");
  const why = t(out, "rationale") || t(out, "reason");
  const normalized = Boolean(raw) && raw !== dec;
  const cs: Check[] = [
    c(
      "路由取值原样合法",
      !normalized,
      normalized
        ? `收到「${raw}」，已按 ${dec} 处理；下游按这三个值分支，请在 Prompt 里把取值定死`
        : ""
    ),
    c("一句话说清了信号在说什么", Boolean(reading)),
    c("说清了为什么走这条路", why.length >= 10, `${why.length} 字`),
  ];
  if (dec === "update_issue") {
    const code = t(out, "target_issue_code");
    cs.push(c("指名了要取代的既有议题", Boolean(code)));
    cs.push(
      c(
        "要取代的议题在上下文里存在",
        Boolean(code) && memberIds.has(code),
        code && !memberIds.has(code) ? `${code} 不在本次上下文里，是编的` : ""
      )
    );
  }
  return cs;
}

/**
 * 判噪音那条路的自检。
 *
 * 这条路的产出是「什么都不做」，所以要盯的就是它有没有资格什么都不做。
 * 说不出「什么情况下它会重新值得处理」的，是搁置不是判断 —— 下次同一条信号
 * 再来，还是一样卡着。
 */
export function a1aIgnore(out: Out): Check[] {
  const verdict = t(out, "verdict");
  const later = t(out, "what_would_change_it");
  return [
    c(
      "判词原样给出",
      verdict === IGNORE_VERDICT,
      verdict === IGNORE_VERDICT ? "" : `实际是「${verdict}」，应为「${IGNORE_VERDICT}」`
    ),
    c("说清了为什么是噪音", Boolean(t(out, "reason"))),
    c(
      "说得出什么情况下它会重新值得处理",
      later.length >= 6,
      later.length < 6 ? "说不出这一条的是搁置，不是判断" : ""
    ),
  ];
}

/**
 * 「证据边界」那一格里等于没写的写法。
 *
 * 方法域 S01 §5.1 要的是「必要 Evidence boundary」—— 具体说出是哪一种不足（自披露
 * 还是第三方核实、样本一个还是多个、时间窗多长、哪一句是媒体叙事）。写成下面这几句
 * 的，那一格是填满了，但它要否掉的那个假设一个字都没否掉。
 *
 * 只在**整格就是这么一句**时判不通过：真实的边界句里常常含着「资料有限」这四个字，
 * 后面接着说清了是哪一种有限 —— 那种要算通过，否则这条检查会把写得最细的那些判成红的。
 */
const VACUOUS_BOUNDARY = [
  "信息有限",
  "资料有限",
  "证据有限",
  "信息不足",
  "资料不足",
  "证据不足",
  "尚不清楚",
  "有待核实",
  "有待进一步核实",
  "需要进一步核实",
];

/**
 * S01 那四块的自检，三条路（新建 / 取代 / 纯外部）共用。
 *
 * **共用是有意的。** 同一份技能 §5.1 同时管这三条路，各写一份的话，往后加一格检查
 * 时改两处漏一处 —— 漏掉的那条路照样跑、照样出格式正确的议题，只是它按上一版的
 * 标准在被检查，而台账上看不出任何区别（跟 `prompts.ts` 里 `{{SKILL}}` 不许抄成
 * 四份是同一个道理）。
 *
 * 三条路各自独有的那几格（`shakes_assumption`、`replaces`、`why_it_qualifies`）留在
 * 各自的函数里 —— 这里只管技能里那四块。
 */
function s01Blocks(out: Out): Check[] {
  const title = t(out, "sharp_title");
  const boundary = t(out, "evidence_boundary");
  // `business_consequence` 是这一版统一的名字；锚定路历史上给 `why_now`，纯外部路给
  // `why_it_qualifies`。三个都认，跟 `readIssueFraming` 同一条回落链 —— 两边不一致的
  // 话，屏幕上有内容而台账报「缺」，或者反过来。
  const consequence =
    t(out, "business_consequence") || t(out, "why_now") || t(out, "why_it_qualifies");
  const question = t(out, "real_question");

  const missing = [
    ["what_happened", t(out, "what_happened")],
    ["evidence_boundary", boundary],
    ["business_consequence", consequence],
    ["real_question", question],
    ["source_line", t(out, "source_line")],
  ]
    .filter(([, val]) => !val)
    .map(([key]) => key);

  /*
   * 一段一件事。
   *
   * 实测最常见的失败不是缺格，是**把同一句话填进两格** —— 七格全满，看着无懈可击，
   * 而其中一格其实没答。这件事人眼很难在长文里看出来，机器一比就出来了。
   */
  const filled = [
    ["标题", title],
    ["议题正文", t(out, "issue_statement")],
    ["发生了什么", t(out, "what_happened")],
    ["证据边界", boundary],
    ["这意味着什么", consequence],
    ["真正要回答的问题", question],
  ].filter(([, val]) => val) as [string, string][];
  const dup: string[] = [];
  for (let i = 0; i < filled.length; i++) {
    for (let j = i + 1; j < filled.length; j++) {
      if (squash(filled[i][1]) === squash(filled[j][1])) dup.push(`${filled[i][0]}=${filled[j][0]}`);
    }
  }

  return [
    c("给出了标题", Boolean(title), `${title.length} 字`),
    c(
      "标题是一个短问句",
      Boolean(title) && /[？?]$/.test(title) && title.length <= 40,
      !title ? "没给标题" : !/[？?]$/.test(title) ? "不是问句" : `${title.length} 字，短问句应在 40 字内`
    ),
    c("那四块的每一格都填了", missing.length === 0, missing.length ? `缺: ${missing.join(", ")}` : ""),
    c(
      "证据边界说到了具体是哪一种不足",
      boundary.length >= 12 && !VACUOUS_BOUNDARY.some((w) => squash(boundary) === squash(w)),
      !boundary ? "这一格空着" : `「${boundary.slice(0, 20)}」——只说了信息有限，等于没说边界`
    ),
    c("一段一件事，没有把同一句话填进两格", dup.length === 0, dup.length ? `重复: ${dup.join("、")}` : ""),
  ];
}

export function a1aNew(out: Out, memberIds: Set<string>): Check[] {
  const issue = t(out, "issue_statement");
  const missing = ["shakes_assumption", "suggested_handling"].filter((f) => !t(out, f));
  const [ok, detail] = citedOk(list(out, "cited_member_ids"), memberIds);
  return [
    c("给出了议题正文", Boolean(issue), `${issue.length} 字`),
    c("议题正文不超过三句", sentences(issue) <= 3, `${sentences(issue)} 句`),
    ...s01Blocks(out),
    c("动摇的假设与建议都给了", missing.length === 0, missing.length ? `缺: ${missing.join(", ")}` : ""),
    c("引用 ID 真实", ok, detail),
    c("动摇的假设指向具体战略", t(out, "shakes_assumption").length >= 8),
  ];
}

/**
 * 取代既有议题那条路的自检。比新建多盯三件事，都是「取代」这个动作特有的：
 * 被取代的那条得是真的、旧说法得照录下来（否则事后对不出改了哪里）、
 * 新说法不能等于旧说法（那不是取代，是把同一句话再抄一遍）。
 */
export function a1aUpdate(out: Out, memberIds: Set<string>): Check[] {
  const rep = nested(out, "replaces");
  const code = t(out, "target_issue_code") || t(rep, "code");
  const before = t(rep, "statement_before") || t(out, "statement_before");
  const after = t(out, "issue_statement");
  const changed = t(out, "what_changed");
  const same = Boolean(after) && squash(after) === squash(before);
  const [ok, detail] = citedOk(list(out, "cited_member_ids"), memberIds);
  return [
    c("指名了被取代的议题", Boolean(code)),
    c(
      "被取代的议题在上下文里存在",
      Boolean(code) && memberIds.has(code),
      code && !memberIds.has(code) ? `${code} 不在本次上下文里，是编的` : ""
    ),
    c(
      "照录了旧议题的说法",
      Boolean(before),
      before ? `${before.length} 字` : "没有旧说法，事后对不出改了哪一处"
    ),
    c("给出了新议题正文", Boolean(after), `${after.length} 字`),
    c("新议题不是旧议题的原地重复", !same, same ? "新旧两条几乎一样——那不是取代" : ""),
    ...s01Blocks(out),
    c("说清了变的是哪一处", changed.length >= 8, `${changed.length} 字`),
    /*
     * 「变的是哪一处」对着旧说法说，「发生了什么」对着世界说。写成同一句话的，通常是
     * 把 what_happened 当成 what_changed 的复述交了 —— 于是这一轮里「世界发生了什么」
     * 整个没答。s01Blocks 的重复检查看不到 what_changed（它不属于那四块），所以在这里对。
     */
    c(
      "「变的是哪一处」与「发生了什么」不是同一句",
      !(changed && squash(changed) === squash(t(out, "what_happened"))),
      changed && squash(changed) === squash(t(out, "what_happened"))
        ? "两格填了同一句话，其中一格没答"
        : ""
    ),
    c("说清了为什么是取代而不是另开一条", Boolean(t(out, "why_replace_not_new"))),
    c("引用 ID 真实", ok, detail),
  ];
}

/** 纯外部那条路上不该出现的措辞：没有公司上下文时说这些，只能是编的。 */
const PHANTOM_CONTEXT = [
  "公司现有战略假设",
  "公司此前认为",
  "公司战略假设是",
  "根据公司上下文",
  "公司内部数据显示",
];

/**
 * 纯外部路的路由取值原样合法。
 *
 * `raw` 是模型**原样**给的 `decision`，调用方在改写之前取下来。这条路只有两个合法
 * 取值，模板还明写了 `update_issue` 不成立（这里没有既有议题可取代）；而 `run.ts`
 * 会把任何看不懂的值改写成 `new_issue`。改写不留痕的话，「模型违反了硬约束」和
 * 「模型好好答的」在台账上长一个样 —— 而这条恰好是实测最常走的路。
 *
 * 与锚定路的同名检查有一处不同：那边空值会在 `normalizeDecision` 里就地失败，这边
 * 没有就地失败这一步，所以**空值同样判不通过**，否则它会从两道口子中间漏过去。
 */
function externalRouteVerbatim(raw: string, target: "ignore" | "new_issue"): Check {
  if (raw === target) return c("路由取值原样合法", true);
  if (!raw) {
    return c("路由取值原样合法", false, `没给 decision，已按 ${target} 处理；模板要求原样给出`);
  }
  return c(
    "路由取值原样合法",
    false,
    `收到「${raw}」，已按 ${target} 处理` +
      (raw === "update_issue" ? "；这条路上没有既有议题，update_issue 不成立" : "")
  );
}

/**
 * A1a 纯外部分支的自检。
 *
 * 与 `a1aNew` / `a1aUpdate` 分开，因为标准不同：这条路上没有公司上下文，
 * 四段式的「动摇哪条战略假设」根本无从判断，拿那把尺子来量会把对的产出量成
 * 错的。这里盯的是另外两件事——判词有没有原样给出，以及有没有凭空造出公司
 * 内部材料。
 *
 * `raw`：模型原样给的 `decision`。**必填**，不给默认值 —— 调用方必须在改写
 * `out.decision` 之前把原值取下来，有默认值的话漏传就静默变成「合法」。
 */
export function a1aExternal(out: Out, raw: string): Check[] {
  if (a1aIsIgnore(out)) {
    const verdict = t(out, "verdict");
    const later = t(out, "what_would_change_it");
    return [
      externalRouteVerbatim(raw, "ignore"),
      c(
        "判词原样给出",
        verdict === NO_ISSUE_VERDICT,
        verdict === NO_ISSUE_VERDICT ? "" : `实际是「${verdict}」，应为「${NO_ISSUE_VERDICT}」`
      ),
      c("不值得必须给理由", Boolean(t(out, "reason"))),
      c(
        "说得出什么情况下它会重新值得处理",
        later.length >= 6,
        later.length < 6 ? "说不出这一条的是搁置，不是判断" : ""
      ),
    ];
  }
  const issue = t(out, "issue_statement");
  const why = t(out, "why_it_qualifies");
  /*
   * 编造公司上下文要在**整份产出**里查，不只在这两格。
   *
   * 原来只看 `issue_statement + why_it_qualifies`，而这一版新增的
   * `business_consequence` / `evidence_boundary` 恰恰是最容易写出「公司现有战略假设
   * 是……」的两格 —— 前者要说「哪一个当前重要判断需要重新审视」，后者要说边界，
   * 两处都在诱导模型去引一份它这次根本没有的内部材料。少查那几格等于这条检查
   * 在最需要它的地方不生效。
   */
  const blob = [
    issue,
    why,
    t(out, "sharp_title"),
    t(out, "what_happened"),
    t(out, "evidence_boundary"),
    t(out, "business_consequence"),
    t(out, "real_question"),
    t(out, "source_line"),
  ].join("\n");
  const phantom = PHANTOM_CONTEXT.filter((w) => blob.includes(w));
  const cited = list(out, "cited_member_ids");
  return [
    externalRouteVerbatim(raw, "new_issue"),
    c("给出了议题正文", Boolean(issue), `${issue.length} 字`),
    ...s01Blocks(out),
    c("给出了值得成为议题的解释", why.length >= 20, `${why.length} 字`),
    // 议题正文最多三句。超了通常是把信号原文摘要照抄进来了 —— 「议题」是一个要
    // 想清楚的问题，一句话说不完就说明还没想清楚。
    c("议题正文不超过三句", sentences(issue) <= 3, `${sentences(issue)} 句`),
    c(
      "没有编造公司上下文",
      phantom.length === 0,
      phantom.length ? `出现了: ${phantom.join("、")}` : "本次无公司上下文，产出也没假装有"
    ),
    c(
      "引用为空",
      cited.length === 0,
      cited.length
        ? `引了 ${cited.length} 个 member，但本次没有任何 member 可引`
        : "本次无公司上下文，引用为空是对的"
    ),
  ];
}

/**
 * 锚点与问题是否对得上。**不拦截，只把判断依据摆出来。**
 *
 * 最坏的失败是「问题问 A、锚点指向 B」——产出看着完全合理，但用的是另一条
 * 议题的上下文。那种偏差会被归到 Prompt 头上，然后往错误的方向改。
 */
export function anchorChecks(opened: OpenedContext): Check[] {
  if (opened.mode === "narrative") {
    /*
     * 这条也**判通过**，理由和纯外部那条一样：没有锚点不是错，是这个源本来就不产生锚点。
     * 但两件事必须写进这条 detail，否则评分的人会拿错的标准去评：
     *
     * 一、**这一轮只有公司层的语义记忆，没有工作记忆。** 本体那一层（议题 + 它挂着的
     *     判断 + 已有共识）还没建起来。所以「没引用这条议题的既有判断」在这条路上是对的，
     *     不是缺陷 —— 而反过来，产出里但凡出现一句「公司现有判断是……」，那一定是从公司层
     *     材料里推想出来的，该扣的是这一处。
     * 二、**引用应为空。** 叙述接口不回短码，正文里出现的是对象的名字。
     *
     * 该看的那一件正面的事也写上：每条战略议题都从属于某条当前 Mission，所以这份产出
     * 有没有把议题挂上去（或者明说挂不上）是可评的 —— 这比「有没有引用」有意义得多。
     */
    return [
      c(
        "本次只有公司层上下文（语义记忆），无锚点、无既有判断",
        true,
        "本体的工作记忆（议题+判断+共识）尚未建立，这一轮拿到的只有公司层内容" +
          "（愿景 / Outcome / Mission / 经营原则）：引用应为空，" +
          "**没有引用这条议题的既有判断是对的，不是缺陷**。" +
          "反过来，产出里出现「公司现有判断是……」一定是推想的。" +
          "该评的是它有没有把这条议题挂到某条当前 Mission 上，或者明说挂不上"
      ),
    ];
  }
  if (opened.mode === "external_only") {
    /*
     * 这条**判通过**。没有锚点不是错——它是一条正常分支，说明这条输入对公司
     * 现有的战略方向来说还太新，图谱里还没有它的位置。但它必须写清楚，否则
     * 评分的人会拿「有公司上下文」的标准去评一份根本没有公司上下文的产出：
     * 「没引用任何战略假设」在这条路上是对的，在那条路上才是错的。
     */
    return [
      c(
        "本次无公司上下文（纯外部）",
        true,
        `${opened.noAnchorReason ?? "图谱里没有对应锚点"}。` +
          "评这份产出时按纯外部标准：引用应为空，不该出现公司内部材料"
      ),
    ];
  }
  const a = opened.anchor;
  if (!a) {
    /*
     * 没有 `anchor` 有两种原因，台账上不能混：显式钉住（复现旧运行）是有人手工
     * 指定过；按判断号定是**没有人**指定，是前端那层对应关系带过来的。两条都没有
     * 分数可比，只报事实 —— 但报错哪一条，事后就会照错的方向去查。
     */
    if (opened.anchorOrigin === "judgmentRefs") {
      return [
        c(
          "锚点与问题相关",
          true,
          `锚点是这条议题挂着的在版判断（${opened.bundle?.anchorCode ?? ""}），不是检索出来的：` +
            "图谱里没有前端这些议题对象。相关度由「议题动摇哪条判断」那层对应关系担保，" +
            "而那一层是模型提案、待人确认的，本次不做相似度核验"
        ),
      ];
    }
    return [c("锚点与问题相关", true, "锚点由调用方钉住，本次不做相关度核验")];
  }
  const label = a.label.length > 24 ? `（${a.label.slice(0, 24)}…）` : a.label ? `（${a.label}）` : "";
  if (a.ambiguous && a.runnersUp.length) {
    const u = a.runnersUp[0];
    return [
      c(
        "锚点与问题相关",
        false,
        `${a.anchorCode}(${a.score}) 与 ${u.code}(${u.score}) 分数接近，` +
          `这句问题同时像两条议题；上下文只装了 ${a.anchorCode}${label}`
      ),
    ];
  }
  const alt = a.runnersUp.length
    ? `；次名 ${a.runnersUp.slice(0, 2).map((u) => `${u.code}(${u.score})`).join("、")}`
    : "";
  return [
    c("锚点与问题相关", true, `自动选定 ${a.anchorCode}${label}，P3 首名（相似度 ${a.score}）${alt}`),
  ];
}

export function summarize(checks: Check[]): CheckSummary {
  const passed = checks.filter((x) => x.ok).length;
  return {
    passed,
    total: checks.length,
    allPassed: passed === checks.length,
    failed: checks.filter((x) => !x.ok).map((x) => x.name),
  };
}
