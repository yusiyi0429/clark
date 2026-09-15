/**
 * **一次调用的请求体是怎么拼出来的**：几块内容怎么合、断点落在哪一块上、json 模式那道兜底
 * 补在哪。
 *
 * ## 这一版之前，这个文件记的是一笔明账：缓存断了
 *
 * 2026-08-27 加 `cache_control` 是为了治一件量出来的浪费：写四节那几次每次把同一份材料整包
 * 重发，一轮真运行里 `alt` 的输入是 **349,472 token、cached 一栏全 0**。做法是在「这一轮里
 * 再也不会变的那一段」末尾打一个断点（`ContentPart.cache`），服务端把前缀存下来，后面几次
 * 只按「读缓存」计价。
 *
 * 2026-08-31 换到网宿之后，这里的几条用例改成了断言「断点还在代码里，但落不到线上」——
 * 依据是一句推断：网宿是 OpenAI 兼容口，只认标准字段，`cache_control` 是 Anthropic 的方言，
 * 发过去应该是 400。**那句推断从来没有人去验，而这几条用例忠实地绿了一整天。**
 * 一组绿着的用例记着一笔损失，比没有用例更坏：它让那笔损失看起来是已知且已决的。
 *
 * ## 2026-09-01 三态实测：它是支持的
 *
 * 同一段 9 千 token 的前缀，三次调用：
 *
 *   带断点、前缀第一次    `creation_tokens: 9092`、`ephemeral_5m_input_tokens: 9092`  ← 写进去了
 *   带断点、前缀第二次    `cached_tokens: 9092`                                       ← 读到了
 *   不带断点、同一前缀    `cached_tokens: 0`                                          ← 它是显式的
 *
 * 三条一起才说得出结论：前两条只说明「有缓存」，第三条才排掉「其实是自动前缀缓存、断点白发」。
 * 也就是说这条口**没有**自动前缀缓存 —— 不发断点那 8 万 token 的材料每次按全价重算。
 * 有效期只有 5 分钟（递 `ttl: "1h"` 不报错，实测被静默降级），所以「先写后读」隔了多久是要
 * 算的事，见 `stage-write.ts` 里暖缓存那一段。
 *
 * ## 所以下面几条守的是什么
 *
 * 断点这件事的两种坏法**都没有症状**，只有账单看得出来，所以每一种都要在请求体上钉死：
 *
 *   · **发不出去**（判据写错、块被拼回一整段）→ 每次全价重算，`cachedInputTokens` 恒为 0。
 *     上一版就是这么静默空转的。
 *   · **发错地方**（多发给不认它的口）→ 那不是浪费，是 **400**：`gpt-5.6-sol` 和方舟对不
 *     认识的字段是整次调用失败，不是忽略。
 *
 * 还有第三种，藏在 json 那道兜底里：**前缀被悄悄改掉**。补一句话进已经标了断点的那一块，
 * 等于每次写一份新缓存 —— 比不缓存还贵，而请求体照旧合法、调用照旧成功。
 *
 * 提示词那边「system 段逐字节相同、稳定前缀不掺随节变的字」几条约束（`a4/prompt.ts`，测试在
 * `a4/prompt.test.ts`）是同一件事的上游，一直没动。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * 生产代码里那一次请求走的是 **undici 的 `fetch`**，不是全局的（原因整段写在
 * `complete.ts` 的 `httpFetch` 上：Node 内置 fetch 用的是它自己捆的那份 undici，
 * 递一个外部 `Agent` 给它会当场 `UND_ERR_INVALID_ARG`）。
 *
 * 这里把它转回全局那一个，好让下面所有 `vi.stubGlobal("fetch", …)` 照旧生效 ——
 * 这些用例要验的是**发出去的那一份长什么样**，跟走哪个 fetch 实现无关。
 */
vi.mock("undici", async (importActual) => {
  const actual = await importActual<typeof import("undici")>();
  return {
    ...actual,
    fetch: (...args: unknown[]) =>
      (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
  };
});


/** 每次调用真正发出去的那一份：地址、头、请求体。 */
type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
const sent: Sent[] = [];

/** 一个只记账、恒成功的上游。返回体照 OpenAI 兼容口的形状。 */
const stubFetch = (usage: Record<string, unknown> = {}) => {
  vi.stubGlobal(
    "fetch",
    async (url: string, init: { headers: Record<string, string>; body: string }) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "回来了" }, finish_reason: "stop" }],
          usage,
        }),
      };
    }
  );
};

