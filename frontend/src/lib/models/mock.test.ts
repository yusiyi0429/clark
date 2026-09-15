import { describe, expect, it } from "vitest";

import { mockText } from "./mock";

const parse = (hint: string) => JSON.parse(mockText(hint)) as Record<string, unknown>;

describe("假模型", () => {
  it("四个 A1a prompt 各有自己的罐头，路由值合法", () => {
    expect(parse("a1a.triage").decision).toBe("new_issue");
    expect(parse("a1a.issue.new").decision).toBe("new_issue");
    expect(parse("a1a.issue.update").decision).toBe("update_issue");
    expect(parse("a1a.issue.external").decision).toBe("new_issue");
  });

  it("A3 的罐头带齐 PreResearchDoc 的九个字段（2026-09-05 加 verdict / premises）", () => {
    const o = parse("a3.pre-research");
    expect(Object.keys(o).sort()).toEqual(
      ["finding", "openQuestion", "premises", "question", "soWhat", "status", "statusReason", "take", "verdict"].sort()
    );
    expect(String(o.verdict).length).toBeGreaterThan(0);
    // 罐头也要过 status 那条一致性检查，不然 mock 跑一遍就是一条 p0。
    expect(o.status).toBe("valid");
    expect(o.statusReason).toBe("");
    expect(String(o.question).endsWith("？")).toBe(true);
    expect((o.finding as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it("A4 压缩那一层的罐头带齐五节，反证那条单独一个 key", () => {
    const o = parse("a4.digest");
    expect(Object.keys(o).sort()).toEqual(
      ["counters", "judgment", "keyEvidence", "routeSuggestion", "unknowns"].sort()
    );
    expect(Object.keys(parse("a4.challenge"))).toEqual(["counters"]);
  });

  it("A4 报告那一层的罐头是报告正文，不是 JSON 字符串", () => {
    /*
     * 报告那次调用走 `json:false`，要的就是正文。`mockText` 要是一律 stringify，
     * `sourceText` 里会存进一份带转义引号的假 JSON，而报告页签照样渲染 —— 屏幕上
     * 看不出哪里不对，只有人读到那份东西时才发现它满是反斜杠。
     */
    const t = mockText("a4.report");
    expect(t.startsWith("{")).toBe(false);
    expect(t).toContain("## 核心判断");
  });

  it("A4 报告那一份罐头要过得了出口对账", () => {
    /*
     * 离线跑走的是假检索加假页面，但**入账那几段是真跑的**：抓页、逐字定位引句、独立性
     * 折叠、覆盖判定一步都没跳。所以这份罐头得像一份真的取过证的报告：
     *
     *  · 至少引一个台账里真实存在的编号（离线一轮至少入账到 E2）—— 不然 A4-G02 会说
     *    「台账里有证据，正文一条都没引」，而那一轮重写在 mock 下永远修不好。
     *  · 有「未能核实的部分」这一节 —— 罐头的第二条命题故意查不到（见 `a4.props`）。
     *  · **不写「未联网」** —— 写了会被 A4-R07 判成自我否认：这一轮真的取了证。
     */
    const t = mockText("a4.report");
    expect(t).toContain("[E1]");
    expect(t).toContain("## 未能核实的部分");
    expect(t).not.toContain("未联网");
  });

  it("每条链路各一份罐头：同一套硬要求，几份互不相同", () => {
    /*
     * 一轮深研跑几条独立链路，几份原件同时摆在报告区。**这张表要跟着 `a4/run.ts` 的
     * `LANES` 走**：那边新接一条链路而这里不补一份罐头，离线跑那一栏出的是兜底 JSON ——
     * 屏幕上表现成「那一栏写了一份满是花括号的报告」，而它看起来像渲染坏了。
     *
     * 几份走的是**同一道出口对账**，所以上面那几件硬要求对每一份都成立 —— 少一件，离线
     * 跑就会在那一栏红成「这份报告没引任何编号」，而原因其实是罐头没写全。
     */
    const lanes = {
      DeepSeek: mockText("a4.report"),
      Claude: mockText("a4.report.claude"),
      ChatGPT: mockText("a4.report.gpt"),
    };

    for (const [label, t] of Object.entries(lanes)) {
      expect(t.startsWith("{"), label).toBe(false);
      expect(t, label).toContain("[E1]");
      expect(t, label).toContain("## 未能核实的部分");
      expect(t, label).not.toContain("未联网");
      // 兜底那份是 JSON，上面那几条它其实也过不了；点名一次是为了让失败的原话说得出病因。
      expect(t, label).not.toContain("准备罐头");
    }

    /*
     * 几份得看得出是几份不同的东西，**标题那句话也要各不相同**：页签切过去看到一模一样的
     * 开头，屏幕上表现成渲染错了。而同时出这几份的全部用处，是让一号位对照各条链路各自
     * 取证、各自写出来的结论 —— 几份罐头一致的话，这件事一次都没被验过。
     */
    const texts = Object.values(lanes);
    expect(new Set(texts).size).toBe(texts.length);
    expect(new Set(texts.map((t) => t.split("\n")[0])).size).toBe(texts.length);
  });

  it("哪一条都不许提到别的几份 —— 它们是独立链路，不是对照表", () => {
    /*
     * ChatGPT 那一栏 2026-08-25 换了身份：原来是「多模型报告」（读完前面两份再合出一份），
     * 现在是一条独立链路，自己编命题、自己联网取证、自己写。它跑的时候别的几条还在跑，所以
     * 它**不可能**知道别人写了什么。
     *
     * 罐头是这条要求唯一一处会被自动检查的地方（真模型那一遍靠指令，没人守着看）。这些字
     * 一旦回来，就说明有人把旧那份合成罐头搬回来了 —— 而那会让离线屏幕继续演一个已经删掉
     * 的步骤。
     */
    for (const hint of ["a4.report", "a4.report.claude", "a4.report.gpt"]) {
      const t = mockText(hint);
      for (const banned of ["第一份", "第二份", "另一份报告", "两份报告", "两种读法"]) {
        expect(t, `${hint} / ${banned}`).not.toContain(banned);
      }
    }
    // 旧键名也不许还在：`run.ts` 现在按 `a4.report.gpt` / `a4.report.claude` 找罐头，
    // 旧键并存等于留了一份谁都不会去改的死文案，而它的立场是照当时那个模型写的。
    for (const stale of ["a4.report.synth", "a4.report.alt"]) {
      expect(mockText(stale), stale).toContain(`没有为 ${stale} 准备罐头`);
    }
  });

  it("认不出 hint 时给一个能 parse 的兜底，并说明它是兜底", () => {
    // 抛异常的话，一条没登记的链路在 mock 下表现为「模型挂了」，
    // 而真正的问题是罐头没写 —— 两件事要分得开。
    const o = parse("a9.something");
    expect(o.note).toContain("没有为 a9.something 准备罐头");
  });
});
