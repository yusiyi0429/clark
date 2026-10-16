import { describe, expect, it, vi } from "vitest";
import {
  TIER_GUIDANCE, TIER_SETTINGS, TRIAGE_PROMPT, chartOnly, cleanTopic, createResponsesThinkingTranslator, createResponsesThoughtTranslator, createResponsesTriage, fallbackModelFor, deepNotice, parsePartialTriage, parseTriage, routeTurn, ruleTier, toolProgressLabel, withNotice,
  type TriageFn,
} from "../src/conversationRouting.js";
import { CONVERSATION_WRITING_STYLE, HUMAN_WRITING_STYLE } from "../src/promptStyle.js";
import { DECISION_JUDGEMENT_RULES } from "../src/decisionJudgement.js";
import { SYSTEM_PROMPT, driSystemPrompt } from "../src/piConversationRuntime.js";
import { createPreflightThoughtTranslator } from "../src/preflightAgent.js";

const signal = () => new AbortController().signal;
const D1 = "市场上近期和我们集团业务相类似的系统化 Token 工厂，代表企业的发展近况，以及近况背后的市场判断，对集团未来策略有什么影响？";
const D2 = "有传闻硅基流动和无问芯穹近期都有递表，但近期又做了两笔比较大的融资，背后的原因是什么？";
const ENVIRONMENT_WORDS = /演示|本场|场次|(?<![A-Za-z])demo(?![A-Za-z])/i;

describe("对话分档：本地规则", () => {
  it("快答：寒暄、明确的修改与选择、只问本系统里的状态", () => {
    for (const text of ["好的", "谢谢", "选择：先补首项目底稿", "把会议改到 11 点", "负责人改成周宁", "词元云集的长期目标是什么", "这周待决策的议题有几个",
      "【页面】正在讨论战场「AIDC」（AIDC，战场id=aidc）\n\n这个战场的负责人是谁"]) {
      expect(ruleTier(text), text).toBe("quick");
    }
  });

  it("带判断意味、或要查外部事实的问法不算快答", () => {
    expect(ruleTier("词元云集春节前的长期目标能否达成，最大的风险是什么？")).toBeNull();
    expect(ruleTier("硅基流动最近一次融资是什么时候、融了多少？")).toBeNull();
    expect(ruleTier("Fireworks AI 和 Together AI 目前的主要产品和定价方式有什么不同？")).toBeNull();
  });

  it("深度：战略对象加上要深入判断的问法，或明确要求深度分析", () => {
    expect(ruleTier(D1)).toBe("deep");
    expect(ruleTier(D2)).toBe("deep");
    expect(ruleTier("从目前 Token 市场供需状况出发往前预判，AIDC 和词元应该关注哪些点，如何定义更有商业合理性的价值模式？")).toBe("deep");
    expect(ruleTier("帮我深度分析一下 AIDC 首项目")).toBe("deep");
    // 只问一个融资事实，不算深度。
    expect(ruleTier("硅基流动 C 轮融了多少")).not.toBe("deep");
  });
});

