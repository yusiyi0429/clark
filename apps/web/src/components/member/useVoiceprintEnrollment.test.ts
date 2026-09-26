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
const api = vi.hoisted(() => ({ GET: vi.fn(), DELETE: vi.fn() }));
vi.mock("react", () => hooks);
vi.mock("@/lib/api/client", () => ({ browserApi: api }));

import { useVoiceprintEnrollment, type VoiceprintStatus } from "./useVoiceprintEnrollment";

class Recorder {
  static instances: Recorder[] = [];
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly stream: MediaStream) { Recorder.instances.push(this); }
  start = vi.fn(() => { this.state = "recording"; });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["recorded audio"], { type: this.mimeType }) });
    this.onstop?.();
  });
}

class AudioContextMock {
  static instances: AudioContextMock[] = [];
  state = "running";
  source = { connect: vi.fn(), disconnect: vi.fn() };
  analyser = { fftSize: 0, getByteTimeDomainData: (data: Uint8Array) => data.fill(144), disconnect: vi.fn() };
  createMediaStreamSource = vi.fn(() => this.source);
  createAnalyser = vi.fn(() => this.analyser);
  resume = vi.fn(async () => {});
  close = vi.fn(async () => { this.state = "closed"; });
  constructor() { AudioContextMock.instances.push(this); }
}

const initialStatus: VoiceprintStatus = { configured: true, enrolled: false, updatedAt: null };
const enrolled: VoiceprintStatus = { configured: true, enrolled: true, updatedAt: "2026-09-27T01:00:00.000Z" };
let state: ReturnType<typeof useVoiceprintEnrollment>;
let trackStop: ReturnType<typeof vi.fn>;
let stream: MediaStream;
let getUserMedia: ReturnType<typeof vi.fn>;
let requestFrame: ReturnType<typeof vi.fn>;
let cancelFrame: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

function render(status: VoiceprintStatus | undefined = initialStatus) {
  hooks.begin();
  state = useVoiceprintEnrollment({ initialStatus: status });
  hooks.flush();
  return state;
}

async function startConsented() {
  render().setConsent(true);
  await render().start();
  render();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-27T00:00:00Z"));
  Recorder.instances = [];
  AudioContextMock.instances = [];
  trackStop = vi.fn();
  stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
  getUserMedia = vi.fn().mockResolvedValue(stream);
  requestFrame = vi.fn().mockReturnValue(1);
  cancelFrame = vi.fn();
  fetchMock = vi.fn().mockResolvedValue(Response.json(enrolled));
  api.GET.mockResolvedValue({ data: initialStatus });
  api.DELETE.mockResolvedValue({ response: new Response(null, { status: 204 }) });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame,
    AudioContext: AudioContextMock,
  });
});

