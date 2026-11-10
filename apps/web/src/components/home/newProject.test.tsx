import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Project } from "@/lib/home/projects";
import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";

/** 没有 jsdom：HeroUI 的 Modal 换成直接把内容画出来的桩，看弹窗里有什么。 */
vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  const pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { ...actual, Modal: Object.assign(pass, { Backdrop: pass, Container: pass, Dialog: pass }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import { FolderList, NewProjectDialog } from "./NewProjectDialog";
import { ProjectInfo } from "./ProjectInfo";

const local = { phase: "ready", folders: [], sessions: [] } as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];
const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
const tianshu = { id: "f1", path: "C:\\work\\tianshu", label: "tianshu" };
const docs = { id: "f2", path: "C:\\work\\docs", label: "docs" };

describe("新建项目的小弹窗（17.2 第 46 条）", () => {
  const dialog = (withFolders: boolean) => renderToStaticMarkup(<LocalContext.Provider value={local}>
    <NewProjectDialog withFolders={withFolders} limit={5} onCreate={async () => undefined} onClose={() => undefined} /></LocalContext.Provider>);

  it("项目名（进来就聚焦）、文件夹、取消、创建；不加说明句；没填名字「创建」点不了", () => {
    const html = dialog(true);
    expect(text(html)).toBe("|新建项目|文件夹|添加文件夹|取消|创建|");
    expect(html).toMatch(/<input[^>]*autofocus=""[^>]*aria-label="项目名"[^>]*placeholder="项目名"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="project-create"|data-testid="project-create"[^>]*disabled=""/);
  });

  it("这台电脑没连上本机程序（手机、没装）：不出文件夹这一块", () => {
    expect(text(dialog(false))).toBe("|新建项目|取消|创建|");
  });
});

describe("文件夹列表（弹窗里和项目详情里同一个）", () => {
  it("一个一行：名字、淡色路径、行尾移除；有两个以上时第一个后面写「工作目录」", () => {
    const two = renderToStaticMarkup(<FolderList folders={[tianshu, docs]} onRemove={() => undefined} />);
    expect(text(two)).toBe("|tianshu|C:\\work\\tianshu|工作目录|docs|C:\\work\\docs|");
    expect(two).toContain('aria-label="移除 tianshu"');
    expect(two).toContain('aria-label="移除 docs"');
    expect(text(renderToStaticMarkup(<FolderList folders={[tianshu]} onRemove={() => undefined} />))).toBe("|tianshu|C:\\work\\tianshu|");
    expect(renderToStaticMarkup(<FolderList folders={[]} onRemove={() => undefined} />)).toBe("");
  });

  it("项目详情的「文件夹」是这份列表加「添加文件夹」；到上限不出「添加文件夹」；没连上本机程序不出这一节", () => {
    const project = { id: "p1", name: "首页改版", archived: false, folder: "tianshu", transfer: null, goals: [], current: [], subSessions: [], items: [] } as unknown as Project;
    const actions = { rename: vi.fn(), archive: vi.fn(), setFolders: vi.fn(), setDue: vi.fn(), transfer: vi.fn(), withdraw: vi.fn() };
    const info = (value: typeof local, limit: number) => renderToStaticMarkup(<LocalContext.Provider value={value}>
      <ProjectInfo project={project} period="2026-11" go={vi.fn()} actions={actions} folders={[tianshu, docs]} folderLimit={limit} doneDefinitionOf={() => null} me={{ personId: "me", name: "我" }} />
    </LocalContext.Provider>);
    const section = (html: string) => text(html.match(/<section[^>]*data-testid="project-folders"[\s\S]*?<\/section>/)?.[0] ?? "");
    expect(section(info(local, 5))).toBe("|文件夹|tianshu|C:\\work\\tianshu|工作目录|docs|C:\\work\\docs|添加文件夹|");
    expect(section(info(local, 2))).toBe("|文件夹|tianshu|C:\\work\\tianshu|工作目录|docs|C:\\work\\docs|");
    expect(info({ ...local, phase: "offline" } as typeof local, 5)).not.toContain("project-folders");
  });
});

describe("假本机程序：一个项目绑多个文件夹（D 契约 e92cb3ca）", () => {
  it("folderIds 整份换掉，第一个是工作目录；folderId 换掉第一个、其余不动；null 全部解绑；不认识的文件夹 404", async () => {
    const runner = createMockRunner({ stepMs: 1 });
    const a = (await runner.listFolders())[0]!;
    const b = (await runner.pickFolder()).folder!;
    const c = (await runner.pickFolder()).folder!;
    const put = await runner.putProjectFolder("p1", { folderIds: [a.id, b.id], name: "首页改版" });
    expect(put.folders?.map((folder) => folder.id)).toEqual([a.id, b.id]);
    expect(put.folder?.id).toBe(a.id);
    // 老写法只换第一个：其余的还在。
    expect((await runner.putProjectFolder("p1", { folderId: c.id })).folders?.map((folder) => folder.id)).toEqual([c.id, b.id]);
    // 它本来在其余的里面：挪到第一个。
    expect((await runner.putProjectFolder("p1", { folderId: b.id })).folders?.map((folder) => folder.id)).toEqual([b.id]);
    await expect(runner.putProjectFolder("p1", { folderIds: [a.id, "nope"] })).rejects.toMatchObject({ status: 404 });
    expect((await runner.putProjectFolder("p1", { folderIds: [] })).folder).toBeNull();
    expect((await runner.listProjects())[0]?.folders).toEqual([]);
  });
});
