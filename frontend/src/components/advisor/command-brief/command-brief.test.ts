/**
 * 决断包这一屏的静态渲染。口径同 `blocks/render.test.ts` —— 这个仓库的单测跑在 node 上，
 * 没有 DOM，所以印成静态 HTML 看里面有没有该有的东西。
 *
 * 两条断言值得单独有一行会红的：
 *
 * · **命令上不预填负责人**。参谋手上没有名册，猜一个名字写上去，屏幕上那份带着假人名的
 *   命令和真的长得一模一样 —— 这类错只有断言拦得住。
 * · **没有决断包就挑不出东西来**。它是「旧报告的默认页仍然是判断板」那条硬要求的全部
 *   触发条件（`_views/advisor-view.tsx` 的 `picked`）。这一句一旦被谁改成「兜底给一个空
 *   的包」，行业题和老报告会当场换掉默认页，而屏幕上只是多了一格空白。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommandBriefView } from "./command-brief-view";
import { pickCommandBrief } from "./pick";
import type { CommandBrief } from "./types";

const brief: CommandBrief = {
  situation: [
    { text: "对手把首发挪到了三月 [E1]", evidenceRefs: ["E1"] },
    { text: "两家渠道口径不一致 [E2]", evidenceRefs: ["E2"] },
  ],
  recommendation: {
    action: "把首发提前到二月中",
    intent: "在对手之前占住渠道货架",
    whyNow: "渠道排期二月一日封版",
    confidence: "较强支持",
    evidenceRefs: ["E1", "E2"],
    evidenceEffect: "changed",
    evidenceEffectWhy: "取证前判断是四月发，[E1] 把窗口整体前移了六周",
  },
  decisionsRequired: [
    {
      question: "要不要动首发日期",
      recommendedChoice: "动，提前到二月中",
      costOfDelay: "过了一月三十一日渠道排期封版，这一轮就没了",
      recoveryIfWrong: "二月中之前都可以撤回排期，只损失一次报审",
    },
  ],
  proposedOrders: [
    {
      role: "产品负责人",
      outcome: "二月中可发的版本冻结，缺陷清单清空",
      dueOn: "2026-01-28",
      acceptance: ["主干无 p0", "三家渠道各出一份验收回执"],
      resources: ["交付技术两人"],
    },
  ],
  controls: {
    mustNot: ["不许为赶期删掉安全评审"],
    changeTriggers: ["对手把首发再挪一次"],
    abortConditions: ["渠道排期封版提前"],
    reviewAt: "2026-02-05",
  },
  alternatives: [{ action: "按原计划四月发", whenBetter: "渠道排期能加塞" }],
};

describe("决断包这一屏", () => {
  it("五段都渲染得出来，命令上不预填负责人", () => {
    const html = renderToStaticMarkup(
      createElement(CommandBriefView, { brief, evidence: [] }),
    );
    for (const s of [
      "参谋建议",
      "把首发提前到二月中",
      "证据改了判断",
      "请您决断",
      "拟制命令",
      "产品负责人",
      "指挥边界",
      "改变路线的证据",
      "批准并下达",
      "修改后批准",
      "暂缓",
      "退回参谋重拟",
    ]) {
      expect(html).toContain(s);
    }
    // 负责人那一格是空的 —— 没有名册，不预填（见 `types.ts` 的 `BriefOrderEdit.dri`）。
    expect(html).toContain('placeholder="批准时指定"');
    expect(html).not.toContain('value="产品负责人"');
  });

  it("没有决断包的报告挑不出东西来 —— 那时这一页连行动整理那一格都不长出来", () => {
    expect(pickCommandBrief(undefined)).toBeNull();
    expect(pickCommandBrief([{ key: "agent", label: "ChatGPT", awaiting: { name: "白田田", since: "2026-09-01" } }])).toBeNull();
  });
});

describe("不能下达的时候", () => {
  /*
   * 屏幕这一下是**提前告知**，闸在服务端（`store.approveCommandBrief`）—— 这一组测的只是
   * 「他不用按下去才知道」。原话由 `dispatchBlockReason` 出，两边同一句。
   */
  const blocked = "这一轮深研只交付了部分章节，核心论证没有写完 —— 可以读、可以接着追问，但不能据此下达命令。";

  it("主键置灰，原因写在按钮底下", () => {
    const html = renderToStaticMarkup(
      createElement(CommandBriefView, { brief, evidence: [], blocked }),
    );
    expect(html).toContain(blocked);
    // 「批准并下达」和「修改后批准」两颗都灰 —— 改完一屏才在最后一下被拒比一开始说不行坏。
    expect(html.match(/disabled=""/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // 暂缓和退回照旧能按：一份不能下达的决断包恰恰最需要这两个出口。
    expect(html).toContain("暂缓");
    expect(html).toContain("退回参谋重拟");
  });

  it("能下达时那句话不出现，主键不灰", () => {
    const html = renderToStaticMarkup(
      createElement(CommandBriefView, { brief, evidence: [] }),
    );
    expect(html).not.toContain("不能据此下达命令");
  });
});

/** 一段文字**紧挨着的那两层标签**。窗口开大会把别处的 class 扫进来（见下面那条注释）。 */
const slot = (html: string, text: string): string => {
  const at = html.indexOf(text);
  expect(at).toBeGreaterThan(-1);
  return html.slice(Math.max(0, at - 120), at);
};

describe("期限", () => {
  const withDue = (dueOn: string) => ({
    ...brief,
    proposedOrders: [{ ...brief.proposedOrders[0], dueOn }],
  });

  it("没写日期 → 时间待定，不是一片空白", () => {
    const html = renderToStaticMarkup(
      createElement(CommandBriefView, { brief: withDue(""), evidence: [] }),
    );
    expect(html).toContain("时间待定");
  });

  it("写的是相对时间 → 照原话摆着，不换算成某一天，也不进等宽数字那一档", () => {
    const html = renderToStaticMarkup(
      createElement(CommandBriefView, { brief: withDue("首访前"), evidence: [] }),
    );
    expect(html).toContain("首访前");
    expect(html).not.toContain("时间待定");
    /*
     * 等宽数字是给真日期用的（三条命令竖着对齐才看得出哪条先到）。这一条断的是那个
     * class 只跟着日期走 —— 它是「这一栏是不是被当成日期」在屏幕上唯一的痕迹。
     *
     * 只看紧挨着那一格的两层标签（`slot`），不看一整段：拟制命令那个小标题旁边的条数
     * 本来就是等宽数字，窗口开大一点就把它扫进来了。
     */
    expect(slot(html, "首访前")).not.toContain("tabular-nums");
  });

  it("真日期照旧走等宽数字", () => {
    const html = renderToStaticMarkup(
      createElement(CommandBriefView, { brief: withDue("2026-01-28"), evidence: [] }),
    );
    expect(slot(html, "2026-01-28")).toContain("tabular-nums");
  });
});
