import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { anchorHref, anchorLabel, groupMemories, MEMORY_EXPORT_PROMPT, referenceSource, type MemoryItem } from "./memoryModel";
import { MemoryImportPanel } from "./MemoryImportPanel";

const item = (kind: MemoryItem["kind"], id = kind): MemoryItem => ({ id, kind, title: id, text: id, status: "active", supersededBy: null, anchors: [], references: [],
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });

describe("我的记忆", () => {
  it("按四组分：偏好与表达方式、做法、想法与立场（含理由）、没定的问题；空组不出现", () => {
    const groups = groupMemories([item("open_question"), item("reason"), item("preference"), item("idea"), item("stance")]);
    expect(groups.map((group) => [group.label, group.items.map((entry) => entry.kind)])).toEqual([
      ["偏好与表达方式", ["preference"]], ["想法与立场", ["reason", "idea", "stance"]], ["没定的问题", ["open_question"]]]);
  });

  it("出处和「关于什么」：对话、导入来源；主题直接写，对象写类型和标题，按身份给链接", () => {
    expect(referenceSource("chat:abc#3")).toBe("对话");
    expect(referenceSource("import:claude_code:i:c")).toBe("Claude Code");
    expect(anchorLabel({ target: "topic:渠道下沉" })).toBe("渠道下沉");
    expect(anchorLabel({ target: "issue:1", title: "要不要扩编" })).toBe("议题 · 要不要扩编");
    expect(anchorHref({ target: "issue:1" }, "member")).toBe("/me/issues/1");
    expect(anchorHref({ target: "issue:1" }, "ceo")).toBe("/issues/1");
    expect(anchorHref({ target: "topic:x" }, "ceo")).toBeNull();
  });

  it("导入：粘贴框没有占位说明；提示词原文平时折叠，只有一颗「复制提示词」", () => {
    const html = renderToStaticMarkup(<MemoryImportPanel onCreated={() => undefined} />);
    expect(html).toContain("复制提示词");
    expect(html).not.toContain("placeholder");
    expect(html).not.toContain(MEMORY_EXPORT_PROMPT.slice(0, 20));
    expect(MEMORY_EXPORT_PROMPT).toContain("类别 | 内容 | 来源 | 时间 | 把握");
  });
});
