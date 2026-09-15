/**
 * DRI 三条链路的服务端方法，以及一号位那侧对它们的读法。
 *
 * 每个用例都在 `runAsActor` 里跑 —— 这些方法的全部意义就是「按调用者过滤」，
 * 不带身份地测它们等于没测。断言只认「我刚写的那条」（同 inbox-signals.test.ts）。
 *
 * 每条用例自己 `addIssue` 造一件议题，不按位置从库里取。上一版按 `issues[0]` /
 * `issues[1]` 取，于是两条用例落在同一件议题上：后一条跑的是「覆盖提交」而不是
 * 「首次回传」，而读代码时看不出来。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { runAsActor } from "./actor";
import type {
  api as Api,
  briefText as BriefText,
  inboxSignalGet as InboxSignalGet,
  __seedResearchedIssueForTest as SeedResearched,
} from "./store";
import type { AltReport, Brief, ResearchDoc } from "./types";

let api: typeof Api;
let briefText: typeof BriefText;
let inboxSignalGet: typeof InboxSignalGet;
let seedResearched: typeof SeedResearched;

beforeAll(async () => {
  // 别读也别写 .data 里那份真快照 —— 否则这几条断言跟着开发机上的现场数据飘，
  // 而且「测试 DRI 承接中」这类假话会被落盘，下一次 `pnpm dev` 就出现在屏幕上。
  process.env.TKOS_PERSIST = "0";
  // 单测里一次模型都不许真调用：这台机器上可能导出着真 key。
  process.env.TKOS_MODEL_MOCK = "1";
  const mod = await import("./store");
  api = mod.api;
  briefText = mod.briefText;
  inboxSignalGet = mod.inboxSignalGet;
  seedResearched = mod.__seedResearchedIssueForTest;
});

const asDri = <T,>(personId: string, fn: () => Promise<T>) =>
  runAsActor({ personId, role: "dri" }, fn);
const asCeo = <T,>(fn: () => Promise<T>) => runAsActor({ personId: "PSN-01", role: "ceo" }, fn);

/** 一件干净的在办议题。`addIssue` 会顺手起一轮预研，那一轮在假模型下就地失败，与这里无关。 */
const freshIssue = (title: string) => asCeo(() => api.addIssue(title));

const filledDoc = {
  sourceText: "## 我查到的\n\n三家都在自建。",
  judgment: ["现在自研比采购便宜"],
  keyEvidence: ["三家客户都提了"],
  counters: ["样本只有三家"],
  unknowns: ["不知道明年价格"],
  routeSuggestion: "建议上会",
};

describe("submitDriSignal", () => {
  it("落进同一个待挑池，署他的名，不带分数", async () => {
    const got = await asDri("PSN-02", () =>
      api.submitDriSignal({
        title: "有客户提到要自建 Agent 平台",
        source: "客户电话",
        text: "对方 CTO 说明年 Q1 要试",
        why: "我们的报价窗口就在这两周",
      })
    );
    expect(got.kind).toBe("reported");
    if (got.kind === "reported") expect(got.by).toBe("白田田");
    expect(inboxSignalGet(got.dedupeKey)?.title).toBe("有客户提到要自建 Agent 平台");
  });

  it("同一个人同一天报同一句，第二次不新增一条", async () => {
    const one = await asDri("PSN-02", () =>
      api.submitDriSignal({ title: "重复的一句", source: "群里", text: "", why: "现在" })
    );
    const two = await asDri("PSN-02", () =>
      api.submitDriSignal({ title: "重复的一句", source: "群里", text: "", why: "现在" })
    );
    expect(two.dedupeKey).toBe(one.dedupeKey);
    expect(two.receivedAt).toBe(one.receivedAt);
  });

  it("有 URL 就用 URL 做幂等键 —— 两个人报同一篇文章算同一条", async () => {
    const a = await asDri("PSN-02", () =>
      api.submitDriSignal({ title: "同一篇", source: "36氪", text: "", why: "x", url: "https://a.com/x?utm_source=y" })
    );
    const b = await asDri("PSN-03", () =>
      api.submitDriSignal({ title: "同一篇（他也看到了）", source: "36氪", text: "", why: "x", url: "https://a.com/x" })
    );
    expect(b.dedupeKey).toBe(a.dedupeKey);
  });

  it("标题空的拒掉，给一句人话", async () => {
    await expect(
      asDri("PSN-02", () => api.submitDriSignal({ title: "  ", source: "群里", text: "", why: "现在" }))
    ).rejects.toThrow("一句话总得有");
  });

  it("listMyReports 只给我自己报的那几条", async () => {
    const mine = await asDri("PSN-02", () =>
      api.submitDriSignal({ title: "只有白田田看得到这条", source: "群里", text: "", why: "现在" })
    );
    await asDri("PSN-03", () =>
      api.submitDriSignal({ title: "孙铭泽报的", source: "群里", text: "", why: "现在" })
    );

    const list = await asDri("PSN-02", () => api.listMyReports());
    expect(list.map((s) => s.dedupeKey)).toContain(mine.dedupeKey);
    expect(list.some((s) => s.title === "孙铭泽报的")).toBe(false);
  });
});

