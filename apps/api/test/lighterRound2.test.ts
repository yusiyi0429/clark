import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { MATERIAL_EDITING_RULES, SYSTEM_PROMPT, createPiConversationRuntime } from "../src/piConversationRuntime.js";
import type { ConversationRuntimeEvent } from "../src/conversations.js";
import { RICH_BLOCK_BRIEF, promptIntents, tierSystemPrompt, type PromptShape } from "../src/conversationPrompt.js";
import {
  TRIAGE_PROMPT, TRIAGE_TIMEOUT_MS, cleanTopic, createResponsesTriage, parsePartialTriage, parseTriage, priorityDeep, routeTurn, ruleTier, type TriageFn,
} from "../src/conversationRouting.js";
import {
  asksAllBattlefields, battlefieldBriefs, focusGlobalContext, mentionedBattlefields, messageQuotes, pageBattlefield, referencedBattlefields, resolveFocus,
} from "../src/conversationFocus.js";
import { ANSWER_OPTIONS_RULES, DECISION_JUDGEMENT_RULES } from "../src/decisionJudgement.js";
import { RICH_BLOCK_RULES } from "../src/richBlocks.js";
import { testEnv } from "./helpers.js";

/**
 * 10/13 第二轮减负：上下文包按问题筛选战场、系统提示把特定场景的规则挪进工具说明并按意图拼接、分诊 5 秒且只有深度档给预取检索词。
 */
const CEO_VIEWER = { personId: "person-fixture-001", displayName: "测试甲", role: "ceo" as const };
const TIERS = { quick: "gpt-5.6-sol", grounded: "claude-sonnet-5-5", deep: "claude-opus-5-5" };
const signal = () => new AbortController().signal;
const usage = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** 三个战场的首页摘要（形状与 globalConversationContext 相同）。 */
const CONTEXT = {
  period: "2026-10",
  company: { ltco: "集团长期方向", version: 1 },
  battlefields: [
    { id: "aidc", code: "AIDC", name: "AIDC", owner: "王丽", sixMonthOutcome: "AIDC 长期目标", monthOutcome: "AIDC 本月目标", missionCount: 0 },
    { id: "tk", code: "TK", name: "词元云集", owner: "刘明华", sixMonthOutcome: "词元云集长期目标", monthOutcome: "词元云集本月目标", missionCount: 0 },
    { id: "fdd", code: "FDD", name: "房懂懂", owner: "陈怀洲", sixMonthOutcome: "房懂懂长期目标", monthOutcome: "房懂懂本月目标", missionCount: 0 },
  ],
  capabilities: [],
  missionCount: 0,
  pendingIssues: [
    { id: "i-aidc", title: "AIDC 首项目目标是否正式化", location: { level: "battlefield", battlefieldId: "aidc" } },
    { id: "i-tk", title: "TokenOps 商业闭环的证据", location: { level: "battlefield", battlefieldId: "tk" } },
    { id: "i-fdd", title: "房懂懂客户数口径", location: { level: "battlefield", battlefieldId: "fdd" } },
    { id: "i-co", title: "集团协同如何认定", location: { level: "company", relatedBattlefieldIds: ["aidc", "tk", "fdd"] } },
  ],
  monthlyPlan: { id: "plan-1", version: 1, status: "draft", companyOutcome: "按战场分别推进", battlefields: [
    { battlefieldId: "aidc", outcome: "AIDC 本月目标" }, { battlefieldId: "tk", outcome: "词元云集本月目标" }, { battlefieldId: "fdd", outcome: "房懂懂本月目标" },
  ] },
  meetings: [],
  battlefieldMissions: [
    { battlefieldId: "fdd", battlefieldName: "房懂懂", missions: [{ id: "m1", code: "M-F1", title: "上线准备", status: "blocked", statusLabel: "受阻" }] },
  ],
  battlefieldProgress: [
    { battlefieldId: "tk", battlefieldName: "词元云集", period: "2026-09", 问题: ["灯塔项目延期（2026-09；出处：9 月复盘）"] },
  ],
};
const BRIEFS = battlefieldBriefs(CONTEXT);

