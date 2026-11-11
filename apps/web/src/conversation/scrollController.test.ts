import { describe, expect, it, vi } from "vitest";
import {
  createScrollController, easeOutCubic, followGlides, followTop, isAtEnd, nextMode, nextReserve, OPEN_SETTLE_MS, pinTarget, reserveNeeded, SEND_PIN_MS,
} from "./scrollController";

/**
 * 发送后置顶（与 Claude / ChatGPT 一致）：纯函数与状态机，再用假的滚动区把控制器整条走一遍。
 */
describe("纯函数", () => {
  it("置顶目标：刚发的那条的上沿对齐滚动区上方留白之下", () => {
    // 元素在视口 900，滚动区上沿 100，已滚 300，上留白 44 → 900 - 100 + 300 - 44
    expect(pinTarget({ elementTop: 900, scrollerTop: 100, scrollTop: 300, inset: 44 })).toBe(1056);
    expect(pinTarget({ elementTop: 110, scrollerTop: 100, scrollTop: 0, inset: 44 })).toBe(0);
  });

  it("预留空白：刚好让目标位置能滚到，不多留；内容够长就是 0", () => {
    expect(reserveNeeded({ keepTop: 1000, viewport: 600, naturalEnd: 1200 })).toBe(400);
    expect(reserveNeeded({ keepTop: 1000, viewport: 600, naturalEnd: 2000 })).toBe(0);
  });

  it("置顶时按需留白（可增可减）；其他时候只缩不涨，缩完当前位置仍然可达（视图不跳）", () => {
    expect(nextReserve({ mode: "pinned", current: 100, keepTop: 1000, viewport: 600, naturalEnd: 1200 })).toBe(400);
    expect(nextReserve({ mode: "pinned", current: 500, keepTop: 1000, viewport: 600, naturalEnd: 1500 })).toBe(100);
    expect(nextReserve({ mode: "free", current: 100, keepTop: 1000, viewport: 600, naturalEnd: 1200 })).toBe(100);
    expect(nextReserve({ mode: "free", current: 400, keepTop: 900, viewport: 600, naturalEnd: 1200 })).toBe(300);
    expect(nextReserve({ mode: "follow", current: 400, keepTop: 900, viewport: 600, naturalEnd: 2000 })).toBe(0);
  });

  it("新一轮按真实内容重算，留白不跨轮叠加", () => {
    // 上一轮剩 300 的留白，scrollHeight 1500 = 真实 1200 + 300；新一轮目标 1100
    const first = nextReserve({ mode: "pinned", current: 300, keepTop: 1100, viewport: 600, naturalEnd: 1500 - 300 });
    expect(first).toBe(500);
    expect(nextReserve({ mode: "pinned", current: first, keepTop: 1100, viewport: 600, naturalEnd: 1700 - first })).toBe(500);
  });

  it("到底判断只看真实内容的末尾（不算留白）", () => {
    expect(isAtEnd({ scrollTop: 1000, viewport: 600, naturalEnd: 1200 })).toBe(true);
    expect(isAtEnd({ scrollTop: 1000, viewport: 600, naturalEnd: 1670 })).toBe(true);
    expect(isAtEnd({ scrollTop: 1000, viewport: 600, naturalEnd: 1680 })).toBe(false);
  });

  it("跟随只往下走，不把看得到的留白拉回来", () => {
    expect(followTop({ scrollTop: 100, viewport: 600, naturalEnd: 1200 })).toBe(600);
    expect(followTop({ scrollTop: 800, viewport: 600, naturalEnd: 1200 })).toBe(800);
  });

  it("缓动短而利落：两端准确，前段走得快", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.3)).toBeGreaterThan(0.6);
    expect(SEND_PIN_MS).toBeLessThanOrEqual(250);
  });
});