describe("listMyDomainJudgments", () => {
  it("只给我这个域的在版判断，且只给 id 和陈述", async () => {
    // PSN-14（陈溪南）是 D-04（Agents）的负责人之一 —— 2026-08-31 在位人校准之后，
    // 那个域的名单是「陈溪南、孙铭泽」，而**名单里有我就算我的域**。
    const list = await asDri("PSN-14", () => api.listMyDomainJudgments());
    expect(list.length).toBeGreaterThan(0);
    expect(Object.keys(list[0]).sort()).toEqual(["id", "statement"]);
    expect(list.every((j) => j.id.startsWith("04-"))).toBe(true);
  });
});

describe("listMyHandoffs / submitDriReport", () => {
  it("只给点名派给我的那几件 —— 不按域回落", async () => {
    // 先由一号位指派。assignIssue 是 ceo 侧的方法，所以用 ceo 身份跑。
    const target = await freshIssue("要不要把交付节奏改成两周一次");
    await asCeo(() => api.assignIssue(target.id, "PSN-02"));

    const mine = await asDri("PSN-02", () => api.listMyHandoffs());
    expect(mine.map((h) => h.issueId)).toContain(target.id);
    expect(mine.find((h) => h.issueId === target.id)?.submitted).toBe(false);

    // 没被点名的人手上是空的，哪怕他是这个域的 DRI。
    const other = await asDri("PSN-03", () => api.listMyHandoffs());
    expect(other.map((h) => h.issueId)).not.toContain(target.id);
  });

  it("回传落成一份 ResearchDoc，每句都盖 human 溯源与他的名字", async () => {
    const target = await freshIssue("三家客户都想自建，要不要出一版报价");
    await asCeo(() => api.assignIssue(target.id, "PSN-02"));

    await asDri("PSN-02", () => api.submitDriReport(target.id, filledDoc));

    const reports = await asCeo(() => api.listReports(target.id));
    // 一号位那侧读到的就是同一份 —— 不另建类型（spec §3.2）。
    const driReport = reports.find((r) => r.key === "dri");
    const mine = await asDri("PSN-02", () => api.listMyHandoffs());
    expect(mine.find((h) => h.issueId === target.id)?.submitted).toBe(true);
    expect(driReport?.doc?.judgment[0]?.text).toBe("现在自研比采购便宜");
    expect(driReport?.doc?.judgment[0]?.traces[0]?.kind).toBe("human");
  });

  it("回传时间从时间线事件算出来，不是另存一份", async () => {
    const target = await freshIssue("要不要把定价页改成阶梯式");
    await asCeo(() => api.assignIssue(target.id, "PSN-02"));

    // 回传前没有 submittedAt
    const before = await asDri("PSN-02", () => api.listMyHandoffs());
    expect(before.find((h) => h.issueId === target.id)?.submittedAt).toBeUndefined();

    await asDri("PSN-02", () => api.submitDriReport(target.id, filledDoc));

    // 回传后有 submittedAt，且等于时间线上那条事件的 at
    const after = await asDri("PSN-02", () => api.listMyHandoffs());
    const handoff = after.find((h) => h.issueId === target.id);
    expect(handoff?.submittedAt).toBeTruthy();

    const timeline = await asCeo(() => api.getTimeline(target.id));
    const reportEvent = timeline.find((e) => e.id.startsWith(`E-${target.id}-dri-report-`));
    expect(handoff?.submittedAt).toBe(reportEvent?.at);
  });

  it("没派给我的议题，我提交不了", async () => {
    const target = await freshIssue("要不要把实验台的靶点再加两个");
    await expect(
      asDri("PSN-09", () => api.submitDriReport(target.id, filledDoc))
    ).rejects.toThrow("不是派给你的");
  });

  it("四节全空的拒掉 —— 一份什么都没说的回传比没有回传更坏", async () => {
    const target = await freshIssue("要不要把周报合并进月报");
    await asCeo(() => api.assignIssue(target.id, "PSN-02"));
    await expect(
      asDri("PSN-02", () =>
        api.submitDriReport(target.id, {
          sourceText: "",
          judgment: [],
          keyEvidence: [],
          counters: [],
          unknowns: [],
          routeSuggestion: "",
        })
      )
    ).rejects.toThrow("四节里总得有一句");
  });
});