const KEYS = [
  "ARK_API_KEY",
  "ARK_BASE_URL",
  "WANGSU_API_KEY",
  "WANGSU_BASE_URL",
  "TKOS_MODEL_MOCK",
  "TKOS_COST_TAP",
  "TKOS_MODEL_NO_VERBOSITY",
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  sent.length = 0;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

type Messages = Parameters<typeof import("./complete").callModel>[0]["messages"];

/** 散文那一支：这几条测的是内容怎么拼，别让 json 模式那道兜底掺进来。 */
const call = async (messages: Messages, slot: "alt" | "synth" | "pro") => {
  const { callModel } = await import("./complete");
  return callModel({ slot, messages, maxTokens: 100, json: false });
};

/**
 * **断点落在哪、哪些口一个都不许收。**
 *
 * 一头是浪费（该发的没发，账单上才看得见），另一头是 400（不该发的发了，整条链路当场挂掉）。
 * 两头都没有中间态，所以逐个口钉一遍。
 */
describe("缓存断点落到线上", () => {
  it("网宿上的 Claude：标了 cache 的那一块发成内容块，带 ephemeral", async () => {
    process.env.WANGSU_API_KEY = "wangsu-key";
    stubFetch();
    await call(
      [
        { role: "system", content: "规矩那一段" },
        {
          role: "user",
          content: [
            { text: "这一轮不变的材料", cache: true },
            { text: "这一节自己的证据包" },
          ],
        },
      ],
      "alt"
    );
    expect(sent[0].body.messages).toEqual([
      { role: "system", content: "规矩那一段" },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "这一轮不变的材料",
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: "这一节自己的证据包" },
        ],
      },
    ]);
  });

  it("断点只落在标了的那一块上 —— 打到后面那一块等于每节写一份新缓存", async () => {
    /*
     * 位置错了不会报错，只会变成每次写一份新缓存（比不缓存还贵），唯一看得出来的地方是账单。
     * `stage-write.ts` 那一段注释说的就是这件事，这里是它的机检。
     */
    process.env.WANGSU_API_KEY = "wangsu-key";
    stubFetch();
    await call(
      [{ role: "user", content: [{ text: "稳定前缀", cache: true }, { text: "随节变的" }] }],
      "alt"
    );
    const blocks = (sent[0].body.messages as { content: Record<string, unknown>[] }[])[0].content;
    expect(blocks.map((b) => "cache_control" in b)).toEqual([true, false]);
  });

  it("这条消息没打过断点：形状和从前逐字节相同 —— 请求体不变是命中的前提", async () => {
    /*
     * 换口那一版把「一律拼回一整段」当成了唯一行为，这一条是从那一版留下来的、仍旧该成立的
     * 那一半：**没标 `cache` 的消息一个字节都不该变**。它是三档里的中间那一档 ——
     * 只有它盯着「别顺手把所有消息都改成块数组」。
     */
    process.env.WANGSU_API_KEY = "wangsu-key";
    stubFetch();
    await call([{ role: "user", content: [{ text: "上半" }, { text: "下半" }] }], "alt");
    await call([{ role: "user", content: "上半\n\n下半" }], "alt");
    expect(sent[0].body.messages).toEqual([{ role: "user", content: "上半\n\n下半" }]);
    expect(JSON.stringify(sent[1].body)).toBe(JSON.stringify(sent[0].body));
  });

  it("网宿上的 GPT：一块都不许发 —— 这条口上多一个字段是 400，不是忽略", async () => {
    /*
     * 同一个网关、同一把 key、同一条地址，**只有 Claude 那一族认 `cache_control`**。
     * 判据里那一半家族条件掉了的表现不是少省一点钱，是 `synth` 那条链路整条挂掉。
     */
    process.env.WANGSU_API_KEY = "wangsu-key";
    stubFetch();
    await call(
      [{ role: "user", content: [{ text: "上半", cache: true }, { text: "下半" }] }],
      "synth"
    );
    expect(sent[0].body.messages).toEqual([{ role: "user", content: "上半\n\n下半" }]);
    /*
     * 整份请求体里搜一遍，而不是只看 messages：漏到任何一层上都是同一个 400，
     * 而 400 的原话（`Unsupported parameter`）要有人去读服务端应答才看得见。
     */
    expect(JSON.stringify(sent[0].body)).not.toContain("cache_control");
  });

  it("方舟那条口一样一块都不许发", async () => {
    process.env.ARK_API_KEY = "ark-key";
    stubFetch();
    await call(
      [
        { role: "system", content: "规矩" },
        { role: "user", content: [{ text: "上半", cache: true }, { text: "下半" }] },
      ],
      "pro"
    );
    expect(sent[0].body.messages).toEqual([
      { role: "system", content: "规矩" },
      { role: "user", content: "上半\n\n下半" },
    ]);
    expect(JSON.stringify(sent[0].body)).not.toContain("cache_control");
  });

  it("打到第五个断点时截到四个，不抛 —— 断点是优化，不该让这一次调用失败", async () => {
    /*
     * Anthropic 一次最多认四个，第五个是 400。真打到第五个说明该合并了（断点越多缓存越碎、
     * 命中率越低），但那是调用处的事 —— 在出口这一层为它抛异常，代价是一次本来能跑的调用
     * 没跑成。所以静默截，留下的是靠前那四个（越靠前的前缀越长、越值钱）。
     */
    process.env.WANGSU_API_KEY = "wangsu-key";
    stubFetch();
    await call(
      [{ role: "user", content: [1, 2, 3, 4, 5].map((n) => ({ text: `第${n}块`, cache: true })) }],
      "alt"
    );
    const blocks = (sent[0].body.messages as { content: Record<string, unknown>[] }[])[0].content;
    expect(blocks).toHaveLength(5);
    expect(blocks.map((b) => "cache_control" in b)).toEqual([true, true, true, true, false]);
  });

  it("兼容口没有单独的 system 字段 —— system 段照旧留在 messages 里", async () => {
    /*
     * Anthropic 原生口是把 system 抽成一个顶层字段的。换到兼容口之后 system 就是 messages
     * 里的第一条，抽出去等于把那一段丢了 —— 而丢的表现是「模型今天不守规矩」，不是报错。
     */
    process.env.WANGSU_API_KEY = "wangsu-key";
    stubFetch();
    await call(
      [
        { role: "system", content: [{ text: "规矩那一段", cache: true }] },
        { role: "user", content: "材料" },
      ],
      "alt"
    );
    expect(sent[0].body.system).toBeUndefined();
    expect(sent[0].body.messages).toEqual([
      {
        role: "system",
        content: [
          { type: "text", text: "规矩那一段", cache_control: { type: "ephemeral" } },
        ],
      },
      { role: "user", content: "材料" },
    ]);
  });
});

