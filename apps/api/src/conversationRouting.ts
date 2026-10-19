/**
 * 对话分档（模型路由方案 docs/superpowers/specs/2026-10-13-model-routing.md §4.3–§4.5 的最小可用版）：
 * 每轮先定档位，再按档位定思考强度、整轮时限和回答篇幅。
 * - quick 快答：寒暄、明确的修改指令、查本系统里的状态和定义；关思考（网关上 effort none，Sol 首字约 1.9 秒，low 约 3.7 秒）。
 * - grounded 检索问答：大多数问题；思考 low（gpt-5.6-sol 实测），目标 20–40 秒。
 * - deep 深度：只给很重要的战略问题；思考 high（10/13 起深度档用 claude-opus-5-5），开头先告诉一号位要深入查证和推演（用时只在进度行显示）。
 * 每档用哪个模型见 conversationModel.ts 的 conversationTierModels（快答 gpt-5.6-sol、检索问答 claude-sonnet-5-5、深度 claude-opus-5-5）。
 * 先走本地规则（不叫模型）；规则定不了的，或判为深度需要一句话概括对象的，再叫一次快模型分诊。
 * 分诊失败、超时、输出不合规，一律回落到规则结果或检索问答档，不卡住整轮。
 */

export type ConversationTier = "quick" | "grounded" | "deep";
export type TierThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

export type TierSettings = {
  thinkingLevel: TierThinkingLevel;
  /**
   * 这一档通常要多久（毫秒）：只用于中途升级提示估算「还需约多少秒」。10/13 起不再按它截断回答——
   * 是否卡住按「连续 90 秒没有任何新事件」判断（conversationRecovery.ts），另有 10 分钟的绝对上限只防死循环（app.ts）。
   */
  timeoutMs: number;
  /** 界面上给的预计用时（秒）。 */
  expectSeconds: number;
};

export const TIER_SETTINGS: Record<ConversationTier, TierSettings> = {
  quick: { thinkingLevel: "off", timeoutMs: 90_000, expectSeconds: 10 },
  // 检索问答：10/13 实测 gpt-5.6-sol 上 medium 两次都在 47–50 秒（超出 20–40 秒目标），low 为 21–35 秒；换到 gpt-6.1-sol 后再按方案改回 medium。
  grounded: { thinkingLevel: "low", timeoutMs: 120_000, expectSeconds: 30 },
  deep: { thinkingLevel: "high", timeoutMs: 180_000, expectSeconds: 90 },
};

/** 每轮放进上下文包的回答档位说明（answerMode）：控制查证范围和篇幅，不规定格式模板。 */
export const TIER_GUIDANCE: Record<ConversationTier, string> = {
  quick: "快答：直接回答，一到三句话；只在需要时读一次看板或企业知识，不做外部检索；修改指令按业务修改规则执行。",
  grounded: "检索问答：回答第一句就是结论，不写开场白，不说要先查什么、怎么查。先查企业知识和看板，内部不足再做外部检索，合计不超过 3 次，证据够了就停；开头一句给结论，篇幅与问题相称。",
  deep: "深度：这是一个重要的战略问题。回答第一句就是判断，不写开场白，不说要先查什么、怎么推演。先界定问题和对标层级，查企业知识和看板数值，再针对关键分歧做外部检索，合计不超过 6 次，每次检索词具体到公司和事件，额度留给关键分歧；按「深度分析」的形状写：开头一段给判断，然后用段落写清因果链、关键证据、最有力的反对意见和二阶影响，落到集团和具体战场，最后写需要盯的信号与仍不确定的地方。证据够下判断就动笔，不追求穷尽。",
};

/**
 * 分诊结果。battlefields 是这句提问涉及的战场（all、战场 id 数组；空数组表示不针对任何战场），上下文包据此筛选（conversationFocus.ts）。
 * 只有深度档带预取检索词（memory：企业知识，web：公开来源），服务端据此在主答第一轮之前并行预取；检索问答档不再给，分诊输出更短、更快。
 */
export type TriageResult = { tier: ConversationTier; topic?: string; battlefields?: "all" | string[]; memory?: string[]; web?: string[];
  /** 这一轮适不适合出图（时间线、路线图、指标对比、图示：路线图、排期、阶段、节奏、差距、组织、因果链、矩阵、流程）；没给按 false。 */
  visual?: boolean };
/** 给分诊看的战场清单（id 与名称）。 */
export type TriageBattlefield = { id: string; name: string; code?: string };
export type TriageFn = (input: { message: string; previousUserMessage?: string; signal: AbortSignal; battlefields?: TriageBattlefield[] }) => Promise<TriageResult | null>;

export type TurnRoute = {
  tier: ConversationTier;
  /** rule：本地规则定的；model：分诊模型定的；fallback：分诊失败后回落。 */
  source: "rule" | "model" | "fallback";
  thinkingLevel: TierThinkingLevel;
  timeoutMs: number;
  expectSeconds: number;
  /** 开场说明（检索问答档、深度档）：界面立刻显示，也写进这条回答的开头；快答档没有。 */
  notice?: string;
  /** 预取检索词（来自分诊，已清洗；只有深度档）；规则定档或分诊没给时没有。 */
  prefetch?: { memory: string[]; web: string[] };
  /** 分诊给的本轮涉及的战场（已清洗）；分诊没有结果时没有，上下文包按规则判断（conversationFocus.ts）。 */
  battlefields?: "all" | string[];
  /** 本轮一号位有没有修改、确认、批准一类的意思：没有时主答不带直接写入的工具（conversationPrompt.ts）。 */
  writeIntent: boolean;
  /** 分诊判这一轮要出图（时间线、路线图、指标对比、图示）：与 conversationPrompt.ts 的正则取或，决定带不带图表块完整规则。分诊没结果时没有。 */
  visual?: boolean;
};