describe("指派与回传怎么推状态", () => {
  it("指派那一下推到等证据 —— 「等谁」这句话得在状态机上有落点", async () => {
    const target = await freshIssue("要不要现在就招第二个交付");
    expect(target.state).toBe("Candidate");

    await asCeo(() => api.assignIssue(target.id, "PSN-02"));

    const after = await asCeo(() => api.getIssue(target.id));
    expect(after.state).toBe("WaitingEvidence");
    // 他这一刻没有下一步 —— 等的是别人。
    expect(after.nextActionForUser).toBeNull();
  });

  it("改派不把一件已经能上会的议题打回去等证据", async () => {
    const target = await freshIssue("要不要把 Foundry 的定价重做一遍");
    await asCeo(() => api.assignIssue(target.id, "PSN-02"));
    await asDri("PSN-02", () => api.submitDriReport(target.id, filledDoc));
    expect((await asCeo(() => api.getIssue(target.id))).state).toBe("ReadyForDecision");

    await asCeo(() => api.assignIssue(target.id, "PSN-03"));

    const after = await asCeo(() => api.getIssue(target.id));
    expect(after.state).toBe("ReadyForDecision");
    expect(after.assigneeName).toBe("孙铭泽");
  });

  it("没有会前准备就不说「会前准备已就绪」", async () => {
    // 这一件没有深研报告，`synthBrief` 装不出会前准备。状态照推（回传是真的），
    // 但那句下一步不能写 —— 写了他点进去撞到 `getBrief` 抛「还没有会前准备」。
    const target = await freshIssue("要不要把客服外包出去");
    await asCeo(() => api.assignIssue(target.id, "PSN-02"));
    await asDri("PSN-02", () => api.submitDriReport(target.id, filledDoc));

    const after = await asCeo(() => api.getIssue(target.id));
    expect(after.state).toBe("ReadyForDecision");
    expect(after.nextActionForUser).not.toBe("会前准备已就绪 · 会后确认");
    await expect(asCeo(() => api.getBrief(target.id))).rejects.toThrow("还没有会前准备");
  });

  it("回传那一刻不起草写回提案", async () => {
    // 起草时读的是深研报告，**完全不含刚回传的那一份**；没有深研报告时还会拿
    // `research: null` 去让模型凭空写七要素。起草时机不在这个任务里改，
    // 所以这一刻什么都不该起。
    const target = await freshIssue("要不要把年度目标从三条减到两条");
    await asCeo(() => api.assignIssue(target.id, "PSN-02"));
    await asDri("PSN-02", () => api.submitDriReport(target.id, filledDoc));

    expect((await asCeo(() => api.writeBackStatus(target.id))).status).toBe("idle");
  });
});

