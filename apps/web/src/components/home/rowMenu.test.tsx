import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkHomeData } from "@/lib/home/types";
import { fromHome } from "@/lib/home/projects";
import { CloudError } from "@/lib/board/cloud";
import { LeftColumn, deleteProjectFail } from "./LeftColumn";
import { ActionsContext, ArchivedSubRow, Subs, archiveSubFail, deleteSubFail, type RowActions } from "./SubRows";

const sub = { id: "00000000-0000-4000-8000-0000000000c1", kind: "card", title: "拆左栏", state: "done", waiting: null, updatedAt: "2026-11-09T01:00:00.000Z", queueReason: null, holdUntil: null, sessionId: null, unseen: false };
const data = {
  period: "2026-11", archivedCount: 0, month: { missions: [] }, waiting: [], other: { subSessions: [sub], items: [] },
  projects: [{
    projectId: "p1", name: "首页改版", lastActivityAt: "2026-11-07T01:00:00.000Z", budget: null, goals: [], transfer: null,
    summary: { running: 0, waiting: 0, queued: 0, done: 1, doneToday: 0, needsYou: 0 }, pipeline: { conversationId: null, scope: "project:p1" }, planning: false, subSessions: [], items: [],
  }],
} as unknown as WorkHomeData;
const actions: RowActions = { renameProject: vi.fn(), archiveProject: vi.fn(), deleteProject: vi.fn(), hideProject: vi.fn(), renameSub: vi.fn(), archiveSub: vi.fn(), deleteSub: vi.fn() };
const render = (extra: Partial<Parameters<typeof LeftColumn>[0]>) => renderToStaticMarkup(
  <LeftColumn data={data} view={{ kind: "card", id: sub.id }} buddy={null} go={() => undefined} phone={false}
    account={{ displayName: "孙铭泽", role: "member" }} today="11 月 9 日 周一"
    projects={data.projects.map((project) => fromHome(project, data, new Map()))} archived={[]} onCreate={async () => "x"} {...extra} />,
);

describe("左栏行尾「…」菜单（17.2 第 35 条，B 契约 c3366f28）", () => {
  it("项目行和子会话行行尾各一个「…」（读屏读「… 更多」）；不给 actions 不画", () => {
    const html = render({ actions });
    expect(html.match(/data-testid="row-more"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="首页改版 更多"');
    expect(render({})).not.toContain("row-more");
    const subs = (given: RowActions | null) => renderToStaticMarkup(<ActionsContext.Provider value={given}><Subs subs={[sub] as never} view={{ kind: "home" }} go={() => undefined} /></ActionsContext.Provider>);
    expect(subs(actions)).toContain('aria-label="拆左栏 更多"');
    expect(subs(null)).not.toContain("row-more");
  });

  it("没成时就地写的话：项目删除 PROJECT_BUSY 照云端原话、PROJECT_TRANSFERRING「正在转交」；子会话在跑「先停下再归档」「先停下再删」；别的「没删成」", () => {
    expect(deleteProjectFail(new CloudError(409, "A · 拆左栏 还在跑，先停掉再删", "PROJECT_BUSY"))).toBe("A · 拆左栏 还在跑，先停掉再删");
    expect(deleteProjectFail(new CloudError(409, "正在转交给林知行", "PROJECT_TRANSFERRING"))).toBe("正在转交");
    expect(deleteProjectFail(new Error("断了"))).toBe("没删成");
    expect(archiveSubFail(new CloudError(409, "还在跑", "SUB_SESSION_RUNNING"))).toBe("先停下再归档");
    expect(archiveSubFail(new CloudError(500, "坏了"))).toBe("没归档成");
    expect(deleteSubFail(new CloudError(409, "还在跑", "SUB_SESSION_RUNNING"))).toBe("先停下再删");
  });

  it("归档了的子会话：带原来的项目，「…」里能恢复（左栏不列，挪去右边的会话面板）", () => {
    const archived = { kind: "topic" as const, id: "00000000-0000-4000-8000-0000000000t1", title: "选型", letter: "B", projectId: "p1", projectName: "首页改版", archivedAt: "2026-11-09T02:00:00.000Z" };
    const html = renderToStaticMarkup(<ActionsContext.Provider value={actions}><ArchivedSubRow sub={archived as never} go={() => undefined} /></ActionsContext.Provider>).replace(/<!-- -->/g, "");
    expect(html).toMatch(/data-testid="tree-archived-sub".*选型.* · 首页改版.*aria-label="选型 更多"/);
    expect(render({ actions })).not.toContain("tree-archived");
  });
});