/**
 * **换网关之后请求体长什么样。**
 *
 * 这一组是新的：上一版 `alt` 走的是 SDK，请求体的形状由 `@anthropic-ai/bedrock-sdk` 负责，
 * 这里管不着。现在两条链路都是我们自己拼的一段 fetch，而这条口对不认的字段是 400 ——
 * 多发一个、字段名写成另一套方言，表现都是那条链路整条挂掉。
 */
describe("网宿那条口发出去的样子", () => {
  const send = async (slot: "alt" | "synth") => {
    process.env.WANGSU_API_KEY = "wangsu-key";
    stubFetch();
    const { callModel } = await import("./complete");
    await callModel({
      slot,
      messages: [{ role: "user", content: "写这一节" }],
      maxTokens: 100,
      json: false,
      // 上层照旧会给这两个（出稿那几次给 high）；这条口认不认由 registry 上那两个开关说了算。
      effort: "high",
      verbosity: "high",
      temperature: 0.7,
    });
    return sent[0];
  };

  it("打 {base}/chat/completions，Bearer 认证", async () => {
    const s = await send("alt");
    expect(s.url).toBe("https://api.edgecloudapp.com/v2/llm/chat/completions");
    expect(s.headers.authorization).toBe("Bearer wangsu-key");
  });

  it("上限字段是标准的 max_tokens，不是 max_completion_tokens", async () => {
    /*
     * 这两个名字是两套方言：Bedrock 那个兼容口拒收 `max_tokens`（400 `Unsupported
     * parameter`），网宿文档里每个例子都是 `max_tokens`。发错名字不是被忽略，是 400。
     */
    const s = await send("synth");
    expect(s.body.max_tokens).toBe(100);
    expect(s.body.max_completion_tokens).toBeUndefined();
  });

  it("扩展字段一个都不发：effort / verbosity / temperature 全不上线", async () => {
    /*
     * 上层给了 `effort: "high"`、`verbosity: "high"`、`temperature: 0.7`，这条口一个都不认
     * （`registry.ts` 上那三个开关全 false）。所以这里钉的是「给了也不发」——
     * 漏一个的代价是那条链路整条挂掉，而屏幕上是「Claude 那一栏这一轮没出东西」。
     */
    for (const slot of ["alt", "synth"] as const) {
      sent.length = 0;
      const s = await send(slot);
      expect(s.body.reasoning_effort, slot).toBeUndefined();
      expect(s.body.output_config, slot).toBeUndefined();
      expect(s.body.verbosity, slot).toBeUndefined();
      expect(s.body.temperature, slot).toBeUndefined();
    }
  });

  it("两条链路的模型名不同，别的一个字都不差 —— 它们本来就是同一条口", async () => {
    sent.length = 0;
    await send("alt");
    const a = sent[0];
    sent.length = 0;
    await send("synth");
    const b = sent[0];
    expect(a.url).toBe(b.url);
    expect(a.body.model).toBe("claude-opus-5");
    expect(b.body.model).toBe("gpt-5.6-sol");
    expect({ ...a.body, model: null }).toEqual({ ...b.body, model: null });
  });
});

