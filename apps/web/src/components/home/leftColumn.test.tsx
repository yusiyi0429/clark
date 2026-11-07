import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { THomeItem } from "@warmap/contracts";
import type { HomeTask, WorkHomeData } from "@/lib/home/types";
import { LeftColumn, planOrder } from "./LeftColumn";

const data = { period: "2026-11", missions: [], waiting: [], other: { subSessions: [], items: [] } } as unknown as WorkHomeData;
const render = (extra: Partial<Parameters<typeof LeftColumn>[0]>) => renderToStaticMarkup(
  <LeftColumn data={data} view={{ kind: "home" }} buddy={null} speaking={false} go={() => undefined} phone={false}
    account={{ displayName: "孙铭泽", role: "member" }} today="11 月 7 日 周六" alert={false} {...extra} />,
);

describe("左栏：计划读不到、空月份（5.4.2、5.4.4）", () => {
  it("计划读不到时树最上面一行「本体读取失败」加「重试」，不画成空树", () => {
    const html = render({ onRetryPlan: () => undefined });
    expect(html).toContain('data-testid="plan-read-failed"');
    expect(html).toMatch(/本体读取失败.*重试/);
    expect(render({})).not.toContain("本体读取失败");
  });

  it("空月份：「今天」行行尾出「11 月待敲定」chip", () => {
    const html = render({ month: { href: "/me/work/month/2026-11", label: "11 月待敲定" } });
    expect(html).toMatch(/11 月 7 日 周六.*11 月待敲定/);
    expect(render({})).not.toContain("待敲定");
  });
});

const item = (id: string, title: string, extra: Partial<THomeItem> = {}): THomeItem => ({
  id, title, status: "in_progress", dueDate: null, awaitingAcceptance: false, updatedAt: "2026-11-07T01:00:00.000Z", ...extra,
});
const withTask = (items: THomeItem[], extra: Partial<HomeTask> = {}) => ({
  ...data,
  missions: [{ missionId: "m1", title: "首页改版", period: "2026-11", tasks: [{
    taskId: "t1", missionId: "m1", name: "左栏", subtitle: null, summary: { running: 0, waiting: 0, queued: 0, done: 0, doneToday: 0, needsYou: 0 },
    pipeline: { conversationId: null, scope: "plan-task:t1" }, planning: false, completedAt: null, subSessions: [], items, ...extra,
  }] }],
}) as unknown as WorkHomeData;

describe("左栏：本人自己做的事项（9.10）", () => {
  it("Task 下面列本人事项：标题加行尾截止日「11/12」，是树里能用方向键走到的一行", () => {
    const html = render({ data: withTask([item("00000000-0000-4000-8000-000000000001", "写验收清单", { dueDate: "2026-11-12" })]) });
    expect(html).toMatch(/data-testid="tree-task".*data-testid="tree-item"[^>]*>.*写验收清单.*11\/12/);
    expect(html).toMatch(/<button[^>]*data-tree-row=""[^>]*data-testid="tree-item"/);
    expect(html).toMatch(/data-testid="tree-item"><span[^>]*aria-hidden="true"><\/span><span[^>]*>写验收清单/);
    expect(html).not.toMatch(/data-testid="tree-item"><span[^>]*role="img"/);
  });

  it("交了等验收的行尾写「待验收」，不写截止日；没有截止日也不等验收的行尾不写", () => {
    const html = render({ data: withTask([
      item("00000000-0000-4000-8000-000000000001", "写验收清单", { dueDate: "2026-11-12", awaitingAcceptance: true }),
      item("00000000-0000-4000-8000-000000000002", "约评审"),
    ]) });
    expect(html).toMatch(/写验收清单.*待验收/);
    expect(html).not.toContain("11/12");
    expect(html).toMatch(/约评审<\/span><\/button>/);
  });

  it("没有「已完成 N」：做完的事项排在后面、变淡", () => {
    const html = render({ data: withTask([item("00000000-0000-4000-8000-000000000001", "写验收清单", { status: "done" }), item("00000000-0000-4000-8000-000000000002", "约评审")]) });
    expect(html).not.toContain("已完成");
    expect(html).toMatch(/约评审.*data-state="done"[^>]*data-tree-row=""[^>]*data-testid="tree-item".*写验收清单/);
  });

  it("待归位的事项进「其他」：没有子会话也画这一组", () => {
    expect(render({})).not.toContain('aria-label="其他"');
    const html = render({ data: { ...data, other: { subSessions: [], items: [item("00000000-0000-4000-8000-000000000003", "整理会议纪要", { dueDate: "2026-11-09" })] } } });
    expect(html).toMatch(/aria-label="其他".*其他.*data-testid="tree-item".*整理会议纪要.*11\/09/);
  });
});

describe("Mission 行和「子会话 N」（14.2）", () => {
  const sub = (id: string, state: string, waiting: unknown = null) => ({ id, kind: "card", title: `卡${id}`, state, waiting, updatedAt: "a", queueReason: null, holdUntil: null });
  it("Mission 行能点、进 Mission 详情", () => {
    const html = render({ data: withTask([]) });
    expect(html).toMatch(/<button[^>]*data-testid="tree-mission"[^>]*>.*首页改版/);
  });
  it("子会话默认收成一行「子会话 N」加一格一个的小方块，不列出来、不画蓝点", () => {
    const html = render({ data: withTask([], { subSessions: [sub("1", "running"), sub("2", "waiting", "question"), sub("3", "done")] as never }) });
    expect(html).toMatch(/aria-expanded="false"[^>]*data-testid="tree-subs".*子会话 3/);
    expect(html.match(/<i data-state=/g)?.length).toBe(3);
    expect(html).not.toContain("卡1");
  });
});

describe("子会话的先后（照派活单）", () => {
  it("卡按看板里建出来的先后，没读到的和专题在后面", () => {
    const sub = (id: string, kind: "card" | "topic", updatedAt: string) => ({ id, kind, updatedAt }) as unknown as HomeTask["subSessions"][number];
    const at = new Map([["c1", "2026-11-07T01:00:00.001Z"], ["c2", "2026-11-07T01:00:00.002Z"], ["c3", "2026-11-07T01:00:00.003Z"]]);
    const list = [sub("c3", "card", "z"), sub("t1", "topic", "a"), sub("c1", "card", "y"), sub("c2", "card", "x")];
    expect(planOrder(list, at).map((entry) => entry.id)).toEqual(["c1", "c2", "c3", "t1"]);
  });
});
