import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MaterialMenu } from "./MaterialTabs";

describe("材料下拉钮", () => {
  it("显示各份材料等本人处理的合计，读屏也读出来；没有时不显示", () => {
    const tabs = [{ id: "task", label: "事项", title: "事项" }, { id: "m1", label: "方案", title: "方案.md", count: 2 }, { id: "m2", label: "补充", title: "补充.md", count: 1 }];
    const html = renderToStaticMarkup(<MaterialMenu tabs={tabs} selected="task" onSelect={() => undefined} label="材料" />);
    expect(html).toContain('aria-label="材料：正在看 事项，3 条待处理，切换材料"');
    expect(html).toMatch(/<span class="[^"]*" aria-hidden="true">3<\/span>/);
    const none = renderToStaticMarkup(<MaterialMenu tabs={tabs.map((tab) => ({ ...tab, count: 0 }))} selected="task" onSelect={() => undefined} label="材料" />);
    expect(none).not.toContain("待处理");
    expect(none).not.toMatch(/aria-hidden="true">0</);
  });
});
