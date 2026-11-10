import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Project } from "@/lib/home/projects";
import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import { bindProjectFolders } from "@/lib/local/projectFolders";
import { LocalRunnerError, type LocalRunner } from "@/lib/local/runner";

/** 没有 jsdom：HeroUI 的 Modal 换成直接把内容画出来的桩，看弹窗里有什么。 */
vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  const pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { ...actual, Modal: Object.assign(pass, { Backdrop: pass, Container: pass, Dialog: pass }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import { FolderList, NewProjectDialog, firstOf } from "./NewProjectDialog";
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
  it("一个一行：名字、淡色路径、行尾移除；有两个以上时第一个后面写「工作目录」，别的行是「设为工作目录」（挪到第一个）", () => {
    const none = () => undefined;
    const two = renderToStaticMarkup(<FolderList folders={[tianshu, docs]} onRemove={none} onFirst={none} />);
    expect(text(two)).toBe("|tianshu|C:\\work\\tianshu|工作目录|docs|C:\\work\\docs|设为工作目录|");
    expect(two).toMatch(/<span[^>]*>工作目录<\/span>/);
    expect(two).toMatch(/<button[^>]*>设为工作目录<\/button>/);
    expect(two).toContain('aria-label="移除 tianshu"');
    expect(two).toContain('aria-label="移除 docs"');
    expect(text(renderToStaticMarkup(<FolderList folders={[tianshu]} onRemove={none} onFirst={none} />))).toBe("|tianshu|C:\\work\\tianshu|");
    expect(renderToStaticMarkup(<FolderList folders={[]} onRemove={none} onFirst={none} />)).toBe("");
    expect(firstOf([tianshu, docs, { id: "f3", path: "C:\\x", label: "x" }], "f3").map((folder) => folder.id)).toEqual(["f3", "f1", "f2"]);
  });

  it("项目详情的「文件夹」是这份列表加「添加文件夹」；到上限不出「添加文件夹」；没连上本机程序不出这一节", () => {
    const project = { id: "p1", name: "首页改版", archived: false, folder: "tianshu", transfer: null, goals: [], current: [], subSessions: [], items: [] } as unknown as Project;
    const actions = { rename: vi.fn(), archive: vi.fn(), setFolders: vi.fn(), setDue: vi.fn(), transfer: vi.fn(), withdraw: vi.fn() };
    const info = (value: typeof local, limit: number) => renderToStaticMarkup(<LocalContext.Provider value={value}>
      <ProjectInfo project={project} period="2026-11" go={vi.fn()} actions={actions} folders={[tianshu, docs]} folderLimit={limit} doneDefinitionOf={() => null} me={{ personId: "me", name: "我" }} />
    </LocalContext.Provider>);
    const section = (html: string) => text(html.match(/<section[^>]*data-testid="project-folders"[\s\S]*?<\/section>/)?.[0] ?? "");
    expect(section(info(local, 5))).toBe("|文件夹|tianshu|C:\\work\\tianshu|工作目录|docs|C:\\work\\docs|设为工作目录|添加文件夹|");
    expect(section(info(local, 2))).toBe("|文件夹|tianshu|C:\\work\\tianshu|工作目录|docs|C:\\work\\docs|设为工作目录|");
    expect(info({ ...local, phase: "offline" } as typeof local, 5)).not.toContain("project-folders");
  });
});

describe("绑文件夹的顺序（D 契约 e92cb3ca）：认多个的交整份；老的本机程序只绑第一个、不发 folderIds；还看不出来时先绑第一个再看回执", () => {
  /** 老的本机程序：回的东西里没有 folders，发 folderIds 回 400。 */
  const old = (runner: LocalRunner, calls: unknown[]): Pick<LocalRunner, "putProjectFolder"> => ({
    putProjectFolder: async (projectId, body) => {
      calls.push(body);
      if (body.folderIds) throw new LocalRunnerError("validation", "不认 folderIds", 400);
      const { folders: _folders, ...rest } = await runner.putProjectFolder(projectId, body);
      return rest;
    },
  });
  const setup = async () => {
    const runner = createMockRunner({ stepMs: 1 });
    const a = (await runner.listFolders())[0]!;
    const b = (await runner.pickFolder()).folder!;
    const calls: unknown[] = [];
    const spy: Pick<LocalRunner, "putProjectFolder"> = { putProjectFolder: (projectId, body) => { calls.push(body); return runner.putProjectFolder(projectId, body); } };
    return { runner, a, b, calls, spy };
  };

  it("还看不出来（刚新建的项目）：先 folderId 绑第一个，回执里有 folders 再交整份", async () => {
    const { runner, a, b, calls, spy } = await setup();
    expect(await bindProjectFolders(spy, null, "p1", [a.id, b.id], "首页改版")).toBe(true);
    expect(calls).toEqual([{ folderId: a.id, name: "首页改版" }, { folderIds: [a.id, b.id], name: "首页改版" }]);
    expect((await runner.listProjects())[0]?.folders?.map((folder) => folder.id)).toEqual([a.id, b.id]);
    // 只有一个：绑完第一个就够了，不再交整份。
    calls.length = 0;
    expect(await bindProjectFolders(spy, null, "p2", [b.id])).toBe(true);
    expect(calls).toEqual([{ folderId: b.id }]);
  });

  it("老的本机程序：停在一个，一次 folderIds 都不发；知道是老的以后也只发 folderId", async () => {
    const { runner, a, b } = await setup();
    const calls: unknown[] = [];
    expect(await bindProjectFolders(old(runner, calls), null, "p1", [a.id, b.id])).toBe(false);
    expect(await bindProjectFolders(old(runner, calls), false, "p1", [b.id, a.id])).toBe(false);
    expect(calls).toEqual([{ folderId: a.id }, { folderId: b.id }]);
  });

  it("认多个的：加、减、换工作目录、全部解绑都是交整份", async () => {
    const { runner, a, b, calls, spy } = await setup();
    expect(await bindProjectFolders(spy, true, "p1", [b.id, a.id])).toBe(true);
    expect(await bindProjectFolders(spy, true, "p1", [])).toBe(true);
    expect(calls).toEqual([{ folderIds: [b.id, a.id] }, { folderIds: [] }]);
    expect((await runner.listProjects())[0]?.folder).toBeNull();
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
    // 删掉一个允许的文件夹：从项目的列表里一起拿掉，剩下的第一个成了工作目录。
    await runner.putProjectFolder("p1", { folderIds: [a.id, b.id, c.id] });
    await runner.removeFolder(a.id);
    expect((await runner.listProjects())[0]).toMatchObject({ folder: { id: b.id }, folders: [{ id: b.id }, { id: c.id }] });
  });
});