describe("listReports 里的等待态", () => {
  it("已指派未回传：页签在，但它不是一份报告 —— 只给「等谁」「从什么时候起」", async () => {
    const target = await freshIssue("要不要把 SLA 从 8 小时收到 4 小时");
    await asCeo(() => api.assignIssue(target.id, "PSN-02"));

    const reports = await asCeo(() => api.listReports(target.id));
    const dri = reports.find((r) => r.key === "dri");
    expect(dri?.awaiting?.name).toBe("白田田");
    // 不许伪造一份四节全空的 ResearchDoc 来放那句等待文案。
    expect(dri?.doc).toBeUndefined();

    // 「从什么时候起」和 DRI 那侧的 assignedAt 是同一个事实、同一段算法。
    const mine = await asDri("PSN-02", () => api.listMyHandoffs());
    expect(dri?.awaiting?.since).toBe(mine.find((h) => h.issueId === target.id)?.assignedAt);
  });

  it("没指派就没有这个页签", async () => {
    const target = await freshIssue("要不要把官网首页的字标换掉");
    const reports = await asCeo(() => api.listReports(target.id));
    expect(reports.some((r) => r.key === "dri")).toBe(false);
  });

  it("回传之后是报告，等待态消失", async () => {
    const target = await freshIssue("要不要把试用期从 14 天延到 30 天");
    await asCeo(() => api.assignIssue(target.id, "PSN-02"));
    await asDri("PSN-02", () => api.submitDriReport(target.id, filledDoc));

    const dri = (await asCeo(() => api.listReports(target.id))).find((r) => r.key === "dri");
    expect(dri?.awaiting).toBeUndefined();
    expect(dri?.doc?.sourceText).toContain("三家都在自建");
  });
});

/**
 * 一轮深研三条链路各写一份原件之后，这一栏有几个页签。
 *
 * 单测里跑不出一轮真的深研（出不了网、也不许调模型），所以直接把那份文档摆成要验的
 * 样子。要钉的不是模型写了什么，是读侧那三件事：
 *
 * · 另外两条链路**各长成一个页签，而且不是 ResearchDoc** —— 四节压缩、划线锚点、判断板
 *   都只从主源那一份来（理由在 `a4/run.ts` 头部：判断板只有一块，「板上这一条出自哪一份
 *   原件」在产品上没有答案）。
 * · **装配清单和用时各是自己的**。三条链路各自编命题、各自联网取证，抓回来的页不一样、
 *   花的时间也不一样；只有时刻共享（同一轮收尾）。
 * · **页签顺序按产出带来的 `tabOrder` 排**，主源不一定在第一栏 —— 屏幕上那排是
 *   `DeepSeek │ Claude │ ChatGPT`，而主源是最后那一条。
 */
