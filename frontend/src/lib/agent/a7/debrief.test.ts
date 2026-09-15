/**
 * A7 会后提炼的出口形状。**钉的全是「错了以后在屏幕上看不出来」的那几件。**
 *
 * 这条链路的每一种坏法都不报错、不白屏，交出来的卡片读起来都通顺 —— 这正是它值得
 * 单测的理由。逐条说清各自错了之后屏幕上长什么样：
 *
 *   · **议题号指错。** 这场会的产物落到另一件议题的卡片上。那张卡上什么异常都没有：
 *     要点读着通顺，只是说的不是那件事。他会按着别的会的结论决定这一件。
 *   · **第一行空了。** 卡面顶上开一个天窗，下面几条要点照常显示 —— 于是这张卡看起来
 *     是好的，只有「这场会把这件事推到哪儿了」这个唯一要他判的东西不见了。
 *   · **边界 / 负责人 / 期限被写成空串而不是不存在。** 屏幕上会出现一个叫「未指定」的
 *     人、一条到头处是空白的结论。空串和「这一栏没有」在渲染里分不开，而在事实上
 *     完全是两回事。
 *   · **条数上限失效。** 卡片撑成第二份纪要，而它存在的全部理由是扫一眼就能按。
 *   · **`consensus.reached` 判成了 true 却还列着没定的事。** 卡上默认高亮确认键，他一按
 *     就把一件还悬着的事变成了公司口径。这一条只能靠台账里的 A7-05 看见。
 *   · **两样都空的议题交了一份空壳。** 他的待处理里凭空多一张卡，点开是空的 —— 而
 *     「这场会没谈到它」本来就该什么都不出现。
 *   · **任务那一段装的不是任务。** 三种坏法各自都读得通：做不完的（「继续讨论定价」）、
 *     替他把人派了的（「小张出一版报价模型」）、把还没谈拢的事排进要做的事的（「目标客户
 *     标准还没定」）。他按下的那颗键的含义是「这件议题就此往下做」，所以这三种各自是：
 *     部署了一句「接着聊」、给一个不知情的人派了活、把一件悬着的事变成了公司口径。
 *     只能靠台账里的 A7-06 / A7-07 / A7-08 看见。
 *
 * 不出网也不真调模型：`TKOS_MODEL_MOCK=1` 让 `callModel` 落到罐头上（那一档也一起测，
 * 它是离线跑唯一的真实形状来源）。要考具体某种坏输出时才用 `answer()` 顶一次回复 ——
 * `{ spy: true }` 不写工厂，默认仍然走真模块，所以两种姿态能在同一个文件里并存。
 */
process.env.TKOS_MODEL_MOCK = "1";

import { describe, expect, it, vi } from "vitest";

import { callModelJson } from "@/lib/agent/json";

import {
  checkDebriefs,
  extractDebrief,
  resolveLabel,
  type DebriefDraft,
  type DebriefInput,
} from "./debrief";

vi.mock("@/lib/agent/json", { spy: true });

type Reply = Awaited<ReturnType<typeof callModelJson>>;

/** 顶掉下一次模型调用，交一份指定的 JSON。只顶一次 —— 其余仍然走罐头。 */
function answer(body: Record<string, unknown>): void {
  vi.mocked(callModelJson).mockResolvedValueOnce({
    text: JSON.stringify(body),
    usage: { inputTokens: 11, outputTokens: 22, cachedInputTokens: 0, reasoningTokens: 0 },
    ms: 5,
    slot: "pro",
    alias: "mock",
    providerModelId: "mock",
    effortSent: null,
    stopReason: "stop",
  } as unknown as Reply);
}

const input: DebriefInput = {
  slotLabel: "周四 9/4 · 14:00–15:30",
  issues: [
    { id: "ISS-901", title: "灯塔项目首版边界", judgements: ["首版可以浅，但端到端形态要成立。"] },
    { id: "ISS-902", title: "定价与收入组合", judgements: [] },
  ],
  transcript: "（转写）口径这一层今天定了，成本那一档还等实测数据。",
};

