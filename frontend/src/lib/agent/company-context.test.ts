import { describe, expect, it, vi } from "vitest";

import { companyContextForChat, ontologyLookupForChat, wrapCompanyContext } from "./company-context";

/*
 * 打桩注意（vitest v4 会去 await mock 的返回值，`mock.settledResults`）：
 * - 桩不能返回永不 settle 的 promise。「超时」那条因此让慢请求在假时钟上
 *   最终 resolve，测完再把时钟推完，不留 pending 的。
 * - 桩不能 reject（会被判成未处理的拒绝，红的是测试写法不是被测代码）。
 *   「本体不可达」那条因此不打桩，跑真链路，见 `company-context.unavailable.test.ts`。
 * - `mockReset()` 写在每个用例里而不是 `beforeEach`：放在钩子里时，
 *   假时钟那条用例会让钩子挂到超时。
 * - 桩打在**分派点**上，不打在 `@/lib/graphknowledge` 上。这扇门现在两个源共用一条路，
 *   桩在旧源上的话，默认那一支（叙述接口）会绕过桩去打真地址 —— 而症状是这个文件里
 *   每条用例都在报「没配 TKOS_MEMORY_API_BASE_URL」，看起来像环境问题不像桩打错了地方。
 */
vi.mock("@/lib/ontology/context", () => ({ openOntologyContext: vi.fn() }));
vi.mock("@/lib/ontology/lookup", () => ({ lookupOntology: vi.fn() }));

const { openOntologyContext } = await import("@/lib/ontology/context");
const { lookupOntology } = await import("@/lib/ontology/lookup");
const mocked = vi.mocked(openOntologyContext);
const mockedLookup = vi.mocked(lookupOntology);

type Opened = Awaited<ReturnType<typeof openOntologyContext>>;

const anchored = {
  mode: "anchored",
  bundle: {
    recipe: "S02",
    anchorCode: "ISS-D1",
    memberIds: ["member:a", "member:b"],
    renderedMarkdown: "毛利率下滑 [member:a]",
    viewer: "PSN-01",
    asOf: "2026-08-19",
    sourceBaseUrl: "https://example.invalid/graph",
  },
  anchor: null,
  noAnchorReason: null,
  snapshotId: "ctx-1",
  trace: [],
  warnings: [],
} as unknown as Opened;

describe("wrapCompanyContext", () => {
  it("说清 [member:x] 这类锚点不要写进回复", () => {
    // 屏幕认不出、点不开的编号写进回复，一号位点一次发现是死链，
    // 之后整份回复的可信度都要打折。
    const w = wrapCompanyContext("毛利率下滑 [member:abc][partition:p][source:s]");
    expect(w).toContain("[member:");
    expect(w).toContain("不要把它写进回复");
    expect(w).toContain("毛利率下滑");
  });

  it("正文照原样带进去，不做任何改写", () => {
    expect(wrapCompanyContext("原样 $& 文本")).toContain("原样 $& 文本");
  });
});

