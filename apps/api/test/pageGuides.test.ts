import { describe, expect, it } from "vitest";
import { PAGE_GUIDES, pageFor, pageGuide, taskOfPage, taskPageGuide } from "../src/pageGuides.js";

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

  it("Task 页的老路径（本月页）和新路径（新首页锚到 Task）都认成同一个 Task；新首页本身和成员首页一样不带", async () => {
    const facts = { name: "对话质量达标", criteria: 2, cards: { todo: 1, doing: 2, review: 0, done: 3 } };
    const readTask = async (taskId: string) => taskId === "task-1" || taskId === "任务 1" ? facts : null;
    const table: [string, string | null, string | null][] = [
      // [路径, 认出的 Task, 带给 Chat 的页面名]
      ["/me/month/tasks/task-1", "task-1", "Task：对话质量达标"],
      ["/me/work/tasks/task-1", "task-1", "Task：对话质量达标"],
      ["/me/work/tasks/%E4%BB%BB%E5%8A%A1%201", "任务 1", "Task：对话质量达标"],
      ["/me/work/tasks/not-mine", "not-mine", null],
      ["/me/work", null, null],
      ["/me", null, null],
      ["/me/work/tasks", null, null],
      ["/me/work/tasks/task-1/cards", null, null],
      ["/me/work/tasks/%E0%A4%A", null, null],
      ["/me/tasks/t-1", null, "执行事项"],
    ];
    for (const [path, taskId, title] of table) {
      expect(taskOfPage(path), path).toBe(taskId);
      expect((await pageFor(path, readTask))?.title ?? null, path).toBe(title);
    }
    expect((await pageFor("/me/work/tasks/task-1", readTask))?.guide).toBe("本人在这个 Task 的页面，说的事默认指这个 Task。它有 2 条验收标准；看板上待开始 1 张、进行中 2 张、验收中 0 张、已完成 3 张。");
    expect(await pageFor("/me/month/tasks/task-1", async () => { throw new Error("本体读不到"); })).toBeNull();
  });

  it("Task 页：不是负责人（没有看板）只写标准条数；名字再长也不超 Chat 的上限", () => {
    expect(taskPageGuide("/me/month/tasks/x", { name: "别人负责的", criteria: 1, cards: null }).guide).toBe("本人在这个 Task 的页面，说的事默认指这个 Task。它有 1 条验收标准；");
    const long = taskPageGuide("/me/month/tasks/x", { name: "长".repeat(80), criteria: 99, cards: { todo: 999, doing: 999, review: 999, done: 999 } });
    expect(long.title.length).toBeLessThanOrEqual(40);
    expect(long.guide.length).toBeLessThanOrEqual(150);
  });
});
