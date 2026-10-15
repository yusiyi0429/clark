import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTICE_QUOTA, NOTICE_UNAVAILABLE } from "./dictationAsr";
import { DictationEngine, MIC_CONSTRAINTS, resetRealtimeAvailability, type EngineDeps, type EngineEvents, type SocketLike } from "./dictationEngine";
import { tencentMessage } from "./dictationFixture";

class FakeSocket implements SocketLike {
  binaryType = "blob";
  sent: (ArrayBuffer | string)[] = [];
  closed = false;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onerror: SocketLike["onerror"] = null;
  onclose: SocketLike["onclose"] = null;
  constructor(readonly url: string) {}
  send(data: ArrayBuffer | string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  /** 服务端发来一条。 */
  emit(raw: string) {
    this.onmessage?.({ data: raw });
  }
  /** 服务端断开（实测 final 之后总是 1006）。 */
  drop(code = 1006) {
    this.onerror?.({});
    this.onclose?.({ code });
  }
  get audio() {
    return this.sent.filter((item): item is ArrayBuffer => typeof item !== "string");
  }
  get audioSamples() {
    return this.audio.reduce((sum, item) => sum + item.byteLength / 2, 0);
  }
}

let sockets: FakeSocket[];
let onFrame: ((frame: Float32Array, rate: number) => void) | null;
let trackStop: ReturnType<typeof vi.fn>;
let captureClose: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let sessionResponses: (() => Response)[];
let events: { [K in keyof EngineEvents]: ReturnType<typeof vi.fn> };

function deps(): EngineDeps {
  return {
    fetch: fetchMock as unknown as typeof fetch,
    getUserMedia: getUserMedia as unknown as EngineDeps["getUserMedia"],
    createCapture: () => ({
      attach: async (_stream, callback) => {
        onFrame = callback;
      },
      close: captureClose,
    }),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/** 说 seconds 秒（16k 输入，40ms 一帧，时钟跟着走）。 */
function speak(seconds: number) {
  const frames = Math.round(seconds / 0.04);
  for (let i = 0; i < frames; i++) {
    vi.advanceTimersByTime(40);
    onFrame?.(Float32Array.from({ length: 640 }, () => 0.2), 16000);
  }
}

async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

async function started() {
  const engine = new DictationEngine(deps(), events as unknown as EngineEvents);
  expect(await engine.start()).toBe("ok");
  await settle();
  return engine;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRealtimeAvailability();
  sockets = [];
  onFrame = null;
  trackStop = vi.fn();
  captureClose = vi.fn();
  getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: trackStop }] });
  sessionResponses = [];
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/me/dictation/session") return (sessionResponses.shift() ?? (() => Response.json({ url: "wss://asr.cloud.tencent.com/asr/v2/1?sig" })))();
    if (url === "/api/me/dictation") return Response.json({ text: "下周一前把渠道预算定下来。" });
    throw new Error(`unexpected ${url}`);
  });
  events = { slice: vi.fn(), drop: vi.fn(), level: vi.fn(), notice: vi.fn(), limit: vi.fn(), mode: vi.fn() };
});

afterEach(() => {
  vi.useRealTimers();
  resetRealtimeAvailability();
});

