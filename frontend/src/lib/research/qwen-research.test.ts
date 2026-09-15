/**
 * 通义深研这一环，**离线，一个字节都不出网** —— `fetch` 整个换成一条自己编的 SSE。
 *
 * 这里钉的三件事都属于「坏了没有症状」那一类：
 *
 * 1. **`answer` 阶段的 `references` 不许进来。** 它是模型写报告时挑出来引的地址，能被它
 *    读过的页面正文指挥，而这几条地址接着会进 `fetch.ts` 的抓取白名单。收错了不会报错，
 *    只会让白名单悄悄比注释里承诺的宽一格。
 * 2. **收完 `WebResearch` 就断流。** 不断的代价是等它把一份我们要丢掉的报告写完 ——
 *    那是这条链上最贵的一次等待，而它同样一个错都不报。
 * 3. **`webSites` 挂在哪一级是扫出来的。** 官方文档没给这一层的样例，所以这里拿两种不同
 *    的嵌法各跑一遍：路径写死的实现会在其中一种上静默交零条。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { keepUrl, phaseOf, qwenResearch, QWEN_RESEARCH_PROVIDER } from "./qwen-research";

/** 一帧 DashScope 的 SSE。真回包里还有 `id:` 和 `:HTTP_STATUS/200`，一并带上。 */
const frame = (payload: unknown, i: number): string =>
  `id:${i}\nevent:result\n:HTTP_STATUS/200\ndata:${JSON.stringify(payload)}\n\n`;

/** 一帧的壳。`output.message` 这一种形状。 */
const msg = (phase: string, deepResearch: Record<string, unknown>, content = ""): unknown => ({
  output: { message: { content, extra: { deep_research: { phase, ...deepResearch } } } },
});

/**
 * 把几帧折成一条流。**每次调用各发一遍完整的帧**，各记各的游标 —— 这个模型的合同是两次
 * 调用（反问 + 真跑），共用一个游标的话第二次拿到的是一条空流，而那时每一条断言都会以
 * 「产品没扫到地址」的形状红掉，看不出红的是夹具。
 */
function stubFetch(frames: string[]) {
  const state = { reads: [] as number[], aborted: false, calls: 0 };
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const call = state.calls;
    state.calls += 1;
    state.reads.push(0);
    /*
     * 挂在 signal 上听，**不是**在 `pull` 里查 `signal.aborted`：读到那一帧就 `break` 之后
     * `pull` 再也不会被叫，于是那个查法永远查不到，而它红出来的样子是「没断流」—— 和真的
     * 没断流一模一样。
     */
    init.signal?.addEventListener("abort", () => {
      state.aborted = true;
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        const at = state.reads[call];
        if (at >= frames.length) {
          ctl.close();
          return;
        }
        ctl.enqueue(new TextEncoder().encode(frames[at]));
        state.reads[call] = at + 1;
      },
    });
    return new Response(body, { status: 200 });
  });
  return state;
}

const setup = () => {
  process.env.TKOS_MODEL_MOCK = "";
  process.env.TKOS_DR_SEED = "";
  process.env.TKOS_QWEN_RESEARCH_URL = "https://ws.example.com/api/v1/services/aigc/text-generation/generation";
  process.env.TKOS_QWEN_RESEARCH_KEY = "sk-test";
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TKOS_QWEN_RESEARCH_URL;
  delete process.env.TKOS_QWEN_RESEARCH_KEY;
});

describe("只收 WebResearch 的 webSites", () => {
  it("answer 阶段的 references 一条都不进来", async () => {
    setup();
    // 第一次调用是反问，第二次才是真跑 —— 两次共用这一串帧，够用：反问那次不扫地址。
    const state = stubFetch([
      frame(msg("ResearchPlanning", {}, "你要哪个口径？"), 1),
      frame(
        msg("WebResearch", {
          research: { webSites: [{ url: "https://good.example.com/a", title: "正经材料", description: "摘要" }] },
        }),
        2
      ),
      frame(
        msg("answer", {
          references: [{ url: "https://planted.example.com/evil", title: "被塞进来的", description: "" }],
        }),
        3
      ),
    ]);

    const r = await qwenResearch("题面", "回答");
    expect(state.calls).toBe(2);
    expect(r.hits.map((x) => x.url)).toEqual(["https://good.example.com/a"]);
    expect(r.hits.every((x) => x.provider === QWEN_RESEARCH_PROVIDER)).toBe(true);
    // 走到 answer 就该停手，不是把它读完再挑。
    expect(r.account.phases).toContain("WebResearch");
  });

  it("挂在 deep_research 外面也扫得到 —— 子树里空了就退一步扫整帧", async () => {
    setup();
    stubFetch([
      frame(msg("WebResearch", {}, "反问"), 1),
      // 阶段在 deep_research 里，地址却挂在它外面。文档没给这一层的样例，真回包长什么样
      // 在跑通之前是不知道的 —— 所以这一种也得接得住。
      frame(
        {
          output: {
            message: {
              extra: { deep_research: { phase: "WebResearch" } },
              webSites: [{ url: "https://outside.example.com/y", title: "挂在外面" }],
            },
          },
        },
        2
      ),
    ]);
    const r = await qwenResearch("题面", "回答");
    expect(r.hits.map((x) => x.url)).toEqual(["https://outside.example.com/y"]);
  });

  it("退一步只在 WebResearch 帧上退 —— answer 帧整帧都不扫", async () => {
    setup();
    stubFetch([
      frame(msg("WebResearch", {}, "反问"), 1),
      // 这一帧的 deep_research 子树里没有地址，地址挂在帧的别处 —— 但它是 answer 阶段，
      // 所以整帧都不该被扫。这一条钉的是白名单那格边界，不是功能。
      frame(
        {
          output: {
            message: {
              extra: { deep_research: { phase: "answer" } },
              webSites: [{ url: "https://planted.example.com/evil", title: "不许进来" }],
            },
          },
        },
        2
      ),
    ]);
    const r = await qwenResearch("题面", "回答");
    expect(r.hits).toEqual([]);
  });

  it("webSites 换一层嵌法照样扫得到 —— 路径没文档，所以不猜路径", async () => {
    setup();
    stubFetch([
      frame(msg("WebResearch", {}, "反问"), 1),
      // 这一种直接挂在 deep_research 底下，上一条用例里是挂在 research 底下的。
      frame(msg("WebResearch", { webSites: [{ url: "https://deep.example.com/x", title: "另一种嵌法" }] }), 2),
    ]);
    const r = await qwenResearch("题面", "回答");
    expect(r.hits.map((x) => x.url)).toEqual(["https://deep.example.com/x"]);
  });
});

