import { describe, expect, it } from "vitest";
import { PAGE_GUIDES, pageGuide } from "../src/pageGuides.js";

describe("页面目录", () => {
  it("每页的名字、说明都在 Chat 的上限内（title ≤ 40、guide ≤ 150 字），超了整轮会被拒", () => {
    const over = PAGE_GUIDES.filter((item) => item.title.length > 40 || item.guide.length > 150 || !item.guide.trim())
      .map((item) => `${item.title}：${item.guide.length}`);
    expect(over).toEqual([]);
  });

  it("按路径找到页面；首页、不挂对话的页面和没收的路径不带", () => {
    expect(pageGuide("/me/requests/new")?.title).toBe("新请求");
    expect(pageGuide("/requests/abc")?.title).toBe("请求详情");
    expect(pageGuide("/reviews/2026-10/ltco")?.title).toBe("长期目标审视");
    expect(pageGuide("/reviews/2026-10")?.title).toBe("月末复盘");
    expect(pageGuide("/me/tasks/t-1")?.title).toBe("执行事项");
    expect(pageGuide("/me/tasks/new")?.title).toBe("开启执行事项");
    for (const path of ["/", "/me", "/radar", "/me/radar", "/config/missions", "/me/battlefields/b1", "/nope"]) expect(pageGuide(path)).toBeNull();
  });
});