/** 比第一行的上限（60）多一个字。写成常量是为了让「多一个字就响」这件事看得见。 */
const SUMMARY_OVER = 61;

/** 一份形状完整的提炼。各条测试只改自己要考的那一个字段。 */
const draft = (over: Partial<DebriefDraft> = {}): DebriefDraft => ({
  issueId: "ISS-901",
  summary: "首版边界从要不要做完整形态推进到覆盖多深，验收标准还没定。",
  points: [
    { text: "出一版首版验收标准，写清哪三件事算通过。", boundary: "只到验收标准，排期和人力不在里面。" },
  ],
  // 待办这一段反过来：人和期限是会上真说了的那句原话，照记 —— 它不该被任务那三条规则碰到。
  todos: [{ text: "出一版首期验证的组织范围清单", owner: "小张", due: "周五之前" }],
  open: ["首版完整形态覆盖到什么深度，下一轮要带一份验收清单回来。"],
  consensus: { reached: false, reason: "形态这一层落了锤，验收标准还依赖没到手的项目方案。" },
  ...over,
});

describe("A7 会后提炼", () => {
  it("罐头这一档：五样都在，没给的字段是**不存在**而不是空串", async () => {
    const { debriefs, run } = await extractDebrief(input);

    expect(debriefs.map((d) => d.issueId)).toEqual(["ISS-901", "ISS-902"]);
    const d = debriefs[0];

    // 卡面第一行。空的时候屏幕上是一张顶上开着天窗、下面照常好看的卡。
    expect(d.summary.length).toBeGreaterThan(0);

    /*
     * 会上划了边界的那一条带 `boundary`，没划的那一条**整个字段不出现**。
     * `toBeUndefined()` 不够 —— `{ boundary: "" }` 也能过，而空串落到展开里是一条
     * 「到头处是空白」的结论，看起来像边界没写出来，实际是它被编了一个空的。
     */
    expect(d.points[0].boundary).toBeTruthy();
    expect("boundary" in d.points[1]).toBe(false);

    // 假模型手上没有任何人名和时间，这两栏一个都不许有 —— 同上一条的验法。
    expect("owner" in d.todos[0]).toBe(false);
    expect("due" in d.todos[0]).toBe(false);
    // label 反过来是无条件给的（同 principal）：罐头写了实在的标签，不是靠兜底垫出来的。
    expect(d.todos[0].label).toBe("成本口径拍板");

    expect(d.open.length).toBeGreaterThan(0);
    // 多数会议是没谈拢的。罐头给 true 会让离线跑的每张卡都默认高亮确认键。
    expect(d.consensus.reached).toBe(false);
    expect(d.consensus.reason.length).toBeGreaterThan(0);

    expect(run.agent).toBe("A7");
    expect(run.status).toBe("ok");
    expect(run.input).toBe("周四 9/4 · 14:00–15:30 · 2 件议题 · 转写 26 字");
  });

  it("指到不在这场会上的议题号 —— 丢掉，不猜一个最像的", async () => {
    answer({
      debriefs: [
        {
          issueId: "ISS-999",
          summary: "这一句属于另一件议题。",
          points: [{ text: "会上把口径定了。" }],
          todos: [],
          open: [],
          consensus: { reached: false, reason: "" },
        },
      ],
    });

    const { debriefs, run } = await extractDebrief(input);

    expect(debriefs).toHaveLength(0);
    // 一条都没提炼出来是 ignored 不是 ok：它和「一场只有寒暄的会」必须分得开。
    expect(run.status).toBe("ignored");
    expect(run.trace.some((n) => n.label.includes("不在这场会上"))).toBe(true);
  });

  it("第一行空了就顶上第一条要点，并且留痕 —— 不许交一份没有第一行的卡", async () => {
    answer({
      debriefs: [
        {
          issueId: "ISS-901",
          summary: "  ",
          points: [{ text: "首版必须端到端成立，不交孤立功能。" }],
          todos: [],
          open: [],
          consensus: { reached: false, reason: "验收标准还没谈。" },
        },
      ],
    });

    const { debriefs, run } = await extractDebrief(input);

    expect(debriefs[0].summary).toBe("首版必须端到端成立，不交孤立功能。");
    expect(run.trace.some((n) => n.label.includes("没有第一行"))).toBe(true);
  });

  it("「无」「未指定」这类占位词不是值 —— 边界、负责人、期限一律当没有", async () => {
    answer({
      debriefs: [
        {
          issueId: "ISS-901",
          summary: "口径这一层定了。",
          points: [{ text: "会上把口径定了。", boundary: "无" }],
          todos: [{ text: "把口径落成一页纸", owner: "未指定", due: "" }],
          open: ["待定", "  ", "成本那一档按哪个口径算。"],
          consensus: { reached: false, reason: "待定" },
        },
      ],
    });

    const { debriefs } = await extractDebrief(input);
    const d = debriefs[0];

    // 留着的话，屏幕上会出现一个叫「未指定」的人和一条边界写着「无」的结论。
    expect("boundary" in d.points[0]).toBe(false);
    expect("owner" in d.todos[0]).toBe(false);
    expect("due" in d.todos[0]).toBe(false);
    expect(d.open).toEqual(["成本那一档按哪个口径算。"]);
    expect(d.consensus.reason).toBe("");
  });

  it("要点、待办、未决各封到五条 —— 卡片撑开就成了第二份纪要", async () => {
    const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);
    answer({
      debriefs: [
        {
          issueId: "ISS-901",
          summary: "口径这一层定了。",
          points: many(7, "要点").map((text) => ({ text })),
          todos: many(7, "待办").map((text) => ({ text })),
          open: many(8, "未决"),
          consensus: { reached: false, reason: "还有几件悬着。" },
        },
      ],
    });

    const { debriefs } = await extractDebrief(input);
    const d = debriefs[0];

    expect(d.points).toHaveLength(5);
    expect(d.todos).toHaveLength(5);
    expect(d.open).toHaveLength(5);
    // 截的是尾巴不是头：模型把最要紧的写在前面，从中间挑一条留下才是真的没有依据。
    expect(d.points[0].text).toBe("要点1");
  });

  it("两样都空的议题不交一份空壳 —— 待处理里不该凭空多一张点开是空的卡", async () => {
    answer({
      debriefs: [
        {
          issueId: "ISS-901",
          summary: "这件事今天只被提了一句。",
          points: [],
          todos: [],
          open: ["下一轮再谈。"],
          consensus: { reached: false, reason: "没谈。" },
        },
      ],
    });

    const { debriefs, run } = await extractDebrief(input);

    expect(debriefs).toHaveLength(0);
    expect(run.status).toBe("ignored");
  });

  it("新增的两条自检真的会响，而且接进了台账：第一行超长（A7-04）、说定了却还列着没定的事（A7-05）", async () => {
    const long = "定".repeat(SUMMARY_OVER);
    answer({
      debriefs: [
        {
          issueId: "ISS-901",
          summary: long,
          points: [{ text: "首版必须端到端成立。" }],
          todos: [],
          open: ["首版覆盖到什么深度还没定。"],
          consensus: { reached: true, reason: "会上说了就这么定。" },
        },
      ],
    });

    const { debriefs, run } = await extractDebrief(input);

    // 只记不挡：挡了卡片上就少一条，那比留着一条超长的第一行更糟。
    expect(debriefs).toHaveLength(1);
    expect(run.status).toBe("ok");
    expect(run.violations?.some((v) => v.startsWith("A7-04 p1"))).toBe(true);
    expect(run.violations?.some((v) => v.startsWith("A7-05 p1"))).toBe(true);
  });

  it("两条新规则各自只在该响的时候响 —— 合规的那一份一条都不出", () => {
    expect(checkDebriefs([draft()])).toHaveLength(0);

    const over = checkDebriefs([draft({ summary: "定".repeat(SUMMARY_OVER) })]);
    expect(over.map((v) => v.rule)).toEqual(["A7-04"]);
    expect(over[0].severity).toBe("p1");

    /*
     * 「谈拢了」和「还有这几件没定」同时出现，两者必有一个是错的。不改哪一边 ——
     * 改 `reached` 是替他放弃一次确认，改 `open` 是把一件悬着的事抹掉，方向完全相反。
     */
    const clash = checkDebriefs([draft({ consensus: { reached: true, reason: "会上落了锤。" } })]);
    expect(clash.map((v) => v.rule)).toEqual(["A7-05"]);
    expect(clash[0].severity).toBe("p1");

    // 真谈拢了、也确实没有悬着的事 —— 这一份不该被这条规则拦。
    expect(
      checkDebriefs([draft({ open: [], consensus: { reached: true, reason: "会上落了锤。" } })])
    ).toHaveLength(0);
  });

  it("任务做不完就响（A7-06）—— 「继续讨论」不是一件事，它属于未决", () => {
    const rules = (text: string) => checkDebriefs([draft({ points: [{ text }] })]).map((x) => x.rule);

    expect(rules("继续讨论目标客户的选择标准。")).toEqual(["A7-06"]);
    expect(rules("持续关注竞品的报价变化。")).toEqual(["A7-06"]);
    expect(rules("进一步明确首版的覆盖边界。")).toEqual(["A7-06"]);

    // 交得出东西的那一条不许被这条规则拦住 —— 拦住了，卡上就少一件真要做的事。
    expect(rules("出一版分三档的报价模型，每档写清对应的交付物。")).toEqual([]);
    expect(rules("评估三家供应商的报价，出一张对比表。")).toEqual([]);
  });

  it("任务里写了谁来做就响（A7-07，p0）—— 派给谁只有他在卡上点的那一下才算数", () => {
    const rules = (text: string) => checkDebriefs([draft({ points: [{ text }] })]).map((x) => x.rule);

    expect(rules("小张出一版分三档的报价模型。")).toEqual(["A7-07"]);
    expect(rules("由市场部牵头把候选区域收敛到两个。")).toEqual(["A7-07"]);
    expect(rules("李总负责跟客户对一轮价格。")).toEqual(["A7-07"]);

    // 这一条是 p0：一行读着通顺的任务安着一个没接过它的人，屏幕上和他自己点过的一模一样。
    expect(checkDebriefs([draft({ points: [{ text: "小张出一版报价模型。" }] })])[0].severity).toBe(
      "p0"
    );

    /*
     * 待办那一段反过来 —— 它记的就是会上点了名的那句原话，人名是它的内容而不是它的错。
     * 这条规则只看任务；漏了这一句，改法很容易顺手写成「整份产出里不许出现人名」。
     */
    expect(
      checkDebriefs([
        draft({ todos: [{ text: "小张周五之前出一版组织范围清单", owner: "小张", due: "周五之前" }] }),
      ])
    ).toHaveLength(0);
  });

  it("没谈拢的事被排进任务就响（A7-08，p0）—— 他一确认它就成了公司要做的事", () => {
    const bad = checkDebriefs([draft({ points: [{ text: "目标客户的选择标准还没定。" }] })]);
    expect(bad.map((x) => x.rule)).toEqual(["A7-08"]);
    expect(bad[0].severity).toBe("p0");

    // 同一句话写在未决里是对的 —— 这条规则不该顺手把 open 也管了。
    expect(checkDebriefs([draft({ open: ["目标客户的选择标准还没定。"] })])).toHaveLength(0);
  });

  it("三条新规则都接进了台账 —— 只记不挡，卡片照常交出去", async () => {
    answer({
      debriefs: [
        {
          issueId: "ISS-901",
          summary: "首版边界谈到了覆盖多深，没落锤。",
          points: [
            { text: "继续讨论首版要覆盖到多深。" },
            { text: "小张出一版首版验收标准。" },
            { text: "首版的验收标准还没定。" },
          ],
          todos: [],
          open: [],
          consensus: { reached: false, reason: "覆盖深度这一层没落锤。" },
        },
      ],
    });

    const { debriefs, run } = await extractDebrief(input);

    // 挡了卡片上就少一条 —— 一条写坏的任务他看得见，一条被吞掉的任务他看不见。
    expect(debriefs[0].points).toHaveLength(3);
    expect(run.status).toBe("ok");
    expect(run.violations?.some((v) => v.startsWith("A7-06 p1"))).toBe(true);
    expect(run.violations?.some((v) => v.startsWith("A7-07 p0"))).toBe(true);
    expect(run.violations?.some((v) => v.startsWith("A7-08 p0"))).toBe(true);
  });
});

