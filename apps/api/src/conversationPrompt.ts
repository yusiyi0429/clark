/**
 * 对话主答的系统提示与工具按档位、页面和本轮意图裁剪（10/13 两轮减负）。
 *
 * 第一轮：快答不带外部检索的工具和条款，也不带决策六节、图表块与选项块；没有修改意图的轮次不带直接写入的工具。
 * 第二轮（Claude 系统提示约 1.05 万 token → 6,000 以下）：
 * - 只在特定场景用到的规则挪进对应工具的说明，用到那个工具时才带上：写入的授权细则、冲突处理、字段对应在写工具里，
 *   确认卡的写法与「决定之后」的后续提议在 propose_business_change 里，群材料与历史决定的引用写法在各自的读取工具里；
 * - 与本轮意图无关的段落不拼进来：决策六节只在要求评估一项具体决策时带，选项块只在要方案、要下一步或评估决策时带，
 *   图表块只在问差距、完成度、节奏、截止、推算时带，月度计划逐段评审只在消息带月度计划引用时带；
 * - 与页面无关的段落不拼进来：材料改写规则只在当前页面有材料工具时带。
 * 一号位可见措辞的约束（不用称呼、不出现运行环境字眼、正式书面语、长期目标与本月目标的叫法、不输出内部编号和工具名）、
 * 不编造事实、确认卡机制与权限边界各档都保留：表达要求整段不动，证据与修改边界一段不动。
 * 同一档位、同一组意图的提示每轮逐字相同，缓存前缀稳定。
 */
import type { ConversationTier } from "./conversationRouting.js";
import { RICH_BLOCK_RULES } from "./richBlocks.js";
import { ANSWER_OPTIONS_RULES, DECISION_JUDGEMENT_RULES } from "./decisionJudgement.js";

/** 快答档的检索条款（替换「# 检索与证据」整节）。 */
export const QUICK_EVIDENCE_PROMPT = `# 检索与证据

快答只用上下文、看板和企业知识，不做外部检索。搜不到就明说，不编造。工具报错或超时时，用一句话说清没读到什么、为什么，并给出下一步（例如稍后重试，或在依据面板直接打开原文），不要凭印象补原文。没有来源、样本或可复核计算时，不给竞争重叠率、成功概率和置信度写精确百分比。`;

/** Claude 档：思考过程用中文（10/13 实测经网宿网关时摘要仍多为英文，界面再按段翻译，见 conversationThinking.ts）。 */
export const THINK_IN_CHINESE = "思考过程用简体中文。";

const EVIDENCE_HEADING = "# 检索与证据";
const STYLE_HEADING = "# 表达要求（书面中文）";
const WEB_TOOL_LINES = [/\n- `read_outlet_feed`：[^\n]*/, /\n- `web_search`：[^\n]*/];

/** 直接写入的工具：没有修改意图的轮次不带（提议类工具照常带）。 */
export const DIRECT_WRITE_TOOLS = new Set(["edit_material", "create_material"]);
/** 外部检索工具：快答不带。 */
export const EXTERNAL_SEARCH_TOOLS = new Set(["web_search", "read_outlet_feed"]);

/** 本轮意图：决定带不带那几段只在特定场景用到的规则。不提供时按全部为真处理（保持完整提示）。 */
export type PromptIntents = {
  /** 要求评估一项具体决策：带决策六节与选项块。 */
  decision: boolean;
  /** 要几个方案、几个可选的下一步：带选项块。 */
  options: boolean;
  /** 问差距、完成度、节奏、截止、推算：带图表块与公式。 */
  chart: boolean;
  /** 消息带月度计划的引用（逐段评审、按意见重写）：带月度计划逐段评审规则。 */
  planReview: boolean;
};

export type PromptShape = {
  tier: ConversationTier;
  writeIntent: boolean;
  anthropic: boolean;
  intents?: PromptIntents;
  /** 当前页面有没有材料工具；false 时去掉材料改写规则。不提供时保留。 */
  materials?: boolean;
};

/** 评估一项具体决策（六节只在这种时候用，见 DECISION_JUDGEMENT_RULES）。 */
const DECISION_ASK = /(要不要|该不该|是否(批准|采用|同意|通过|推进|上|投|签|启动|接受|继续|暂停|退出)|批不批|能不能批|选哪(个|一个|种|条)|哪个方案|哪种方案|方案[一二三四ABCD]|帮我评估|评估(一下)?(这个|是否|要不要|该不该|方案|决策|决定)|值不值得|拍板|怎么决策|如何决策|决策建议|做(这个)?决定)/;
/** 要几个可选的做法。 */
const OPTIONS_ASK = /(可选的?下一步|下一步(怎么|做什么|有哪些|该)|有哪几种|哪几种做法|几种做法|几个方案|几套方案|列几个|几条路|给我几个|有哪些选择|有什么选择|备选)/;
/**
 * 差距、完成度、节奏、截止、推算，以及要「画出来」「直观看」的路线图、排期、阶段，和组织、因果链、矩阵、流程、关系图这类结构：图表块与公式的场景。
 * 「画」只认画出来 / 画一下 / 画个 / 画张 / 画成 / 画图这几种说法，「客户画像」「刻画」不算。
 */