describe("对话分档：分诊与回落", () => {
  it("规则判快答时不叫分诊", async () => {
    let called = 0;
    const route = await routeTurn({ message: "这周待决策的议题有几个", signal: signal(), triage: async () => { called += 1; return { tier: "deep" }; } });
    expect(route).toMatchObject({ tier: "quick", source: "rule", thinkingLevel: "off" });
    expect(route.notice).toBeUndefined();
    expect(called).toBe(0);
  });

  it("分诊判深度：思考 high、开场说明带判断对象，不写用时", async () => {
    const route = await routeTurn({ message: D1, signal: signal(), triage: async () => ({ tier: "deep", topic: "Token 工厂赛道格局与集团定位" }) });
    expect(route).toMatchObject({ tier: "deep", source: "model", thinkingLevel: "high", timeoutMs: 180_000 });
    expect(route.notice).toBe("这个问题涉及Token 工厂赛道格局与集团定位的战略判断，需要更深入地查证和推演。");
  });

  it("只有很重要的战略问题才走深度：规则判深度时分诊可以降为检索问答，但不降到快答", async () => {
    expect((await routeTurn({ message: D2, signal: signal(), triage: async () => ({ tier: "grounded" }) })).tier).toBe("grounded");
    expect((await routeTurn({ message: D2, signal: signal(), triage: async () => ({ tier: "quick" }) })).tier).toBe("grounded");
    // 明确要求深度分析的，分诊不能改。
    expect((await routeTurn({ message: "请深入分析无问芯穹的融资节奏", signal: signal(), triage: async () => ({ tier: "grounded" }) })).tier).toBe("deep");
  });

  it("分诊失败、超时、输出不合规：不卡住整轮，回落到规则结果或检索问答档", async () => {
    const failing: TriageFn = async () => { throw new Error("gateway 500"); };
    const hanging: TriageFn = ({ signal: abort }) => new Promise((_resolve, reject) => abort.addEventListener("abort", () => reject(new Error("aborted"))));
    const invalid: TriageFn = async () => ({ tier: "unknown" as never });
    const question = "Fireworks AI 和 Together AI 目前的主要产品和定价方式有什么不同？";
    expect(await routeTurn({ message: question, signal: signal(), triage: failing })).toMatchObject({ tier: "grounded", source: "fallback", thinkingLevel: "low" });
    const started = Date.now();
    expect(await routeTurn({ message: question, signal: signal(), triage: hanging, timeoutMs: 30 })).toMatchObject({ tier: "grounded", source: "fallback" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await routeTurn({ message: question, signal: signal(), triage: invalid })).toMatchObject({ tier: "grounded", source: "fallback" });
    // 规则已判深度、分诊挂了：按深度走，开场说明用通用说法。
    const deep = await routeTurn({ message: D1, signal: signal(), triage: hanging, timeoutMs: 30 });
    expect(deep).toMatchObject({ tier: "deep", source: "rule" });
    expect(deep.notice).toBe(deepNotice());
    // 没配分诊：规则定不了的走检索问答。
    expect(await routeTurn({ message: question, signal: signal() })).toMatchObject({ tier: "grounded", source: "fallback" });
  });

  it("只要一张图或表：最高到检索问答档，分诊判深度也压到检索问答；同时要判断的仍走深度", async () => {
    const chartAsks = ["把三个战场按机会和风险做个对比矩阵", "画一下词元云集今年的路线图", "列个时间线，把 AIDC 首项目的关键节点排出来", "帮我画出三个战场的组织关系图"];
    const judgeAsks = ["画个三个战场的对比矩阵并告诉我先投哪个", "三个战场里哪个最需要一号位本月介入，为什么", "做一张对比表，说说哪个战场最需要介入", "画出 Token 工厂赛道的因果链，并给出集团应该怎么应对的建议"];
    for (const text of chartAsks) {
      expect(chartOnly(text), text).toBe(true);
      expect(ruleTier(text), text).not.toBe("deep");
      const route = await routeTurn({ message: text, signal: signal(), triage: async () => ({ tier: "deep", topic: "三个战场机会与风险" }) });
      expect(route, text).toMatchObject({ tier: "grounded", source: "model", visual: true });
      // 分诊挂了也不进深度
      expect((await routeTurn({ message: text, signal: signal(), triage: async () => { throw new Error("gateway 500"); } })).tier, text).not.toBe("deep");
    }
    for (const text of judgeAsks) {
      expect(chartOnly(text), text).toBe(false);
      expect((await routeTurn({ message: text, signal: signal(), triage: async () => ({ tier: "deep" }) })).tier, text).toBe("deep");
    }
    // 跨战场的判断题照旧由规则定深度、分诊不能降档
    expect((await routeTurn({ message: judgeAsks[1], signal: signal(), triage: async () => ({ tier: "grounded" }) })).tier).toBe("deep");
    expect(TRIAGE_PROMPT).toMatch(/只要一张图或表.*最高写 grounded.*先投哪个.*deep/);
  });

  it("分诊输出解析：取第一段 JSON，档位不合规时丢弃", () => {
    expect(parseTriage('{"tier":"deep","topic":"资本动作背后的逻辑"}')).toEqual({ tier: "deep", topic: "资本动作背后的逻辑" });
    expect(parseTriage('好的\n{"tier":"grounded","topic":""}')).toEqual({ tier: "grounded" });
    expect(parseTriage('{"tier":"maybe"}')).toBeNull();
    expect(parseTriage("不是 JSON")).toBeNull();
  });

  it("分诊同时判断要不要出图（visual）：解析、半截输出、路由结果都带上；分诊失败时没有", async () => {
    expect(TRIAGE_PROMPT).toContain('"visual":false');
    expect(TRIAGE_PROMPT).toMatch(/visual：.*路线图.*true.*画像.*false/);
    expect(parseTriage('{"tier":"grounded","visual":true,"topic":"词元云集路线图"}')).toEqual({ tier: "grounded", visual: true, topic: "词元云集路线图" });
    expect(parseTriage('{"tier":"grounded","visual":false,"topic":"负责人"}')).toEqual({ tier: "grounded", topic: "负责人" });
    expect(parseTriage('{"tier":"grounded","visual":"yes"}')).toEqual({ tier: "grounded" });
    expect(parsePartialTriage('{"tier":"grounded","visual":true,"topic":"三个战场推进节奏","battlefields":["t')).toEqual({ tier: "grounded", visual: true, topic: "三个战场推进节奏" });
    const question = "帮我直观看一下三个战场的推进安排";
    expect(await routeTurn({ message: question, signal: signal(), triage: async () => ({ tier: "grounded", visual: true }) })).toMatchObject({ tier: "grounded", visual: true });
    expect((await routeTurn({ message: question, signal: signal(), triage: async () => ({ tier: "grounded" }) })).visual).toBeUndefined();
    expect((await routeTurn({ message: question, signal: signal(), triage: async () => { throw new Error("gateway 500"); } })).visual).toBeUndefined();
    expect((await routeTurn({ message: "请深入分析无问芯穹的融资节奏", signal: signal(), triage: async () => ({ tier: "grounded", visual: true }) }))).toMatchObject({ tier: "deep", visual: true });
  });

  it("分诊请求：快模型、关思考、只发提问本身，key 只在请求头", async () => {
    const seen: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
      const events = ['{"type":"response.output_text.delta","delta":"{\\"tier\\":\\"deep\\","}', '{"type":"response.output_text.delta","delta":"\\"topic\\":\\"赛道格局\\"}"}'];
      return new Response(events.map((data) => `data: ${data}\n\n`).join(""), { status: 200 });
    }) as unknown as typeof fetch;
    const triage = createResponsesTriage({ baseUrl: "https://gateway.test/v2/llm/responses", apiKey: "test-key", modelId: "fast-model", fetch: fakeFetch });
    expect(await triage({ message: "问题", signal: signal() })).toEqual({ tier: "deep", topic: "赛道格局" });
    expect(seen[0].url).toBe("https://gateway.test/v2/llm/responses");
    expect(seen[0].body).toMatchObject({ model: "fast-model", reasoning: { effort: "none" }, instructions: TRIAGE_PROMPT });
    expect(JSON.stringify(seen[0].body)).not.toContain("test-key");
    expect(seen[0].auth).toBe("Bearer test-key");
  });
});

