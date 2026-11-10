import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 没有 jsdom：useState 记下最后一次 set 的值，useEffect 收起来由测试来跑（同 taskMutations.test 的做法）。 */
const hooks = vi.hoisted(() => ({ value: undefined as unknown, effects: [] as (() => unknown)[] }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [hooks.value ?? initial, (next: unknown) => { hooks.value = next; }],
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
}));
const api = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: api }));

import { saveRailBackground, useRailBackground } from "./useRailBackground";

const storage = new Map<string, string>();
/** 这个人打开页面：先用本机记的那份；服务端那份由 server 给（不给就一直等着）。 */
async function open(personId: string | null, server?: unknown) {
  hooks.value = undefined; hooks.effects = [];
  api.GET.mockReturnValue(server === undefined ? new Promise(() => undefined) : Promise.resolve({ data: server }));
  useRailBackground(personId);
  hooks.effects.forEach((effect) => effect());
  await new Promise((resolve) => setTimeout(resolve, 0));
  return hooks.value;
}

beforeEach(() => {
  storage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } },
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("通知栏背景的本机那份按人分开", () => {
  it("同一台电脑换账号：后登录的人不会先用上一个人的背景，等到自己的再换；回到原来的人还是他自己的", async () => {
    const sunPhoto = { choice: "custom", imageVersion: "v1" };
    expect(await open("sun", sunPhoto)).toEqual(sunPhoto);
    expect(await open("wang")).toBeNull();
    expect(await open("wang", { choice: "pine", imageVersion: null })).toEqual({ choice: "pine", imageVersion: null });
    expect(await open("sun")).toEqual(sunPhoto);
  });

  it("拿不到是谁时不用本机那份，只等服务端", async () => {
    await open("sun", { choice: "dusk", imageVersion: null });
    expect(await open(null)).toBeNull();
  });

  it("保存后通知各处重读，重读回来的记到这个人名下", async () => {
    await open("sun", { choice: "mist", imageVersion: null });
    api.PUT.mockResolvedValue({ data: { choice: "night", imageVersion: null } });
    api.GET.mockResolvedValue({ data: { choice: "night", imageVersion: null } });
    await saveRailBackground({ choice: "night" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await open("sun")).toEqual({ choice: "night", imageVersion: null });
  });
});
