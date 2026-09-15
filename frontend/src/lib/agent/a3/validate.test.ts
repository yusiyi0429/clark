import { describe, expect, it } from "vitest";

import type { PreResearchDoc, PreResearchStatus } from "@/lib/data/types";

import { validatePreResearch } from "./validate";

const trace = [{ kind: "int" as const, source: "投标记录" }];

/** 一份各项都过的预研。每个用例只动它要测的那一处。 */
function doc(over: Partial<PreResearchDoc> = {}): PreResearchDoc {
  return {
    issueId: "ISS-101",
    status: "valid",
    statusReason: "",
    verdict: "值得现在投入：决策权换层之后，技术评分不再是进场票。",
    premises: [],
    question: "入口移到交付侧之后，我们的模型能力还能不能带动成单？",
    take:
      "采购决策权正在从技术评估侧移到行业交付侧。两个已投标客户的决策人换成了业务线负责人。同期招标文件里技术评分权重从四成降到两成五。\n\n反问：这条链断了之后，我们还靠什么进场？",
    finding: [
      { label: "决策人已经换了层", text: "两个已投标客户的决策人在近一个季度换成业务线负责人。", traces: trace },
      { label: "评分口径跟着一起动", text: "同期公开招标文件里技术评分权重从四成降到两成五。", traces: trace },
    ],
    openQuestion: [{ text: "这个权重变化是一个行业的事，还是三个行业都在发生？", traces: trace }],
    soWhat: "值得升级：它压在我们最主要的那条获客假设上。",
    byAgentLabel: "您的 Agent",
    assembledFrom: [],
    at: "2026-08-19T10:00:00+08:00",
    ...over,
  };
}

const rules = (d: PreResearchDoc) => validatePreResearch(d).map((v) => `${v.rule}/${v.severity}`);

describe("A3 质量门 · Phase A 的定性结论", () => {
  it("基线那份 valid 的预研一条 p0 都不该有", () => {
    expect(validatePreResearch(doc()).filter((v) => v.severity === "p0")).toEqual([]);
  });

  it("没给 status 记 p0，不当成 valid", () => {
    // shape() 认不出的值一律记 null。这里要确认 null 会被打回 —— 不然「没人判过」
    // 和「判过、成立」在屏幕上分不开。
    expect(rules(doc({ status: null }))).toContain("S02-A/p0");
  });

  it("判了 invalid / reframing 却不说哪一处不对，记 p0", () => {
    for (const s of ["invalid", "reframing_needed"] as PreResearchStatus[]) {
      const v = validatePreResearch(doc({ status: s, statusReason: "  " }));
      expect(v.some((x) => x.rule === "S02-A" && x.severity === "p0"), s).toBe(true);
    }
  });

  it("判了 invalid 而结尾还在说值得升级，记 p0", () => {
    // 两句单独看都通顺，所以只有这一层对得出来。
    const v = validatePreResearch(
      doc({ status: "invalid", statusReason: "技术评分权重的下降只发生在一个行业。", soWhat: "值得升级：它压在获客假设上。" })
    );
    expect(v.some((x) => x.rule === "S02-A" && x.severity === "p0" && /自相矛盾/.test(x.message))).toBe(true);
  });

  it("判了 invalid 且结尾落在「不值得」上，就不该再报 status 那一组", () => {
    const v = validatePreResearch(
      doc({
        status: "invalid",
        statusReason: "权重下降只发生在一个行业，另外两个行业的招标口径没变。",
        soWhat: "不值得升级：削弱它的那条事实这一轮已经查实。",
      })
    );
    expect(v.filter((x) => x.rule === "S02-A")).toEqual([]);
  });

  it("判了 reframing 而结尾没说说法要改，记 p1（不挡）", () => {
    const v = validatePreResearch(
      doc({ status: "reframing_needed", statusReason: "问的对象是「模型能力」，真正在变的是进场路径。" })
    );
    expect(v.filter((x) => x.rule === "S02-A" && x.severity === "p1").length).toBe(1);
    expect(v.filter((x) => x.rule === "S02-A" && x.severity === "p0")).toEqual([]);
  });

  it("valid 却带了理由，记 p1 —— 那一句屏幕上不会显示", () => {
    expect(rules(doc({ statusReason: "顺手写的一句" }))).toContain("S02-A/p1");
  });

  it("statusReason 也走全局那几条：空词、markdown、member: 死链", () => {
    const v = validatePreResearch(
      doc({ status: "invalid", statusReason: "**赋能**不足，见 member:abc123。", soWhat: "不值得升级。" })
    );
    expect(v.map((x) => x.rule)).toEqual(expect.arrayContaining(["FE-md", "A7-03", "G-09"]));
  });
});

describe("A3 质量门 · 每条依据的判断式短标题", () => {
  it("少一句短标题记 p0 —— 缺了这一栏在结果页上看起来一切正常", () => {
    const v = validatePreResearch(
      doc({
        finding: [
          { text: "两个已投标客户的决策人在近一个季度换成业务线负责人。", traces: trace },
          { label: "评分口径跟着一起动", text: "同期招标文件里技术评分权重从四成降到两成五。", traces: trace },
        ],
      })
    );
    expect(v.some((x) => x.rule === "S02-B" && x.severity === "p0" && /第 1 个/.test(x.message))).toBe(true);
  });

  it("短标题是类目名而不是判断，记 p1（不挡）", () => {
    const v = validatePreResearch(
      doc({
        finding: [
          { label: "市场情况", text: "两个已投标客户的决策人在近一个季度换成业务线负责人。", traces: trace },
          { label: "评分口径跟着一起动", text: "同期招标文件里技术评分权重从四成降到两成五。", traces: trace },
        ],
      })
    );
    expect(v.filter((x) => x.rule === "S02-B" && x.severity === "p0")).toEqual([]);
    expect(v.some((x) => x.rule === "S02-B" && x.severity === "p1" && /类目名/.test(x.message))).toBe(true);
  });

  it("短标题里的 markdown 一样要被挡下来 —— 加粗是屏幕做的", () => {
    const v = validatePreResearch(
      doc({
        finding: [
          { label: "**决策人已经换了层**", text: "两个已投标客户的决策人换成业务线负责人。", traces: trace },
          { label: "评分口径跟着一起动", text: "同期招标文件里技术评分权重从四成降到两成五。", traces: trace },
        ],
      })
    );
    expect(v.some((x) => x.rule === "FE-md" && x.severity === "p0")).toBe(true);
  });
});