describe("深度档的开场说明", () => {
  it("正式克制：不称呼、不出现运行环境字眼，只说要做什么，不写用时（用时只在进度行）", () => {
    for (const notice of [deepNotice(), deepNotice("资本动作背后的逻辑")]) {
      expect(notice).toMatch(/需要更深入地查证和推演。$/);
      expect(notice).not.toMatch(/预计|分钟|秒/);
      expect(notice).not.toMatch(/王总|您好|领导/);
      expect(notice).not.toMatch(ENVIRONMENT_WORDS);
    }
  });

  it("分诊给的判断对象不合规就不用", () => {
    expect(cleanTopic("「资本动作背后的逻辑」")).toBe("资本动作背后的逻辑");
    expect(cleanTopic("王总关心的融资问题")).toBeUndefined();
    // 上限 10/13 起从 24 字放宽到 40 字（deepseek 分诊给的对象常在 20–33 字）。
    expect(cleanTopic("一段很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的描述性文字")).toBeUndefined();
    expect(cleanTopic("赛道：格局")).toBeUndefined();
    expect(cleanTopic(42)).toBeUndefined();
    expect(cleanTopic(["演", "示"].join("") + "里的议题")).toBeUndefined();
  });

  it("存进记录时开场说明在前、空一行接正文", () => {
    expect(withNotice("开场。", "正文")).toBe("开场。\n\n正文");
    expect(withNotice(undefined, "正文")).toBe("正文");
    expect(withNotice("开场。", "")).toBe("开场。");
  });
});