describe("待办顶行标签（label）", () => {
  it("resolveLabel：真给了一句像样的短标签，原样收下", () => {
    expect(resolveLabel("产品方向决策确认", true)).toBe("产品方向决策确认");
  });

  it("resolveLabel：没给 / 占位词 / 长得像议题号或 mission 编号 —— 按 principal 分岔兜底", () => {
    expect(resolveLabel(undefined, true)).toBe("待您拍板的事项");
    expect(resolveLabel("", false)).toBe("待跟进事项");
    expect(resolveLabel("无", true)).toBe("待您拍板的事项");
    // 卡片顶行绝不许出现议题号或 mission 编号——出现了就当没给，落到兜底。
    expect(resolveLabel("ISS-221", true)).toBe("待您拍板的事项");
    expect(resolveLabel("跟进 MS-20260901-am 那件事", false)).toBe("待跟进事项");
  });

  it("resolveLabel：超长的标签截断，不整句扔进兜底", () => {
    const long = "一二三四五六七八九十十一十二十三十四十五";
    const got = resolveLabel(long, true);
    expect(long.startsWith(got)).toBe(true);
    expect(got.length).toBeLessThan(long.length);
  });

  it("模型真起了一句标签，原样进草稿 —— 不是每次都落到兜底", async () => {
    answer({
      debriefs: [
        {
          issueId: "ISS-901",
          summary: "口径这一层定了。",
          points: [],
          todos: [
            {
              text: "定下成本那一档对外按哪个口径报",
              principal: { needed: true, reason: "两个口径各有各的代价，只有他能选。" },
              label: "成本口径拍板",
            },
          ],
          open: [],
          consensus: { reached: false, reason: "还没落锤。" },
        },
      ],
    });

    const { debriefs } = await extractDebrief(input);
    expect(debriefs[0].todos[0].label).toBe("成本口径拍板");
  });

  it("模型这一条没给 label —— 兜底成一句能用的话，且按 principal 分岔", async () => {
    answer({
      debriefs: [
        {
          issueId: "ISS-901",
          summary: "口径这一层定了。",
          points: [],
          todos: [
            {
              text: "定下成本那一档对外按哪个口径报",
              principal: { needed: true, reason: "两个口径各有各的代价，只有他能选。" },
            },
            {
              text: "把口径落成一页纸",
              principal: { needed: false, reason: "口径已经定了，剩下是写。" },
            },
          ],
          open: [],
          consensus: { reached: false, reason: "还没落锤。" },
        },
      ],
    });

    const { debriefs } = await extractDebrief(input);
    expect(debriefs[0].todos[0].label).toBe("待您拍板的事项");
    expect(debriefs[0].todos[1].label).toBe("待跟进事项");
  });
});
