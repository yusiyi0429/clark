import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));
vi.mock("@/lib/board/cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/board/cloud")>();
  return { ...actual, topicBrief: vi.fn(async () => ({ topicId: "t", markdown: "# 首页改版\n\n把登录页改简单一点", critics: [], latestVersion: null, role: null })) };
});

import type { HomeProject, WorkHomeData } from "@/lib/home/types";
import { topicBrief, CloudError } from "@/lib/board/cloud";
import { queueText, subQueueText } from "@/lib/home/derive";
import { fromHome } from "@/lib/home/projects";
import { LocalContext, type LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import type { LocalRunner } from "@/lib/local/runner";
import { startTopic } from "@/lib/local/start";
import { claimTopic } from "@/lib/home/startFolder";
import { LeftColumn } from "./LeftColumn";
import { NewSubView } from "./NewSub";
import { scopeOf, viewOf } from "./view";

const MODEL = { id: "subscription", label: "Claude 订阅", source: "subscription", agent: "claude-code", baseUrl: null, model: null, smallModel: null, webSearch: true, hasKey: false, isDefault: true } as const;
const HOLDER = { kind: "card" as const, id: "c1", letter: "B" as const, title: "改登录页" };

describe("项目下的「+」开自由子会话（第 68 条）", () => {
  it("地址 /me/work/projects/<id>/new，右栏列这个项目的", () => {
    expect(viewOf("/me/work/projects/p1/new")).toEqual({ kind: "newSub", projectId: "p1" });
    expect(scopeOf({ kind: "newSub", projectId: "p1" })).toBe("project:p1");
    expect(viewOf("/me/work/projects/p1")).toEqual({ kind: "project", id: "p1" });
  });

  it("新子会话页：项目名做页头，底下是首页那个输入框，不加别的字", () => {
    const html = renderToStaticMarkup(<NewSubView project={{ id: "p1", name: "首页改版" }} onCreate={async () => undefined} />);
    expect(html).toMatch(/<h1[^>]*>首页改版<\/h1>/);
    expect(html).toContain('placeholder="说点什么…"');
    expect(html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|")).toBe("|首页改版|");
  });

  it("开工带 free 和项目的文件夹，交代是云端给的第一句话；不带评审、版本、岗位", async () => {
    const createSession = vi.fn(async (body: unknown) => body);
    const runner = { createSession } as unknown as LocalRunner;
    await startTopic(runner, { id: "t1", title: "把登录页改简单一点", free: true, cwd: "C:\\work\\site" }, MODEL as never, ["x"]);
    expect(topicBrief).toHaveBeenLastCalledWith("t1", undefined);
    expect(createSession.mock.calls[0]![0]).toMatchObject({ subject: { kind: "topic", topicId: "t1" }, free: true, cwd: "C:\\work\\site", firstMessage: "# 首页改版\n\n把登录页改简单一点" });
    expect(createSession.mock.calls[0]![0]).not.toHaveProperty("critics");
    // 云端交代还没有（404）：第一句话就是标题；普通专题照旧不带 free、cwd。
    vi.mocked(topicBrief).mockRejectedValueOnce(new CloudError(404, "没有"));
    await startTopic(runner, { id: "t2", title: "改登录页", free: true, cwd: null }, MODEL as never);
    expect(createSession.mock.calls[1]![0]).toMatchObject({ free: true, firstMessage: "改登录页" });
    expect(createSession.mock.calls[1]![0]).not.toHaveProperty("cwd");
    await startTopic(runner, { id: "t3", title: "调研" }, MODEL as never);
    expect(createSession.mock.calls[2]![0]).not.toHaveProperty("free");
  });

  it("排队写清在等谁：「已排队 · 等 B 改登录页 这一轮做完」；不知道是谁时「等文件夹空出来」", () => {
    expect(queueText("folder_busy", null, HOLDER)).toBe("等 B 改登录页 这一轮做完");
    expect(queueText("folder_busy", null, { ...HOLDER, letter: null })).toBe("等 改登录页 这一轮做完");
    expect(queueText("folder_busy", null)).toBe("等文件夹空出来");
    expect(subQueueText({ state: "queued", queueReason: "folder_busy", holdUntil: null, heldBy: HOLDER })).toBe("已排队 · 等 B 改登录页 这一轮做完");
    expect(subQueueText({ state: "queued", queueReason: "folder_busy", holdUntil: null, heldBy: HOLDER }, true)).toBe("已排队 · 等 B");
    expect(subQueueText({ state: "queued", queueReason: "slot", holdUntil: null }, true)).toBe("已排队 · 等空位");
    expect(subQueueText({ state: "running", queueReason: null, holdUntil: null })).toBeNull();
  });

  it("假本机：同一个普通文件夹里有卡在跑，自由子会话排队、报在等哪张卡；卡停下后接着开；free 只给专题", async () => {
    const runner = createMockRunner({ stepMs: 2000 });
    expect(runner.freeSessions).toBe(true);
    expect((await runner.health()).protocol).toBeGreaterThanOrEqual(4);
    const card = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "改登录页", cwd: "D:\\site", firstMessage: "改" });
    const free = await runner.createSession({ subject: { kind: "topic", topicId: "t1" }, title: "把按钮改圆", cwd: "D:\\site", firstMessage: "把按钮改圆", free: true });
    expect(free.status).toBe("queued");
    expect(free.heldBy).toEqual({ kind: "card", id: "c1", title: "改登录页" });
    await runner.kill(card.id);
    const after = (await runner.listSessions()).find((session) => session.id === free.id)!;
    expect(after.status).not.toBe("queued");
    expect(after.heldBy).toBeUndefined();
    await expect(runner.createSession({ subject: { kind: "card", cardId: "c2" }, title: "x", firstMessage: "x", free: true })).rejects.toMatchObject({ status: 400 });
  });
});