describe("待答问题的短标题也是屏幕上的正文", () => {
  /*
   * 查到了什么那几条的 `label` 早就算进全局那一摊（`validate.ts` 里那段注释论证过：
   * 它和 text 一样上屏，所以既要被 FE-md 挡、也要占 900 字预算）。
   *
   * **同一条论证对待答问题逐字成立** —— `json.ts` 的 `toStatements` 对两者一视同仁地
   * 保留 `label`，`StatementLine` 对两者一视同仁地渲染它，`signal-view.tsx` 用同一个
   * `StatementList` 渲染 `openQuestion`。而校验那一处只取了 `text`。
   *
   * 后果是：待答问题的短标题里写 `**` 不会被挡，会原样显示成星号 —— 而 FE-md 存在的
   * 全部理由就是挡这个。
   */
  it("待答问题的短标题里有 markdown，照样被 FE-md 挡下来", () => {
    const v = validatePreResearch(
      doc({
        openQuestion: [
          { label: "**三个行业都在动吗**", text: "这个权重变化是一个行业的事，还是三个行业都在发生？", traces: trace },
        ],
      })
    );
    expect(v.some((x) => x.rule === "FE-md")).toBe(true);
  });

  it("待答问题的短标题占 900 字预算，不是免费额度", () => {
    // 正文压到远低于上限，只靠三条短标题把总数顶过去。
    const long = "读". repeat(320);
    const v = validatePreResearch(
      doc({
        take: long,
        openQuestion: [
          { label: "读".repeat(200), text: "这个权重变化是一个行业的事？", traces: trace },
          { label: "读".repeat(200), text: "还是三个行业都在发生？", traces: trace },
          { label: "读".repeat(200), text: "我们手上有没有第三方口径？", traces: trace },
        ],
      })
    );
    expect(v.some((x) => x.rule === "A3-12")).toBe(true);
  });
});

describe("无依据的绝对化", () => {
  /*
   * `overclaim` 判的正是 `prompt.ts` 里那条硬规矩：「结论强度要匹配依据。依据不足就写
   * 『当前更支持』『初步支持』，不要无依据地绝对化。」
   *
   * A4 用它两处、A5 用它一处，**只有 A3 把这条留在提示词里祈祷** —— 而这个文件开头
   * 那段话说的就是这件事：「可数的东西写进 prompt 然后指望模型每次都数对，是这类项目
   * 最常见的失败……可数的就去数。」这一条是可数的。
   */
  it("绝对化又没有数字或编号撑着，记 p1", () => {
    const v = validatePreResearch(doc({ soWhat: "值得升级：这条链断了必然导致我们出局。" }));
    expect(v.some((x) => x.rule === "G-05" && x.severity === "p1")).toBe(true);
  });

  it("绝对化但句内有数或编号，放过 —— 它有依据", () => {
    const v = validatePreResearch(
      doc({ soWhat: "值得升级：两个客户的决策人已经换了，这条链必然要重走一遍（见 01-J2）。" })
    );
    expect(v.filter((x) => x.rule === "G-05")).toEqual([]);
  });

  it("p1 不挡门 —— 加这一条不会让本来能出稿的预研出不了稿", () => {
    const v = validatePreResearch(doc({ soWhat: "值得升级：这条链断了必然导致我们出局。" }));
    expect(v.filter((x) => x.rule === "G-05" && x.severity === "p0")).toEqual([]);
  });
});

describe("A3 质量门 · 预研 v3（2026-09-05）", () => {
  it("S02-C：判 invalid 的理由是「上下文没有证据表明…」—— p0", () => {
    const v = validatePreResearch(
      doc({
        status: "invalid",
        statusReason: "议题声称维信诺是第一个客户，但当前上下文没有任何证据表明该公司已与维信诺接触或维信诺表达过意向，议题基础不成立。",
        soWhat: "当前不值得升级深研。",
      })
    );
    expect(v.some((x) => x.rule === "S02-C" && x.severity === "p0")).toBe(true);
  });

  it("S02-C：理由是议题本身的问题 —— 不报", () => {
    const v = validatePreResearch(
      doc({ status: "invalid", statusReason: "量级不到本期 Outcome 的门槛，且与在版判断无关。", soWhat: "不值得升级。" })
    );
    expect(v.some((x) => x.rule === "S02-C")).toBe(false);
  });

  it("A3-20：verdict 空是 p0；没有立场（「进一步研究」）也是 p0", () => {
    expect(validatePreResearch(doc({ verdict: "" })).some((x) => x.rule === "A3-20" && x.severity === "p0")).toBe(true);
    expect(validatePreResearch(doc({ verdict: "这件事需要进一步研究后再定。" })).some((x) => x.rule === "A3-20" && x.severity === "p0")).toBe(true);
  });
});