describe("状态机", () => {
  it("打开：默认跟随到底；从气泡打开不跟随", () => {
    expect(nextMode("free", { type: "open", anchor: "end" })).toBe("follow");
    expect(nextMode("follow", { type: "open", anchor: "reply" })).toBe("free");
  });
  it("发送：找到刚发的那条就置顶，找不到（群聊）照旧跟随到底", () => {
    expect(nextMode("follow", { type: "send", found: true })).toBe("pinned");
    expect(nextMode("free", { type: "send", found: false })).toBe("follow");
  });
  it("回答结束：置顶变成自由（不自动跟随），跟随与自由不变", () => {
    expect(nextMode("pinned", { type: "streamEnd" })).toBe("free");
    expect(nextMode("follow", { type: "streamEnd" })).toBe("follow");
    expect(nextMode("free", { type: "streamEnd" })).toBe("free");
  });
  it("用户往上滚就停；点 ↓、换频道、自己滚回真实末尾就跟随", () => {
    expect(nextMode("follow", { type: "userUp" })).toBe("free");
    expect(nextMode("pinned", { type: "userUp" })).toBe("free");
    expect(nextMode("pinned", { type: "jump" })).toBe("follow");
    expect(nextMode("free", { type: "reset" })).toBe("follow");
    expect(nextMode("free", { type: "userReachedEnd" })).toBe("follow");
  });
  it("跳到某一块（待确认 N）：交还给用户，不跟随", () => {
    expect(nextMode("follow", { type: "reveal" })).toBe("free");
    expect(nextMode("pinned", { type: "reveal" })).toBe("free");
  });
});

/** 假滚动区：上留白 pad、下留白 bottom，内容高度、宽度、整体缩放可变，留白元素高度跟着 style.height。 */
function fakeDom({ viewport = 600, pad = 44, bottom = 130, items = [] as { role: string; top: number; h?: number }[], height = 2000, width = 360, scale = 1 } = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const reserve = { style: { height: "" } };
  const state = { height, items, width, scale };
  const reserveHeight = () => parseFloat(reserve.style.height) || 0;
  let top = 0;
  const scroller = {
    clientHeight: viewport,
    offsetHeight: viewport,
    get clientWidth() { return state.width; },
    get scrollHeight() { return pad + state.height + bottom + reserveHeight(); },
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.scrollHeight - viewport)); },
    getBoundingClientRect: () => ({ top: 100, height: viewport * state.scale }),
    addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const content = {
    querySelectorAll: (selector: string) => state.items
      .filter((item) => !selector.includes('"') || selector.includes(`"${item.role}"`))
      .map((item) => ({ getBoundingClientRect: () => {
        const at = 100 + (pad + item.top - top) * state.scale;
        return { top: at, bottom: at + (item.h ?? 100) * state.scale, height: (item.h ?? 100) * state.scale };
      } })),
  };
  const fire = (type: string, event: unknown = {}) => listeners.get(type)?.(event);
  /** 用户滚动：先有手势，再有 scroll 事件。 */
  const userScroll = (to: number) => { fire("wheel", { deltaY: to - top }); scroller.scrollTop = to; fire("scroll"); };
  return { scroller, content, reserve, state, reserveHeight, fire, userScroll };
}

function setup(options: { reduced?: boolean; anchor?: "end" | "reply" } & Parameters<typeof fakeDom>[0] = {}) {
  const dom = fakeDom(options);
  const frames: (() => void)[] = [];
  let clock = 0;
  const onAtBottom = vi.fn();
  const controller = createScrollController({
    anchor: options.anchor,
    onAtBottom,
    reduced: () => Boolean(options.reduced),
    inset: () => 44,
    now: () => clock,
    raf: (callback) => { frames.push(callback); return frames.length; },
    caf: () => { frames.length = 0; },
    resizeObserver: null,
  });
  controller.attachContent(dom.content as unknown as HTMLElement);
  controller.attachReserve(dom.reserve as unknown as HTMLElement);
  controller.attachScroller(dom.scroller as unknown as HTMLElement);
  const runFrames = (ms = SEND_PIN_MS + 20) => {
    for (let elapsed = 0; elapsed <= ms && frames.length; elapsed += 16) {
      clock += 16;
      const pending = frames.splice(0);
      pending.forEach((callback) => callback());
    }
    dom.fire("scroll");
  };
  /** 时间往前走（不跑帧）：过了打开后的那一小会儿。 */
  const advance = (ms: number) => { clock += ms; };
  return { ...dom, controller, onAtBottom, runFrames, frames, advance };
}

