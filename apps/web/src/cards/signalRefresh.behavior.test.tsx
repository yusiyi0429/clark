import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Card } from "@/lib/api/client";

const h = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[], get: vi.fn() }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => h.effects.push(effect),
  useState: (initial: unknown) => [initial, vi.fn()],
  useMemo: (compute: () => unknown) => compute(),
}));
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: h.get } }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ homeCards: [] }) }));
vi.mock("@/components/shell/DetailFrame", () => ({ DetailFrame: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("./SignalArticle", () => ({ SignalArticle: () => null }));
vi.mock("./SignalStory", () => ({ SignalStory: () => null }));
import { SignalCard } from "./SignalCard";

const card = (version: number): Card => ({ id: "signal:s1", version, kind: "signal", title: "信号", objectRef: { type: "signal", id: "s1", version },
  payload: { source: { type: "web" }, assessment: { anchorId: "a1" }, state: { read: false, saved: false, dismissed: false } }, actions: [], schemaVersion: 1 } as unknown as Card);
let listener: EventListener;
beforeEach(() => {
  h.effects = []; h.get.mockReset();
  vi.stubGlobal("window", { addEventListener: vi.fn((_name, next) => { listener = next; }), removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
const changed = (scope: string) => listener({ detail: { scope } } as unknown as Event);
const setup = () => {
  const onCard = vi.fn();
  renderToStaticMarkup(<SignalCard card={card(1)} collection={[]} onCard={onCard} onNavigate={vi.fn()} />);
  const cleanup = h.effects[0]();
  return { onCard, cleanup };
};

describe("信号修改后直接重读当前对象", () => {
  it("仅当前scope成功事件触发无缓存单对象查询，并把最新Card交给左侧", async () => {
    const latest = card(3);
    h.get.mockResolvedValue({ data: { cards: [latest] }, response: { ok: true } });
    const { onCard } = setup();
    changed("signal:other");
    expect(h.get).not.toHaveBeenCalled();
    changed("signal:s1");
    await vi.waitFor(() => expect(onCard).toHaveBeenCalledWith(latest));
    expect(h.get).toHaveBeenCalledWith("/api/cards/signals/{id}", { params: { path: { id: "s1" } }, cache: "no-store" });
  });

  it("查询失败不替换正文，离开页面后迟到的响应也不覆盖其他页面", async () => {
    h.get.mockResolvedValueOnce({ response: { ok: false } });
    const { onCard, cleanup } = setup();
    changed("signal:s1");
    await Promise.resolve(); await Promise.resolve();
    expect(onCard).not.toHaveBeenCalled();
    let resolve!: (value: unknown) => void;
    h.get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    changed("signal:s1");
    cleanup?.();
    resolve({ data: { cards: [card(3)] }, response: { ok: true } });
    await Promise.resolve(); await Promise.resolve();
    expect(onCard).not.toHaveBeenCalled();
  });
});
