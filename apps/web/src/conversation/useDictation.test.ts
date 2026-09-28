import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 现有测试环境是 Node；只模拟 hooks 的状态与清理周期，浏览器录音接口各自可观察。
const hooks = vi.hoisted(() => {
  const slots: unknown[] = [];
  let cursor = 0;
  let pending: (() => void)[] = [];
  const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return {
    begin() { cursor = 0; },
    flush() { const effects = pending; pending = []; effects.forEach((effect) => effect()); },
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
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = cursor++;
      const existing = slots[index] as { deps: readonly unknown[]; cleanup?: () => void } | undefined;
      if (existing && same(existing.deps, deps)) return;
      pending.push(() => {
        existing?.cleanup?.();
        slots[index] = { deps, cleanup: effect() };
      });
    },
  };
});
vi.mock("react", () => hooks);

import { DICTATION_DOTS, useDictation, withDictation } from "./useDictation";

class Recorder {
  static instances: Recorder[] = [];
  static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(readonly stream: MediaStream, readonly options?: MediaRecorderOptions) { Recorder.instances.push(this); }
  start = vi.fn(() => { this.state = "recording"; });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["spoken audio"], { type: this.mimeType }) });
    this.onstop?.();
  });
}

class AudioContextMock {
  static instances: AudioContextMock[] = [];
  state = "running";
  source = { connect: vi.fn() };
  analyser = { fftSize: 0, getByteTimeDomainData: (data: Uint8Array) => data.fill(144) };
  createMediaStreamSource = vi.fn(() => this.source);
  createAnalyser = vi.fn(() => this.analyser);
  resume = vi.fn(async () => {});
  close = vi.fn(async () => { this.state = "closed"; });
  constructor() { AudioContextMock.instances.push(this); }
}

let state: ReturnType<typeof useDictation>;
let trackStop: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let keyListeners: ((event: KeyboardEvent) => void)[];

let onCancel: ReturnType<typeof vi.fn>;

function render() {
  hooks.begin();
  state = useDictation({ onCancel });
  hooks.flush();
  return state;
}

async function startListening() {
  await render().start();
  return render();
}

beforeEach(() => {
  vi.useFakeTimers();
  Recorder.instances = [];
  AudioContextMock.instances = [];
  keyListeners = [];
  onCancel = vi.fn();
  trackStop = vi.fn();
  const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
  getUserMedia = vi.fn().mockResolvedValue(stream);
  fetchMock = vi.fn().mockResolvedValue(Response.json({ text: "下周一前把渠道预算定下来。" }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    AudioContext: AudioContextMock,
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

describe("输入框听写", () => {
  it("点麦克风才请求麦克风；录音与音量同一条流，点阵随音量从右往左推", async () => {
    expect(render().phase).toBe("idle");
    expect(getUserMedia).not.toHaveBeenCalled();
    await startListening();
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true });
    expect(state.phase).toBe("listening");
    expect(state.active).toBe(true);
    expect(Recorder.instances[0].options).toEqual({ mimeType: "audio/webm;codecs=opus" });
    expect(AudioContextMock.instances[0].createMediaStreamSource).toHaveBeenCalledWith(Recorder.instances[0].stream);
    expect(state.levels).toHaveLength(DICTATION_DOTS);
    expect(state.levels.every((level) => level === 0)).toBe(true);
    vi.advanceTimersByTime(70 * 3);
    const levels = render().levels;
    expect(levels).toHaveLength(DICTATION_DOTS);
    expect(levels.slice(-3).every((level) => level > 0)).toBe(true);
    expect(levels[0]).toBe(0);
  });

  it("✓：停下、归还麦克风、传给 /api/me/dictation，返回转好的文字", async () => {
    await startListening();
    const text = await state.confirm();
    expect(text).toBe("下周一前把渠道预算定下来。");
    expect(trackStop).toHaveBeenCalled();
    expect(AudioContextMock.instances[0].close).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me/dictation");
    expect(init.method).toBe("POST");
    const audio = (init.body as FormData).get("audio") as File;
    expect(audio.name).toBe("dictation.webm");
    expect(await audio.text()).toBe("spoken audio");
    expect(render().phase).toBe("idle");
    expect(state.error).toBeNull();
  });

  it("✕ 和 Esc：丢掉这段、归还麦克风，不上传", async () => {
    await startListening();
    state.cancel();
    expect(render().phase).toBe("idle");
    expect(trackStop).toHaveBeenCalledOnce();
    await startListening();
    expect(keyListeners).toHaveLength(1);
    const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent;
    keyListeners[0](event);
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(render().phase).toBe("idle");
    expect(trackStop).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    // 两次都告诉输入框「丢掉了」：首页据此缩回原样。
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("没听清、服务端失败、没授权：返回 null 并说清原因", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ text: "" }));
    await startListening();
    expect(await state.confirm()).toBeNull();
    expect(render().error).toContain("没听清");

    fetchMock.mockResolvedValueOnce(Response.json({ code: "DICTATION_NOT_CONFIGURED", message: "语音识别还没配" }, { status: 503 }));
    await startListening();
    expect(state.error).toBeNull();
    expect(await state.confirm()).toBeNull();
    expect(render().error).toBe("语音识别还没配");

    getUserMedia.mockRejectedValueOnce(new Error("denied"));
    await render().start();
    expect(render().phase).toBe("idle");
    expect(state.error).toContain("麦克风没有授权");
  });

  it("权限弹窗还开着时离开：迟到的授权立即归还麦克风", async () => {
    let grant: (stream: MediaStream) => void = () => {};
    getUserMedia.mockReturnValueOnce(new Promise<MediaStream>((resolve) => { grant = resolve; }));
    const pending = render().start();
    expect(render().phase).toBe("starting");
    hooks.unmount();
    grant({ getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream);
    await pending;
    expect(trackStop).toHaveBeenCalledOnce();
    expect(Recorder.instances).toHaveLength(0);
  });

  it("转好的文字接在已有输入后面", () => {
    expect(withDictation("", "你好")).toBe("你好");
    expect(withDictation("先说一句，", "再补一句")).toBe("先说一句，再补一句");
  });
});
