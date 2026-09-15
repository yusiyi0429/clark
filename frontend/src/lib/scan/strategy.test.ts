/**
 * 解析靶点策略正文这一条钉的是**屏幕上那几个点和正文里的话是同一句**。
 *
 * 下面那份样本照实验台 `r-bbf2f19afb` 的正文抄的形状（不是全文）：`H` 那几条带句末
 * 分号、域标题是 `**D1 …**（对应 …）`、KIQ 换行缩进续行。这三样每一样都曾经是
 * 「看起来解析对了、其实少半句」的来源。
 */
import { describe, expect, it } from "vitest";

import { parseStrategyBody } from "./strategy";

const BODY = `## 一、扫描主体画像

  当前战略假设：

  H1 「AI 转型必须从一号位开始」是有效的市场切入；
  H2 决策层的信息过载是真实且付费的痛点；

## 二、观察域与 KIQ

**D1 竞争与替代**（对应 H1、H2）

- KIQ1.1 Palantir / Aera 类平台有无面向中国市场或
  一号位场景的新动作？
- KIQ1.2 有没有新的对手在做同一件事？

**D2 政策与合规**（对应 H2）

- KIQ2.1 Gartner
  DIP 口径有无变化？

## 三、源类型指引

- 优先官方公告与一手访谈。
`;

describe("parseStrategyBody", () => {
  const parsed = parseStrategyBody(BODY);

  it("战略假设认出来了，句末那个分号摘掉", () => {
    expect(parsed.hypotheses).toEqual([
      "H1 「AI 转型必须从一号位开始」是有效的市场切入",
      "H2 决策层的信息过载是真实且付费的痛点",
    ]);
  });

  it("域标题带上后面那个括号 —— 那半句写的是它对着哪几条假设", () => {
    expect(parsed.domains.map((d) => `${d.code} ${d.title}`)).toEqual([
      "D1 竞争与替代（对应 H1、H2）",
      "D2 政策与合规（对应 H2）",
    ]);
  });

  it("KIQ 挂在自己那个域下面", () => {
    expect(parsed.domains[0].kiqs).toHaveLength(2);
    expect(parsed.domains[1].kiqs).toHaveLength(1);
  });

  it("中文续行接回去不补空格 —— 那个换行是排版，不是词的边界", () => {
    expect(parsed.domains[0].kiqs[0]).toBe(
      "KIQ1.1 Palantir / Aera 类平台有无面向中国市场或一号位场景的新动作？"
    );
  });

  it("拉丁词之间的续行补一个空格 —— 不补会粘成 GartnerDIP", () => {
    expect(parsed.domains[1].kiqs[0]).toBe("KIQ2.1 Gartner DIP 口径有无变化？");
  });

  it("小节标题终结上一条：第三节那个条目不会被塞进 D2", () => {
    expect(parsed.domains[1].kiqs).toEqual(["KIQ2.1 Gartner DIP 口径有无变化？"]);
  });

  it("格式认不出来就是空的，不猜", () => {
    const out = parseStrategyBody("一段和策略正文完全不同构的文字。\n没有 H、没有 D。");
    expect(out.hypotheses).toEqual([]);
    expect(out.domains).toEqual([]);
  });

  it("域还没开就出现的 KIQ 一律丢 —— 挂到「上一个域」是在编一条对应关系", () => {
    const out = parseStrategyBody("- KIQ0.1 无主的一条？\n\n**D1 有主**\n- KIQ1.1 有主的一条？");
    expect(out.domains).toHaveLength(1);
    expect(out.domains[0].kiqs).toEqual(["KIQ1.1 有主的一条？"]);
  });
});
