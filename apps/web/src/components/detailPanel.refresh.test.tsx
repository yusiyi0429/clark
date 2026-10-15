import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";

const h = vi.hoisted(() => ({ states: [] as unknown[], index: 0, deps: [] as (unknown[] | undefined)[], effectIndex: 0,
  effects: [] as (() => void)[], dirty: false, onCard: null as ((card: Card) => void) | null }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = h.index++;
    if (!(index in h.states)) h.states[index] = initial;
    return [h.states[index], (update: unknown) => {
      const next = typeof update === "function" ? update(h.states[index]) : update;
      if (next !== h.states[index]) h.dirty = true;
      h.states[index] = next;
    }];
  },
  useEffect: (effect: () => void, deps: unknown[]) => {
    const index = h.effectIndex++, previous = h.deps[index];
    if (!previous || deps.some((value, i) => value !== previous[i])) { h.deps[index] = deps; h.effects.push(effect); }
  },
  useMemo: (compute: () => unknown) => compute(),
  useCallback: (callback: unknown) => callback,
}));
vi.mock("@/cards/registry", () => ({ renderCard: ({ card, onCard }: { card: Card; onCard: (card: Card) => void }) => {
  h.onCard = onCard; return <article>{card.title} v{card.version}</article>;
} }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useRegisterDetail: () => {}, useWorkspace: () => ({ navigate: vi.fn(), close: vi.fn(), viewerId: "ceo" }) }));
import { DetailPanel } from "./DetailPanel";

const card = (version: number): Card => ({ id: "signal:s1", version, kind: "signal", title: `研判${version}` } as Card);
beforeEach(() => {
  h.states = []; h.deps = []; h.onCard = null;
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
function render(initialCards: Card[]) {
  let html = "";
  for (let i = 0; i < 4; i++) {
    h.index = 0; h.effectIndex = 0; h.effects = []; h.dirty = false;
    html = renderToStaticMarkup(<DetailPanel initialCards={initialCards} scope="signal:s1" label="信号" />);
    h.effects.forEach((effect) => effect());
    if (!h.dirty) return html;
  }
  throw new Error("Panel did not settle");
}

describe("对象详情保留最新版本", () => {
  it("单对象查询先返回新Card后，较旧路由刷新不能覆盖；更新的路由Card仍正常更新", () => {
    const original = [card(1)];
    expect(render(original)).toContain("研判1 v1");
    h.onCard!(card(3));
    expect(render(original)).toContain("研判3 v3");
    expect(render([card(2)])).toContain("研判3 v3");
    const newer = [card(4)];
    expect(render(newer)).toContain("研判4 v4");
    h.onCard!(card(2));
    expect(render(newer)).toContain("研判4 v4");
  });

  it("切换对象时使用新对象的Card，即使它的版本低于先前对象", () => {
    expect(render([card(6)])).toContain("研判6 v6");
    const another = { ...card(1), id: "signal:s2", title: "新导入信号" };
    const html = render([another]);
    expect(html).toContain("新导入信号 v1");
    expect(html).not.toContain("研判6");
  });
});