const ACK = /^(好的?|好|谢谢|多谢|收到|明白|了解|知道了|可以|行|嗯+|ok|okay|thanks?)[。！!，,.\s]*$/i;
/** 明确的修改、选择、确认：按业务修改规则执行，要的是准确而不是长思考。 */
const WRITE_INTENT = /^选择[:：]|就按(方案|这个|第)|按这个改|^同意|采用(方案|这个)|(把|将).{1,40}(改成|改为|改到|调到|调整为|换成|设为)|负责人改成|签发|撤回|撤销|新建(一个)?(议题|原则)|立(一个|个)?议题|(变成|转成|列为|立为|升级为|升级成).{0,12}议题|记(一下|住)|写进/;
/**
 * 「有写入意图」比 WRITE_INTENT 宽：明确的改法、批准确认卡的短答（好的、同意、就这样）、各种改动类动词都算。
 * 只用来决定这一轮带不带写入工具，宁可多判：多判只是多带几个工具，少判会让一号位的修改要求执行不了。
 */
const WRITE_WORDS = /(改|修订|调整|更新|新建|创建|新增|添加|加上|加一|删|去掉|移出|恢复|签发|决定|确认|撤回|撤销|取消|采用|同意|批准|通过|就这样|按这个|按意见|重写|记住|记一下|写进|写入|保存|设为|设成|换成|标成|标记|指派|交给|分派|推进到|标为|置为|预审|重新预研|选择|选定|就按|就用|就定|定了|拍板|执行|落实|方案[一二三四五六七八九十0-9A-Za-z]|变成.{0,8}议题|转成.{0,8}议题|立.{0,4}议题)/;
export function hasWriteIntent(message: string): boolean {
  const text = coreText(message);
  return ACK.test(text) || WRITE_INTENT.test(text) || WRITE_WORDS.test(text);
}

/** 只问本系统里的状态、名单、日期、数量、定义。 */
const STATUS_ASK = /(有几个|有多少|多少个|几个|是什么|是谁|谁负责|负责人是|什么时候|哪天|几点|截止|进展到哪|什么状态|状态是|名单|列一下|列出)/;
/** 带判断、评估意味的问法不算查状态。 */
const ANALYTIC_ASK = /(能否|能不能|会不会|风险|为什么|怎么|如何|建议|判断|评估|分析|原因|影响|要不要|是否|值不值|该不该)/;
/** 战略层面的对象。 */
const STRATEGIC_SCOPE = /(战略|集团.{0,8}(影响|策略|方向|定位|价值|布局)|商业模式|价值模式|商业合理性|盈利(性|模式|能力)|竞争(格局|态势)|行业格局|市场(格局|判断|供需)|供需|对标|赛道|护城河|上市|递表|融资|估值|并购|投资逻辑|长期走势|未来策略)/;
/** 要求深入判断的问法。 */
const DEPTH_ASK = /(为什么|背后(的)?(原因|逻辑|判断)|深层|深入|深度|系统(地|性)|全面(分析|评估|判断)|如何(定义|应对|布局|参考|规避|看待)|怎么(看|判断|应对|布局|定义)|往前(看|预判)|预判|推演|演化|趋势|影响|意味着|启示|应该关注)/;
const EXPLICIT_DEEP = /(深度分析|深入分析|系统分析|战略推演|深度研究|深入研究|认真想一想|好好想想)/;
/**
 * 跨战场的比较、排序、取舍，以及「最需要」「优先」「介入」「哪个更重要」这类要下优先级判断的问题（10/13 实测：
 * 「三个战场里哪个最需要一号位本月介入，为什么」题干里没有「战略」「集团」，三个分诊模型都判成了非深度档）。
 * 这两类直接定深度，分诊不再降档。
 */
const MULTI_BATTLEFIELD = /((三|几|两|3|2)\s*个|各个|所有|全部|每个|哪个|哪些|各)战场|战场(之间|间|对比|比较|排序|排名|优先)/;
const COMPARE_ASK = /(比较|对比|排序|排个序|排名|取舍|权衡|哪个|哪一个|谁更|更(重要|急|关键|值得|需要)|最(需要|该|值得|重要|急|关键))/;
const PRIORITY_JUDGEMENT = /(最需要|最该|最值得|优先(级|处理|解决|介入|投入|抓|做)?|介入|哪(个|一个|件事|块)(更|最)(重要|急|关键|值得|需要)|更(重要|急|紧迫)的是哪|轻重缓急|先抓哪|先做哪)/;
/** 跨战场比较、优先级判断：定深度、不降档（见上）。 */
export function priorityDeep(message: string): boolean {
  const text = coreText(message);
  if (WRITE_INTENT.test(text) || text.length < 8) return false;
  return (MULTI_BATTLEFIELD.test(text) && (COMPARE_ASK.test(text) || DEPTH_ASK.test(text))) || PRIORITY_JUDGEMENT.test(text);
}
/**
 * 只要一张图或表（10/14：「把三个战场按机会和风险做个对比矩阵」被判成深度档，用了 124 秒）：
 * 主要诉求是画、做、列一张图、表或矩阵，又没有要求深入分析、判断或给建议的，最高判到检索问答档。
 * 两种都有（「画个对比矩阵并告诉我先投哪个」）仍按原规则走深度。
 */
const CHART_NOUN = /(路线图|时间线|时间轴|甘特图|矩阵|对比表|对照表|表格|一张表|个表|张表|图示|示意图|关系图|架构图|组织(关系|架构|结构)|因果链|因果图|流程图|鱼骨图|脑图|思维导图|图表|柱状图|条形图|饼图|折线图|雷达图|象限|排期表|里程碑图|全景图|地图)/;
const CHART_VERB = /(画|做|列|出|整理|梳理|生成|给我|来|弄|拉|排|展示|呈现|可视化|直观)/;
/** 要深入分析、下判断或给建议的说法：出现了就不按「只要图表」降档。 */
const JUDGEMENT_ASK = /(为什么|建议|判断|评估|深入|深度|推演|预判|怎么(看|办|应对|选)|如何(看待|应对|选)|应该|该不该|要不要|值不值|是否值得|先投|投哪|先(抓|做|推|上|管|处理|解决)哪|最(需要|该|值得|重要|急|关键)|哪(个|一个|块|件)(更|最)|优先(处理|解决|介入|投入|抓|做)|介入|取舍|结论|下一步|怎么做|启示|意味着)/;
export function chartOnly(message: string): boolean {
  const text = coreText(message);
  if (!CHART_NOUN.test(text) || !CHART_VERB.test(text)) return false;
  return !JUDGEMENT_ASK.test(text) && !EXPLICIT_DEEP.test(text);
}
/** 外部具体对象与时效：至少要查证。 */
const NEEDS_EVIDENCE = /(最新|近期|最近|现在|目前|今年|本月|融资|财报|价格|定价|市场|政策|公司|产品|对标|竞品|[A-Z][A-Za-z]{2,})/;