/**
 * **读缓存那一栏是唯一能看出断点有没有真发挥作用的地方。**
 *
 * 断点发出去了没有、命中了没有，屏幕上一个字都没有 —— `cachedInputTokens` 是唯一的现场。
 * 少了它，账单对不上而看不出为什么，也就没人会发现上面那几条守的事情已经不成立了。
 * 这正是 `complete.ts` 头上那句「四个字段归一」的由来。
 */
describe("用量四栏", () => {
  it("命中的那一份照旧单独记账", async () => {
    process.env.ARK_API_KEY = "ark-key";
    stubFetch({
      prompt_tokens: 10,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 7 },
      completion_tokens_details: { reasoning_tokens: 3 },
    });
    const r = await call([{ role: "user", content: "随便" }], "pro");
    expect(r.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 7,
      reasoningTokens: 3,
    });
  });

  it("上游一栏都不给时是 0，不是 undefined —— 加总那一侧不许出 NaN", async () => {
    process.env.WANGSU_API_KEY = "wangsu-key";
    stubFetch();
    const r = await call([{ role: "user", content: "随便" }], "alt");
    expect(r.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
  });
});

/**
 * **json 模式下消息里必须出现 "json" 这个词**，否则方舟和网宿这两条兼容口都当场 400。
 *
 * 这条规矩坑在它不像故障：2026-08-27 之前 `a4.plan` 的提示词里画着 JSON 例子却没写这个词，
 * 于是每一轮深研的检索计划都 400 → 八维零命题 → N3 整段空转 → 交出一份读着挺像样、
 * 却一条外部证据都没有的报告。补在出口那层，因为漏一个的代价是整轮悄悄降级。
 */
describe("json 模式的兜底", () => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const run = async (messages: { role: string; content: string }[], json?: boolean) => {
    process.env.ARK_API_KEY = "ark-key";
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }], usage: {} }) };
    });
    const { callModel } = await import("./complete");
    await callModel({ slot: "pro", messages, maxTokens: 100, ...(json === undefined ? {} : { json }) });
    return bodies[bodies.length - 1];
  };

  it("提示词里没这个词时补一句，补在 system 段末尾", async () => {
    const b = await run([
      { role: "system", content: "你在排检索计划。" },
      { role: "user", content: "草稿如下……" },
    ]);
    expect(b.messages[0].content).toBe("你在排检索计划。\n\n输出必须是一个合法的 json 对象。");
    // user 段一个字都不动。
    expect(b.messages[1].content).toBe("草稿如下……");
  });

  it("已经有这个词就一个字都不加 —— 不动请求体是命中的前提", async () => {
    /*
     * 它守的是「别人给什么就发什么」。多补一句话最坏的地方不是那句话本身，是它每次拼出来的
     * 位置可能不一样 —— 前缀变一个字节，这一次就从「读缓存」变回全价。
     */
    const msgs = [
      { role: "system", content: "只输出一个 json 对象。" },
      { role: "user", content: "抽这一页" },
    ];
    const b = await run(msgs);
    expect(b.messages).toEqual(msgs);
  });

  it("大小写都算数（提示词里写 JSON 的更多）", async () => {
    const b = await run([{ role: "system", content: "交一份 JSON。" }, { role: "user", content: "好" }]);
    expect(b.messages[0].content).toBe("交一份 JSON。");
  });

  it("没有 system 段时补一条，不去改 user 段", async () => {
    const b = await run([{ role: "user", content: "直接问" }]);
    expect(b.messages[0]).toEqual({ role: "system", content: "输出必须是一个合法的 json 对象。" });
    expect(b.messages[1].content).toBe("直接问");
  });

  it("散文那一支（json:false）不补 —— 那几次根本没有 response_format", async () => {
    const b = await run([{ role: "system", content: "写一节报告。" }, { role: "user", content: "材料" }], false);
    expect(b.messages[0].content).toBe("写一节报告。");
    expect((b as unknown as { response_format?: unknown }).response_format).toBeUndefined();
  });
});

