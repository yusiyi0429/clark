/*
 * `/api/chat` 上那条议事对话支路。
 *
 * 这一段是全支唯一把对谈层十几个模块连成一条**生产链**的地方：没有它，`runTalkTurn`、
 * `TALK_SYSTEM`、`packHistory`、`lookupEvidence`、`landTalkEvidence`、`proposeTalkPoint`、
 * `recordEscalation` 在生产上一次都不会跑。而它从前一条测试都没有 —— 把 `if (talk)`
 * 整条支路关掉，全仓一千一百多条测试全绿。
 *
 * 这一轮先钉三件（不求覆盖全路由）：
 *   1. **进这条支路的四个条件**，四个各有正反；
 *   2. **`{user}` 真的被换成了他的名字**（换掉这一步在生产上从前零覆盖）；
 *   3. **尾巴的差量拼接**：当面告知那几句要补上，已经流式吐过的正文不许再说一遍。
 *
 * 范本是 `src/app/api/data/route.test.ts`（`import { POST } from "./route"` + `vi.mock`）。
 *
 * ## 上游是假的，别的都是真的
 *
 * `fetch` 打桩成一条按脚本走的 SSE 上游 —— 这是唯一的假货：`pump` 的切帧、`runTalkTurn`
 * 的轮内循环、`TALK_TOOLS`、`tellHim` 那几句告知全是真代码。库那一侧用 `vi.mock` 换成
 * 记数的桩：这条路由要断言的是「装配对不对」，不是 store 又写了什么。
 */

// 这三行必须在任何摸到路由的 import 之前：路由在模块求值期不读它们（都在 POST 里读），
// 但 `providers()` 认 `TKOS_MODEL_MOCK`，而假 key 是让 `resolveModel("pro")` 有东西可回。
process.env.TKOS_MODEL_MOCK = "1";
process.env.TKOS_PERSIST = "0";
process.env.DEEPSEEK_API_KEY = "假 key —— 这个文件一个字节都不出网";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SYSTEM_INSTRUCTIONS } from "@/lib/agent/instructions";
import { ORAL_INSTRUCTIONS } from "@/lib/agent/instructions-oral";
import { TALK_SYSTEM } from "@/lib/agent/talk/system";
import { frameText, readSse } from "@/lib/agent/sse";

import { POST } from "./route";

/** 他的名字。挑一个 `TALK_SYSTEM` 正文里不会碰巧出现的串 —— 否则下面那条断言恒真。 */
const VIEWER = "测试一号位·柯";

const store = vi.hoisted(() => ({
  deepResearch: { status: "done" } as { status: string },
  proposed: [] as unknown[],
  escalated: [] as unknown[],
  /**
   * 轮内取证「落台账」那一格的行为，逐条用例自己摆（`beforeEach` 复位成成功那一档）。
   *
   * 默认成功那一档**要把编号真的换掉**：生产上落库那一步会重排编号，而喂回模型的必须是
   * 落库回来那几条。恒返回 `[]` 的桩看不出这件事 —— 那时候「落成了」和「落砸了」喂回去
   * 的是同一份，`route.ts` 那个 `.catch` 分支也就无从测起。
   */
  landEvidence: null as null | ((entries: readonly { id: string }[]) => { id: string }[]),
}));

vi.mock("@/lib/data/store", () => ({
  agentRunOpen: vi.fn(() => "run-test"),
  agentRunSettle: vi.fn(),
  api: {
    getIssue: vi.fn(async () => ({ id: "ISS-T1", title: "测试议题", judgmentRefs: [] })),
    deepResearchStatus: vi.fn(async () => store.deepResearch),
    getViewer: vi.fn(async () => ({ name: VIEWER })),
    getResearchDoc: vi.fn(async () => ({ ledger: [], blocks: undefined })),
    landTalkEvidence: vi.fn(async (_id: string, entries: readonly { id: string }[]) =>
      store.landEvidence!(entries)),
    proposeTalkPoint: vi.fn(async (_id: string, p: unknown) => {
      store.proposed.push(p);
    }),
    recordEscalation: vi.fn(async (e: unknown) => {
      store.escalated.push(e);
    }),
  },
}));