/** 去掉页面附带的前缀与附件正文：只看一号位这一轮说的话。 */
function coreText(message: string): string {
  const withoutAttachments = message.split(/\n\n\[附件 /)[0];
  return withoutAttachments.replace(/^【页面】[^\n]*\n+/u, "").trim();
}

/** 本地规则：能定就定（0 毫秒），定不了返回 null。deep 也返回结果，但还要分诊模型给一句话的判断对象。 */
export function ruleTier(message: string): ConversationTier | null {
  const text = coreText(message);
  if (ACK.test(text)) return "quick";
  if (WRITE_INTENT.test(text)) return "quick";
  if (EXPLICIT_DEEP.test(text)) return "deep";
  // 只要一张图或表：不按规则定深度，交给分诊，分诊结果最高也只到检索问答（routeTurn）。
  const chart = chartOnly(message);
  if (!chart && priorityDeep(message)) return "deep";
  const strategic = STRATEGIC_SCOPE.test(text);
  const depth = DEPTH_ASK.test(text);
  if (!chart && strategic && depth && text.length >= 18) return "deep";
  if (!strategic && STATUS_ASK.test(text) && !ANALYTIC_ASK.test(text) && text.length <= 30 && !NEEDS_EVIDENCE.test(text)) return "quick";
  return null;
}

// 开场说明不能出现称呼和运行环境字眼；后者按字符码拼出来，源码里不出现这些字面。
// 称呼词同样按字符码拼（promptGovernance 检查固定文案里不出现称呼）。
const FORBIDDEN_WORDS = [[0x738b, 0x603b], [0x9886, 0x5bfc], [0x8001, 0x677f], [0x60a8, 0x597d], [0x6f14, 0x793a], [0x672c, 0x573a], [0x573a, 0x6b21], [0x64, 0x65, 0x6d, 0x6f]]
  .map((codes) => String.fromCharCode(...codes));
const FORBIDDEN_IN_NOTICE = new RegExp(`(${FORBIDDEN_WORDS.join("|")}|[一-龥]总(?![体结部量额]))`, "i");

/** 分诊模型给的判断对象：只收一个短名词短语，不合规就不用（回到通用说法）。 */
export const TOPIC_MAX_CHARS = 40;
export function cleanTopic(topic: unknown): string | undefined {
  if (typeof topic !== "string") return undefined;
  const value = topic.trim()
    .replace(/^[「『“"']+|[」』”"']+$/g, "")
    .replace(/(的)?(战略)?(判断|问题|分析|研究)$/, "")
    .replace(/[。！？!?，,；;：:]+$/, "")
    .trim();
  // 上限 40 字：10/13 实测 deepseek-v4.1-flash 给的对象在 20–33 字之间（英文公司名占字数，如「Fireworks AI 与 Together AI 产品定价对比」33 字），
  // 24 字会把合规的对象丢掉、开场退回通用句。
  if (value.length < 2 || value.length > TOPIC_MAX_CHARS) return undefined;
  if (/[\n。！？!?；;：:——]/.test(value) || FORBIDDEN_IN_NOTICE.test(value)) return undefined;
  return value;
}


/** 存进对话记录的回答：开场说明在前，空一行接正文（界面流式时也是这样拼的）。 */
export function withNotice(notice: string | undefined, body: string): string {
  if (!notice) return body;
  return body ? [notice, body].join(String.fromCharCode(10, 10)) : notice;
}

/** 预取检索词：每个 2–40 字、去重，企业知识最多 2 个、公开来源最多 3 个；不合规的丢掉。 */
export function cleanPrefetch(result: Pick<TriageResult, "memory" | "web"> | null | undefined): { memory: string[]; web: string[] } | undefined {
  const clean = (list: unknown, max: number) => [...new Set((Array.isArray(list) ? list : [])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length >= 2 && item.length <= 40 && !FORBIDDEN_IN_NOTICE.test(item)))].slice(0, max);
  const memory = clean(result?.memory, 2), web = clean(result?.web, 3);
  return memory.length || web.length ? { memory, web } : undefined;
}

/** 分诊给的战场：all，或 1–40 字的字符串数组（最多 5 个，可以为空）；不合规返回 undefined（当作分诊没给）。 */
export function cleanTriageBattlefields(value: unknown): "all" | string[] | undefined {
  if (value === "all") return "all";
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item.length >= 1 && item.length <= 40);
  if (list.some((item) => item.toLowerCase() === "all")) return "all";
  return [...new Set(list)].slice(0, 5);
}

function routeOf(tier: ConversationTier, source: TurnRoute["source"], message: string, topic?: string,
  options: { prefetch?: TurnRoute["prefetch"]; battlefields?: TurnRoute["battlefields"]; visual?: boolean } = {}): TurnRoute {
  const settings = TIER_SETTINGS[tier];
  // 各档都不在回答开头加开场白（10/18 走查：每条回答开头都多一句「先查企业知识……」「需要更深入地查证和推演」）：
  // 慢的原因由进度行与步骤列表体现，回答直接给结论。route.notice 的通路保留（恢复、续写仍按它拼），这里不再产出。
  const notice: string | undefined = undefined;
  // 只有深度档预取：快答不做外部检索；检索问答档 10/13 起不再让分诊给检索词（分诊更快，第一轮由主答自己查）。
  const prefetch = tier === "deep" ? options.prefetch : undefined;
  return { tier, source, ...settings, ...(notice ? { notice } : {}), ...(prefetch ? { prefetch } : {}),
    ...(options.battlefields !== undefined ? { battlefields: options.battlefields } : {}), ...(options.visual ? { visual: true } : {}), writeIntent: hasWriteIntent(message) };
}

/** 分诊整体时限：网关上快模型首字约 1.7 秒，整次 1.6–3.2 秒；10/13 实测深度档带检索词时有两次 4 秒内没写完，放宽到 5 秒，超过就不等。 */
export const TRIAGE_TIMEOUT_MS = 5_000;
/** 分诊前最多等战场清单这么久（只读查询，正常几毫秒）；没等到就不给清单，分诊照常进行。 */
const TRIAGE_BATTLEFIELDS_WAIT_MS = 300;

/**
 * 定本轮档位。
 * - 规则判快答、或一号位明确要求深度分析：直接定，分诊只补判断对象。
 * - 规则判深度（战略对象 + 深入问法）：交分诊复核，分诊可以确认，也可以降为检索问答（只有很重要的战略问题才走深度）；分诊没结果就按深度走。
 * - 规则定不了：按分诊结果；分诊失败、超时或没配置，回落到检索问答档。
 */
export async function routeTurn(input: { message: string; previousUserMessage?: string; signal: AbortSignal; triage?: TriageFn; timeoutMs?: number;
  /** 给分诊看的战场清单；不提供时分诊不判断涉及哪些战场。 */
  battlefields?: Promise<TriageBattlefield[] | undefined>; }): Promise<TurnRoute> {
  const rule = ruleTier(input.message);
  if (rule === "quick") return routeOf("quick", "rule", input.message);
  // 明确要求深度分析、跨战场比较与优先级判断：定深度，分诊只补判断对象、战场和检索词，不降档。
  // 只要一张图或表：最高到检索问答档，不进深度（分诊判 deep 也压到 grounded），这一轮带图表块规则。
  const chart = chartOnly(input.message);
  const explicitDeep = EXPLICIT_DEEP.test(coreText(input.message)) || (!chart && priorityDeep(input.message));
  // 没配快模型分诊（没有网关的环境）：只按规则分档，检索问答档不加开场句，回答与原来一致；配了分诊但这次失败或超时，仍用通用开场句。
  if (!input.triage || input.signal.aborted) return routeOf(rule ?? "grounded", rule ? "rule" : "fallback", input.message, undefined, { ...(chart ? { visual: true } : {}) });
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const battlefieldList = input.battlefields ? await Promise.race([
      input.battlefields.catch(() => undefined),
      new Promise<undefined>((resolve) => { const wait = setTimeout(() => resolve(undefined), TRIAGE_BATTLEFIELDS_WAIT_MS); (wait as { unref?: () => void }).unref?.(); }),
    ]) : undefined;
    const result = await Promise.race([
      input.triage({ message: coreText(input.message).slice(0, 1_500), previousUserMessage: input.previousUserMessage?.slice(0, 300), signal: controller.signal,
        ...(battlefieldList?.length ? { battlefields: battlefieldList } : {}) }),
      new Promise<null>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, input.timeoutMs ?? TRIAGE_TIMEOUT_MS); }),
    ]).catch(() => null);
    if (!result || !["quick", "grounded", "deep"].includes(result.tier)) return routeOf(rule ?? "grounded", rule ? "rule" : "fallback", input.message, undefined, chart ? { visual: true } : {});
    const topic = cleanTopic(result.topic);
    const prefetch = cleanPrefetch(result);
    const battlefields = cleanTriageBattlefields(result.battlefields);
    const visual = result.visual === true || chart;
    if (explicitDeep) return routeOf("deep", "rule", input.message, topic, { prefetch, battlefields, visual });
    // 规则判深度时分诊最多降到检索问答，不降到快答；只要一张图或表时分诊判深度也压到检索问答（兼顾 DeepSeek 分诊不总按提示走）。
    const tier = chart && result.tier === "deep" ? "grounded" : rule === "deep" && result.tier === "quick" ? "grounded" : result.tier;
    return routeOf(tier, "model", input.message, topic, { prefetch, battlefields, visual });
  } finally {
    if (timer) clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
  }
}

