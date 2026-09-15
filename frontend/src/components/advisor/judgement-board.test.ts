/**
 * 判断板上两件**没有症状**的事。口径同 `blocks/render.test.ts`：这个仓库的单测跑在
 * node 上，没有 DOM，所以印成静态 HTML 看里面有没有该有的东西。
 *
 * 两条都属于「坏了也不会有人报错」的那一类：
 *
 * · **同义重复的判断**。ISS-239 那一轮的当前判断 1 和 3 说的是同一件事的两个说法，摊在
 *   一排上时这块板看起来有三条判断、实际只有两条 —— 而屏幕上没有任何一处看得出来。
 *   折起来之后**一条都不许丢**：折的是版面，不是内容。
 * · **指不到东西的引用**。同一块板上出现过 `href=/docs/E30` —— `E30` 是那一份报告里的
 *   证据编号，不是文档号，点进去必然是「找不到文档 E30」。他点第二次就不再相信这一屏上
 *   任何一个可点的东西，而这件事在代码里一个报错都不会有。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { JudgementBoardPane, foldSynonymous, sameSaying, traceHref } from "./judgement-board";
import type { BoardJudgement, JudgementBoard } from "@/lib/data/types";

/** ISS-239 那一轮真落到板上的三条（`report-audit-ISS239/snapshot.json`），正文原样。 */
const S1 =
  "将维信诺首次拜访做成合肥 G6 或 ViP 产线的一个具体场景的验收标准定义会，共同确定验收指标、数据边界与离线验证授权，不展示 TKOS 完整能力，不报价，不推集团级方案。这比展示完整能力更可能换到第二次会面与客户认同。";
const S2 =
  "以 ViP 产业化进展作为开场叙事是成立的，因为 ViP 有已量产工艺、合肥 G6 升级线供货与 8.6 代调试等可公开引用链条。但必须同时携带一套车载场景备份叙事，以防客户对 ViP 话题设限或无对接人。";
const S3 =
  "应将此次维信诺首次拜访验证挂到 TKOS 战略主线下，新设或指定一个「维信诺首客验证」Mission，明确其目标为获取单场景验收标准与离线验证授权，而非签单或展示全能力。";

const judgement = (id: string, statement: string, extra: Partial<BoardJudgement> = {}): BoardJudgement => ({
  id,
  issueId: "ISS-239",
  statement,
  origin: "research",
  at: "2026-09-07T11:53:00+08:00",
  notes: [],
  ...extra,
});

const boardOf = (draft: BoardJudgement[]): JudgementBoard => ({
  issueId: "ISS-239",
  draft,
  confirmed: [],
  pending: null,
});

describe("同义重复折起来", () => {
  it("ISS-239 的 1 和 3 折成一条，2 单独站着", () => {
    const groups = foldSynonymous([
      judgement("BJ-1", S1),
      judgement("BJ-2", S2),
      judgement("BJ-3", S3),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].lead.id).toBe("BJ-1");
    expect(groups[0].echoes.map((e) => e.id)).toEqual(["BJ-3"]);
    expect(groups[1].lead.id).toBe("BJ-2");
    expect(groups[1].echoes).toEqual([]);
  });

  it("量出来的数：1↔3 过线，另外两对差一个数量级", () => {
    /*
     * 断具体数字而不是只断分组结果 —— 阈值（0.15）是在这一个样本上量出来的，改动它的人
     * 得看得见自己离两边各有多远。1↔3 是 0.17，1↔2 是 0.045，2↔3 是 0。
     */
    expect(sameSaying(S1, S3)).toBeGreaterThan(0.15);
    expect(sameSaying(S1, S2)).toBeLessThan(0.08);
    expect(sameSaying(S2, S3)).toBeLessThan(0.08);
  });

  it("折起来的那一条一个字都没丢 —— 屏幕上点开就在", () => {
    const html = renderToStaticMarkup(
      createElement(JudgementBoardPane, {
        board: boardOf([judgement("BJ-1", S1), judgement("BJ-3", S3, { boundary: "只适用于本次首访验证阶段" })]),
      }),
    );
    // 屏幕上是一条判断……
    expect(html).toContain("1 条");
    expect(html).toContain("另有 1 条说法与这条重合");
    // ……而被折起来那条的正文和它自己的边界都还在（`<details>` 里，点开就有）。
    expect(html).toContain("维信诺首客验证");
    expect(html).toContain("只适用于本次首访验证阶段");
  });

  it("不相干的两条各站各的", () => {
    const groups = foldSynonymous([judgement("BJ-1", S1), judgement("BJ-2", S2)]);
    expect(groups).toHaveLength(2);
  });
});

describe("指不到东西的引用不许长得像链接", () => {
  it("`/docs/E30`：证据编号进了文档路径 —— 不可点", () => {
    expect(traceHref("/docs/E30")).toBeNull();
  });

  it("`/docs/ISS-239`：议题号进了文档路径 —— 不可点", () => {
    expect(traceHref("/docs/ISS-239")).toBeNull();
  });

  it("真文档和外网地址照旧可点", () => {
    expect(traceHref("/docs/DOC-03")).toBe("/docs/DOC-03");
    expect(traceHref("https://example.com/a")).toBe("https://example.com/a");
    // 站内别的路由（不是 /docs/ 底下的）照旧放行。
    expect(traceHref("/issues/ISS-239")).toBe("/issues/ISS-239");
  });

  it("没有 href 的引用就是一段署名，不可点也不标未定位", () => {
    expect(traceHref(undefined)).toBeNull();
    const html = renderToStaticMarkup(
      createElement(JudgementBoardPane, {
        board: boardOf([
          judgement("BJ-1", S1, { notes: [{ kind: "ext", source: "CSA / Oasis 2026" }] }),
        ]),
      }),
    );
    expect(html).toContain("CSA / Oasis 2026");
    expect(html).not.toContain("未定位");
  });

  it("给了地址但指不到东西：保留文字、标未定位、不出 <a>", () => {
    const html = renderToStaticMarkup(
      createElement(JudgementBoardPane, {
        board: boardOf([
          judgement("BJ-1", S1, {
            notes: [{ kind: "ext", source: "维信诺 2025 年年度报告摘要", href: "/docs/E30" }],
          }),
        ]),
      }),
    );
    expect(html).toContain("维信诺 2025 年年度报告摘要");
    expect(html).toContain("未定位");
    expect(html).not.toContain('href="/docs/E30"');
  });
});