/**
 * **这道兜底跑在 `wireContent` 之后，所以它面对的是两种形状。**
 *
 * 上面那一组全是字符串那一支。块那一支上，按字符串写的那一版不抛也不红：`/json/i.test()`
 * 认的是数组 `toString()` 出来的东西、拼接拼进去的是 `[object Object]`，一路发到服务端 ——
 * 这正是这个文件反复在说的那类失败，读起来一切正常，只有服务端知道。
 *
 * 而在这一支上补错位置还有第二重代价：**补进标了断点的那一块等于换一份前缀**，每次写一份
 * 新缓存，比不缓存还贵。所以这一组既验「补对了」，也验「没碰前缀」。
 */
describe("json 兜底遇上内容块", () => {
  const runBlocks = async (messages: Messages) => {
    process.env.WANGSU_API_KEY = "wangsu-key";
    stubFetch();
    const { callModel } = await import("./complete");
    await callModel({ slot: "alt", messages, maxTokens: 100 });
    return sent[sent.length - 1].body.messages as {
      role: string;
      content: Record<string, unknown>[];
    }[];
  };

  it("块里的字也算数：写着 json 的块在，就一个字都不加", async () => {
    /*
     * 这一条是那个静默失败的正面：按字符串写的那一版在这里看不见块里的 `json`，于是
     * **一份本来完全合规的提示词被多补了一句**，前缀跟着变，缓存从此一次不中。
     */
    const before = await runBlocks([
      {
        role: "system",
        content: [{ text: "只输出一个 json 对象。", cache: true }, { text: "别的规矩" }],
      },
    ]);
    expect(before).toEqual([
      {
        role: "system",
        content: [
          { type: "text", text: "只输出一个 json 对象。", cache_control: { type: "ephemeral" } },
          { type: "text", text: "别的规矩" },
        ],
      },
    ]);
  });

  it("最后一块不是断点：补进那一块，前缀那一块一个字节不动", async () => {
    const msgs = await runBlocks([
      {
        role: "system",
        content: [{ text: "这一轮不变的材料", cache: true }, { text: "这一节的规矩" }],
      },
    ]);
    expect(msgs[0].content[0]).toEqual({
      type: "text",
      text: "这一轮不变的材料",
      cache_control: { type: "ephemeral" },
    });
    expect(msgs[0].content[1]).toEqual({
      type: "text",
      text: "这一节的规矩\n\n输出必须是一个合法的 json 对象。",
    });
  });

  it("最后一块正是断点：另起一块补在它后面，不许塞进前缀里", async () => {
    /*
     * **这一条是整组的理由。** 塞进去请求体照旧合法、调用照旧成功、报告照旧写完，只有账单
     * 上看得出每次都在写一份新缓存。所以判据是块的位置（有没有 `cache_control`），不是
     * 「反正走缓存那几次都是 `json: false`」—— 后者是今天的事实，它哪天变了没人会想起这里。
     */
    const msgs = await runBlocks([
      { role: "system", content: [{ text: "整段都是稳定前缀", cache: true }] },
      { role: "user", content: "材料" },
    ]);
    expect(msgs[0].content).toEqual([
      { type: "text", text: "整段都是稳定前缀", cache_control: { type: "ephemeral" } },
      { type: "text", text: "输出必须是一个合法的 json 对象。" },
    ]);
    // user 段一个字都不动。
    expect(msgs[1].content).toEqual("材料");
  });

  it("补的是最后一个 system 段 —— 前面那个带断点的一个字节都不碰", async () => {
    const msgs = await runBlocks([
      { role: "system", content: [{ text: "这一轮不变的材料", cache: true }] },
      { role: "system", content: "这一次的规矩" },
      { role: "user", content: "材料" },
    ]);
    expect(msgs[0].content).toEqual([
      { type: "text", text: "这一轮不变的材料", cache_control: { type: "ephemeral" } },
    ]);
    expect(msgs[1].content).toEqual("这一次的规矩\n\n输出必须是一个合法的 json 对象。");
  });
});