describe("档位设置与进度文案", () => {
  it("快答关思考 / 检索问答 low / 深度 high；档位用时只用于升级提示估算，不截断回答", () => {
    expect(TIER_SETTINGS.quick.thinkingLevel).toBe("off");
    expect(TIER_SETTINGS.grounded).toMatchObject({ thinkingLevel: "low", timeoutMs: 120_000 });
    expect(TIER_SETTINGS.deep).toMatchObject({ thinkingLevel: "high", timeoutMs: 180_000 });
    for (const guidance of Object.values(TIER_GUIDANCE)) expect(guidance).not.toMatch(ENVIRONMENT_WORDS);
  });

  it("进度只写在查什么，不写工具名", () => {
    expect(toolProgressLabel("web_search", { query: "硅基流动 递表" })).toBe("检索公开来源「硅基流动 递表」");
    expect(toolProgressLabel("get_passages", {})).toBe("阅读企业知识原文");
    expect(toolProgressLabel("unknown_tool", {})).toBeUndefined();
  });
});

describe("对话提示词不再强制列点（10/13 验收：格式僵化）", () => {
  it("对话的风格段没有「两个以上要点一律加粗列点」，并按问题选回答形状", () => {
    expect(CONVERSATION_WRITING_STYLE).not.toContain("用要点列表，每条写成");
    expect(CONVERSATION_WRITING_STYLE).not.toContain("避免大段自然语言");
    for (const shape of ["直答", "对标比较", "深度分析", "决策评估", "段落是默认写法"]) expect(CONVERSATION_WRITING_STYLE).toContain(shape);
    for (const prompt of [SYSTEM_PROMPT, driSystemPrompt("周宁")]) {
      expect(prompt).toContain(CONVERSATION_WRITING_STYLE);
      expect(prompt).not.toContain("加粗的核心结论或待判断的问题");
      expect(prompt).not.toContain("核心结论或待判断的问题**：解释」逐条写");
    }
  });

  it("候选 Agent 的短字段规则不变", () => {
    expect(HUMAN_WRITING_STYLE).toContain("每条写成「- **加粗的核心结论或待判断的问题**：解释」");
  });

  it("六节只在明确要求评估某项具体决策时使用，没有内容的节合并或省略", () => {
    expect(DECISION_JUDGEMENT_RULES).toContain("只在 CEO 明确要求评估一项具体的待决事项时使用这个结构");
    expect(DECISION_JUDGEMENT_RULES).toContain("问能否达成、风险在哪、为什么、怎么看、对集团有什么影响");
    expect(DECISION_JUDGEMENT_RULES).toContain("并入相邻一节或省略");
    expect(DECISION_JUDGEMENT_RULES).not.toContain("写「缺」");
  });
});

