import { describe, expect, it } from "vitest";
import { localizeTabScrollButtons, shortSourceName } from "@/lib/displayText";

describe("前端文案（巡检 P2-21 / 22 / 31）", () => {
  it("对话里确认写入的出处不写「CEO」", () => {
    expect(shortSourceName("CEO 对话确认（10-11 18:08）")).toBe("对话中确认");
  });

  it("页签滚动键的英文 aria 改成中文", () => {
    const buttons = [{ attrs: { "aria-label": "Scroll tabs left" } as Record<string, string> }, { attrs: { "aria-label": "Scroll tabs right" } as Record<string, string> }]
      .map((entry) => ({ ...entry, getAttribute: (name: string) => entry.attrs[name] ?? null, setAttribute: (name: string, value: string) => { entry.attrs[name] = value; } }));
    localizeTabScrollButtons({ querySelectorAll: () => buttons } as unknown as ParentNode);
    expect(buttons.map((button) => button.attrs["aria-label"])).toEqual(["页签向左滚动", "页签向右滚动"]);
  });
});