describe("滚动控制器", () => {
  it("打开时落在底部；历史后到也跟到底", () => {
    const t = setup({ height: 2000 });
    expect(t.scroller.scrollTop).toBe(44 + 2000 + 130 - 600);
    t.state.height = 3000;
    t.controller.layout();
    expect(t.scroller.scrollTop).toBe(44 + 3000 + 130 - 600);
    expect(t.controller.mode()).toBe("follow");
  });

  it("发送：短促动画把刚发的那条推到顶部留白之下，下面留出一屏空白；回答增长时视图不动", () => {
    const t = setup({ height: 2000, items: [{ role: "user", top: 1200 }, { role: "assistant", top: 1400 }, { role: "user", top: 1900 }] });
    t.state.height = 2060; // 刚发的那条出现
    t.controller.layout();
    t.controller.send();
    expect(t.controller.mode()).toBe("pinned");
    // 目标：该条在内容中的 44 + 1900 处 - 上留白 44 = 1900
    expect(t.reserveHeight()).toBe(1900 + 600 - (44 + 2060 + 130));
    expect(t.frames.length).toBe(1);
    t.runFrames();
    expect(t.scroller.scrollTop).toBe(1900);
    // 回答长起来：不跟随，留白跟着缩，总高度不变（不跳）
    t.state.height = 2200;
    t.controller.layout();
    expect(t.scroller.scrollTop).toBe(1900);
    expect(t.reserveHeight()).toBe(1900 + 600 - (44 + 2200 + 130));
    expect(t.controller.atBottom()).toBe(true);
  });

  it("回答超过一屏：仍不跟随，出 ↓；点 ↓ 跳到最新并跟随到这轮结束", () => {
    const t = setup({ height: 2000, items: [{ role: "user", top: 1900 }] });
    t.controller.send();
    t.runFrames();
    t.state.height = 3200;
    t.controller.layout();
    expect(t.scroller.scrollTop).toBe(1900);
    expect(t.reserveHeight()).toBe(0);
    expect(t.controller.atBottom()).toBe(false);
    expect(t.onAtBottom).toHaveBeenLastCalledWith(false);
    t.controller.jump();
    t.runFrames();
    expect(t.scroller.scrollTop).toBe(44 + 3200 + 130 - 600);
    expect(t.controller.mode()).toBe("follow");
    t.state.height = 3600;
    t.controller.layout();
    expect(t.scroller.scrollTop).toBe(44 + 3600 + 130 - 600);
    expect(t.onAtBottom).toHaveBeenLastCalledWith(true);
  });

  it("回答结束：留白缩到刚好够用，当前位置不变（不跳），也不开始跟随", () => {
    const t = setup({ height: 2000, items: [{ role: "user", top: 1900 }] });
    t.controller.send();
    t.runFrames();
    t.state.height = 2100;
    t.controller.layout();
    const before = t.scroller.scrollTop;
    t.controller.streamEnd();
    expect(t.controller.mode()).toBe("free");
    expect(t.scroller.scrollTop).toBe(before);
    expect(t.reserveHeight()).toBe(before + 600 - (44 + 2100 + 130));
    // 用户往上看过后结束：留白缩到不露在视口里
    t.userScroll(1500);
    t.controller.streamEnd();
    expect(t.reserveHeight()).toBe(0);
    expect(t.scroller.scrollTop).toBe(1500);
  });

  it("下一次发送重新算留白，不叠加", () => {
    const t = setup({ height: 2000, items: [{ role: "user", top: 1900 }] });
    t.controller.send();
    t.runFrames();
    t.controller.streamEnd();
    t.state.height = 2300;
    t.state.items = [{ role: "user", top: 1900 }, { role: "user", top: 2250 }];
    t.controller.layout();
    t.controller.send();
    t.runFrames();
    expect(t.scroller.scrollTop).toBe(2250);
    expect(t.reserveHeight()).toBe(2250 + 600 - (44 + 2300 + 130));
  });

  it("用户往上滚就停；回答进行中不会被拉回", () => {
    const t = setup({ height: 2000, items: [{ role: "user", top: 1900 }] });
    t.controller.send();
    t.runFrames();
    t.userScroll(1000);
    expect(t.controller.mode()).toBe("free");
    t.state.height = 2600;
    t.controller.layout();
    expect(t.scroller.scrollTop).toBe(1000);
  });

  it("跟随中往上滚停跟随；内容缩短被浏览器夹回不算用户滚动", () => {
    const t = setup({ height: 2000 });
    t.state.height = 1900;
    t.scroller.scrollTop = 9999; // 夹到新末尾
    t.fire("scroll");
    expect(t.controller.mode()).toBe("follow");
    t.userScroll(500);
    expect(t.controller.mode()).toBe("free");
    t.state.height = 2500;
    t.controller.layout();
    expect(t.scroller.scrollTop).toBe(500);
  });

  it("置顶动画中用户一动手就交还控制", () => {
    const t = setup({ height: 2000, items: [{ role: "user", top: 1900 }] });
    t.scroller.scrollTop = 0;
    t.controller.send();
    t.fire("wheel", { deltaY: -10 });
    expect(t.frames.length).toBe(0);
    expect(t.controller.mode()).toBe("free");
  });

  it("减少动态效果时置顶是瞬时的", () => {
    const t = setup({ reduced: true, height: 2000, items: [{ role: "user", top: 1900 }] });
    t.controller.send();
    expect(t.frames.length).toBe(0);
    expect(t.scroller.scrollTop).toBe(1900);
  });

  it("找不到刚发的那条（群聊）就照旧滚到底并跟随", () => {
    const t = setup({ height: 2000 });
    t.userScroll(300);
    t.controller.send();
    t.runFrames();
    expect(t.controller.mode()).toBe("follow");
    expect(t.scroller.scrollTop).toBe(44 + 2000 + 130 - 600);
  });

  it("换频道：清掉留白，直接落到底部并跟随", () => {
    const t = setup({ height: 2000, items: [{ role: "user", top: 1900 }] });
    t.controller.send();
    t.runFrames();
    t.controller.reset();
    expect(t.reserveHeight()).toBe(0);
    expect(t.scroller.scrollTop).toBe(44 + 2000 + 130 - 600);
    expect(t.controller.mode()).toBe("follow");
  });

  it("从气泡打开：停在最后一条回答的开头，不跟随", () => {
    const t = setup({ anchor: "reply", height: 3000, items: [{ role: "assistant", top: 500 }, { role: "assistant", top: 1500 }] });
    t.controller.anchorReply();
    expect(t.scroller.scrollTop).toBe(1500);
    expect(t.controller.mode()).toBe("free");
    t.state.height = 3500;
    t.controller.layout();
    expect(t.scroller.scrollTop).toBe(1500);
  });
});