function reply(model: Model<any>, parts: { text?: string; tool?: { id: string; name: string; arguments: Record<string, unknown> } }): AssistantMessageEventStream {
  const tail = parts.tool ? { type: "toolCall" as const, ...parts.tool } : { type: "text" as const, text: parts.text ?? "好" };
  const final: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [tail], usage,
    stopReason: parts.tool ? "toolUse" : "stop", timestamp: Date.now() };
  const events = createAssistantMessageEventStream();
  void (async () => {
    events.push({ type: "start", partial: { ...final, content: [] } });
    if (tail.type === "toolCall") {
      events.push({ type: "toolcall_start", contentIndex: 0, partial: final });
      events.push({ type: "toolcall_end", contentIndex: 0, toolCall: tail, partial: final });
      events.push({ type: "done", reason: "toolUse", message: final });
    } else {
      events.push({ type: "text_start", contentIndex: 0, partial: final });
      events.push({ type: "text_delta", contentIndex: 0, delta: tail.text, partial: final });
      events.push({ type: "text_end", contentIndex: 0, content: tail.text, partial: final });
      events.push({ type: "done", reason: "stop", message: final });
    }
  })();
  return events;
}
const lastUserText = (context: Context) => {
  const last = [...context.messages].reverse().find((message) => message.role === "user");
  if (typeof last?.content === "string") return last.content;
  return (last?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
};

async function conversation(options: { triage?: TriageFn; respond?: (model: Model<any>, context: Context, index: number) => AssistantMessageEventStream }) {
  const seen: { model: Model<any>; context: Context }[] = [];
  const runtime = await createPiConversationRuntime({
    companyMemory: loadCompanyMemory(testEnv), baseUrl: "https://gw.invalid/v2/llm/responses", apiKey: "test-key",
    modelId: TIERS.quick, tierModels: TIERS, compactionModelId: "fake-compaction", triage: options.triage,
    globalContext: async () => structuredClone(CONTEXT), listBattlefields: async () => BRIEFS,
    streamSimple: (model, context) => {
      seen.push({ model, context });
      return options.respond ? options.respond(model, context, seen.length - 1) : reply(model, { text: "好" });
    },
  });
  const turn = async (message: string, extra: { references?: unknown[] } = {}) => {
    const events: ConversationRuntimeEvent[] = [];
    const result = await runtime.run({ scope: "global", viewer: CEO_VIEWER, message, currentObject: null, referencesSnapshot: (extra.references ?? []) as never,
      runtimeEntries: [], piSessionId: "44444444-4444-4444-8444-444444444444", signal: signal(), emit: (event) => events.push(event) });
    return { result, events };
  };
  return { seen, turn, runtime };
}
const firstContext = (seen: { context: Context }[]) => JSON.parse(lastUserText(seen[0].context)).globalContext as Record<string, unknown>;

describe("上下文包按问题筛选战场", () => {
  it("规则：页面、引用、点名、分诊给的战场展开；问集团整体或分诊说全部时全量；判断不出时全量；分诊说不针对战场时检索问答只给摘要、深度档全量", () => {
    const focus = (message: string, triage: "all" | string[] | undefined, tier: "quick" | "grounded" | "deep" = "grounded", pinned: string[] = []) =>
      resolveFocus({ message, tier, triage, briefs: BRIEFS, pinned });
    expect(focus("词元云集的长期目标是什么", undefined, "quick")).toEqual(["tk"]);
    expect(focus("TK 这个月卡在哪", undefined)).toEqual(["tk"]);
    expect(focus("词元云集和房懂懂哪个更急", undefined, "quick")).toEqual(["tk", "fdd"]);
    expect(focus("三个战场里哪个最需要一号位本月介入，为什么？", ["tk"])).toBe("all");
    expect(focus("这个月最该关注什么", "all")).toBe("all");
    expect(focus("这周待决策的议题有几个", undefined, "quick")).toBe("all");
    expect(focus("硅基流动最近一次融资是什么时候？", [])).toEqual([]);
    expect(focus("硅基流动为什么连续融资？", [], "deep")).toBe("all");
    expect(focus("它的风险在哪", ["房懂懂"])).toEqual(["fdd"]);
    expect(focus("这里的风险在哪", [], "grounded", ["aidc"])).toEqual(["aidc"]);
    expect(focus("AIDC、词元云集、房懂懂分别怎么样", undefined)).toBe("all");
    // 英文编号按词边界：「tkos」不算点名词元云集
    expect(mentionedBattlefields("TKOS 部署进度", BRIEFS)).toEqual([]);
    expect(asksAllBattlefields("对集团未来策略有什么影响")).toBe(true);
  });

  it("页面上下文、引用卡片、消息里的引用块都能定位战场；引用的议题按它所在的战场", () => {
    expect(pageBattlefield("【页面】正在讨论战场「房懂懂」（FDD，战场id=fdd）\n\n这个月卡在哪")).toBe("fdd");
    const known = new Set(BRIEFS.map((item) => item.id));
    expect(referencedBattlefields([{ objectRef: { type: "battlefield", id: "aidc" } }], known)).toEqual(["aidc"]);
    expect(referencedBattlefields([{ payload: { location: { level: "battlefield", battlefieldId: "tk" } } }], known)).toEqual(["tk"]);
    const quoted = "[天枢引用上下文 v1]\n" + JSON.stringify({ message: "这条怎么看", quotes: [{ text: "客户数口径", source: { objectType: "issue", objectId: "i-fdd" } }] });
    expect(referencedBattlefields([messageQuotes(quoted)], known, (id) => (id === "i-fdd" ? "fdd" : undefined))).toEqual(["fdd"]);
  });

  it("筛选：只展开相关战场，其余战场一行（名称、状态、待决议题数）；议题、战役、进展按战场筛，公司级议题保留；月度计划不重复各战场本月目标", () => {
    const scoped = focusGlobalContext(CONTEXT, ["tk"]);
    expect((scoped.battlefields as { id: string }[]).map((item) => item.id)).toEqual(["tk"]);
    expect(scoped.otherBattlefields).toEqual(["AIDC（id=aidc）：未登记状态灯；待决议题 1 项", "房懂懂（id=fdd）：战役 1 个（受阻 1）；待决议题 1 项"]);
    expect((scoped.pendingIssues as { id: string }[]).map((item) => item.id)).toEqual(["i-tk", "i-co"]);
    expect(scoped.focus).toEqual({ expanded: ["词元云集"], pendingIssueTotal: 4 });
    expect(scoped.battlefieldMissions).toEqual([]);
    expect(scoped.battlefieldProgress).toHaveLength(1);
    expect((scoped.monthlyPlan as Record<string, unknown>).battlefields).toBeUndefined();
    expect((scoped.monthlyPlan as Record<string, unknown>).companyOutcome).toBe("按战场分别推进");
    const full = focusGlobalContext(CONTEXT, "all");
    expect(full.battlefields).toEqual(CONTEXT.battlefields);
    expect(full.pendingIssues).toEqual(CONTEXT.pendingIssues);
    expect(full).not.toHaveProperty("focus");
    expect(JSON.stringify(full).length).toBeLessThan(JSON.stringify(CONTEXT).length);
    expect(JSON.stringify(scoped).length).toBeLessThan(JSON.stringify(full).length);
  });

  it("运行时：分诊给的战场决定上下文包；分诊拿到战场清单；分诊失败退回全量；漏带的战场可以用 get_warmap_overview 按 battlefieldId 补读", async () => {
    const seenTriage: Parameters<TriageFn>[0][] = [];
    const triage: TriageFn = async (input) => { seenTriage.push(input); return { tier: "grounded", topic: "房懂懂的卡点", battlefields: ["fdd"] }; };
    const chat = await conversation({ triage, respond: (model, _context, index) => (index === 0
      ? reply(model, { tool: { id: "call-1", name: "get_warmap_overview", arguments: { battlefieldId: "tk" } } })
      : reply(model, { text: "好" })) });
    try {
      await chat.turn("这个月最需要盯的卡点是什么，原因呢？");
      expect(seenTriage[0].battlefields).toEqual(BRIEFS);
      const context = firstContext(chat.seen);
      expect(context.focus).toEqual({ expanded: ["房懂懂"], pendingIssueTotal: 4 });
      expect((context.battlefields as { id: string }[]).map((item) => item.id)).toEqual(["fdd"]);
      expect(context.otherBattlefields).toHaveLength(2);
      // 补读：get_warmap_overview(battlefieldId=tk) 完整返回词元云集
      const toolResult = chat.seen[1].context.messages.find((message) => message.role === "toolResult");
      const overview = JSON.parse((toolResult?.content as { text: string }[])[0].text);
      expect(overview.focus.expanded).toEqual(["词元云集"]);
      expect(overview.battlefields[0]).toMatchObject({ id: "tk", sixMonthOutcome: "词元云集长期目标" });
      expect(overview.battlefieldProgress).toHaveLength(1);
      const tool = chat.seen[0].context.tools?.find((item) => item.name === "get_warmap_overview");
      expect(JSON.stringify(tool?.parameters)).toContain("battlefieldId");
    } finally { await chat.runtime.close?.(); }

    const failing = await conversation({ triage: async () => null });
    try {
      await failing.turn("这个月最需要盯的卡点是什么，原因呢？");
      const context = firstContext(failing.seen);
      expect(context).not.toHaveProperty("focus");
      expect((context.battlefields as unknown[]).length).toBe(3);
    } finally { await failing.runtime.close?.(); }
  });

  it("页面所在的战场优先：分诊说不针对战场时仍展开页面战场", async () => {
    const chat = await conversation({ triage: async () => ({ tier: "grounded", topic: "卡点", battlefields: [] }) });
    try {
      await chat.turn("【页面】正在讨论战场「房懂懂」（FDD，战场id=fdd）\n\n这个月卡在哪");
      expect(firstContext(chat.seen).focus).toEqual({ expanded: ["房懂懂"], pendingIssueTotal: 4 });
    } finally { await chat.runtime.close?.(); }
  });
});

describe("系统提示继续压缩：特定场景的规则挪进工具说明，按意图拼接", () => {
  const none = { decision: false, options: false, chart: false, planReview: false };
  // 带全部按场景裁剪段落的完整提示（材料改写、决策六节、图表块、选项块），用来核对裁剪本身。
  const FULL = [SYSTEM_PROMPT, DECISION_JUDGEMENT_RULES, RICH_BLOCK_RULES, ANSWER_OPTIONS_RULES].join("\n\n");
  const prompt = (shape: Partial<PromptShape>) => tierSystemPrompt(FULL,
    { tier: "grounded", writeIntent: false, anthropic: true, intents: none, materials: false, ...shape }, { materials: MATERIAL_EDITING_RULES });

  it("意图判定：评估决策、要方案、问差距和节奏、带月度计划引用", () => {
    expect(promptIntents("这个方案要不要批？")).toMatchObject({ decision: true, options: true });
    expect(promptIntents("给我几个可选的下一步")).toMatchObject({ decision: false, options: true });
    expect(promptIntents("词元云集三条收入线现在离季度目标差多少？剩下的时间每个月要补多少？把从现在到春节前的关键时间节点也列一下，长期目标来得及吗？给我几个可选的下一步。"))
      .toEqual({ decision: false, options: true, chart: true, planReview: false });
    expect(promptIntents("硅基流动最近一次融资是什么时候？")).toEqual(none);
    expect(promptIntents('[天枢引用上下文 v1]\n{"quotes":[{"source":{"objectType": "monthly-plan","intent":"plan-review"}}]}').planReview).toBe(true);
  });

  it("出图意图：路线图、画出来、直观、排期、阶段划分等说法都算，「画像」「刻画」不算；分诊判 visual 也算", () => {
    for (const ask of ["目前词元云集的整个计划规划的路线图能不能画出来我看看", "帮我直观看一下三个战场的推进节奏", "把 10 月到春节的关键节点排一下",
      "给我画个房懂懂的阶段划分", "出一张规划图", "画一下", "画张图", "用图示说明", "来个示意图", "可视化一下收入结构", "做个甘特", "下季度排期",
      "增长路径图", "产品 roadmap", "时间轴", "这条线的演进", "阶段划分是怎样的", "画成时间线",
      "画一下集团和三个子公司、主要负责人的组织关系", "词元云集 9 月目标没达成的因果链画出来", "把三个战场按机会和风险做个对比矩阵", "这件事的审批流程图",
      "集团的组织架构图"]) expect(promptIntents(ask).chart, ask).toBe(true);
    for (const ask of ["词元云集的负责人是谁", "这个客户画像是什么样的", "用户画像怎么定", "刻画一下竞争对手", "硅基流动最近一次融资是什么时候？"])
      expect(promptIntents(ask).chart, ask).toBe(false);
    expect(promptIntents("这个客户画像是什么样的", { visual: true }).chart).toBe(true);
    expect(promptIntents("这个客户画像是什么样的", { visual: false }).chart).toBe(false);
    expect(promptIntents("这个客户画像是什么样的", {}).chart).toBe(false);
  });

  it("不带图表块完整规则时各档都留一句能力说明（40 字以内）；快答档要出图时也带完整规则", () => {
    const chars = [...RICH_BLOCK_BRIEF.replace(/[A-Za-z-]+/g, "W")].length;
    expect(chars).toBeLessThanOrEqual(40);
    for (const tier of ["quick", "grounded", "deep"] as const) {
      const text = prompt({ tier });
      expect(text, tier).toContain(RICH_BLOCK_BRIEF);
      expect(text, tier).not.toContain(RICH_BLOCK_RULES);
      const chart = prompt({ tier, intents: { ...none, chart: true } });
      expect(chart, tier).toContain(RICH_BLOCK_RULES);
      expect(chart, tier).not.toContain(RICH_BLOCK_BRIEF);
    }
    // 快答档没给意图（旧调用方）：留说明，不带完整规则
    expect(tierSystemPrompt(FULL, { tier: "quick", writeIntent: false, anthropic: false })).toContain(RICH_BLOCK_BRIEF);
  });

  it("没有特定意图的检索问答、深度档：不带决策六节、图表块、选项块和材料改写规则；必须保留的约束都在", () => {
    for (const tier of ["grounded", "deep"] as const) {
      const text = prompt({ tier });
      for (const block of [DECISION_JUDGEMENT_RULES, RICH_BLOCK_RULES, ANSWER_OPTIONS_RULES, MATERIAL_EDITING_RULES]) expect(text).not.toContain(block);
      // 不用称呼、正式书面语、不编造、只读边界
      for (const rule of ["不用任何头衔或姓名称呼", "不用客套开场", "董事会材料、投研报告的书面语", "不编造", "你不能执行任何业务写入", "get_warmap_overview"]) expect(text, rule).toContain(rule);
      expect(text.match(/演示|本场|场次|(?<![A-Za-z_/-])demo(?![A-Za-z_-])/i)).toBeNull();
      // Claude 计约 0.9 token/字：6,300 字以内即 6,000 token 以内（10/13 实测 5,577 字计 5,262 token）
      expect(text.length).toBeLessThan(6_300);
    }
  });

  it("按意图带回：评估决策带六节与选项块，问差距和节奏带图表块，有材料工具带材料改写", () => {
    expect(prompt({ intents: { ...none, decision: true, options: true } })).toContain(DECISION_JUDGEMENT_RULES);
    expect(prompt({ intents: { ...none, decision: true, options: true } })).toContain(ANSWER_OPTIONS_RULES);
    expect(prompt({ intents: { ...none, options: true } })).not.toContain(DECISION_JUDGEMENT_RULES);
    expect(prompt({ intents: { ...none, chart: true } })).toContain(RICH_BLOCK_RULES);
    expect(prompt({ materials: true })).toContain(MATERIAL_EDITING_RULES);
    // 不提供意图时保持完整提示（旧调用方）
    expect(tierSystemPrompt(FULL, { tier: "deep", writeIntent: true, anthropic: false })).toContain(RICH_BLOCK_RULES);
  });

});

describe("分诊时限与预取", () => {
  it("时限 5 秒；只有深度档给检索词；输出带涉及的战场", () => {
    expect(TRIAGE_TIMEOUT_MS).toBe(5_000);
    expect(TRIAGE_PROMPT).toContain("memory 与 web 只在 tier 为 deep 时写");
    expect(TRIAGE_PROMPT).toContain("battlefields");
    expect(parseTriage('{"tier":"grounded","topic":"房懂懂客户数","battlefields":["fdd"]}')).toEqual({ tier: "grounded", topic: "房懂懂客户数", battlefields: ["fdd"] });
    expect(parseTriage('{"tier":"deep","topic":"格局","battlefields":"all","memory":["词元云集"],"web":["硅基流动 融资 2026"]}'))
      .toEqual({ tier: "deep", topic: "格局", battlefields: "all", memory: ["词元云集"], web: ["硅基流动 融资 2026"] });
    expect(parseTriage('{"tier":"grounded","topic":"融资","battlefields":[]}')).toEqual({ tier: "grounded", topic: "融资", battlefields: [] });
    expect(parsePartialTriage('{"tier":"grounded","topic":"房懂懂","battlefields":["fdd"],"me')).toEqual({ tier: "grounded", topic: "房懂懂", battlefields: ["fdd"] });
    expect(parsePartialTriage('{"tier":"grounded","topic":"房懂懂","battlefields":["fd')).toEqual({ tier: "grounded", topic: "房懂懂" });
  });

  it("跨战场的比较、排序、取舍与优先级判断题直接定深度，分诊不降档；单战场查状态、改字段、立议题不受影响", async () => {
    for (const text of ["三个战场里哪个最需要一号位本月介入，为什么", "词元云集和房懂懂这个月各自最大的卡点是什么，哪个更急？",
      "AIDC、词元云集、房懂懂这季度的资源应该怎么排优先级？", "这个月我应该先抓哪个战场？", "如果只能保一个，三个战场里保哪个"]) {
      expect(priorityDeep(text), text).toBe(true);
      expect(ruleTier(text), text).toBe("deep");
      const route = await routeTurn({ message: text, signal: signal(), triage: async () => ({ tier: "grounded", topic: "三个战场本月介入的优先级" }) });
      expect(route.tier, text).toBe("deep");
    }
    expect(ruleTier("词元云集的长期目标是什么")).toBe("quick");
    expect(ruleTier("这个事我想变成后续核心的战略议题")).toBe("quick");
    for (const text of ["结合九月复盘看词元的状态", "硅基流动最近一次融资是什么时候、融了多少？", "AIDC 首项目的进展到哪了"]) expect(priorityDeep(text), text).toBe(false);
    expect(TRIAGE_PROMPT).toContain("几个战场之间的比较、排序、取舍");
    // 对象上限放宽：deepseek 给的英文公司名对象常超过 24 字
    expect(cleanTopic("Fireworks AI 与 Together AI 产品定价对比")).toBe("Fireworks AI 与 Together AI 产品定价对比");
    expect(cleanTopic("长".repeat(41))).toBeUndefined();
  });

  it("分诊请求带战场清单；分诊超时的退回路径不变（规则或检索问答档、通用开场句）", async () => {
    const bodies: { input: { content: string }[] }[] = [];
    const fetcher = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      const text = '{"tier":"grounded","topic":"房懂懂客户数","battlefields":["fdd"]}';
      return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`, { status: 200 });
    }) as unknown as typeof fetch;
    const triage = createResponsesTriage({ baseUrl: "https://gw.invalid/v2/llm", apiKey: "k", modelId: "terra", fetch: fetcher });
    const route = await routeTurn({ message: "房懂懂的客户数口径怎么定比较合适？", signal: signal(), triage, battlefields: Promise.resolve(BRIEFS) });
    expect(route).toMatchObject({ tier: "grounded", source: "model", battlefields: ["fdd"] });
    expect(bodies[0].input[0].content).toContain("战场清单：aidc=AIDC；tk=词元云集（TK）；fdd=房懂懂（FDD）");
    const slow: TriageFn = (input) => new Promise((resolve) => { input.signal.addEventListener("abort", () => resolve(null)); });
    const fallback = await routeTurn({ message: "房懂懂的客户数口径怎么定比较合适？", signal: signal(), triage: slow, timeoutMs: 30 });
    expect(fallback).toMatchObject({ tier: "grounded", source: "fallback" });
    expect(fallback.battlefields).toBeUndefined();
    expect(fallback.notice).toContain("需要先查证企业知识和公开来源");
  });
});