describe("listReports 里的三条链路", () => {
  /*
   * 主源是 ChatGPT 那一条（`a4/run.ts` 的 `PRIMARY_SLOT`），所以它的 `sourceTabOrder`
   * 是 2 —— 它在屏幕上排最后一栏，而在数据里它是单独一份文档、不在 `altReports` 里。
   */
  const docWith = (issueId: string, alts?: AltReport[]): ResearchDoc => ({
    issueId,
    judgment: [{ text: "决策权已经移到业务线", traces: [] }],
    keyEvidence: [{ text: "两个已投标客户的决策人换了", traces: [] }],
    counters: [{ text: "样本只有两个客户", traces: [] }],
    unknowns: [{ text: "另外两个行业还没查", traces: [] }],
    routeSuggestion: "建议上会",
    byAgentLabel: "CEO Agent",
    assembledFrom: [{ label: "投标记录", href: "/docs/DOC-01" }],
    sourceText: "## 核心判断\n\nChatGPT 那条链路写的原文。",
    sourceLabel: "ChatGPT",
    sourceTabOrder: 2,
    at: "2026-08-25T02:00:00.000Z",
    durationMs: 183000,
    ...(alts ? { altReports: alts } : {}),
  });

  const question = { text: "定价改按用量吗", suggestedDri: "白田田", deadline: "48小时" };

  it("主源那份是文档，另一条只有原文 —— 而那份装配清单和用时是它自己的", async () => {
    const target = await freshIssue("要不要把每条链路自己的证据包也摆到屏幕上");
    seedResearched(
      target.id,
      docWith(target.id, [
        {
          modelAlias: "claude-opus-5",
          label: "Claude",
          tabOrder: 1,
          text: "## 核心判断\n\nClaude 那条链路写的原文。",
          assembledFrom: [{ label: "外部检索 · Claude 那条链路取回 4 页、入账 6 条" }],
          durationMs: 121_000,
        },
      ]),
      question
    );

    const reports = await asCeo(() => api.listReports(target.id));
    // Claude(1) 排在主源(2) 前面 —— 顺序由 `tabOrder` 定，不是「主源永远第一栏」。
    expect(reports.map((r) => r.key)).toEqual(["agent:alt1", "agent"]);
    // 页签名字由那一轮自己报（链路表 → `sourceLabel` / `AltReport.label`），不在读侧硬编码。
    expect(reports.map((r) => r.label)).toEqual(["Claude", "ChatGPT"]);

    // 主源那一份是完整文档：四节、锚点、判断板都从它来。
    expect(reports[1].doc?.sourceText).toContain("ChatGPT 那条链路写的原文");
    // 另一条**不是** ResearchDoc。伪造一份四节出来，判断板就有了两个出处。
    expect(reports[0].doc).toBeUndefined();
    expect(reports[0].source?.text).toContain("Claude 那条链路写的原文");

    /*
     * **装配清单和用时各取自己那一份，不抄主源的。** 三条链路各自联网取证，抄过来就是在
     * 屏幕上把 ChatGPT 取回的页说成是 Claude 取回的 —— 而那份清单是拿来对账的。
     */
    expect(reports[0].source?.durationMs).toBe(121_000);
    expect(reports[0].source?.durationMs).not.toBe(reports[1].doc?.durationMs);
    expect(reports[0].source?.assembledFrom?.[0]?.label).toContain("Claude 那条链路");
    // 只有时刻是共享的：那是这一轮深研收尾的时刻，三条链路属于同一轮。
    expect(reports[0].source?.at).toBe(reports[1].doc?.at);
    expect(reports[0].source?.byAgentLabel).toBe("CEO Agent");
  });

  it("三条链路排成 DeepSeek → Claude → ChatGPT，key 跟着身份不跟着位置", async () => {
    const target = await freshIssue("要不要把三条链路都摆到屏幕上");
    seedResearched(
      target.id,
      docWith(target.id, [
        {
          modelAlias: "deepseek-v4-pro",
          label: "DeepSeek",
          tabOrder: 0,
          text: "## 核心判断\n\nDeepSeek 那条链路写的原文。",
          kind: "writer",
          durationMs: 141_000,
        },
        {
          modelAlias: "claude-opus-5",
          label: "Claude",
          tabOrder: 1,
          text: "## 核心判断\n\nClaude 那条链路写的原文。",
          kind: "writer",
          durationMs: 121_000,
        },
      ]),
      question
    );

    const reports = await asCeo(() => api.listReports(target.id));
    expect(reports.map((r) => r.label)).toEqual(["DeepSeek", "Claude", "ChatGPT"]);
    /*
     * key 按 `tabOrder` 拼，和这一轮还在跑时上报草稿用的是同一套算法（`DraftReport.key`）。
     * 按数组下标拼的话，中间那条链路没跑成时后面那条的 key 会往前挪一格 —— 他正读着的那
     * 一栏在报告落库那一瞬换了 key，屏幕把他弹回主源。
     */
    expect(reports.map((r) => r.key)).toEqual(["agent:alt0", "agent:alt1", "agent"]);
    // 三条各是 writer：没有谁读谁（那一步 2026-08-25 删了）。
    expect(reports[0].source?.kind).toBe("writer");
    expect(reports[0].source?.basedOn).toBeUndefined();
    expect(reports[1].source?.kind).toBe("writer");
    // 用时三栏各说自己的。
    expect(reports[0].source?.durationMs).toBe(141_000);
    expect(reports[1].source?.durationMs).toBe(121_000);
    expect(reports[2].doc?.durationMs).toBe(183_000);
  });

  it("老库里那份合出来的报告仍然带着「怎么来的」—— 屏幕上那句说明不许靠 label 猜", async () => {
    /*
     * `kind: "synthesis"` 是 2026-08-25 之前那一版的产物（读完前面两份再合出一份）。那一步
     * 删掉了，但**老库里躺着几份**，所以读侧仍要把 `kind` / `basedOn` 原样带出去：丢在这一
     * 层的话，报告页头只能按页签上的字猜 —— 而那会把「另一条链路自己取的证」这句话写在一份
     * 根本没联网的报告上。
     *
     * 老数据也没有 `tabOrder`（那时候主源确实是第一栏），所以这里顺带钉住那条回落。
     */
    const target = await freshIssue("要不要让老库里那份合出来的报告也读得出来");
    seedResearched(
      target.id,
      {
        ...docWith(target.id, [
          {
            modelAlias: "kimi-k3",
            label: "K3 报告原文",
            text: "## 核心判断\n\nK3 写的那一份原文。",
            kind: "writer",
          },
          {
            modelAlias: "gpt-5.6",
            label: "多模型报告",
            text: "## 核心判断\n\n合出来的那一份原文。",
            kind: "synthesis",
            basedOn: ["V4", "K3"],
          },
        ]),
        sourceLabel: "V4 报告原文",
        sourceTabOrder: undefined,
      },
      question
    );

    const reports = await asCeo(() => api.listReports(target.id));
    // 没有 `tabOrder` 时回落成原来那个顺序：主源第一栏，其余按数组位置。
    expect(reports.map((r) => r.key)).toEqual(["agent", "agent:alt0", "agent:alt1"]);
    expect(reports.map((r) => r.label)).toEqual(["V4 报告原文", "K3 报告原文", "多模型报告"]);

    // 它同样不是 ResearchDoc：四节仍然只从主源那一份压出来。
    expect(reports[2].doc).toBeUndefined();
    expect(reports[2].source?.text).toContain("合出来的那一份原文");
    expect(reports[2].source?.kind).toBe("synthesis");
    expect(reports[2].source?.basedOn).toEqual(["V4", "K3"]);
    // 写手那几份仍然是 writer，不许被这一栏带跑。
    expect(reports[1].source?.kind).toBe("writer");
    expect(reports[1].source?.basedOn).toBeUndefined();
    /*
     * 老数据里 `durationMs` / `assembledFrom` 根本不存在，那就**不给** —— 回落到主源那一份
     * 会把「这几份共享一套证据」那句已经不成立的话重新写回屏幕上。
     */
    expect(reports[2].source?.durationMs).toBeUndefined();
    expect(reports[2].source?.assembledFrom).toBeUndefined();
    expect(reports[2].source?.at).toBe(reports[0].doc?.at);
  });

  it("只跑成一条时不多一个空页签", async () => {
    // 另外两把钥匙没配、或者那两条链路这一轮都没写成 —— 都落在这里：字段根本不存在。
    const target = await freshIssue("要不要在只剩一条链路时也留一栏");
    seedResearched(target.id, docWith(target.id), question);

    const reports = await asCeo(() => api.listReports(target.id));
    expect(reports.map((r) => r.key)).toEqual(["agent"]);
  });
});

