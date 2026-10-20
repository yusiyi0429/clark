import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TMeetingCardView } from "@warmap/contracts";

/* hooks 换成按调用顺序存值的小仓库；useEffect 按依赖变没变决定这次渲染后跑不跑（像 React 一样先清理上一次）。 */
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, refs: [] as { current: unknown }[], refIndex: 0,
  effects: [] as { deps?: unknown[]; cleanup?: void | (() => void) }[], effectIndex: 0, queued: [] as (() => void)[],
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
  useRef(initial: unknown) {
    return (hooks.refs[hooks.refIndex++] ??= { current: initial });
  },
  useEffect(run: () => void | (() => void), deps?: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    if (previous && deps && previous.deps && deps.every((dep, at) => Object.is(dep, previous.deps![at]))) return;
    hooks.queued.push(() => {
      if (typeof previous?.cleanup === "function") previous.cleanup();
      hooks.effects[index] = { deps, cleanup: run() };
    });
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect }));
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: api.get } }));

import { useMeetingCardProbe } from "./useMeetingCardProbe";

const render = (refreshKey: string) => {
  hooks.index = 0; hooks.refIndex = 0; hooks.effectIndex = 0; hooks.queued = [];
  const probe = useMeetingCardProbe("m1", refreshKey);
  hooks.queued.forEach((run) => run());
  return probe;
};
const cardView = (draftVersion: number) => ({ draft: { title: "渠道预算会" }, draftVersion, confirmed: null }) as unknown as TMeetingCardView;
const ok = (data: unknown) => ({ data, response: { ok: true, status: 200 } });

beforeEach(() => { hooks.values = []; hooks.refs = []; hooks.effects = []; api.get.mockReset(); });

describe("会议记录用会议卡还是旧格式", () => {
  it("问到是会议卡以后，会议状态变了也不再问；会议卡交回的最新一份接着用（不重新挂载、不回到旧内容）", async () => {
    api.get.mockResolvedValue(ok(cardView(3)));
    expect(render("held|ready").status).toBe("unknown");
    await vi.waitFor(() => expect(render("held|ready").status).toBe("card"));
    expect(api.get).toHaveBeenCalledTimes(1);

    const card = render("held|ready");
    if (card.status !== "card") throw new Error("not a card");
    card.remember(cardView(7));
    const confirmed = render("reviewed|ready");
    await Promise.resolve();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(confirmed.status === "card" && confirmed.initial.draftVersion).toBe(7);
  });

  it("旧格式（或还没有草稿）时，会后整理状态变了再问一次", async () => {
    api.get.mockResolvedValueOnce(ok({ draft: null, confirmed: null, draftVersion: 0 })).mockResolvedValueOnce(ok(cardView(1)));
    render("held|running");
    await vi.waitFor(() => expect(render("held|running").status).toBe("legacy"));
    render("held|ready");
    await vi.waitFor(() => expect(render("held|ready").status).toBe("card"));
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});
