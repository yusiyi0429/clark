import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { THomeItem } from "@warmap/contracts";
import type { HomeProject, SubSession, WorkHomeData } from "@/lib/home/types";
import { NO_EDITS, fromHome } from "@/lib/home/projects";
import { LeftColumn, planOrder } from "./LeftColumn";

const data = { period: "2026-11", projects: [], archivedCount: 0, month: { missions: [] }, waiting: [], other: { subSessions: [], items: [] } } as unknown as WorkHomeData;
const projectsOf = (used: WorkHomeData) => used.projects.map((project) => fromHome(project, used, NO_EDITS));
const render = (extra: Partial<Parameters<typeof LeftColumn>[0]>) => {
  const used = extra.data ?? data;
  return renderToStaticMarkup(
    <LeftColumn data={used} view={{ kind: "home" }} buddy={null} speaking={false} go={() => undefined} phone={false}
      account={{ displayName: "孙铭泽", role: "member" }} today="11 月 7 日 周六" alert={false}
      projects={projectsOf(used)} archived={[]} onCreate={async () => "x"} {...extra} />,
  );
};

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
const withTask = (items: THomeItem[], extra: Partial<HomeProject> = {}) => ({
  ...data,
  projects: [{
    projectId: "p1", name: "首页改版", lastActivityAt: "2026-11-07T01:00:00.000Z", budget: null,
    goals: [{ taskId: "t1", missionId: "m1", name: "左栏", period: "2026-11", dueDate: "2026-11-30", criteria: [], criteriaMet: 0, criteriaTotal: 0, completedAt: null }],
    summary: { running: 0, waiting: 0, queued: 0, done: 0, doneToday: 0, needsYou: 0 },
    pipeline: { conversationId: null, scope: "project:p1" }, planning: false, subSessions: [], items, ...extra,
  }],
}) as unknown as WorkHomeData;

describe("左栏：项目（16.2）", () => {
  it("「项目」组头右边一个「+」；项目行两行：名字，第二行「11 月 · Task · 截止 验收」；信息按钮进项目详情", () => {
    const html = render({ data: withTask([]) });
    expect(html).toMatch(/项目<\/span><button[^>]*aria-label="新建项目"/);
    expect(html).toMatch(/data-testid="tree-project".*首页改版.*11 月 · 左栏 · 11\/30 验收/);
    expect(html).toContain('aria-label="首页改版 详情"');
  });

  it("没有 Mission 分组：不再画 Mission 行", () => {
    expect(render({ data: withTask([]) })).not.toContain("tree-mission");
  });

  it("本人事项在项目下面：标题加行尾截止日；做完的排后、变淡", () => {
    const html = render({ data: withTask([item("00000000-0000-4000-8000-000000000001", "写验收清单", { status: "done" }), item("00000000-0000-4000-8000-000000000002", "约评审", { dueDate: "2026-11-12" })]) });
    expect(html).toMatch(/data-testid="tree-project".*约评审.*11\/12.*data-state="done"[^>]*data-tree-row=""[^>]*data-testid="tree-item".*写验收清单/);
    expect(html).not.toContain("已完成");
  });

  it("会话默认收成一行「会话 N」加一格一个的小方块，不列出来、不画蓝点", () => {
    const sub = (id: string, state: string, waiting: unknown = null) => ({ id, kind: "card", title: `卡${id}`, state, waiting, updatedAt: "a", queueReason: null, holdUntil: null });
    const html = render({ data: withTask([], { subSessions: [sub("1", "running"), sub("2", "waiting", "question"), sub("3", "done")] as never }) });
    expect(html).toMatch(/aria-expanded="false"[^>]*data-testid="tree-subs".*会话 3/);
    expect(html.match(/<i data-state=/g)?.length).toBe(3);
    expect(html).not.toContain("卡1");
  });

  it("有已归档的：一行「已归档 N」，默认收起", () => {
    const html = render({ data: withTask([]), projects: [], archived: projectsOf(withTask([])).map((project) => ({ ...project, archived: true })) });
    expect(html).toMatch(/aria-expanded="false"[^>]*data-testid="tree-archived".*已归档 1/);
    expect(html).not.toContain('data-testid="tree-project"');
  });

  it("待归位的事项进「其他」：没有会话也画这一组", () => {
    expect(render({})).not.toContain('aria-label="其他"');
    const html = render({ data: { ...data, other: { subSessions: [], items: [item("00000000-0000-4000-8000-000000000003", "整理会议纪要", { dueDate: "2026-11-09" })] } } });
    expect(html).toMatch(/aria-label="其他".*其他.*data-testid="tree-item".*整理会议纪要.*11\/09/);
  });
});

describe("会话的先后（照派活单）", () => {
  it("卡按看板里建出来的先后，没读到的和专题在后面", () => {
    const sub = (id: string, kind: "card" | "topic", updatedAt: string) => ({ id, kind, updatedAt }) as unknown as SubSession;
    const at = new Map([["c1", "2026-11-07T01:00:00.001Z"], ["c2", "2026-11-07T01:00:00.002Z"], ["c3", "2026-11-07T01:00:00.003Z"]]);
    const list = [sub("c3", "card", "z"), sub("t1", "topic", "a"), sub("c1", "card", "y"), sub("c2", "card", "x")];
    expect(planOrder(list, at).map((entry) => entry.id)).toEqual(["c1", "c2", "c3", "t1"]);
  });
});
