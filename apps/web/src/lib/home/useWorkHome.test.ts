import { beforeEach, describe, expect, it, vi } from "vitest";

// 不起浏览器：react 的几个 hook 换成可重放的假实现，effect 在每次「渲染」后照顺序跑一遍。
const hooks = vi.hoisted(() => ({
  position: 0, values: [] as unknown[], effects: [] as (() => void | (() => void))[],
  useState(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[key], (next: unknown) => { hooks.values[key] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[key]) : next; }];
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: hooks.useState,
  useMemo: (make: () => unknown) => make(),
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
}));

const cloud = vi.hoisted(() => ({ next: null as null | { resolve: (value: unknown) => void } }));
vi.mock("@/lib/board/cloud", () => ({ readWorkHome: () => new Promise((resolve) => { cloud.next = { resolve }; }) }));
vi.mock("@/components/member/home/useHomePlan", () => ({ useHomePlan: () => ({ error: null, refresh: vi.fn() }) }));
vi.mock("@/components/member/useMemberHome", () => ({ useMemberHome: () => ({ notifications: [], rounds: [], unreadThreads: [], unreadMissionGroups: [], refresh: vi.fn() }) }));
vi.mock("@/lib/local/LocalRunnerProvider", () => ({ useLocalRunner: () => ({ status: null, phase: "offline", sessions: [] }) }));
vi.mock("@/lib/work/merge", () => ({ useMergeIssues: () => [] }));
vi.mock("@/lib/work/useWork", () => ({ useWork: () => ({ plan: { tasks: [] }, workers: [], boards: {}, proposals: [], refresh: vi.fn() }) }));
const project = (projectId: string, name: string) => ({ projectId, name, goals: [], subSessions: [], summary: { needsYou: 0 } });
const home = (projects: ReturnType<typeof project>[]) => ({ period: "2026-11", projects, archivedCount: 0, month: { missions: [] }, other: { subSessions: [], items: [] }, waiting: [] });
// 回退：按 Mission 拼一个同名项目（derive.ts，16.5）。
vi.mock("./derive", () => ({ deriveWorkHome: () => home([project("mission:seed-nov-tianshu", "天枢 11 月：V1 11/18 上线，V2 11/30 上线")]) }));

import { useWorkHome } from "./useWorkHome";

vi.stubGlobal("window", { setInterval: () => 0, clearInterval: () => undefined });
vi.stubGlobal("document", { visibilityState: "hidden" });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const render = () => {
  hooks.position = 0; hooks.effects = [];
  const api = useWorkHome();
  hooks.effects.forEach((effect) => effect());
  return api;
};
const names = (api: ReturnType<typeof useWorkHome>) => api.data.projects.map((entry) => entry.name);

beforeEach(() => { hooks.values = []; cloud.next = null; });

describe("useWorkHome：云端首页和按 Mission 拼的回退", () => {
  it("云端首页还没回：项目、等你、本月都空，不拿 Mission 拼项目", () => {
    const api = render();
    expect(api.known).toBe(false);
    expect(api.data.projects).toEqual([]);
    expect(api.data.waiting).toEqual([]);
    expect(api.data.month.missions).toEqual([]);
    expect(api.data.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it("云端首页 404：照旧用按 Mission 拼的项目", async () => {
    render();
    cloud.next!.resolve(null);
    await flush();
    const api = render();
    expect(api.known).toBe(true);
    expect(api.live).toBe(false);
    expect(names(api)).toEqual(["天枢 11 月：V1 11/18 上线，V2 11/30 上线"]);
  });

  it("云端首页回来：用云端的项目", async () => {
    render();
    cloud.next!.resolve(home([project("p1", "灯塔试点"), project("p2", "新版天枢应用")]));
    await flush();
    const api = render();
    expect(api.live).toBe(true);
    expect(names(api)).toEqual(["灯塔试点", "新版天枢应用"]);
  });
});