const sub = (extra: Record<string, unknown>) => ({ id: "t9", kind: "topic", letter: "C", title: "把按钮改圆", state: "running", unseen: false, waiting: null, queueReason: null, role: null,
  sessionId: null, deviceId: null, autoStart: false, updatedAt: "2026-11-11T01:00:00.000Z", merge: null, holdUntil: null, ...extra });
const home = (extra: Partial<HomeProject> = {}) => ({
  period: "2026-11", archivedCount: 0, month: { missions: [] }, waiting: [], other: { subSessions: [], items: [] },
  projects: [{ projectId: "p1", name: "首页改版", lastActivityAt: "2026-11-11T01:00:00.000Z", budget: null, goals: [], transfer: null, unseen: false,
    summary: { running: 0, waiting: 0, queued: 0, done: 0, doneToday: 0, needsYou: 0 }, pipeline: { conversationId: null, scope: "project:p1" }, planning: false, subSessions: [], items: [], ...extra }],
}) as unknown as WorkHomeData;
const left = (data: WorkHomeData, local?: Partial<LocalRunnerState>) => {
  const tree = <LeftColumn data={data} view={{ kind: "home" }} buddy={null} speaking={false} go={() => undefined} phone={false} account={{ displayName: "孙铭泽", role: "member" }}
    today="11 月 11 日 周三" alert={false} projects={data.projects.map((project) => fromHome(project, data, new Map()))} archived={[]} onCreate={async () => "x"}
    actions={{ archiveSub: vi.fn(), deleteSub: vi.fn(), renameSub: vi.fn(), archiveProject: vi.fn(), deleteProject: vi.fn(), renameProject: vi.fn() } as never} />;
  return renderToStaticMarkup(local ? <LocalContext.Provider value={{ sessions: [], ...local } as LocalRunnerState}>{tree}</LocalContext.Provider> : tree);
};

