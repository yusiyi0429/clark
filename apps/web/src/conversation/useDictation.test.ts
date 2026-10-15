import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 现有测试环境是 Node；只模拟 hooks 的状态与清理周期。采音 / 连接交给假的引擎（引擎自己的测试在 dictationEngine.test.ts）。
const hooks = vi.hoisted(() => {
  const slots: unknown[] = [];
  let cursor = 0;
  let pending: (() => void)[] = [];
  const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const effect = (run: () => void | (() => void), deps: readonly unknown[]) => {
    const index = cursor++;
    const existing = slots[index] as { deps: readonly unknown[]; cleanup?: () => void } | undefined;
    if (existing && same(existing.deps, deps)) return;
    pending.push(() => {
      existing?.cleanup?.();
      slots[index] = { deps, cleanup: run() };
    });
  };
  return {
    begin() { cursor = 0; },
    flush() { const effects = pending; pending = []; effects.forEach((run) => run()); },
    unmount() {
      for (const slot of slots) (slot as { cleanup?: () => void } | null)?.cleanup?.();
      slots.length = 0;
      pending = [];
    },
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [slots[index] as T, (next: T | ((previous: T) => T)) => {
        slots[index] = typeof next === "function" ? (next as (previous: T) => T)(slots[index] as T) : next;
      }] as const;
    },
    useRef<T>(initial: T) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
    useCallback<T>(callback: T, deps: readonly unknown[]) {
      const index = cursor++;
      const existing = slots[index] as { value: T; deps: readonly unknown[] } | undefined;
      if (!existing || !same(existing.deps, deps)) slots[index] = { value: callback, deps };
      return (slots[index] as { value: T }).value;
    },
    useEffect: effect,
    useLayoutEffect: effect,
  };
});
vi.mock("react", () => hooks);

type FakeEvents = import("./dictationEngine").EngineEvents;
const engines = vi.hoisted(() => ({
  list: [] as { events: FakeEvents; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; realtime: boolean }[],
  outcome: "ok" as string,
  /** ■ / ↑ 时引擎交回的结果；beforeStop 模拟收尾时最后到的识别结果。 */
  stopResult: {} as { error?: string },
  beforeStop: null as null | ((events: FakeEvents) => void),
}));
vi.mock("./dictationEngine", () => ({
  DictationEngine: class {
    realtime = true;
    start = vi.fn(async () => engines.outcome);
    stop = vi.fn(async () => {
      engines.beforeStop?.(this.events);
      return engines.stopResult;
    });
    cancel = vi.fn();
    constructor(_deps: unknown, readonly events: FakeEvents) {
      engines.list.push(this as never);
    }
  },
}));

import { DICTATION_BARS, FRESH_MS, formatElapsed, useDictation, withDictation } from "./useDictation";
import { fullPolishTimeoutMs, SEND_POLISH_DEADLINE_MS } from "./dictationPolish";

let state: ReturnType<typeof useDictation>;
let input: string;
let onValue: ReturnType<typeof vi.fn>;
let onCancel: ReturnType<typeof vi.fn>;
let keyListeners: ((event: KeyboardEvent) => void)[];
let polishCalls: { text: string; mode?: string; resolve: (body: { text: string; polished: boolean }) => void }[];
const field = {
  current: {
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    focus: vi.fn(),
    setSelectionRange: vi.fn(function (this: { selectionStart: number; selectionEnd: number }, start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }),
  },
};

function render() {
  hooks.begin();
  state = useDictation({ field: field as never, value: input, onValue: onValue as never, onCancel: onCancel as never });
  hooks.flush();
  return state;
}

const engine = () => engines.list[engines.list.length - 1];
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
  render();
};

async function listening(text = "", caret = text.length) {
  input = text;
  field.current.value = text;
  field.current.selectionStart = caret;
  field.current.selectionEnd = caret;
  render();
  await state.start();
  render();
  expect(state.phase).toBe("listening");
}