describe("讨论台展开 / 收起：宽度变了、正在缩放", () => {
  it("置顶中变宽：刚发那条按重排后的新位置重新置顶，留白跟着重算", () => {
    const t = setup({ height: 2000, items: [{ role: "user", top: 1200 }, { role: "assistant", top: 1400 }, { role: "user", top: 1900 }] });
    t.controller.send();
    t.runFrames();
    expect(t.scroller.scrollTop).toBe(1900);
    // 对话列 360 → 680：上面的内容重排变矮，刚发那条上移到 1500，内容总高 1700
    t.state.width = 680; t.state.height = 1700;
    t.state.items[0].top = 1000; t.state.items[1].top = 1150; t.state.items[2].top = 1500;
    t.controller.layout();
    expect(t.controller.mode()).toBe("pinned");
    expect(t.scroller.scrollTop).toBe(1500);
    expect(t.reserveHeight()).toBe(1500 + 600 - (44 + 1700 + 130));
  });

  it("自由浏览时变宽：视口顶上那条留在原来的位置", () => {
    const t = setup({ height: 3000, items: [{ role: "user", top: 800 }, { role: "assistant", top: 1000, h: 600 }, { role: "user", top: 2000 }] });
    t.userScroll(1100);
    expect(t.controller.mode()).toBe("free");
    t.state.width = 680; t.state.height = 2700;
    t.state.items[0].top = 600; t.state.items[1].top = 700; t.state.items[1].h = 500; t.state.items[2].top = 1500;
    t.controller.layout();
    // 回答顶边原来在留白线上方 100px（1000 - 1100 + 0），重排后仍是：700 - 800
    expect(t.scroller.scrollTop).toBe(800);
    expect(t.controller.mode()).toBe("free");
  });

  it("滚动区正被整体缩放（展开动画）时发送：置顶仍按布局距离算", () => {
    const t = setup({ height: 2000, scale: 0.5, items: [{ role: "user", top: 1900 }] });
    t.controller.send();
    t.runFrames();
    expect(t.scroller.scrollTop).toBe(1900);
    expect(t.reserveHeight()).toBe(1900 + 600 - (44 + 2000 + 130));
  });

  it("宽度没变时（流式中内容长高）不重新校正，行为和原来一样", () => {
    const t = setup({ height: 2000, items: [{ role: "user", top: 1900 }] });
    t.controller.send(); t.runFrames();
    t.state.height = 2200; t.controller.layout();
    expect(t.scroller.scrollTop).toBe(1900);
  });

  it("「待确认 N」：把提案卡滚到顶部留白之下，之后内容再长也不跟随", () => {
    const t = setup({ reduced: true, height: 3000, items: [{ role: "proposal", top: 1200 }] });
    const [card] = t.content.querySelectorAll('[data-chat-role="proposal"]');
    t.controller.reveal(card as unknown as HTMLElement);
    expect(t.scroller.scrollTop).toBe(1200);
    expect(t.controller.mode()).toBe("free");
    t.state.height = 3500; t.controller.layout();
    expect(t.scroller.scrollTop).toBe(1200);
  });

  describe("跟随时一整段到了：短促滑过去（流畅感第 3 条）", () => {
    it("纯函数：打开一会儿以后、长高超过半屏、不超过三屏才滑", () => {
      expect(followGlides({ jump: 400, viewport: 600, sinceOpen: OPEN_SETTLE_MS })).toBe(true);
      expect(followGlides({ jump: 200, viewport: 600, sinceOpen: OPEN_SETTLE_MS })).toBe(false);
      expect(followGlides({ jump: 400, viewport: 600, sinceOpen: OPEN_SETTLE_MS - 1 })).toBe(false);
      expect(followGlides({ jump: 2000, viewport: 600, sinceOpen: OPEN_SETTLE_MS })).toBe(false);
    });

    it("长高超过半屏：不瞬间跳，约 240ms 缓动到底；逐字的小增长照旧直接贴底", () => {
      const t = setup({ height: 2000 });
      t.advance(OPEN_SETTLE_MS);
      const end = (h: number) => 44 + h + 130 - 600;
      t.state.height = 2100;
      t.controller.layout();
      expect(t.scroller.scrollTop).toBe(end(2100));
      expect(t.frames.length).toBe(0);
      t.state.height = 2600;
      t.controller.layout();
      expect(t.scroller.scrollTop).toBe(end(2100));
      expect(t.frames.length).toBe(1);
      t.runFrames(100);
      expect(t.scroller.scrollTop).toBeGreaterThan(end(2100));
      expect(t.scroller.scrollTop).toBeLessThan(end(2600));
      t.runFrames();
      expect(t.scroller.scrollTop).toBe(end(2600));
      expect(t.controller.mode()).toBe("follow");
    });

    it("滑动途中本人往上滚：立刻停下、不再跟随", () => {
      const t = setup({ height: 2000 });
      t.advance(OPEN_SETTLE_MS);
      t.state.height = 2600;
      t.controller.layout();
      t.runFrames(60);
      const at = t.scroller.scrollTop;
      t.userScroll(at - 200);
      expect(t.frames.length).toBe(0);
      expect(t.controller.mode()).toBe("free");
      t.state.height = 3000;
      t.controller.layout();
      expect(t.scroller.scrollTop).toBe(at - 200);
    });

    it("减少动效、刚打开（历史一次到）、一次长高超过三屏：照旧瞬间到底", () => {
      const reduced = setup({ height: 2000, reduced: true });
      reduced.advance(OPEN_SETTLE_MS);
      reduced.state.height = 2600;
      reduced.controller.layout();
      expect(reduced.scroller.scrollTop).toBe(44 + 2600 + 130 - 600);
      const fresh = setup({ height: 2000 });
      fresh.state.height = 2600;
      fresh.controller.layout();
      expect(fresh.scroller.scrollTop).toBe(44 + 2600 + 130 - 600);
      const huge = setup({ height: 2000 });
      huge.advance(OPEN_SETTLE_MS);
      huge.state.height = 5000;
      huge.controller.layout();
      expect(huge.scroller.scrollTop).toBe(44 + 5000 + 130 - 600);
    });
  });
});
