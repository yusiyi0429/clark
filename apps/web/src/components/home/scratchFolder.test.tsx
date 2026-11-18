// 「随手」项目在这台电脑上的文件夹（plan-dots 第 3 件）：首页打开、本机程序连着时调一次本机的 scratchFolder，成了重读绑定。
// 没有 jsdom：React 的几个钩子换成按调用顺序记状态的假钩子，手动「再画一次」。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TLocalProjectFolder, TLocalScratchFolderRequest, TLocalScratchFolderResponse } from "@warmap/contracts";

const ui = vi.hoisted(() => ({ state: [] as unknown[], cursor: 0, refs: [] as { current: unknown }[], refCursor: 0,
  memos: [] as { value: unknown; deps: readonly unknown[] }[], memoCursor: 0,
  effects: [] as (readonly unknown[] | undefined)[], effectCursor: 0, queued: [] as (() => void | (() => void))[],
  local: null as unknown,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const memo = (make: () => unknown, deps: readonly unknown[]) => {
    const index = ui.memoCursor++, previous = ui.memos[index];
    if (!previous || deps.some((dep, offset) => !Object.is(dep, previous.deps[offset]))) ui.memos[index] = { value: make(), deps };
    return ui.memos[index].value;
  };
  return { ...actual,
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = ui.effectCursor++, previous = ui.effects[index];
      if (!previous || !deps || deps.some((dep, offset) => !Object.is(dep, previous[offset]))) { ui.effects[index] = deps; ui.queued.push(effect); }
    },
    useState: (initial: unknown) => {
      const index = ui.cursor++;
      if (!(index in ui.state)) ui.state[index] = initial;
      return [ui.state[index], (next: unknown) => { ui.state[index] = typeof next === "function" ? next(ui.state[index]) : next; }];
    },
    useRef: (current: unknown) => ui.refs[ui.refCursor++] ??= { current },
    useMemo: memo,
    useCallback: (callback: unknown, deps: readonly unknown[]) => memo(() => callback, deps),
  };
});
vi.mock("@/lib/local/LocalRunnerProvider", () => ({ useLocalRunner: () => ui.local }));
vi.mock("@/lib/board/cloud", () => ({
  listProjects: vi.fn(async () => ({ projects: [] })), listArchivedSubSessions: vi.fn(async () => ({ items: [] })),
  attachGoal: vi.fn(), createProject: vi.fn(), deleteProject: vi.fn(), deleteSubSession: vi.fn(), setGoalDueDate: vi.fn(), startTransfer: vi.fn(),
  updateProject: vi.fn(), updateSubSession: vi.fn(), withdrawTransfer: vi.fn(),
}));
import { LocalRunnerError } from "@/lib/local/runner";
import { startFolder } from "@/lib/home/startFolder";
import { useProjects } from "./useProjects";

const SCRATCH = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";
const OTHER = "0d1c2b3a-4d0c-4c1e-9a43-1f7d2c9b8e11";
const at = "2026-11-18T00:00:00.000Z";
const project = (projectId: string, name: string, scratch?: true) => ({ projectId, name, goals: [], budget: null, lastActivityAt: at, summary: { needsYou: 0 },
  pipeline: { conversationId: null, scope: `project:${projectId}` }, planning: false, subSessions: [], items: [], transfer: null, unseen: false, ...(scratch ? { scratch } : {}) });
type Data = Parameters<typeof useProjects>[0];
const home = (...projects: ReturnType<typeof project>[]) => ({ projects, month: { missions: [] }, period: "2026-11", archivedCount: 0 }) as unknown as Data;

/** 假的本机程序：scratchFolder 照本机的规矩（没绑才建、绑上），也可以换成老版本的 404。 */
function runner(scratch?: (body: TLocalScratchFolderRequest) => Promise<TLocalScratchFolderResponse>) {
  const bound = new Map<string, TLocalProjectFolder>();
  const folder = { id: "s1", path: "C:\\Users\\me\\天枢\\随手", label: "随手", addedAt: at };
  return {
    kind: "mock" as const,
    listProjects: vi.fn(async () => [...bound.values()]),
    putProjectFolder: vi.fn(),
    scratchFolder: vi.fn(scratch ?? (async (body: TLocalScratchFolderRequest) => {
      const ref = { id: folder.id, path: folder.path, label: folder.label };
      const entry = bound.get(body.projectId) ?? { projectId: body.projectId, name: body.projectName ?? null, folder: ref, folders: [ref], updatedAt: at };
      bound.set(body.projectId, entry);
      return { folder, project: entry };
    })),
  };
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function render(data: Data) {
  ui.cursor = 0; ui.refCursor = 0; ui.memoCursor = 0; ui.effectCursor = 0;
  const hook = useProjects(data, async () => undefined);
  ui.queued.splice(0).forEach((effect) => effect());
  return hook;
}
/** 画、等异步做完、再画，直到不再有新的副作用。 */
async function mount(data: Data) {
  let hook = render(data);
  for (let i = 0; i < 4; i++) { await settle(); hook = render(data); }
  await settle();
  return render(data);
}
const connect = (r: ReturnType<typeof runner>, phase = "ready") => { ui.local = { runner: r, phase, folders: [], pickFolder: vi.fn(), createFolder: vi.fn() }; };

beforeEach(() => { ui.state = []; ui.refs = []; ui.memos = []; ui.effects = []; ui.queued = []; });

describe("「随手」项目在这台电脑上的文件夹", () => {
  it("首页里有随手项目、本机程序连着、还没绑：调一次 scratchFolder，再重读绑定", async () => {
    const r = runner();
    connect(r);
    const data = home(project(OTHER, "官网"), project(SCRATCH, "随手", true));
    const hook = await mount(data);
    expect(r.scratchFolder).toHaveBeenCalledTimes(1);
    expect(r.scratchFolder).toHaveBeenCalledWith({ projectId: SCRATCH, projectName: "随手" });
    expect(r.listProjects.mock.calls.length).toBeGreaterThanOrEqual(2); // 进页面读一次，建好后再读一次
    expect(hook.bound.get(SCRATCH)?.path).toBe("C:\\Users\\me\\天枢\\随手");
    expect(hook.bound.has(OTHER)).toBe(false);
    await mount(data);
    expect(r.scratchFolder).toHaveBeenCalledTimes(1);
  });

  it("老版本本机程序没有这个接口，退回问文件夹", async () => {
    const r = runner(async () => { throw new LocalRunnerError("not_found", "没有这个接口", 404); });
    connect(r);
    const data = home(project(SCRATCH, "随手", true));
    let hook = await mount(data);
    expect(r.scratchFolder).toHaveBeenCalledTimes(1);
    expect(hook.bound.size).toBe(0);
    // 掉线再连上、页面再画几次：这次页面打开里不再试
    connect(r, "offline");
    await mount(data);
    connect(r);
    hook = await mount(data);
    expect(r.scratchFolder).toHaveBeenCalledTimes(1);
    expect(hook.bound.size).toBe(0);
    expect(startFolder(SCRATCH, hook.bound, null)).toEqual({ cwd: null, ask: true });
  });

  it("没有随手项目、或本机程序没连上：不调", async () => {
    const none = runner();
    connect(none);
    await mount(home(project(OTHER, "官网")));
    expect(none.scratchFolder).not.toHaveBeenCalled();
    ui.state = []; ui.refs = []; ui.memos = []; ui.effects = []; ui.queued = [];
    const offline = runner();
    connect(offline, "offline");
    await mount(home(project(SCRATCH, "随手", true)));
    expect(offline.scratchFolder).not.toHaveBeenCalled();
  });
});