describe("分诊与思考翻译：快模型出错时改用备用模型再试一次", () => {
  const sse = (...deltas: string[]) => new Response(deltas.map((delta) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`).join(""), { status: 200 });
  /** 按模型 id 给出响应；记下每次请求的模型。 */
  const gateway = (byModel: Record<string, () => Response | Promise<Response>>) => {
    const models: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const model = String(JSON.parse(String(init.body)).model);
      models.push(model);
      return byModel[model]();
    }) as unknown as typeof fetch;
    return { models, fakeFetch };
  };
  const base = { baseUrl: "https://gateway.test/v2/llm", apiKey: "test-key", modelId: "deepseek-v4.1-flash", fallbackModelId: "gpt-5.6-terra" };
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const terraOk = () => sse('{"tier":"grounded","topic":"融资节奏"}');

  it("DeepSeek 返回 4xx、5xx、网络错误、JSON 解析不出来时，用 terra 再分诊一次", async () => {
    const warn = quiet();
    try {
      for (const failure of [
        () => new Response("bad request", { status: 400 }),
        () => new Response("upstream", { status: 503 }),
        () => { throw new TypeError("fetch failed"); },
        () => sse("好的，我来判断一下"),
      ]) {
        const { models, fakeFetch } = gateway({ "deepseek-v4.1-flash": failure, "gpt-5.6-terra": terraOk });
        const triage = createResponsesTriage({ ...base, fetch: fakeFetch });
        expect(await triage({ message: "问题", signal: signal() })).toEqual({ tier: "grounded", topic: "融资节奏" });
        expect(models).toEqual(["deepseek-v4.1-flash", "gpt-5.6-terra"]);
      }
      expect(warn.mock.calls.every(([line]) => !String(line).includes("test-key"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("DeepSeek 正常就不调 terra；没配备用模型或备用与主模型相同时不重试", async () => {
    const ok = gateway({ "deepseek-v4.1-flash": () => sse('{"tier":"deep","topic":"赛道格局"}'), "gpt-5.6-terra": terraOk });
    expect(await createResponsesTriage({ ...base, fetch: ok.fakeFetch })({ message: "问题", signal: signal() })).toMatchObject({ tier: "deep" });
    expect(ok.models).toEqual(["deepseek-v4.1-flash"]);
    for (const fallbackModelId of [undefined, "deepseek-v4.1-flash"]) {
      const failing = gateway({ "deepseek-v4.1-flash": () => new Response("", { status: 500 }), "gpt-5.6-terra": terraOk });
      expect(await createResponsesTriage({ ...base, fallbackModelId, fetch: failing.fakeFetch })({ message: "问题", signal: signal() })).toBeNull();
      expect(failing.models).toEqual(["deepseek-v4.1-flash"]);
    }
  });

  it("剩余时限不够就不重试，交给原来的超时退回", async () => {
    const warn = quiet();
    try {
      // 整体时限只剩 1 秒（少于 2 秒）：不再调 terra
      const failing = gateway({ "deepseek-v4.1-flash": () => new Response("", { status: 502 }), "gpt-5.6-terra": terraOk });
      expect(await createResponsesTriage({ ...base, timeoutMs: 1_000, fetch: failing.fakeFetch })({ message: "问题", signal: signal() })).toBeNull();
      expect(failing.models).toEqual(["deepseek-v4.1-flash"]);
      // 调用方已经中断（整体超时、取消）：也不重试
      const aborted = new AbortController();
      const hanging = gateway({
        "deepseek-v4.1-flash": () => new Promise<Response>((_resolve, reject) => aborted.signal.addEventListener("abort", () => reject(new Error("aborted")))),
        "gpt-5.6-terra": terraOk,
      });
      const pending = createResponsesTriage({ ...base, fetch: hanging.fakeFetch })({ message: "问题", signal: aborted.signal });
      aborted.abort();
      expect(await pending).toBeNull();
      expect(hanging.models).toEqual(["deepseek-v4.1-flash"]);
      // 判断「还够不够」：整体 5 秒，已过 3.5 秒就不够（还剩 1.5 秒 < 2 秒），已过 2.5 秒就够
      const live = new AbortController().signal;
      const at = (elapsed: number) => fallbackModelFor(base, { signal: live, startedAt: 0, budgetMs: 5_000, minRemainingMs: 2_000, what: "分诊", now: () => elapsed });
      expect(at(3_500)).toBeUndefined();
      expect(at(2_500)).toBe("gpt-5.6-terra");
    } finally {
      warn.mockRestore();
    }
  });

  it("分诊重试仍在 routeTurn 的 5 秒整体时限内：DeepSeek 失败、terra 给出档位，按模型结果走", async () => {
    const warn = quiet();
    try {
      const { models, fakeFetch } = gateway({ "deepseek-v4.1-flash": () => new Response("", { status: 503 }), "gpt-5.6-terra": terraOk });
      const route = await routeTurn({ message: "硅基流动最近一次融资是什么时候、融了多少？", signal: signal(), triage: createResponsesTriage({ ...base, fetch: fakeFetch }) });
      expect(route).toMatchObject({ tier: "grounded", source: "model" });
      expect(models).toEqual(["deepseek-v4.1-flash", "gpt-5.6-terra"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("思考要点翻译失败一句，就用 terra 重译这一句（对话与预审两处）", async () => {
    const warn = quiet();
    try {
      const { models, fakeFetch } = gateway({ "deepseek-v4.1-flash": () => new Response("", { status: 500 }), "gpt-5.6-terra": () => sse("核对融资时间线") });
      expect(await createResponsesThoughtTranslator({ ...base, fetch: fakeFetch })("Checking the funding timeline", signal())).toBe("核对融资时间线");
      expect(models).toEqual(["deepseek-v4.1-flash", "gpt-5.6-terra"]);
      const json = (text: string) => () => new Response(JSON.stringify({ output_text: text }), { status: 200 });
      const preflight = gateway({ "deepseek-v4.1-flash": () => { throw new TypeError("fetch failed"); }, "gpt-5.6-terra": json("核对材料口径") });
      expect(await createPreflightThoughtTranslator({ ...base, fetch: preflight.fakeFetch })("Checking the material", signal())).toBe("核对材料口径");
      expect(preflight.models).toEqual(["deepseek-v4.1-flash", "gpt-5.6-terra"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("思考段落翻译失败一段，就用 terra 重译这一段；已经上屏了半段译文就不重译，免得接不上", async () => {
    const warn = quiet();
    try {
      const { models, fakeFetch } = gateway({ "deepseek-v4.1-flash": () => new Response("", { status: 429 }), "gpt-5.6-terra": () => sse("先核对", "融资时间线。") });
      const deltas: string[] = [];
      expect(await createResponsesThinkingTranslator({ ...base, fetch: fakeFetch })("Let me check the funding timeline.", signal(), (delta) => deltas.push(delta)))
        .toBe("先核对融资时间线。");
      expect(deltas.join("")).toBe("先核对融资时间线。");
      expect(models).toEqual(["deepseek-v4.1-flash", "gpt-5.6-terra"]);

      // 半段之后断流：保留已上屏的部分，不调 terra
      const broken = () => {
        let pulls = 0;
        return new Response(new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "先核对" })}\n\n`));
            else controller.error(new Error("socket hang up"));
          },
        }), { status: 200 });
      };
      const half = gateway({ "deepseek-v4.1-flash": broken, "gpt-5.6-terra": () => sse("另一种译法。") });
      const halfDeltas: string[] = [];
      expect(await createResponsesThinkingTranslator({ ...base, fetch: half.fakeFetch })("Let me check.", signal(), (delta) => halfDeltas.push(delta))).toBeNull();
      expect(halfDeltas.join("")).toBe("先核对");
      expect(half.models).toEqual(["deepseek-v4.1-flash"]);
    } finally {
      warn.mockRestore();
    }
  });
});
