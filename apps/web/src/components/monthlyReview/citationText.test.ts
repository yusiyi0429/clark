import { describe, expect, it } from "vitest";
import { fromEditable, inlineSources, toEditable } from "./citationText";

const text = "复盘生成写完了[09/16 Codex 记录](cite:collector:a1)，验收材料已交客户[09/15 进展 · 验收材料](cite:progress:p1)。\n下月见[飞书周复盘](https://tokenking.feishu.cn/wiki/x)。";

describe("复盘段落里的出处", () => {
  it("编辑框里只显示〔名称〕，原样保存时还原成同一段", () => {
    const editable = toEditable(text);
    expect(editable).toBe("复盘生成写完了〔09/16 Codex 记录〕，验收材料已交客户〔09/15 进展 · 验收材料〕。\n下月见〔飞书周复盘〕。");
    expect(fromEditable(editable, text)).toBe(text);
  });

  it("删掉〔名称〕就去掉这条出处；改文字、移动出处都保留地址；认不出的〔〕原样留下", () => {
    const edited = "验收材料已交客户〔09/15 进展 · 验收材料〕，比计划晚一周〔09/16 Codex 记录〕。〔不存在的〕";
    expect(fromEditable(edited, text)).toBe("验收材料已交客户[09/15 进展 · 验收材料](cite:progress:p1)，比计划晚一周[09/16 Codex 记录](cite:collector:a1)。〔不存在的〕");
  });

  it("正文里已经显示的出处，依据一行不再列", () => {
    const shown = inlineSources(text);
    expect(["collector:a1", "progress:p1", "https://tokenking.feishu.cn/wiki/x"].every((source) => shown.has(source))).toBe(true);
    expect(shown.has("mission:m1")).toBe(false);
  });
});