describe("escalate 不再替 DRI 回话", () => {
  it("交接包发出之后就停在等证据：没有「方案回传」、没有「X 承接中」、没人被自动认领", async () => {
    /*
     * 从「深研报告已到、题已定」出发 —— 旧代码那段模拟正是关在 `if (brief)` 里的，
     * 而 `synthBrief` 没有深研报告就返回 null。不预置这一份，旧代码同样走 else 分支，
     * 这条断言就锁不住任何东西（上一版就是这样，RED 从未发生）。
     */
    const target = await freshIssue("要不要把 Agent 的定价从按座位改成按用量");
    seedResearched(
      target.id,
      {
        issueId: target.id,
        judgment: [{ text: "按用量更贴合客户的真实使用", traces: [] }],
        keyEvidence: [{ text: "三家客户的座位数远大于活跃数", traces: [] }],
        counters: [{ text: "按用量的收入可预测性差", traces: [] }],
        unknowns: [{ text: "不知道用量的月度波动有多大", traces: [] }],
        routeSuggestion: "建议上会",
        byAgentLabel: "CEO Agent",
        assembledFrom: [],
      },
      { text: "定价改按用量吗", suggestedDri: "白田田", deadline: "48小时" }
    );

    await asCeo(() => api.escalate(target.id, false));

    const timeline = await asCeo(() => api.getTimeline(target.id));
    // 真人还没交东西，屏幕上不许出现一条他「给出方案」的记录。
    expect(timeline.some((e) => e.headline.includes("方案回传"))).toBe(false);

    const after = await asCeo(() => api.getIssue(target.id));
    expect(after.state).toBe("WaitingEvidence");
    // 也不替真人认领：谁承接由「指派负责人」显式点名。
    expect(after.assigneeName).toBeUndefined();
    // 「白田田承接中」和「承接研究 · 未指派」不许同屏出现，所以这句话根本不写。
    expect(after.monitoringNote).toBeUndefined();

    // 没被点名，白田田那侧就收不到这一件 —— 屏幕两侧说的是同一件事。
    const mine = await asDri("PSN-02", () => api.listMyHandoffs());
    expect(mine.map((h) => h.issueId)).not.toContain(target.id);
  });
});