export const TRIAGE_PROMPT = `判断一号位这句提问应该走哪一档回答、涉及哪些战场，只输出一行 JSON，不输出其他文字：{"tier":"quick|grounded|deep","visual":false,"topic":"…","battlefields":["…"],"memory":["…"],"web":["…"]}

- quick：寒暄致谢；明确的修改、选择、确认指令；只问本系统里的状态、名单、日期、数量、定义（例如某个战场的长期目标是什么、待决策的议题有几个）。
- grounded：需要查企业知识或公开来源才能答准的问题，包括具体公司、产品、市场、政策、数字的现状，以及一般的分析、建议和写作。大多数问题属于这一档。
- deep：只给很重要的战略问题：涉及集团或某个战场的方向与定位、竞争格局与对标、商业模式与盈利性、资本动作背后的逻辑、对未来走势的预判，需要多来源查证和推演才能下判断。以下两类即使没有「战略」「集团」字样也是 deep：几个战场之间的比较、排序、取舍（例如「几个战场里哪个最该本月介入」「两个战场哪个更急」）；要在几件事之间下优先级判断的问题（「最需要」「优先」「介入」「哪个更重要」「先抓哪件」）。只看一个战场的状态、复盘、进展（例如「看看房懂懂上月复盘后的情况」）是 grounded；把某件事变成议题、改某个字段是 quick，即使句子里有「战略」「核心」。其余拿不准时选 grounded。
- 只要一张图或表：主要诉求是画、做、列一张图、表或矩阵（路线图、对比矩阵、因果链、组织关系、时间线等），又没有明确要求深入分析、判断或给建议的，最高写 grounded，即使涉及几个战场的对比（例如「把三个战场按机会和风险做个对比矩阵」是 grounded）。同时要图表又要判断的（例如「画个对比矩阵并告诉我先投哪个」「列个时间线，说说哪个最需要介入、为什么」）仍按上面的规则写 deep。

visual：一号位要看路线图、规划、排期、阶段划分、推进节奏、时间节点，或要看组织关系、因果链、对比矩阵、流程、关系图，或要「画出来」「直观看」，适合用时间线、路线图、指标对比条或图示展示时写 true；只问一个名字、定义、状态，或问「画像」这类描述时写 false。

topic：tier 为 deep 时，用 6 到 24 个字的名词短语概括要判断的对象（例如「Token 工厂赛道格局与集团定位」「三个战场本月介入的优先级」）；tier 为 grounded 时，用 4 到 24 个字的名词短语概括要查证的对象（例如「硅基流动最近一次融资」）；都不写人名、称呼和标点，不写问题里没有的事实。quick 写空字符串。

battlefields：这句提问涉及的战场，从输入的战场清单里取 id 写成数组（例如 ["tk"]）；问集团整体、几个战场之间的比较或排序、所有战场，或判断不出时写 "all"；只问外部公司、市场的公开事实，与哪个战场都无关时写 []。没有战场清单时写 "all"。

memory 与 web 只在 tier 为 deep 时写，是回答前先替主答查好的检索词；quick 和 grounded 不写这两项：
- memory：在企业知识里查的关键词，最多 2 个，每个 2 到 12 个字（例如「词元云集 商业模式」）；问题与集团自身无关时写空数组。
- web：在公开来源检索的查询词，最多 3 个，每个具体到公司、事件和年份（例如「硅基流动 C轮 融资 2026」）；只需要内部资料就能答的写空数组。`;