describe("实时识别：采音、握手前缓冲、发包", () => {
  it("点麦克风时同时请求麦克风和签名地址（不带 body）；握手前的音频先攒着，握手后补发，之后满 200ms 发一包", async () => {
    await started();
    expect(getUserMedia).toHaveBeenCalledWith(MIC_CONSTRAINTS);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me/dictation/session");
    expect(init).toEqual({ method: "POST" });
    const socket = sockets[0];
    expect(socket.url).toBe("wss://asr.cloud.tencent.com/asr/v2/1?sig");
    expect(socket.binaryType).toBe("arraybuffer");

    speak(0.52);
    expect(socket.sent).toHaveLength(0);
    expect(events.level).toHaveBeenCalled();
    socket.emit(tencentMessage(null));
    // 0.52 秒 = 8320 个样本：补发两整包，不满 200ms 的尾巴留着
    expect(socket.audio.map((item) => item.byteLength)).toEqual([6400, 6400]);
    expect(events.mode).toHaveBeenLastCalledWith("realtime");
    speak(0.12);
    expect(socket.audio).toHaveLength(3);
  });

  it("识别结果按句子序号交出去；■ 发尾巴和 end，等 final；final 之后的 1006 关闭不当错误", async () => {
    const engine = await started();
    const socket = sockets[0];
    socket.emit(tencentMessage(null));
    speak(1);
    socket.emit(tencentMessage([1, 0, 880, "嗯那个"]));
    socket.emit(tencentMessage([2, 0, 960, "嗯，那个。"]));
    expect(events.slice.mock.calls).toEqual([
      ["1:0", "嗯那个", false],
      ["1:0", "嗯，那个。", true],
    ]);
    speak(0.12);
    const stopping = engine.stop();
    await settle();
    expect(trackStop).toHaveBeenCalled();
    expect(captureClose).toHaveBeenCalled();
    // 1.12 秒全部发出（最后不满 200ms 的尾巴也发），再发 end
    expect(socket.audioSamples).toBe(17920);
    expect(socket.sent[socket.sent.length - 1]).toBe('{"type":"end"}');
    socket.emit(tencentMessage(null, { final: 1 }));
    expect(await stopping).toEqual({});
    expect(socket.closed).toBe(true);
    socket.drop(1006);
    expect(events.notice).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("停下后 1.5 秒还没等到 final：按现在的样子收下，关掉连接", async () => {
    const engine = await started();
    sockets[0].emit(tencentMessage(null));
    speak(0.4);
    const stopping = engine.stop();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await stopping).toEqual({});
    expect(sockets[0].closed).toBe(true);
  });

  it("握手前就按了 ■：等握手后把整段补发再结束", async () => {
    const engine = await started();
    speak(0.32);
    const stopping = engine.stop();
    await settle();
    sockets[0].emit(tencentMessage(null));
    await settle();
    expect(sockets[0].audioSamples).toBe(5120);
    sockets[0].emit(tencentMessage(null, { final: 1 }));
    expect(await stopping).toEqual({});
  });

  it("录满 5 分钟：通知一次", async () => {
    await started();
    sockets[0].emit(tencentMessage(null));
    for (let i = 0; i < 300; i++) onFrame?.(new Float32Array(16000), 16000);
    expect(events.limit).toHaveBeenCalledTimes(1);
    onFrame?.(new Float32Array(16000), 16000);
    expect(events.limit).toHaveBeenCalledTimes(1);
  });
});

describe("断线重连一次", () => {
  it("握手后断开：换新地址重连，补发上一句定稿之后的音频（≤2 倍实时），旧连接没定稿的句子去掉", async () => {
    await started();
    const first = sockets[0];
    first.emit(tencentMessage(null));
    speak(2);
    first.emit(tencentMessage([2, 0, 1000, "第一句。"]));
    first.emit(tencentMessage([1, 1, 1800, "第二"]));
    first.drop(1006);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = sockets[1];
    expect(first.closed).toBe(true);
    second.emit(tencentMessage(null));
    expect(events.drop).toHaveBeenCalledTimes(1);
    const match = events.drop.mock.calls[0][0] as (key: string) => boolean;
    expect(match("1:1")).toBe(true);
    expect(match("2:0")).toBe(false);
    // 从第 1 秒补：一共 16000 个样本，先冲令牌桶里有的（≤0.8 秒），其余按 2 倍实时（每 100ms 一包 200ms）
    const burst = second.audioSamples;
    expect(burst).toBeGreaterThanOrEqual(9600);
    expect(burst).toBeLessThanOrEqual(12800);
    await vi.advanceTimersByTimeAsync(100);
    expect(second.audioSamples).toBe(Math.min(16000, burst + 3200));
    await vi.advanceTimersByTimeAsync(200);
    expect(second.audioSamples).toBe(16000);
    second.emit(tencentMessage([1, 0, 600, "第二句"]));
    expect(events.slice).toHaveBeenLastCalledWith("2:0", "第二句", false);
    expect(events.notice).not.toHaveBeenCalled();
  });

  it("重连也失败：这次改成录完再转，只转上一句定稿之后的那段", async () => {
    const engine = await started();
    sockets[0].emit(tencentMessage(null));
    speak(2);
    sockets[0].emit(tencentMessage([2, 0, 1000, "第一句。"]));
    sessionResponses.push(() => Response.json({ code: "DICTATION_SESSION_RATE_LIMITED" }, { status: 429 }));
    sockets[0].drop(1006);
    await settle();
    expect(events.notice).toHaveBeenCalledWith(NOTICE_UNAVAILABLE);
    expect(events.mode).toHaveBeenLastCalledWith("batch");
    speak(1);
    expect(await engine.stop()).toEqual({});
    const upload = fetchMock.mock.calls.find(([url]) => url === "/api/me/dictation") as [string, RequestInit];
    const audio = (upload[1].body as FormData).get("audio") as File;
    expect(audio.name).toBe("dictation.wav");
    expect(audio.type).toBe("audio/wav");
    expect(audio.size).toBe(44 + 2 * 32000);
    expect(events.drop).toHaveBeenCalled();
    expect(events.slice).toHaveBeenLastCalledWith(expect.stringMatching(/^batch:/), "下周一前把渠道预算定下来。", true);
  });
});

describe("降级到「录完再转」", () => {
  it("额度用完 4004：提示一次、这次录完再转（整段 PCM 封 WAV 上传），本页后面几次不再试腾讯", async () => {
    const engine = await started();
    sockets[0].emit(JSON.stringify({ code: 4004, message: "资源包用完" }));
    expect(events.notice).toHaveBeenCalledWith(NOTICE_QUOTA);
    expect(sockets[0].closed).toBe(true);
    speak(1);
    expect(await engine.stop()).toEqual({});
    const upload = fetchMock.mock.calls.find(([url]) => url === "/api/me/dictation") as [string, RequestInit];
    expect(((upload[1].body as FormData).get("audio") as File).size).toBe(44 + 32000);
    expect(events.slice).toHaveBeenLastCalledWith(expect.stringMatching(/^batch:/), "下周一前把渠道预算定下来。", true);

    fetchMock.mockClear();
    const next = new DictationEngine(deps(), events as unknown as EngineEvents);
    expect(next.realtime).toBe(false);
    expect(await next.start()).toBe("ok");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.mode).toHaveBeenLastCalledWith("batch");
  });

  it("没配置（503）：提示一次，这次录完再转；转写失败把原因交回去", async () => {
    sessionResponses.push(() => Response.json({ code: "DICTATION_REALTIME_NOT_CONFIGURED" }, { status: 503 }));
    const engine = await started();
    expect(sockets).toHaveLength(0);
    expect(events.notice).toHaveBeenCalledWith(NOTICE_UNAVAILABLE);
    speak(1);
    fetchMock.mockImplementationOnce(async () => Response.json({ message: "语音识别还没配" }, { status: 503 }));
    expect(await engine.stop()).toEqual({ error: "语音识别还没配" });
  });

  it("握手前连接就断了（境外网络等）：这次录完再转", async () => {
    await started();
    sockets[0].drop(1006);
    expect(events.mode).toHaveBeenLastCalledWith("batch");
    expect(events.notice).toHaveBeenCalledWith(NOTICE_UNAVAILABLE);
  });
});

describe("麦克风", () => {
  it("没授权：denied；权限弹窗还开着时取消：迟到的授权立即归还麦克风", async () => {
    getUserMedia.mockRejectedValueOnce(new Error("denied"));
    expect(await new DictationEngine(deps(), events as unknown as EngineEvents).start()).toBe("denied");

    let grant: (stream: MediaStream) => void = () => {};
    getUserMedia.mockReturnValueOnce(new Promise<MediaStream>((resolve) => (grant = resolve)));
    const engine = new DictationEngine(deps(), events as unknown as EngineEvents);
    const pending = engine.start();
    engine.cancel();
    grant({ getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream);
    expect(await pending).toBe("cancelled");
    expect(trackStop).toHaveBeenCalledOnce();
    expect(onFrame).toBeNull();
  });

  it("✕：立刻归还麦克风、关掉连接，之后的消息不再交出去", async () => {
    const engine = await started();
    sockets[0].emit(tencentMessage(null));
    engine.cancel();
    expect(trackStop).toHaveBeenCalled();
    expect(sockets[0].closed).toBe(true);
    sockets[0].emit(tencentMessage([1, 0, 500, "还在说"]));
    expect(events.slice).not.toHaveBeenCalled();
  });
});