afterEach(() => {
  hooks.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("共享声纹录入", () => {
  it("首次状态可直接来自引导快照；未同意不会请求麦克风", async () => {
    expect(render().status).toEqual(initialStatus);
    await state.start();
    expect(api.GET).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(state.recording).toBe(false);
  });

  it("录音和音量使用同一条流，15 秒可停；保存返回已录好的状态", async () => {
    await startConsented();
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true });
    expect(Recorder.instances[0].stream).toBe(stream);
    const context = AudioContextMock.instances[0];
    expect(context.createMediaStreamSource).toHaveBeenCalledWith(stream);
    expect(context.source.connect).toHaveBeenCalledWith(context.analyser);
    expect(state.level).toBeCloseTo(0.5);
    expect(state.recording).toBe(true);
    vi.advanceTimersByTime(14_750);
    expect(render().canStop).toBe(false);
    vi.advanceTimersByTime(250);
    expect(render().canStop).toBe(true);
    state.stop();
    expect(render().phase).toBe("recorded");
    expect(state.seconds).toBe(15);
    expect(trackStop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(state.level).toBe(0);
    await expect(state.save()).resolves.toEqual(enrolled);
    expect(render().status).toEqual(enrolled);
    expect(state.phase).toBe("idle");
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me/voiceprint");
    expect(options.method).toBe("POST");
    const form = options.body as FormData;
    expect(form.get("consent")).toBe("true");
    expect((form.get("audio") as File).name).toBe("voiceprint.webm");
  });

  it("30 秒自动停；停止后的计时和分析不会继续运行", async () => {
    await startConsented();
    vi.advanceTimersByTime(30_000);
    expect(render().phase).toBe("recorded");
    expect(state.seconds).toBe(30);
    expect(Recorder.instances[0].stop).toHaveBeenCalledOnce();
    expect(trackStop).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10_000);
    expect(render().seconds).toBe(30);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("父组件重绘时重建状态快照，不会中断正在进行的录音", async () => {
    await startConsented();
    expect(render({ ...initialStatus }).recording).toBe(true);
    expect(trackStop).not.toHaveBeenCalled();
    expect(Recorder.instances[0].state).toBe("recording");
  });

  it("保留声纹卡提前停止的行为，过短音频不能上传", async () => {
    await startConsented();
    vi.advanceTimersByTime(4000);
    state.stop();
    expect(render().tooShort).toBe(true);
    await expect(state.save()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("上传失败保留录音，重试后能保存", async () => {
    await startConsented();
    vi.advanceTimersByTime(15_000);
    state.stop();
    render();
    fetchMock.mockResolvedValueOnce(Response.json({ message: "声音太小，请重试。" }, { status: 400 }));
    await expect(state.save()).resolves.toBeNull();
    expect(render().phase).toBe("recorded");
    expect(state.error).toBe("声音太小，请重试。");
    await expect(state.save()).resolves.toEqual(enrolled);
    expect(render().error).toBeNull();
  });

  it("保存期间离开步骤，失败后仍能回来重试原录音", async () => {
    await startConsented();
    vi.advanceTimersByTime(15_000);
    state.stop();
    render();
    let finish: ((response: Response) => void) | undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = state.save();
    state.cancel();
    finish?.(Response.json({ message: "请重试。" }, { status: 502 }));
    await pending;
    expect(render().phase).toBe("recorded");
    expect(state.seconds).toBe(15);
    await expect(state.save()).resolves.toEqual(enrolled);
  });

  it("已有声纹可删除，之后重新读取服务端状态", async () => {
    render(enrolled);
    await state.remove();
    await Promise.resolve();
    expect(api.DELETE).toHaveBeenCalledWith("/api/me/voiceprint");
    expect(api.GET).toHaveBeenCalledWith("/api/me/voiceprint");
    expect(render(enrolled).status?.enrolled).toBe(false);
    expect(state.note).toContain("已删除");
  });

  it("麦克风拒绝后可以稍后，且不会留下录音或资源", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await startConsented();
    expect(state.error).toBe("麦克风没有授权，录不了声纹。");
    expect(state.starting).toBe(false);
    expect(state.recording).toBe(false);
    state.cancel();
    expect(render().phase).toBe("idle");
    expect(Recorder.instances).toHaveLength(0);
  });

  it("离开声纹步骤立即释放录音、音频节点、计时和动画帧", async () => {
    await startConsented();
    state.cancel();
    expect(render().phase).toBe("idle");
    expect(state.level).toBe(0);
    expect(trackStop).toHaveBeenCalledOnce();
    expect(Recorder.instances[0].stop).toHaveBeenCalledOnce();
    expect(AudioContextMock.instances[0].source.disconnect).toHaveBeenCalledOnce();
    expect(AudioContextMock.instances[0].analyser.disconnect).toHaveBeenCalledOnce();
    expect(AudioContextMock.instances[0].close).toHaveBeenCalledOnce();
    expect(cancelFrame).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await expect(state.save()).resolves.toBeNull();
  });

  it("卸载时归还麦克风；权限弹窗迟到的授权也不启动录音", async () => {
    let allow: ((stream: MediaStream) => void) | undefined;
    getUserMedia.mockReturnValueOnce(new Promise<MediaStream>((resolve) => { allow = resolve; }));
    render().setConsent(true);
    const pending = render().start();
    hooks.unmount();
    allow?.(stream);
    await pending;
    expect(trackStop).toHaveBeenCalledOnce();
    expect(Recorder.instances).toHaveLength(0);
  });

  it("快速连按开始只申请一条流；取消后迟到的授权立即释放", async () => {
    let allow: ((stream: MediaStream) => void) | undefined;
    getUserMedia.mockReturnValueOnce(new Promise<MediaStream>((resolve) => { allow = resolve; }));
    render().setConsent(true);
    render();
    const first = state.start();
    await state.start();
    state.cancel();
    allow?.(stream);
    await first;
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(trackStop).toHaveBeenCalledOnce();
    expect(render().recording).toBe(false);
  });
});