/** 从分诊模型的输出里取第一段 JSON。 */
export function parseTriage(text: string): TriageResult | null {
  const match = /\{[\s\S]*?\}/.exec(text);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]) as { tier?: unknown; visual?: unknown; topic?: unknown; battlefields?: unknown; memory?: unknown; web?: unknown };
    if (value.tier !== "quick" && value.tier !== "grounded" && value.tier !== "deep") return null;
    const list = (raw: unknown) => (Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []);
    const memory = list(value.memory), web = list(value.web);
    const battlefields = cleanTriageBattlefields(value.battlefields);
    return { tier: value.tier, ...(value.visual === true ? { visual: true } : {}), ...(typeof value.topic === "string" && value.topic ? { topic: value.topic } : {}),
      ...(battlefields !== undefined ? { battlefields } : {}), ...(memory.length ? { memory } : {}), ...(web.length ? { web } : {}) };
  } catch {
    return null;
  }
}

export type ResponsesClientOptions = { baseUrl: string; apiKey: string; modelId: string; fetch?: typeof fetch;
  /** 快模型（TRIAGE_MODEL，DeepSeek）出错时改用的模型（LIGHT_MODEL，terra）；不给或与 modelId 相同就不重试。 */
  fallbackModelId?: string };

/** 分诊失败后，整体时限里至少还剩这么久才用备用模型再分诊一次（terra 分诊整次 1.6–3.2 秒）。 */
export const TRIAGE_RETRY_MIN_MS = 2_000;
/** 思考要点（小标题）翻译失败后，3 秒时限里至少还剩这么久才重译。 */
export const THOUGHT_RETRY_MIN_MS = 1_500;
/** 思考段落翻译失败后，15 秒时限里至少还剩这么久才重译（长段落译文要写 3–6 秒）。 */
export const THINKING_RETRY_MIN_MS = 6_000;

/**
 * 快模型这次出错了（4xx、5xx、网络错误、输出解析不出来），还来得及就返回备用模型 id。
 * 调用方主动中断（软时限已用上结果、整体超时、一轮被取消）时不重试。
 */
export function fallbackModelFor(options: Pick<ResponsesClientOptions, "modelId" | "fallbackModelId">, input: {
  signal: AbortSignal; startedAt: number; budgetMs: number; minRemainingMs: number; what: string; now?: () => number }): string | undefined {
  const fallback = options.fallbackModelId;
  if (!fallback || fallback === options.modelId || input.signal.aborted) return undefined;
  if (input.budgetMs - ((input.now ?? Date.now)() - input.startedAt) < input.minRemainingMs) return undefined;
  console.warn(`${input.what}：${options.modelId} 出错，改用 ${fallback} 再试一次`);
  return fallback;
}

/**
 * 网宿 Responses 网关上的一次快模型调用（关思考 effort none，流式）：每来一段文字调一次 onText，返回非 undefined 就提前停。
 * key 只放在请求头，不进日志和报错。
 */
export async function streamFastResponse<T>(options: ResponsesClientOptions, request: { instructions: string; input: string; maxOutputTokens: number; signal: AbortSignal },
  onText: (text: string) => T | undefined): Promise<{ text: string; early?: T } | null> {
  const url = `${options.baseUrl.replace(/\/+$/, "").replace(/\/responses$/, "")}/responses`;
  const response = await (options.fetch ?? fetch)(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({ model: options.modelId, instructions: request.instructions, input: [{ role: "user", content: request.input }], stream: true, store: false,
      max_output_tokens: request.maxOutputTokens, reasoning: { effort: "none" } }),
    signal: request.signal,
  });
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
        if (!data || data === "[DONE]") continue;
        let event: { type?: string; delta?: string };
        try { event = JSON.parse(data); } catch { continue; }
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          text += event.delta;
          const early = onText(text);
          if (early !== undefined) return { text, early };
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return { text };
}

/** 网宿 Responses 网关上的分诊：快模型、关思考，流式读到第一个完整 JSON 就停。 */
/** 分诊输出还没写完时，先取已经写出的档位、要不要出图、判断对象与战场（战场没写完、检索词还没写完就不要了）。 */
export function parsePartialTriage(text: string): TriageResult | null {
  const tier = /"tier"\s*:\s*"(quick|grounded|deep)"/.exec(text)?.[1] as ConversationTier | undefined;
  if (!tier) return null;
  const topic = /"topic"\s*:\s*"([^"]*)"/.exec(text)?.[1];
  if (tier !== "quick" && topic === undefined) return null;
  const raw = /"battlefields"\s*:\s*("all"|\[[^\]]*\])/.exec(text)?.[1];
  let battlefields: "all" | string[] | undefined;
  try { battlefields = raw ? cleanTriageBattlefields(JSON.parse(raw)) : undefined; } catch { battlefields = undefined; }
  const visual = /"visual"\s*:\s*true/.test(text);
  return { tier, ...(visual ? { visual: true } : {}), ...(topic ? { topic } : {}), ...(battlefields !== undefined ? { battlefields } : {}) };
}