describe("briefText", () => {
  it("stanceRedacted === false 时输出包含 divergences，true 时不包含", () => {
    const testBrief: Brief = {
      issueId: "ISS-TEST",
      coreJudgment: "核心判断测试",
      problem: "要回答的测试问题",
      driRecommendation: { text: "DRI 推荐测试", traces: [] },
      keyEvidence: [{ text: "关键证据1", traces: [] }],
      strongestCounter: { text: "最强反证测试", traces: [] },
      divergences: [
        { kind: "fact", text: "事实分歧测试", note: "事实不足 · 可查证" },
        { kind: "value", text: "价值分歧测试", note: "价值取舍 · 只能您拍板" },
      ],
      suggestedQuestions: [{ q: "测试问题", implication: "测试影响" }],
      byAgentId: "AGT-TEST",
      stanceRedacted: false,
    };

    // stanceRedacted === false 时，divergences 进正文
    const withStance = briefText(testBrief);
    expect(withStance).toContain("## 开放分歧");
    expect(withStance).toContain("事实分歧测试");
    expect(withStance).toContain("价值分歧测试");

    // stanceRedacted === true 时，divergences 不进正文
    testBrief.stanceRedacted = true;
    const withoutStance = briefText(testBrief);
    expect(withoutStance).not.toContain("## 开放分歧");
    expect(withoutStance).not.toContain("事实分歧测试");
    expect(withoutStance).not.toContain("价值分歧测试");

    // 其他字段应该在两种情况下都存在
    expect(withStance).toContain("核心判断测试");
    expect(withStance).toContain("## 要回答的问题");
    expect(withStance).toContain("## 这一份的推荐");
    expect(withStance).toContain("## 关键证据");
    expect(withStance).toContain("## 最强反证");
    expect(withStance).toContain("## 他会问的");

    expect(withoutStance).toContain("核心判断测试");
    expect(withoutStance).toContain("## 要回答的问题");
    expect(withoutStance).toContain("## 这一份的推荐");
    expect(withoutStance).toContain("## 关键证据");
    expect(withoutStance).toContain("## 最强反证");
    expect(withoutStance).toContain("## 他会问的");
  });
});