describe("拿到地址就断流", () => {
  it("阶段一离开 WebResearch 就 abort，后面的帧不再读", async () => {
    setup();
    const tail = Array.from({ length: 20 }, (_, i) =>
      frame(msg("answer", {}, `报告正文第 ${i} 段，我们不要`), i + 10)
    );
    const state = stubFetch([
      frame(msg("WebResearch", { webSites: [{ url: "https://a.example.com/1", title: "一" }] }), 1),
      frame(msg("answer", {}, "开始写报告了"), 2),
      ...tail,
    ]);
    await qwenResearch("题面", "回答");
    /*
     * 看第二次调用（真跑那一次）读了几帧：地址在第 1 帧，第 2 帧就进 `answer` 了，所以它
     * 该停在 2 附近。**关键是那 20 帧报告正文没被读完** —— 读完了就说明断流没生效，而那
     * 正是这一步要省掉的几分钟。
     */
    expect(state.reads[1]).toBeLessThan(2 + tail.length);
    expect(state.aborted).toBe(true);
  });
});

describe("keepUrl 挡掉不该抓的", () => {
  it.each([
    ["https://a.example.com/x", true],
    ["http://a.example.com/x", false],
    ["https://u:p@a.example.com/x", false],
    ["https://a.example.com:8080/x", false],
    ["https://127.0.0.1/x", false],
    ["https://localhost/x", false],
    ["https://a.example.com:443/x", true],
    ["不是个地址", false],
  ])("%s → %s", (url, ok) => {
    expect(keepUrl(url)).toBe(ok);
  });
});

describe("阶段取字", () => {
  it("output.message 和 output.choices[0].message 两种形状都认", () => {
    expect(phaseOf(msg("WebResearch", {}))).toBe("WebResearch");
    expect(
      phaseOf({
        output: { choices: [{ message: { extra: { deep_research: { phase: "answer" } } } }] },
      })
    ).toBe("answer");
    // 心跳帧没有阶段。返回空字符串，**不是**某个默认阶段 —— 那会让断流提前触发。
    expect(phaseOf({ output: { message: { content: "x" } } })).toBe("");
  });

  it("真回包那一种：phase 在 message 上，extra.deep_research 是空的", () => {
    /*
     * 这一帧是 2026-09-01 第一次真跑抄下来的原样（截了 content）。文档样例把阶段画在
     * `extra.deep_research.phase` 上，实际它是个空对象 —— 只认文档那两处的版本在这一帧上
     * 返回空串，然后一条地址都收不到、一个错都不报。这条用例就是为了钉住这件事。
     */
    const real = {
      output: {
        message: {
          phase: "answer",
          role: "assistant",
          content: "1",
          extra: { deep_research: {} },
          status: "typing",
        },
        fininshed: false,
      },
      usage: { input_tokens: 203, output_tokens: 1 },
      request_id: "a498e327-224d-900f-acb4-943337307d1c",
    };
    expect(phaseOf(real)).toBe("answer");
  });
});

describe("没配就不跑，而且要说出来", () => {
  it("没有 URL 时交空表加一句原话，不抛", async () => {
    process.env.TKOS_MODEL_MOCK = "";
    delete process.env.TKOS_QWEN_RESEARCH_URL;
    process.env.TKOS_QWEN_RESEARCH_KEY = "sk-test";
    const r = await qwenResearch("题面", "回答");
    expect(r.hits).toEqual([]);
    expect(r.reason).toContain("TKOS_QWEN_RESEARCH_URL");
  });

  it("接口 500 也不抛 —— 这一步挂掉不该带倒整轮深研", async () => {
    setup();
    vi.stubGlobal("fetch", async () => new Response("upstream boom", { status: 500 }));
    const r = await qwenResearch("题面", "回答");
    expect(r.hits).toEqual([]);
    expect(r.reason).toContain("500");
  });

  it("报错时不许把 key 原样带进那句话里", async () => {
    setup();
    vi.stubGlobal("fetch", async () => new Response("bad key: sk-test", { status: 401 }));
    const r = await qwenResearch("题面", "回答");
    expect(r.reason).not.toContain("sk-test");
    expect(r.reason).toContain("***");
  });
});