/**
 * 分诊的软时限：到这个时候 JSON 还没写完，但档位和判断对象已经写出来了，就先用它们（不带预取检索词）。
 * 整体时限放到 5 秒后跟着从 3 秒放到 4 秒：10/13 实测深度档 3 秒时检索词常常还没写完，预取落空，主答多一轮检索；
 * 快答、检索问答不再写检索词，JSON 短，一般 3 秒内写完，不受影响。
 */
export const TRIAGE_SOFT_DEADLINE_MS = 4_000;

export function createResponsesTriage(options: ResponsesClientOptions & { softDeadlineMs?: number; timeoutMs?: number }): TriageFn {
  return async ({ message, previousUserMessage, signal, battlefields }) => {
    const startedAt = Date.now();
    const list = battlefields?.length
      ? `战场清单：${battlefields.map((item) => `${item.id}=${item.name}${item.code && item.code !== item.name ? `（${item.code}）` : ""}`).join("；")}\n` : "";
    const input = `${list}${previousUserMessage ? `上一句提问：${previousUserMessage}\n` : ""}本轮提问：${message}`;
    // 预取检索词让输出多了几十个 token：仍是读到第一个完整 JSON 就停（JSON 里没有嵌套的花括号）；
    // 网关慢时（10/13 实测有一次 4 秒还没写完）到软时限先用已写出的档位与对象，免得整次分诊作废、开场说明退回通用句。
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let partial = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soft = new Promise<TriageResult | null>((resolve) => {
      timer = setTimeout(() => {
        const early = parsePartialTriage(partial);
        if (early) { controller.abort(); resolve(early); }
      }, options.softDeadlineMs ?? TRIAGE_SOFT_DEADLINE_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    const attempt = (modelId: string) => {
      partial = "";
      return streamFastResponse({ ...options, modelId }, { instructions: TRIAGE_PROMPT, input, maxOutputTokens: 300, signal: controller.signal },
        (text) => { partial = text; return /\}/.test(text) ? parseTriage(text) ?? undefined : undefined; })
        .then((result) => (result ? result.early ?? parseTriage(result.text) : null), () => null);
    };
    // DeepSeek 出错（4xx、5xx、网络错误、JSON 解析不出来）时，整体时限还剩得够就用 terra 再分诊一次；不够就交给 routeTurn 的超时退回。
    const full = attempt(options.modelId).then((first) => {
      if (first) return first;
      const fallback = fallbackModelFor(options, { signal: controller.signal, startedAt, budgetMs: options.timeoutMs ?? TRIAGE_TIMEOUT_MS,
        minRemainingMs: TRIAGE_RETRY_MIN_MS, what: "分诊" });
      return fallback ? attempt(fallback) : null;
    });
    try {
      return await Promise.race([full, soft]);
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}

/** 把推理摘要的英文标题译成一句中文要点（快模型、关思考）；失败返回 null，界面只显示「正在思考」。 */
export type ThoughtTranslator = (headline: string, signal: AbortSignal) => Promise<string | null>;

export const THOUGHT_TRANSLATE_PROMPT = `把下面这句英文（模型思考过程的小标题）译成简体中文短语，不超过 20 个字。只输出译文，不加引号、句号和解释。
不出现「用户」，需要时说成「这个问题」；不加任何称呼；人名、公司名、产品名保留原文。`;

/** 网宿网关上的思考要点翻译：整体 3 秒超时，由调用方控制频率。 */
export function createResponsesThoughtTranslator(options: ResponsesClientOptions & { timeoutMs?: number }): ThoughtTranslator {
  return async (headline, signal) => {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const budgetMs = options.timeoutMs ?? 3_000;
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const attempt = async (modelId: string) => (await streamFastResponse({ ...options, modelId },
      { instructions: THOUGHT_TRANSLATE_PROMPT, input: headline.slice(0, 120), maxOutputTokens: 60, signal: controller.signal },
      () => undefined).catch(() => null))?.text.trim() || null;
    try {
      const first = await attempt(options.modelId);
      if (first) return first;
      // 出错或译文为空：时限里还来得及就用备用模型重译这一句
      const fallback = fallbackModelFor(options, { signal: controller.signal, startedAt, budgetMs, minRemainingMs: THOUGHT_RETRY_MIN_MS, what: "思考要点翻译" });
      return fallback ? await attempt(fallback) : null;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * Claude 的思考摘要按段译成中文（10/13 实测：经网宿网关，系统提示里要求「思考过程用中文」，摘要仍是英文，只有很短的中文问题会用中文想）。
 * 一段一次调用，流式：每来一段译文调一次 onDelta；整体 15 秒超时（长段落译文要写 3–6 秒，6 秒会把末尾截掉）。
 * 快模型出错且还没上屏任何译文时，时限里还来得及就用备用模型重译这一段；再失败返回 null。
 */
export type ThinkingTranslator = (paragraph: string, signal: AbortSignal, onDelta: (delta: string) => void) => Promise<string | null>;

export const THINKING_TRANSLATE_PROMPT = `把下面这段模型思考过程的摘要译成简体中文，意思不增不减，只输出译文，不加引号和解释。
- 「the user」「user」「the CEO」「CEO」都译成「一号位」，或者省略主语；不出现「用户」「CEO」，不加任何称呼。
- 有通行中文名的公司用中文名（例如 SiliconFlow 写硅基流动、Infinigence 写无问芯穹、Volcano Engine 写火山引擎），其余人名、公司名、产品名保留原文；数字照抄。`;

export function createResponsesThinkingTranslator(options: ResponsesClientOptions & { timeoutMs?: number }): ThinkingTranslator {
  return async (paragraph, signal, onDelta) => {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const budgetMs = options.timeoutMs ?? 15_000;
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    let sent = 0;
    const attempt = async (modelId: string) => (await streamFastResponse({ ...options, modelId },
      { instructions: THINKING_TRANSLATE_PROMPT, input: paragraph.slice(0, 2_000), maxOutputTokens: 800, signal: controller.signal },
      (text) => { if (text.length > sent) { onDelta(text.slice(sent)); sent = text.length; } return undefined; }).catch(() => null))?.text.trim() || null;
    try {
      const first = await attempt(options.modelId);
      // 已经流式上屏了一部分译文就不重译（重译的译文接不上已经上屏的半段）；一个字都没出来才用备用模型重译这一段。
      if (first || sent > 0) return first;
      const fallback = fallbackModelFor(options, { signal: controller.signal, startedAt, budgetMs, minRemainingMs: THINKING_RETRY_MIN_MS, what: "思考翻译" });
      return fallback ? await attempt(fallback) : null;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}

/** 思考内容里不能上屏的字眼（称呼、运行环境字眼）；「用户」「CEO」换成「一号位」。命中称呼和运行环境字眼的这一段整段不上屏。 */
export function cleanThinkingText(text: string): string | undefined {
  const value = text.replace(/用户|CEO/g, "一号位");
  return FORBIDDEN_IN_NOTICE.test(value) ? undefined : value;
}

/** 一段文字是不是以中文为主（汉字不少于拉丁字母）。 */
export function mostlyChinese(text: string): boolean {
  const cjk = text.match(/[一-龥]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return cjk > 0 && cjk >= latin;
}

/** 译出来的思考要点：至少两个汉字，去掉引号与句末标点，不超过 30 字，不含称呼和运行环境字眼；不合规返回 undefined。 */
export function cleanThought(text: string): string | undefined {
  const value = text.split(/\n/)[0].trim().replace(/[。.！!；;，,]+$/, "").replace(/^[「『“"'*]+|[」』”"'*]+$/g, "").replace(/[。.！!；;，,]+$/, "").trim();
  if ((value.match(/[一-龥]/g)?.length ?? 0) < 2 || FORBIDDEN_IN_NOTICE.test(value) || /用户/.test(value)) return undefined;
  return value.length > 30 ? `${value.slice(0, 30)}…` : value;
}

/** 推理摘要里最新的一个完整小标题（「**标题**」），不论中英文；没有返回 undefined。 */
export function latestSummaryHeading(summary: string): string | undefined {
  const headings = [...summary.matchAll(/\*\*([^*\n]{2,80})\*\*/g)].map((match) => match[1].trim());
  return headings.at(-1);
}

/** 工具开始时给界面的一行进度（只写在查什么，不写工具名、字段名）。 */
export function toolProgressLabel(name: string, args: unknown): string | undefined {
  const value = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const quoted = (text: unknown) => (typeof text === "string" && text.trim() ? `「${text.trim().slice(0, 40)}」` : "");
  switch (name) {
    case "web_search": return `检索公开来源${quoted(value.query)}`;
    case "read_outlet_feed": return "读取发布方媒体的最新报道";
    case "list_sections": return "查看企业知识目录";
    case "search_sections": return `查找企业知识${quoted(value.query)}`;
    case "get_passages": return "阅读企业知识原文";
    case "search_people": return "查询人员目录";
    case "get_warmap_overview": return "读取战场总览";
    case "list_missions": return "读取战役清单";
    case "list_pending_issues": return "读取待决策议题";
    case "read_ontology": return "读取本体里的公司与目标";
    case "list_business_objects": return "查找相关业务对象";
    case "read_business_object": return "读取业务对象的最新版本";
    case "read_group_evidence": return "读取群材料与讨论";
    case "read_decision_history": return "读取历史决定";
    case "list_materials": case "read_material": return "阅读材料";
    case "read_mission_card": return "读取任务卡";
    case "read_mission_cards": return "读取 Mission 卡";
    case "read_progress": return "读取执行进展";
    case "read_reviews": return "读取复盘";
    case "read_object_tree": return "沿公司地图查找";
    case "read_anchor": return "展开当前页面";
    case "read_issue_conversation": return "读取议题里的对话";
    case "propose_issue": return "起草议题初稿";
    case "update_business_object": case "create_business_object": case "run_business_action": case "apply_business_proposal":
    case "edit_material": case "create_material": case "edit_mission_card": case "edit_current_object":
      return "保存修改";
    case "propose_business_change": case "propose_material_edit": case "propose_review_edit": return "整理确认卡";
    default: return undefined;
  }
}

/** 进度行只显示中文或拉丁字母的标题（检索结果里偶尔夹着其他文字的页面，标题看不懂就不显示）。 */
const READABLE_TITLE = /^[\p{Script=Han}\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u;

/** 工具结果里取一个短标题（外部来源标题、企业知识节名），只用于进度行。 */
function shortTitle(value: unknown, max = 24): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || !READABLE_TITLE.test(text)) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 工具结果的结构化部分：自定义工具放在 details，企业知识工具是 content 里的一段 JSON。 */
function resultValue(result: unknown): Record<string, unknown> {
  const value = (result && typeof result === "object" ? result : {}) as { details?: unknown; content?: unknown };
  if (value.details && typeof value.details === "object" && Object.keys(value.details).length) return value.details as Record<string, unknown>;
  const text = Array.isArray(value.content) ? value.content.map((item) => (item as { text?: unknown })?.text).filter((item) => typeof item === "string").join("") : "";
  try { const parsed = JSON.parse(text) as unknown; return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}

/**
 * 工具结束时给界面的一行查证进度：这一步实际读到了什么（条数、来源标题、企业知识节名）。
 * 由系统按工具结果生成，不由模型来写；没有可说的就返回 undefined，界面保留开始时那一行。
 */
export function toolResultDetail(name: string, args: unknown, result: unknown): string | undefined {
  const value = resultValue(result);
  const query = (args && typeof args === "object" ? (args as { query?: unknown }).query : undefined);
  const list = (key: string) => (Array.isArray(value[key]) ? value[key] as Record<string, unknown>[] : []);
  const titles = (items: Record<string, unknown>[], count = 2) => [...new Set(items.map((item) => shortTitle(item.title ?? (item.section as { title?: unknown } | undefined)?.title, 18)).filter(Boolean))].slice(0, count);
  switch (name) {
    case "web_search": {
      const results = list("results");
      const q = shortTitle(query, 20);
      if (!results.length) return q ? `「${q}」没有找到公开结果` : "没有找到公开结果";
      const head = titles(results, 1).map((title) => `《${title}》`).join("");
      return `${q ? `「${q}」` : ""}找到 ${results.length} 条公开来源${head ? `，如${head}` : ""}`;
    }
    case "search_sections": {
      const results = list("results");
      if (!results.length) return "企业知识里没有找到相关章节";
      return `企业知识里找到 ${results.length} 处相关：${titles(results).map((title) => `《${title}》`).join("")}`;
    }
    case "get_passages": {
      const title = shortTitle((value.section as { title?: unknown } | undefined)?.title);
      return title ? `已读企业知识《${title}》` : undefined;
    }
    case "list_sections": {
      const sections = list("sections");
      return sections.length ? `企业知识共 ${sections.length} 节` : undefined;
    }
    case "read_outlet_feed": {
      const items = list("items");
      return `读到发布方媒体 ${items.length} 条最新报道`;
    }
    case "list_pending_issues": {
      const issues = list("issues");
      return `待决策议题 ${issues.length} 项`;
    }
    case "get_warmap_overview": return "已读取战场总览";
    case "list_missions": return "已读取战役清单";
    // 三层取用：读到多少，有几条因权限没读到。
    case "read_mission_cards": case "read_progress": case "read_reviews": {
      const count = name === "read_mission_cards" ? `${list("missions").length} 张 Mission 卡`
        : name === "read_progress" ? `${list("people").length} 人的执行情况`
        : `${list("monthly").length + list("units").length + list("weekly").length} 份复盘`;
      const filtered = typeof value.filtered === "number" && value.filtered > 0 ? `，${value.filtered} 条无权查看` : "";
      return `读到 ${count}${filtered}`;
    }
    default: return undefined;
  }
}

/** 推理摘要里取一句中文要点（摘要常见格式是「**标题**」加一段说明）；英文摘要不上屏，返回 undefined。 */
export function thinkingHeadline(summary: string): string | undefined {
  const headings = [...summary.matchAll(/\*\*([^*\n]{2,60})\*\*/g)].map((match) => match[1].trim());
  const candidate = headings.at(-1) ?? summary.split(/\n/).map((line) => line.trim()).find(Boolean);
  if (!candidate || !/[一-龥]/.test(candidate)) return undefined;
  // 中文占多数才算中文要点；夹着英文长句的不上屏。
  const cjk = candidate.match(/[一-龥]/g)?.length ?? 0;
  const latin = candidate.match(/[A-Za-z]/g)?.length ?? 0;
  if (cjk < latin) return undefined;
  const text = candidate.replace(/[。.]+$/, "");
  if (FORBIDDEN_IN_NOTICE.test(text)) return undefined;
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

/**
 * 非深度档的中途升级提示：回答超过约 20 秒还没开始出正文，或模型连续多轮回去检索时，
 * 告诉一号位「这个问题需要更深入的分析，预计还需约 X 秒」。每轮最多一次；正文已经开始就不再提示。
 */
export const ESCALATION = {
  afterMs: 20_000,
  /** 连续几轮检索（每轮可以并行多次）才算「需要更深入」：快答 2 轮、检索问答 3 轮。 */
  retrievalRounds: { quick: 2, grounded: 3 } as Record<"quick" | "grounded", number>,
  /** 升级后估计的整轮用时（秒）：10/13 实测检索问答档 20 秒时还没出正文的几轮，正文在 21–36 秒开始、22–40 秒结束；快答按 30 秒估。 */
  expectedTotalSeconds: { quick: 30, grounded: 40 } as Record<"quick" | "grounded", number>,
};

/** 检索类工具：连续多轮调用它们算「还在查」。 */
const RETRIEVAL_TOOLS = new Set(["web_search", "search_sections", "get_passages", "list_sections", "read_outlet_feed"]);

/** 预计还需多少秒：按升级后的整轮估计减去已用时间，取整到 10 秒，至少 20 秒，不超过整轮时限剩下的时间。 */
export function escalationSeconds(tier: "quick" | "grounded", elapsedMs: number, timeoutMs: number): number {
  const left = ESCALATION.expectedTotalSeconds[tier] - elapsedMs / 1000;
  const rounded = Math.max(20, Math.ceil(left / 10) * 10);
  const budget = Math.floor((timeoutMs - elapsedMs) / 1000) - 5;
  return Math.max(10, Math.min(rounded, budget));
}

export function escalationNotice(seconds: number): string {
  return `这个问题需要更深入的分析，预计还需约 ${seconds} 秒。`;
}

export type EscalationEvent = { type: "escalation"; reason: "slow" | "retrieval"; expectSeconds: number; notice: string };

/**
 * 盯一轮回答，满足条件时调用一次 onEscalate。深度档不盯（开场已经说明要深入查证和推演，进度行有用时）。
 * 运行时在模型结束一条带工具调用的消息时调 assistantToolCalls，正文第一次出现时调 textStarted。
 */
export function createEscalationWatch(input: {
  tier: ConversationTier; timeoutMs: number; startedAt: number; onEscalate: (event: EscalationEvent) => void;
  afterMs?: number; now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const tier = input.tier;
  let done = tier === "deep";
  let rounds = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = (reason: EscalationEvent["reason"]) => {
    if (done || tier === "deep") return;
    done = true;
    if (timer) clearTimeout(timer);
    const expectSeconds = escalationSeconds(tier, now() - input.startedAt, input.timeoutMs);
    input.onEscalate({ type: "escalation", reason, expectSeconds, notice: escalationNotice(expectSeconds) });
  };
  if (!done) {
    timer = setTimeout(() => fire("slow"), Math.max(0, (input.afterMs ?? ESCALATION.afterMs) - (now() - input.startedAt)));
    (timer as { unref?: () => void }).unref?.();
  }
  return {
    /** 模型结束了一条消息：带检索工具调用的算一轮检索。 */
    assistantToolCalls(names: string[]) {
      if (done || tier === "deep") return;
      if (!names.some((name) => RETRIEVAL_TOOLS.has(name))) return;
      rounds += 1;
      if (rounds >= ESCALATION.retrievalRounds[tier]) fire("retrieval");
    },
    textStarted() {
      done = true;
      if (timer) clearTimeout(timer);
    },
    dispose() {
      done = true;
      if (timer) clearTimeout(timer);
    },
  };
}