describe("左栏的「+」和排队行（第 68 条）", () => {
  it("项目行和详情放在一起一个「+」，进 /new；这台电脑的本机程序太旧（protocol < 4）时不出，手机、本机没连上时照出", () => {
    expect(left(home())).toMatch(/<span class="[^"]*" data-menu=""><button[^>]*data-testid="project-new-sub"[^>]*aria-label="首页改版 新子会话"/);
    expect(left(home(), { phase: "ready", runner: { freeSessions: false } as never })).not.toContain("project-new-sub");
    expect(left(home(), { phase: "ready", runner: { freeSessions: true } as never })).toContain("project-new-sub");
    expect(left(home(), { phase: "offline", runner: {} as never })).toContain("project-new-sub");
  });

  it("排着队在等文件夹的子会话：行尾写在等哪个字母", () => {
    const other = (extra: Record<string, unknown>) => ({ ...home(), other: { subSessions: [sub(extra)], items: [] } }) as unknown as WorkHomeData;
    const html = left(other({ state: "queued", queueReason: "folder_busy", heldBy: HOLDER }));
    expect(html).toMatch(/把按钮改圆<\/span><span[^>]*data-testid="sub-held">等 B<\/span>/);
    expect(left(other({ state: "queued", queueReason: "slot" }))).not.toContain("sub-held");
  });
});

describe("认领到自由子会话以后怎么开（第 68 条，claimTopic）", () => {
  const FREE = { id: "t1", kind: "topic" as const, title: "把按钮改圆", free: true as const };
  const projects = [{ id: "p1", subSessions: [{ id: "t1" }] }] as never;
  const folder = { id: "f1", path: "D:\site", label: "site" };
  const input = (extra: Partial<Parameters<typeof claimTopic>[1]> = {}) => ({ subs: [FREE], projects, bound: new Map(), freeSessions: true, busy: new Set<string>(), ...extra });

  it("项目已在这台电脑上绑了文件夹：开，带 free 和那个文件夹", () => {
    expect(claimTopic("t1", input({ bound: new Map([["p1", folder]]) }))).toEqual({ kind: "start", topic: { id: "t1", title: "把按钮改圆", free: true, cwd: "D:\site" } });
  });

  it("项目没绑：先问这个项目在哪个文件夹开工，不开", () => {
    expect(claimTopic("t1", input())).toEqual({ kind: "ask", projectId: "p1" });
  });

  it("选完文件夹再认领：开，而且只开一个（这台电脑上已经有它的会话时不再开，也不算没开成）", async () => {
    const runner = createMockRunner({ stepMs: 2000 });
    const bound = new Map([["p1", folder]]);
    const busyNow = async () => new Set((await runner.listSessions()).flatMap((session) => [session.subject.topicId].filter((id): id is string => !!id)));
    const first = claimTopic("t1", input({ bound, busy: await busyNow() }));
    expect(first.kind).toBe("start");
    if (first.kind === "start") await startTopic(runner, first.topic, MODEL as never);
    expect(claimTopic("t1", input({ bound, busy: await busyNow() }))).toEqual({ kind: "skip", failed: false });
    const sessions = await runner.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ subject: { kind: "topic", topicId: "t1" }, cwd: "D:\site" });
  });

  it("本机程序协议号小于 4：不开，记成没开成（不管绑没绑）", () => {
    expect(claimTopic("t1", input({ freeSessions: false }))).toEqual({ kind: "skip", failed: true });
    expect(claimTopic("t1", input({ freeSessions: false, bound: new Map([["p1", folder]]) }))).toEqual({ kind: "skip", failed: true });
  });

  it("普通专题照旧开（本机给专用目录），不看文件夹、不看协议号", () => {
    expect(claimTopic("t2", input({ subs: [{ id: "t2", kind: "topic", title: "调研" }], freeSessions: false }))).toEqual({ kind: "start", topic: { id: "t2", title: "调研" } });
  });
});