const CHART_ASK = /(差距|差多少|差了多少|还差|缺口|完成度|完成率|达成|达不成|能不能完成|来得及|来不及|节奏|进度|每(个)?月(要|需要|得)|月均|增速|增量|推算|测算|算一下|算算|时间(线|节点|表|轴)|节点|里程碑|截止|到期|deadline|公式|路线图|规划图|路径图|示意图|图示|可视化|直观|甘特|排期|roadmap|演进|阶段划分|矩阵|因果链|关系图|流程图|架构图|结构图|组织图|拓扑图|脑图|鱼骨图|(?<![刻描勾])画(出来|一下|个(?!像)|张|一张|成|图))/i;

/** 本轮意图：只看一号位这一轮说的话（去掉页面上下文与附件）和引用；triage 是本轮分诊结果（可选，见 routeTurn 的 visual）。 */
export function promptIntents(message: string, triage?: { visual?: boolean }): PromptIntents {
  const text = message.split(/\n\n\[附件 /)[0].replace(/^【页面】[^\n]*\n+/u, "");
  const decision = DECISION_ASK.test(text);
  return {
    decision,
    options: decision || OPTIONS_ASK.test(text),
    // 要不要出图 = 正则命中 || 分诊判要出图；分诊失败、超时或没跑时只看正则。
    chart: CHART_ASK.test(text) || triage?.visual === true,
    planReview: /"objectType"\s*:\s*"monthly-plan"|plan-review|plan-rewrite/.test(text),
  };
}

/** 本轮带哪些工具。 */
export function toolAllowed(name: string, shape: Pick<PromptShape, "tier" | "writeIntent">): boolean {
  if (shape.tier === "quick" && EXTERNAL_SEARCH_TOOLS.has(name)) return false;
  if (!shape.writeIntent && DIRECT_WRITE_TOOLS.has(name)) return false;
  return true;
}

function removeBlock(prompt: string, block: string): string {
  return prompt.includes(block) ? prompt.replace(`\n\n${block}`, "").replace(block, "") : prompt;
}

/** 不带图表块完整规则时留的一句能力说明（各档都有）：模型自己判断该出图时知道有这两种块；完整写法只在需要时拼进去。 */
export const RICH_BLOCK_BRIEF = "要直观展示排期、多条主线或指标对比时，可写 timeline、roadmap、metric-compare 代码块。";

/**
 * 按档位、页面和意图拼接系统提示。full 是该角色的完整提示（CEO、DRI 都可以）；
 * situational 是 full 里只在特定场景用到的段落（月度计划逐段评审、材料改写）。
 * 找不到的段落不处理，不报错。
 */
export function tierSystemPrompt(full: string, shape: PromptShape,
  situational: { planReview?: string; materials?: string } = {}): string {
  let prompt = full;
  const intents = shape.intents ?? { decision: true, options: true, chart: true, planReview: true };
  if (situational.planReview && !intents.planReview) prompt = removeBlock(prompt, situational.planReview);
  if (situational.materials && shape.materials === false) prompt = removeBlock(prompt, situational.materials);
  if (shape.tier === "quick") {
    const start = prompt.indexOf(EVIDENCE_HEADING);
    const end = prompt.indexOf(STYLE_HEADING, start);
    if (start >= 0 && end > start) prompt = `${prompt.slice(0, start)}${QUICK_EVIDENCE_PROMPT}\n\n${prompt.slice(end)}`;
    for (const line of WEB_TOOL_LINES) prompt = prompt.replace(line, "");
    for (const block of [DECISION_JUDGEMENT_RULES, ANSWER_OPTIONS_RULES]) prompt = removeBlock(prompt, block);
    // 快答档：本轮明确要出图（正则或分诊）才带完整图表规则，否则只留一句能力说明。
    if (!shape.intents?.chart) prompt = prompt.replace(RICH_BLOCK_RULES, RICH_BLOCK_BRIEF);
  } else {
    if (!intents.decision) prompt = removeBlock(prompt, DECISION_JUDGEMENT_RULES);
    if (!intents.chart) prompt = prompt.replace(RICH_BLOCK_RULES, RICH_BLOCK_BRIEF);
    if (!intents.options && !intents.decision) prompt = removeBlock(prompt, ANSWER_OPTIONS_RULES);
  }
  if (shape.anthropic) prompt = `${prompt}\n\n${THINK_IN_CHINESE}`;
  return prompt;
}