describe("companyContextForChat", () => {
  it("命中：正文包裹好，note 报锚点和规模", async () => {
    mocked.mockReset();
    mocked.mockResolvedValue(anchored);
    const r = await companyContextForChat("毛利率为什么下滑");
    expect(r.block).toContain("毛利率下滑 [member:a]");
    expect(r.block).toContain("来自 GraphKnowledge");
    expect(r.note).toContain("命中 ISS-D1");
    expect(r.note).toContain("2 个对象");
    expect(r.note).toMatch(/\d+ms/);
  });

  it("纯外部：不注入，note 的措辞不预设成因", async () => {
    mocked.mockReset();
    mocked.mockResolvedValue({
      mode: "external_only",
      bundle: null,
      anchor: null,
      noAnchorReason: "P3 这一次没算出检索结果，不能读作「图谱里没有这条议题」",
      snapshotId: null,
      trace: [],
      warnings: [],
    } as unknown as Opened);
    const r = await companyContextForChat("一条很新的题");
    expect(r.block).toBeNull();
    expect(r.note).toContain("未取到锚点");
    expect(r.note).toContain("没算出检索结果");
    // 「检索没跑出来」不许被读成「图谱里没有这条议题」，所以前缀不能替它下结论。
    expect(r.note).not.toContain("图谱里没有这条议题的锚点");
  });

  it("超时：不等下去，note 说明本次不带公司上下文", async () => {
    // 本体「慢而不挂」是最难查的一种：对话栏长时间不出字，日志里什么都没有。
    // 推的是 12 秒 —— 默认源是叙述接口，它那道闸比图谱那道宽一倍（上游自己要跑一遍
    // 检索再过一遍模型压缩，实测 3～6 秒，6 秒会卡到正常调用）。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      mocked.mockReset();
      mocked.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(anchored), 60_000))
      );
      const p = companyContextForChat("毛利率为什么下滑");
      await vi.advanceTimersByTimeAsync(12_000);
      const r = await p;
      expect(r.block).toBeNull();
      expect(r.note).toContain("不带公司上下文");
      // 让那个慢请求把自己走完，别留一个 pending 的 promise 给 vitest 的钩子。
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("companyContextForChat · 叙述那一支", () => {
  const narrative = {
    mode: "narrative",
    bundle: {
      recipe: "S02",
      anchorCode: "",
      memberIds: [],
      renderedMarkdown: "公司经营愿景是……本期总 Outcome 是……",
      viewer: "PSN-01",
      asOf: "2026-09-02",
      sourceBaseUrl: "https://memory.test",
    },
    anchor: null,
    anchorOrigin: null,
    noAnchorReason: "本体叙述接口不产生锚点：它沿主导航路径装配一段脉络，没有可引编号",
    staticContext: "",
    snapshotId: "ctx-n",
    trace: [],
    warnings: [],
  } as unknown as Opened;

  it("正文进去了，但包的是叙述那一段说法 —— **不能是教它引短码的那一段**", async () => {
    mocked.mockReset();
    mocked.mockResolvedValue(narrative);
    const r = await companyContextForChat("我们本期要达成什么");
    expect(r.block).toContain("本期总 Outcome");
    // 这一支一个短码都不回，照抄 `wrapCompanyContext` 就是教模型去引一批不存在的编号。
    expect(r.block).not.toContain("来自 GraphKnowledge");
    // 这一句是整段话的重点：手上只有公司层，没有这条议题自己的判断与共识。
    expect(r.block).toContain("不包含这条议题自己的历史");
  });

  it("**members 是空的** —— 没有可引编号，对谈那边的短码机检因此整轮不报", async () => {
    mocked.mockReset();
    mocked.mockResolvedValue(narrative);
    expect((await companyContextForChat("我们本期要达成什么")).members).toEqual([]);
  });

  it("对话这一路取压缩版，不跟着预研深研一起吃原文 —— 首字什么时候出来是产品的一部分", async () => {
    mocked.mockReset();
    mocked.mockResolvedValue(narrative);
    await companyContextForChat("我们本期要达成什么");
    expect(mocked.mock.calls[0][0]).toMatchObject({ includeRaw: false });
  });
});

describe("ontologyLookupForChat", () => {
  it("取到了：回条目，note 说清是按编号还是按语义", async () => {
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue({
      mode: "code",
      sent: "01-J2",
      items: [{ code: "01-J2", label: "架构能力即壁垒", text: "……", status: "confirmed" }],
      recall: "",
      warning: "",
    });
    const r = await ontologyLookupForChat("01-J2");
    expect(r.kind).toBe("found");
    if (r.kind !== "found") throw new Error("unreachable");
    expect(r.items[0].code).toBe("01-J2");
    expect(r.note).toContain("按编号");
  });

  it("图里没有这条：not_found，**不是**失败", async () => {
    // 这条分开的理由同 openContext 那扇门：把「没找到」接成「图挂了」，
    // 他会去查一个没有故障的服务；反过来更糟，故障被读成「公司没有这条」。
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue({ mode: "semantic", sent: "毛利率", items: [], recall: "", warning: "" });
    const r = await ontologyLookupForChat("毛利率");
    expect(r.kind).toBe("not_found");
  });

  it("本体不可达：unavailable，一句人话，不抛", async () => {
    mockedLookup.mockReset();
    mockedLookup.mockImplementation(() => Promise.reject(new Error("connect ECONNREFUSED")));
    const r = await ontologyLookupForChat("01-J2");
    expect(r.kind).toBe("unavailable");
    expect(r.note).toContain("ECONNREFUSED");
  });

  it("超时：到点就走，不把这一轮对话挂在那里", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      mockedLookup.mockReset();
      mockedLookup.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ mode: "code", sent: "x", items: [], recall: "", warning: "" }), 60_000)
          )
      );
      const p = ontologyLookupForChat("01-J2");
      await vi.advanceTimersByTimeAsync(12_000);
      const r = await p;
      expect(r.kind).toBe("unavailable");
      expect(r.note).toContain("超过");
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("**叙述那一档 items 空着也是 found** —— 照旧路那条「空就 not_found」走，每一次都会被报成公司没记过", async () => {
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue({
      mode: "narrative",
      sent: "M1-A 是什么",
      items: [],
      recall: "M1-A 战略决策机制让组织围绕同一个议题持续形成可追溯的判断。",
      warning: "这段叙述由上游 deepseek-v4-flash 压缩生成，不是图里的原话",
    });
    const r = await ontologyLookupForChat("M1-A 是什么");
    expect(r.kind).toBe("found");
    if (r.kind !== "found") throw new Error("unreachable");
    expect(r.mode).toBe("narrative");
    expect(r.recall).toContain("M1-A");
    // 这一句要往上走到模型面前，不只是进日志。
    expect(r.warning).toContain("不是图里的原话");
  });

  it("空问句直接回 not_found，不打上游", async () => {
    mockedLookup.mockReset();
    const r = await ontologyLookupForChat("   ");
    expect(r.kind).toBe("not_found");
    expect(mockedLookup).not.toHaveBeenCalled();
  });
});