/** 图谱那一段在这条路上是「失败也只记日志」，测试里直接给不注入。 */
vi.mock("@/lib/agent/company-context", () => ({
  companyContextForChat: vi.fn(async () => ({ block: null, note: "测试里不接图谱" })),
}));

/* -------------------------------------------------------------------------- */
/* 假上游                                                                      */
/* -------------------------------------------------------------------------- */

type UpDelta = {
  content?: string;
  tool_calls?: { index: number; id: string; function: { name: string; arguments: string } }[];
};

/** 一轮上游：把几个 delta 编成 OpenAI 兼容的 SSE 帧。 */
const upstreamRound = (deltas: UpDelta[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const d of deltas) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`));
      }
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
};

const say = (text: string): UpDelta[] => [{ content: text }];

let rounds: UpDelta[][] = [];
let fetchMock: ReturnType<typeof vi.fn>;

/** 这一次请求真发给上游的那几个请求体，按轮次。 */
const sentBodies = (): { messages: { role: string; content: string | null }[]; tools?: { function: { name: string } }[] }[] =>
  fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));

/** 这一次请求吐给浏览器的正文（把 `event: text` 那几帧按顺序接起来）。 */
const spokenText = async (res: Response): Promise<string> => {
  let out = "";
  for await (const frame of readSse(res.body!)) {
    if (frame.event === "text") out += frameText(frame);
  }
  return out;
};

/** 这一次请求报上来的那几步，按顺序（`event: step`）。 */
const steps = async (res: Response): Promise<string[]> => {
  const out: string[] = [];
  for await (const frame of readSse(res.body!)) {
    if (frame.event === "step") out.push(frameText(frame));
  }
  return out;
};

const post = async (body: Record<string, unknown>): Promise<Response> =>
  POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      body: JSON.stringify({ context: "上下文", messages: [{ role: "user", content: "这一条到底站不站得住？" }], ...body }),
    }),
  );

beforeEach(() => {
  rounds = [say("这是模型这一轮说的话。")];
  store.deepResearch = { status: "done" };
  store.proposed = [];
  store.escalated = [];
  store.landEvidence = (entries) => entries.map((e, i) => ({ ...e, id: `E9${i}` }));
  delete process.env.TKOS_TALK_V2;
  let i = 0;
  fetchMock = vi.fn(async () => {
    const r = rounds[Math.min(i, rounds.length - 1)];
    i += 1;
    return { ok: true, status: 200, body: upstreamRound(r), text: async () => "" } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */

describe("/api/chat 的四条件闸：什么时候进议事对话那一路", () => {
  /**
   * 走的是不是对谈那一路，看**第一次发给上游的那份请求体**：
   * 对谈路的系统提示是 `TALK_SYSTEM`（换过 `{user}`）、工具是完整的对谈工具集；
   * 旧路的系统提示是 `SYSTEM_INSTRUCTIONS` 或 `ORAL_INSTRUCTIONS`。
   */
  const toolNames = (b: ReturnType<typeof sentBodies>[number]): string[] =>
    (b.tools ?? []).map((t) => t.function.name);

  it("四个条件都满足 → 进对谈路：系统提示和工具都是对谈那一套", async () => {
    const res = await post({ issueId: "ISS-T1" });
    await spokenText(res);

    const [first] = sentBodies();
    expect(first.messages[0].content).toContain("[E{n}]"); // TALK_SYSTEM 里那一句
    expect(first.messages[0].content).not.toBe(SYSTEM_INSTRUCTIONS);
    expect(toolNames(first)).toEqual([
      "micro_research",
      "evidence_lookup",
      "ontology_lookup",
      "propose_point_update",
      "report_calculate",
      "escalate",
    ]);
  });

  it("口述模式 → 不进：系统提示是口述那一份，工具是舞台那一套", async () => {
    const res = await post({ issueId: "ISS-T1", mode: "oral", agenda: "议程" });
    await spokenText(res);

    const [first] = sentBodies();
    expect(first.messages[0].content).toBe(ORAL_INSTRUCTIONS);
    expect(toolNames(first)).toContain("present_agenda");
    expect(toolNames(first)).not.toContain("propose_point_update");
  });

  it("TKOS_TALK_V2=0 → 不进：走旧路那份系统提示，一个工具都不带", async () => {
    process.env.TKOS_TALK_V2 = "0";
    const res = await post({ issueId: "ISS-T1" });
    await spokenText(res);

    const [first] = sentBodies();
    expect(first.messages[0].content).toBe(SYSTEM_INSTRUCTIONS);
    expect(first.tools).toBeUndefined();
  });

  it("没有议题 → 不进（四个工具全是按议题取的，不许造一个占位 id 顶上）", async () => {
    const res = await post({});
    await spokenText(res);

    const [first] = sentBodies();
    expect(first.messages[0].content).toBe(SYSTEM_INSTRUCTIONS);
    expect(first.tools).toBeUndefined();
  });

  it("这条议题还没有深研报告 → 不进（分诊那一栏不该对着空台账挑战他）", async () => {
    store.deepResearch = { status: "running" };
    const res = await post({ issueId: "ISS-T1" });
    await spokenText(res);

    const [first] = sentBodies();
    expect(first.messages[0].content).toBe(SYSTEM_INSTRUCTIONS);
    expect(first.tools).toBeUndefined();
  });
});

describe("/api/chat 对谈路的装配", () => {
  it("系统提示里的 {user} 换成了他的名字 —— 不是留着占位符跟他说话", async () => {
    // 先钉住原文里真有这个占位符：没有它，下面那条 `not.toContain` 恒真。
    expect(TALK_SYSTEM).toContain("{user}");

    const res = await post({ issueId: "ISS-T1" });
    await spokenText(res);

    const system = sentBodies()[0].messages[0].content ?? "";
    expect(system).toContain(VIEWER);
    expect(system).not.toContain("{user}");
  });

  it("当面告知那几句补在正文后面，已经流式吐过的正文一个字都不重复", async () => {
    /*
     * 第一轮：模型只发一个工具调用（转异步查证），一个字不说 —— 流式下的工具轮就是这样。
     * 第二轮：模型开口说话。`runTalkTurn` 交回来的 `reply` 是「两轮正文 + 那句告知」，
     * 而正文已经由 `pump` 吐出去了，所以这里只该补那句告知。
     */
    const question = "那条产线的爬坡良率到底在什么区间";
    rounds = [
      [
        {
          index: 0,
          id: "c1",
          function: { name: "escalate", arguments: JSON.stringify({ type: "async_research", question }) },
        },
      ].map((tc) => ({ tool_calls: [tc] })),
      say("这一条我先按现有台账答你。"),
    ];

    const res = await post({ issueId: "ISS-T1" });
    const spoken = await spokenText(res);

    const tell = `关于「${question}」这个点，我需要查证，查证结果稍后补上。`;
    // 告知真的补上了，而且只补了差量：整段正文正好是「模型说的那句 + 空行 + 那句告知」
    expect(spoken).toBe(`这一条我先按现有台账答你。\n\n${tell}`);
    // 同一句不许出现两遍（把差量拼接写成整份重发的话，这里是 2）
    expect(spoken.split(tell)).toHaveLength(2);
    // 而且这一次转手真的落库了 —— 告知不是凭空说的
    expect(store.escalated).toHaveLength(1);
  });
});

describe("轮内取证：落台账落不下去时，这一轮照样答得出来", () => {
  /*
   * `route.ts` 里 `micro` 那一格的 `.catch(...)`：落库炸了就把**原样那几条**喂回模型，
   * 不把一段已经生成好的回应变成一次 500。这是复审点名的四件里最后一件，上一轮仍是零
   * 覆盖 —— 那时候 `landTalkEvidence` 被桩成恒返回 `[]`，「落成了」和「落砸了」喂回去
   * 的是同一份，那条分支走不到。
   *
   * 两条一起看才算数：先钉住成功那一档喂回去的是**重编号之后**那几条，再钉住失败那一档
   * 退回原样。只有后一条的话，`landTalkEvidence` 恒抛也绿。
   */
  const microRound = (question: string) => [
    {
      tool_calls: [
        {
          index: 0,
          id: "c1",
          function: { name: "micro_research", arguments: JSON.stringify({ question, point_id: "ISS-T1" }) },
        },
      ],
    },
  ];

  /** 第二轮发给上游那份请求体里，工具返回值那几条。 */
  const fedBack = (): string =>
    (sentBodies()[1]?.messages ?? [])
      .filter((m) => m.role === "tool")
      .map((m) => m.content ?? "")
      .join("\n");

  it("落成了：喂回模型的是落库重编号之后那几条 —— 他下一轮问那个号才对得上", async () => {
    rounds = [microRound("那条产线的爬坡良率区间"), say("按刚查到的这条我答你。")];
    const res = await post({ issueId: "ISS-T1" });
    expect(await spokenText(res)).toBe("按刚查到的这条我答你。");

    const fed = fedBack();
    expect(fed).toContain("取到了，独立来源");
    expect(fed).toContain("E90");        // 落库那一步换的号
  });

  it("落砸了：照原样喂回去，这一轮照样有回应，不变成一次 500", async () => {
    store.landEvidence = () => {
      throw new Error("库炸了");
    };
    rounds = [microRound("那条产线的爬坡良率区间"), say("按刚查到的这条我答你。")];

    const res = await post({ issueId: "ISS-T1" });
    // 回应照旧吐出来了 —— 落库失败不许把已经生成好的这一轮变成一次 500
    expect(res.status).toBe(200);
    expect(await spokenText(res)).toBe("按刚查到的这条我答你。");

    const fed = fedBack();
    expect(fed).toContain("取到了，独立来源");
    // 少几个能指认的编号，好过把这一轮变成一次 500：喂回去的是原样那几条
    expect(fed).not.toContain("E90");
  });
});

describe("步骤上报：等待时那行扫光小字读的就是它", () => {
  /*
   * `event: step` 是纯提示（口径写在 `sse.ts`）：它一个字都不进落库的回应，所以这几条
   * 断言全部只看帧，不看正文。
   *
   * 要钉的是「**不多报**」和「**不少报**」两头。多报的代价是屏幕上冒出一个没发生过的
   * 步骤 —— 而这行字看起来完全像真的；少报的代价是他盯着一句「正在想」等十几秒，
   * 而那十几秒真正花在出网检索上。
   */
  it("一轮就说完的话：一步都不报 —— 屏幕上是「正在想」，不许编一个假步骤出来", async () => {
    const res = await post({ issueId: "ISS-T1" });
    expect(await steps(res)).toEqual([]);
  });

  it("轮内取证那一轮：先报去外面查证，跑完再报回来组织回答", async () => {
    rounds = [
      [
        {
          tool_calls: [
            {
              index: 0,
              id: "c1",
              function: {
                name: "micro_research",
                arguments: JSON.stringify({ question: "那条产线的爬坡良率区间", point_id: "ISS-T1" }),
              },
            },
          ],
        },
      ],
      say("按刚查到的这条我答你。"),
    ];
    const res = await post({ issueId: "ISS-T1" });
    expect(await steps(res)).toEqual(["正在去外面查证", "正在组织回答"]);
  });

  it("按编号取证那一轮：报的是翻台账，不是去外面查 —— 两件事花的时间差一个数量级", async () => {
    rounds = [
      [
        {
          tool_calls: [
            {
              index: 0,
              id: "c1",
              function: { name: "evidence_lookup", arguments: JSON.stringify({ id: "E1" }) },
            },
          ],
        },
      ],
      say("台账上那一条是这么写的。"),
    ];
    const res = await post({ issueId: "ISS-T1" });
    expect(await steps(res)).toEqual(["正在翻这份报告的台账", "正在组织回答"]);
  });

  it("旧路一步都不报 —— 那一路压根没有工具，全程就是「正在想」", async () => {
    process.env.TKOS_TALK_V2 = "0";
    const res = await post({ issueId: "ISS-T1" });
    expect(await steps(res)).toEqual([]);
  });
});
