/**
 * 区块报告的验收：**这一份是整个仓库唯一一个渲染测试**（`vitest.config.ts` 那句
 * 「渲染不进这里」为它开了一个口子，理由写在那边）。
 *
 * 它盯的不是长相，是两件没有别的东西盯得住的事：
 *
 * 1. 十五种块每一种都真的画出了东西。TS 的穷尽 switch 只保证「有一个 case」，
 *    保证不了那个 case 里的组件不在运行时抛 —— 一个抛异常的渲染器会让整份报告白屏，
 *    而白屏在屏幕上和「这一轮没跑出来」长得一模一样。
 * 2. 半份 JSONL 照旧渲染（任务书 §6④）。这一条只有截断的输入才试得出来，而边跑边渲染
 *    正是这套东西存在的主要理由之一。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FIXTURE_JSONL, fixtureReport } from "@/lib/agent/a4/blocks/fixture";
import { parseBlocks } from "@/lib/agent/a4/blocks/parse";
import type { ReportBlocks } from "@/lib/agent/a4/blocks/schema";

import { BlockReport } from "./index";

const html = (report: ReportBlocks, streaming?: boolean): string =>
  renderToStaticMarkup(createElement(BlockReport, streaming ? { report, streaming } : { report }));

describe("§6① 全部组件渲染", () => {
  it("十五种块都在屏幕上留下了东西", () => {
    const r = fixtureReport();
    const out = html(r);

    // 每种块挑一句只有它才会产出的字。
    const musts = [
      r.title,
      "成立范围",
      "答不出",
      "共源×",
      "什么会推翻",
      "什么会升档",
      "未核验",
      "怎么裁",
      "只看有核验支撑的",
      // 证据利用率那一块：对账那一行在，弃用理由也露在屏幕上。数字两侧被 React 插了
      // 注释节点，所以只挑纯文本那一截 —— 数字本身由 blocks 那一侧的用例盯。
      "条，用上",
      "时点更旧",
    ];
    for (const m of musts) expect(out, `缺 ${m}`).toContain(m);

    // 每个块的第一句内容都要出现。
    for (const b of r.blocks) {
      const probe =
        b.type === "verdict_banner"
          ? b.text
          : b.type === "kpi_cards"
            ? b.cards[0].label
            : b.type === "caliber_map"
              ? b.rows[0].metric
              : b.type === "layered_table"
                ? b.columns[0]
                : b.type === "funnel"
                  ? b.stages[0].label
                  : b.type === "bar_compare"
                    ? b.items[0].label
                    : b.type === "scenario_cards"
                      ? b.cards[0].name
                      : b.type === "prose"
                        ? b.md.slice(0, 8)
                        : b.type === "judgment"
                          ? b.claim.slice(0, 8)
                          : b.type === "unverified_panel"
                            ? b.items[0].statement.slice(0, 8)
                            : b.type === "evidence_list"
                              ? b.items[0].claim.slice(0, 8)
                              : b.type === "evidence_usage"
                                ? b.discarded[0].reason.slice(0, 8)
                                : b.type === "divergence_view"
                                  ? b.topic.slice(0, 8)
                                  : b.type === "falsify_card"
                                    ? b.conditions[0].slice(0, 8)
                                    : b.outputs[0].label;
      // 行内 `[E1]` 变成了芯片，所以原句在 markup 里是被切开的 —— 取第一个引用之前那一截。
      expect(out, `${b.type} 没渲染出来`).toContain(probe.split(/\[E/)[0].slice(0, 12).trim());
    }

    // 计算器算出了数（算式读不通的话这句话会出现）。
    expect(out).not.toContain("算式读不通");
  });

  it("每一种块都有一节标题落进章节导航", () => {
    const r = fixtureReport();
    const out = html(r);
    for (const b of r.blocks) {
      if (b.heading) expect(out).toContain(b.heading);
    }
  });
});

describe("§6④ 截断的前缀", () => {
  it("半份 JSONL 渲染得出东西，不白屏", () => {
    const cut = parseBlocks(FIXTURE_JSONL.slice(0, Math.floor(FIXTURE_JSONL.length * 0.55)));
    expect(cut.blocks.length).toBeGreaterThan(2);
    // 跑到一半时证据表还没折出来 —— 正文里的编号点不开，那是预期状态。
    const half: ReportBlocks = {
      title: cut.meta?.title ?? "",
      confidence: cut.meta?.confidence ?? "初步提示",
      dataCutoff: cut.meta?.dataCutoff ?? "",
      lane: { model: "x", short: "DeepSeek" },
      evidencePackId: "",
      blocks: cut.blocks,
      evidence: [],
    };
    const out = html(half, true);
    expect(out.length).toBeGreaterThan(500);
    expect(out).toContain("还在交后面几块");
    expect(out).toContain("skeleton");
  });

  it("一块都还没交：只有骨架，并且说得出这不是坏了", () => {
    const out = html(
      {
        title: "",
        confidence: "初步提示",
        dataCutoff: "",
        lane: { model: "x", short: "Claude" },
        evidencePackId: "",
        blocks: [],
        evidence: [],
      },
      true,
    );
    expect(out).toContain("还没有一块读得通的");
  });
});

describe("坏行记账", () => {
  it("坏了几行照旧渲染，并且报得出几行", () => {
    const r = fixtureReport();
    r.bad = [{ line: 7, text: '{"type":"prose"', why: "这一行不是合法 JSON" }];
    const out = html(r);
    expect(out).toContain("有 1 行没读通");
  });
});

describe("§6③ 窄面板", () => {
  it("没有一个像素单位的宽度 —— 固定量只有 rem", () => {
    const out = html(fixtureReport());
    const px = [...out.matchAll(/w-\[[^\]]*px[^\]]*\]/g)].map((m) => m[0]);
    expect(px).toEqual([]);
    /*
     * 宽表格的横滚关在自己的盒子里，**而且竖向不滚**（`scroll-x-only`，理由整段写在
     * `globals.css` 那个类上面）。裸的 `overflow-x-auto` 会让鼠标压在表格上时整页滚不动 ——
     * 那是 2026-09-07 从他读报告时撞出来的，而这一层没有任何别的东西盯得住它。
     */
    expect(out).toContain("scroll-x-only");
    expect(out).not.toContain("overflow-x-auto");
  });

  it("没有一处 shadow —— 内容层的边界一律是发丝线", () => {
    expect(html(fixtureReport())).not.toContain("shadow-");
  });
});
