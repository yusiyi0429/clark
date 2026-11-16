import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TCardDraftView } from "@warmap/contracts";
import { projectIdOf, startFolder } from "@/lib/home/startFolder";
import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import type { TLocalFolder } from "@/lib/local/runner";
import { FolderAsk, PICK_OTHER, folderChoice } from "./FolderAsk";
import { createFolderError } from "./InputFooter";
import { PlanDecision } from "./PlanDecision";

const brand = { id: "3e6eb3984cec", path: "C:\\Users\\10021\\Desktop\\tk-branding", label: "tk-branding" };
const other = { id: "f2", path: "C:\\work\\测试新版天枢", label: "测试新版天枢" };
const folder = (entry: typeof brand): TLocalFolder => ({ ...entry, addedAt: "2026-11-09T00:00:00Z" });
const projects = [
  { id: "p-brand", goals: [{ taskId: "t-brand" }], subSessions: [{ id: "card-a" }] },
  { id: "p-test", goals: [{ taskId: "t-test" }], subSessions: [] },
] as unknown as Parameters<typeof projectIdOf>[1];

describe("开工用项目绑的文件夹（17.2 第 32 条）", () => {
  it("有绑定用绑定：卡按自己带的项目、它的 Task 挂在哪、它是哪个项目的子会话找到项目，在那个项目绑的文件夹里开，不看上次用过的", () => {
    const bound = new Map([["p-brand", brand], ["p-test", other]]);
    expect(projectIdOf({ projectId: null, taskId: "t-brand", cardId: "x" }, projects)).toBe("p-brand");
    expect(projectIdOf({ projectId: null, taskId: null, cardId: "card-a" }, projects)).toBe("p-brand");
    expect(projectIdOf({ projectId: "p-test", taskId: "t-brand" }, projects)).toBe("p-test");
    expect(startFolder("p-brand", bound, other.path)).toEqual({ cwd: brand.path, ask: false });
  });

  it("没绑定不开、要问：项目没绑时不给目录、ask；不属于任何项目的才用上次用过的；问的选项框列这台电脑的文件夹，最后是「选择其他文件夹…」", async () => {
    expect(startFolder("p-brand", new Map(), other.path)).toEqual({ cwd: null, ask: true });
    expect(startFolder(null, new Map(), other.path)).toEqual({ cwd: other.path, ask: false });
    const html = renderToStaticMarkup(<FolderAsk folders={[folder(brand), folder(other)]} onBind={vi.fn()} onPickOther={vi.fn()} />);
    expect(html).toContain('data-testid="folder-ask"');
    expect(html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|")).toMatch(/在哪个文件夹开工？.*tk-branding.*测试新版天枢.*选择其他文件夹…/);
    // 选第几个就是哪个文件夹；选最后一项走本机的选择框，取消就不绑。
    const pickOther = vi.fn(async () => folder(other));
    expect(await folderChoice(0, [folder(brand)], pickOther)).toMatchObject({ id: brand.id });
    expect(await folderChoice(1, [folder(brand)], pickOther)).toMatchObject({ id: other.id });
    expect(pickOther).toHaveBeenCalledTimes(1);
    expect(await folderChoice(1, [folder(brand)], async () => null)).toBeNull();
    expect(PICK_OTHER).toBe("选择其他文件夹…");
  });

  it("派活单同输入框下面：项目绑了写文件夹名（点开是在资源管理器中显示、复制路径，换不了）；没绑才给同一个文件夹下拉，写「此电脑」；没有「选文件夹」「这一次用别的」", () => {
    const local = { runner: createMockRunner(), phase: "ready", version: null, status: null, models: [], folders: [folder(brand), folder(other)], sessions: [], pairing: null, error: null,
      refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() } as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];
    const draft = { id: "00000000-0000-4000-8000-0000000000d1", planId: "00000000-0000-4000-8000-0000000000b1", position: 0, title: "做 logo", brief: "", doneDefinition: "做完",
      criterionIndex: 1, executor: "claude_code", modelTier: "normal", why: null, role: null, suggestPresetKey: null, sourceWords: [] } as unknown as TCardDraftView;
    const render = (bound: typeof brand | null) => renderToStaticMarkup(<LocalContext.Provider value={local}>
      <PlanDecision target={{ projectId: "p-brand" }} name="品牌建设" drafts={[draft]} roles={[]} handheld={false} onSay={vi.fn()} onChanged={vi.fn()} folder={bound} onSetFolder={vi.fn()} />
    </LocalContext.Provider>);
    const html = render(brand);
    expect(html).toMatch(/<button[^>]*data-testid="footer-folder"[^>]*aria-label="文件夹：tk-branding"/);
    expect(html).not.toContain("此电脑");
    expect(html).not.toContain("选文件夹");
    expect(render(null)).toMatch(/<button[^>]*data-testid="footer-folder"[^>]*aria-label="文件夹：此电脑"/);
  });

  it("文件夹菜单「选择其他文件夹…」「新建文件夹…」：本机选好或建好后一步绑到项目上；重名 409 就地写「已有同名文件夹」，名字不行照本机说的", async () => {
    const runner = createMockRunner();
    const picked = await runner.pickFolder({ projectId: "p-brand", projectName: "品牌建设" });
    expect(picked.project).toMatchObject({ projectId: "p-brand", folder: { id: picked.folder!.id } });
    const made = await runner.createFolder({ name: "测试新版天枢", projectId: "p-test", projectName: "测试" });
    expect(made.folder.path).toBe(["C:", "Users", "me", "Desktop", "测试新版天枢"].join("\\"));
    expect(made.project).toMatchObject({ projectId: "p-test", folder: { id: made.folder.id, label: "测试新版天枢" } });
    expect((await runner.listProjects()).map((entry) => [entry.projectId, entry.folder?.label])).toEqual([["p-brand", picked.folder!.label], ["p-test", "测试新版天枢"]]);
    const dup = await runner.createFolder({ name: "测试新版天枢", projectId: "p-test" }).catch((error: unknown) => error);
    expect(dup).toMatchObject({ code: "conflict", status: 409 });
    expect(createFolderError(dup)).toBe("已有同名文件夹");
    const bad = await runner.createFolder({ name: "a/b" }).catch((error: unknown) => error);
    expect(createFolderError(bad)).toMatch(/不能有/);
    expect(createFolderError(new Error("断了"))).toBe("没建成");
  });
});
