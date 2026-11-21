import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkHomeData } from "@/lib/home/types";
import { fromHome } from "@/lib/home/projects";
import type { RowMenuItem } from "./RowMenu";
import type { RowActions } from "./SubRows";

// 菜单关着时不画项：把交给 RowMenu 的项截下来看。
const menus = vi.hoisted(() => new Map<string, RowMenuItem[]>());
vi.mock("./RowMenu", async (original) => ({ ...(await original<typeof import("./RowMenu")>()),
  RowMenu: ({ label, items }: { label: string; items: RowMenuItem[] }) => { menus.set(label, items); return null; },
}));
import { LeftColumn } from "./LeftColumn";

const project = (projectId: string, name: string, extra = {}) => ({
  projectId, name, lastActivityAt: "2026-11-07T01:00:00.000Z", budget: null, goals: [], transfer: null, unseen: false,
  summary: { running: 0, waiting: 0, queued: 0, done: 0, doneToday: 0, needsYou: 0 }, pipeline: { conversationId: null, scope: "project:" + projectId }, planning: false, subSessions: [], items: [], ...extra,
});
const data = { period: "2026-11", archivedCount: 0, month: { missions: [] }, waiting: [], other: { subSessions: [], items: [] },
  projects: [project("p1", "首页改版"), project("p2", "私事", { hiddenFromColleagues: true })] } as unknown as WorkHomeData;
const actions: RowActions = { renameProject: vi.fn(), archiveProject: vi.fn(), deleteProject: vi.fn(), hideProject: vi.fn(), renameSub: vi.fn(), archiveSub: vi.fn(), deleteSub: vi.fn() };

describe("项目「更多」里的「不给同事读」（A2）", () => {
  it("没收起的不打勾，点了收起；收起的打勾，再点放开；归档了的不出", async () => {
    const archived = fromHome(project("p3", "旧项目") as never, data, new Map());
    renderToStaticMarkup(<LeftColumn data={data} view={{ kind: "home" }} buddy={null} go={() => undefined} phone={false}
      account={{ displayName: "孙铭泽", role: "member" }} today="11 月 9 日 周一" actions={actions}
      projects={[...data.projects.map((entry) => fromHome(entry, data, new Map())), { ...archived, archived: true }]} archived={[]} onCreate={async () => "x"} />);
    const item = (label: string) => menus.get(label)?.find((entry) => entry.label === "不给同事读");
    expect(item("首页改版")).toMatchObject({ checked: false });
    expect(item("私事")).toMatchObject({ checked: true });
    await item("首页改版")!.run();
    expect(actions.hideProject).toHaveBeenLastCalledWith("p1", true);
    await item("私事")!.run();
    expect(actions.hideProject).toHaveBeenLastCalledWith("p2", false);
    expect(menus.has("旧项目")).toBe(true);
    expect(item("旧项目")).toBeUndefined();
  });
});