beforeEach(() => {
  vi.useFakeTimers();
  engines.list = [];
  engines.outcome = "ok";
  engines.stopResult = {};
  engines.beforeStop = null;
  keyListeners = [];
  polishCalls = [];
  input = "";
  onValue = vi.fn((value: string) => {
    input = value;
    field.current.value = value;
  });
  onCancel = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
  vi.stubGlobal("AudioWorkletNode", class {});
  vi.stubGlobal("WebSocket", class {});
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    if (url !== "/api/me/dictation/polish") throw new Error(url);
    const { text, mode } = JSON.parse(init.body as string) as { text: string; mode?: string };
    return new Promise<Response>((resolve) => polishCalls.push({ text, mode, resolve: (body) => resolve(Response.json(body)) }));
  }));
  vi.stubGlobal("window", {
    AudioContext: class {},
    addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => { if (type === "keydown") keyListeners.push(listener); },
    removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => { keyListeners = keyListeners.filter((item) => item !== listener); },
  });
});

afterEach(() => {
  hooks.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("输入框听写（实时）", () => {
  it("点麦克风才开始；文字从光标处边说边长，这次说的带下划线", async () => {
    expect(render().phase).toBe("idle");
    expect(engines.list).toHaveLength(0);
    await listening("开头。结尾", 3);
    expect(state.active).toBe(true);
    expect(state.levels).toHaveLength(DICTATION_BARS);
    engine().events.slice("1:0", "中间", false);
    expect(input).toBe("开头。中间结尾");
    expect(render().marks).toEqual([{ start: 3, end: 5 }]);
    engine().events.slice("1:0", "中间一句。", true);
    expect(input).toBe("开头。中间一句。结尾");
    engine().events.level(0.5, 12.3);
    expect(render().elapsed).toBe(12);
    expect(formatElapsed(state.elapsed)).toBe("0:12");
  });

  it("听写中改字：改动并进草稿，识别继续在插入点刷新，改过的那句不再被覆盖", async () => {
    await listening("");
    engine().events.slice("1:0", "下午三点", false);
    expect(render().change("下午3点")).toBe(true);
    expect(input).toBe("下午3点");
    engine().events.slice("1:0", "下午三点开会。", true);
    expect(input).toBe("下午3点开会。");
    expect(render().marks).toEqual([{ start: 4, end: 7 }]);
    // 没在听写时交回调用方处理
    state.cancel();
    expect(render().change("随便")).toBe(false);
  });

  it("输入法组词中：识别结果先排着，组完再写", async () => {
    await listening("");
    state.composition(true);
    engine().events.slice("1:0", "你好", false);
    expect(onValue).not.toHaveBeenCalled();
    state.composition(false);
    expect(input).toBe("你好");
  });

  it("✕ 和 Esc：恢复听写前的原文，立刻归还麦克风", async () => {
    await listening("原来的草稿");
    engine().events.slice("1:0", "多说的", false);
    state.cancel();
    expect(input).toBe("原来的草稿");
    expect(engine().cancel).toHaveBeenCalled();
    expect(render().phase).toBe("idle");
    expect(state.marks).toEqual([]);

    await listening("原来的草稿");
    engine().events.slice("1:0", "又说了", false);
    expect(keyListeners).toHaveLength(1);
    const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent;
    keyListeners[0](event);
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(input).toBe("原来的草稿");
    expect(render().phase).toBe("idle");
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("说话过程中：每句定稿就整理这一句，好了原地替换、下划线消失、给一次淡入（还在听）", async () => {
    await listening("问：");
    engine().events.slice("1:0", "嗯，下午三点开会。", true);
    expect(polishCalls.map((call) => [call.text, call.mode])).toEqual([["嗯，下午三点开会。", undefined]]);
    engine().events.slice("1:1", "呃，带上", false);
    polishCalls[0].resolve({ text: "下午三点开会。", polished: true });
    await settle();
    expect(input).toBe("问：下午三点开会。呃，带上");
    expect(state.phase).toBe("listening");
    expect(state.marks).toEqual([{ start: 9, end: 13 }]);
    expect(state.fresh).toMatchObject({ start: 2, end: 9 });
    await vi.advanceTimersByTimeAsync(FRESH_MS);
    expect(render().fresh).toBeNull();
    // 说话中按 Ctrl+Z 交给输入框自己处理，不收掉这次听写
    const undo = { key: "z", ctrlKey: true, metaKey: false, shiftKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent;
    expect(state.keyDown(undo)).toBe(false);
    expect(render().phase).toBe("listening");
  });

  it("组词中逐句整理好了：先排着，组完再换（不打断输入法）", async () => {
    await listening("");
    engine().events.slice("1:0", "嗯，下午三点开会。", true);
    state.composition(true);
    polishCalls[0].resolve({ text: "下午三点开会。", polished: true });
    await settle();
    expect(input).toBe("嗯，下午三点开会。");
    state.composition(false);
    expect(input).toBe("下午三点开会。");
  });

  it("■：停下后整段再整理一次（含分点），替换成最终结果；逐句的结果这时不再换；Ctrl+Z 还原成整理前", async () => {
    await listening("");
    engine().events.slice("1:0", "下周有三件事，第一个就是签合同。", true);
    engine().events.slice("1:1", "第二个就是催回款。", true);
    engine().events.slice("1:2", "嗯，第三个对口径。", true);
    expect(polishCalls).toHaveLength(3);
    polishCalls[0].resolve({ text: "下周有三件事，第一个签合同。", polished: true });
    await settle();
    expect(input).toBe("下周有三件事，第一个签合同。第二个就是催回款。嗯，第三个对口径。");
    await state.stop();
    render();
    expect(state.phase).toBe("polishing");
    expect(polishCalls[3]).toMatchObject({ text: "下周有三件事，第一个签合同。第二个就是催回款。嗯，第三个对口径。", mode: "full" });
    polishCalls[1].resolve({ text: "第二个催回款。", polished: true });
    await settle();
    expect(input).toBe("下周有三件事，第一个签合同。第二个就是催回款。嗯，第三个对口径。");
    const listed = "下周有三件事。\n1. 签合同。\n2. 催回款。\n3. 对口径。";
    polishCalls[3].resolve({ text: listed, polished: true });
    await settle();
    expect(input).toBe(listed);
    expect(state.phase).toBe("idle");
    expect(state.marks).toEqual([]);
    expect(state.fresh).toMatchObject({ start: 0, end: listed.length });

    const undo = { key: "z", ctrlKey: true, metaKey: false, shiftKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent;
    expect(state.keyDown(undo)).toBe(true);
    expect(input).toBe("下周有三件事，第一个就是签合同。第二个就是催回款。嗯，第三个对口径。");
    expect(render().keyDown(undo)).toBe(false);
  });

  it("整段整理期间用户改了字：整段结果不覆盖手改；逐句整理好、用户没动过的句子照换", async () => {
    await listening("");
    engine().events.slice("1:0", "嗯，下午三点开会。", true);
    engine().events.slice("1:1", "呃，带上材料。", true);
    await state.stop();
    expect(polishCalls[2]).toMatchObject({ text: "嗯，下午三点开会。呃，带上材料。", mode: "full" });
    render().change("嗯，下午三点开会。呃，带上电脑。");
    polishCalls[0].resolve({ text: "下午三点开会。", polished: true });
    polishCalls[2].resolve({ text: "下午三点开会，带上材料。", polished: true });
    await settle();
    expect(input).toBe("下午三点开会。呃，带上电脑。");
    expect(state.phase).toBe("idle");
    expect(state.marks).toEqual([]);
  });

  it("这次听写的范围里有用户自己改过的字：不整段整理，只换逐句的（用户没动过的句子）", async () => {
    await listening("");
    engine().events.slice("1:0", "嗯，下午三点开会。", true);
    engine().events.slice("1:1", "带上材料。", true);
    render().change("嗯，下午三点开会。带上电脑。");
    await state.stop();
    render();
    expect(polishCalls.map((call) => call.mode)).toEqual([undefined]);
    expect(state.phase).toBe("polishing");
    polishCalls[0].resolve({ text: "下午三点开会。", polished: true });
    await settle();
    expect(input).toBe("下午三点开会。带上电脑。");
    expect(state.phase).toBe("idle");
  });

  it("■ 之后用户改了还在整理的那句：逐句、整段都不替换它", async () => {
    await listening("");
    engine().events.slice("1:0", "嗯，下午三点开会。", true);
    await state.stop();
    render().change("嗯，下午四点开会。");
    polishCalls[0].resolve({ text: "下午三点开会。", polished: true });
    polishCalls[1].resolve({ text: "下午三点开会。", polished: true });
    await settle();
    expect(input).toBe("嗯，下午四点开会。");
    expect(state.phase).toBe("idle");
  });

  it("↑：等整段整理，返回整理后的整段（分点的换行原样保留）；已经干净的句子不送", async () => {
    await listening("");
    engine().events.slice("1:0", "下午三点开会。", true);
    engine().events.slice("1:1", "嗯，带上材料。", true);
    expect(polishCalls.map((call) => call.text)).toEqual(["嗯，带上材料。"]);
    const sending = state.finish();
    await vi.advanceTimersByTimeAsync(300);
    expect(polishCalls[1]).toMatchObject({ text: "下午三点开会。嗯，带上材料。", mode: "full" });
    polishCalls[1].resolve({ text: "下午三点开会，带上材料。", polished: true });
    expect(await sending).toBe("下午三点开会，带上材料。");
    expect(render().phase).toBe("idle");
    expect(state.marks).toEqual([]);
  });

  it("↑：整段整理超时（按字数放宽）就发逐句整理好的 / 原文，迟到的结果丢掉，不报错", async () => {
    await listening("");
    engine().events.slice("1:0", "嗯，下午三点开会。", true);
    engine().events.slice("1:1", "呃，带上材料。", true);
    const sending = state.finish();
    await vi.advanceTimersByTimeAsync(0);
    const fullText = "嗯，下午三点开会。呃，带上材料。";
    expect(polishCalls[2]).toMatchObject({ text: fullText, mode: "full" });
    polishCalls[0].resolve({ text: "下午三点开会。", polished: true });
    await vi.advanceTimersByTimeAsync(fullPolishTimeoutMs(fullText) - 1);
    expect(render().phase).toBe("polishing");
    await vi.advanceTimersByTimeAsync(1);
    expect(await sending).toBe("下午三点开会。呃，带上材料。");
    expect(render().marks).toEqual([]);
    expect(state.error).toBeNull();
    polishCalls[2].resolve({ text: "下午三点开会，带上材料。", polished: true });
    polishCalls[1].resolve({ text: "带上材料。", polished: true });
    await settle();
    expect(input).toBe("下午三点开会。呃，带上材料。");
  });

  it("↑：只剩逐句整理（不整段）时最多再等 1.2 秒，超时发原文", async () => {
    await listening("");
    engine().events.slice("1:0", "嗯，下午三点开会。", true);
    engine().events.slice("1:1", "带上材料。", true);
    render().change("嗯，下午三点开会。带上电脑。");
    const sending = state.finish();
    await vi.advanceTimersByTimeAsync(SEND_POLISH_DEADLINE_MS);
    expect(await sending).toBe("嗯，下午三点开会。带上电脑。");
    expect(polishCalls.map((call) => call.mode)).toEqual([undefined]);
  });

  it("■ 之后整理还没完就按发送：settle 等这次整段整理，拿整理后的版本", async () => {
    await listening("");
    engine().events.slice("1:0", "嗯，下午三点开会。", true);
    await state.stop();
    render();
    expect(state.polishing).toBe(true);
    const waiting = state.settle();
    polishCalls[1].resolve({ text: "下午三点开会。", polished: true });
    expect(await waiting).toBe("下午三点开会。");
  });

  it("没听清、引擎报错、没授权、浏览器不支持：说清原因", async () => {
    await listening("草稿");
    await state.stop();
    expect(render().error).toContain("未识别到语音");
    expect(state.phase).toBe("idle");
    expect(input).toBe("草稿");

    engines.stopResult = { error: "语音识别还没配" };
    await listening("");
    expect(await state.finish()).toBeNull();
    expect(render().error).toBe("语音识别还没配");

    engines.outcome = "denied";
    input = "";
    render();
    await state.start();
    expect(render().phase).toBe("idle");
    expect(state.error).toContain("麦克风未授权");

    vi.stubGlobal("AudioWorkletNode", undefined);
    await render().start();
    expect(render().error).toContain("当前浏览器不支持录音");
  });

  it("改成「录完再转」的提示：每种只说一次", async () => {
    await listening("");
    engine().events.mode("batch");
    engine().events.notice("实时转写不可用，已改为说完再转");
    expect(render().error).toBe("实时转写不可用，已改为说完再转");
    expect(state.live).toBe(false);
    state.clearError();
    state.cancel();
    await listening("");
    engine().events.notice("实时转写不可用，已改为说完再转");
    expect(render().error).toBeNull();
  });

  it("转好的文字接在已有输入后面", () => {
    expect(withDictation("", "你好")).toBe("你好");
    expect(withDictation("先说一句，", "再补一句")).toBe("先说一句，再补一句");
    expect(formatElapsed(65)).toBe("1:05");
  });
});
