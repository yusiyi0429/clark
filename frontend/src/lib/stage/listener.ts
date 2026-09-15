"use client";

import { frameJson, readSse } from "@/lib/agent/sse";
import type { ClientListenConfig } from "@/lib/asr/config";

/**
 * 听他说话的前端那一半。
 *
 * 形状照着 `speaker.ts`：一个类，不认识 React，只往外报事件。两层是对着的 —— 一个把文字
 * 变成声音，一个把声音变成文字。
 *
 * ## 一条链子上的五段
 *
 *   麦克风 → AudioWorklet（`public/asr/mic-worklet.js`，只管切块和算音量）
 *          → 这个文件（判断他在不在说话、按顺序往上发、收识别结果、决定一句话什么时候算说完）
 *          → `POST /api/listen` 一块一块的 PCM16
 *          → `lib/asr/relay.ts` 转给厂商
 *          → `GET /api/listen` 的 SSE 把 partial / final 送回来
 *
 * ## 三条必须做对的事
 *
 * 1. **半双工**。参谋在念的时候不往上发音频。会议室的音箱声会被麦克风收回来，不挡的话有两个
 *    后果：参谋被自己的声音打断，以及它自己念的那段话被识别成「他说的」再塞进下一轮 ——
 *    参谋自己跟自己聊起来，这是会上最难收场的一种失控。这一条比任何回声消除都可靠。
 *
 * 2. **前置缓冲**。「他开口了」这个判断必然滞后（要连续 `voiceHoldMs` 才算），所以第一个字
 *    总是已经过去了。这里留一个环形缓冲，触发时把之前 400 毫秒一起补发 —— 否则每句话都缺
 *    一个字头，「们这个月」。
 *
 * 3. **上行必须有序**。音频块之间不能并发发：两个 POST 谁先到不保证，错序的音频厂商认出来
 *    是一句谁也听不懂的话。所以同一时刻只有一个请求在飞，攒下来的块合成一块发。慢的时候
 *    自动变成「块更大、请求更少」，这正是想要的退化方式。
 */

export type ListenerState =
  /** 没开麦。 */
  | "off"
  /** 正在要权限、建连接。 */
  | "starting"
  /** 开着，在听。 */
  | "listening"
  /** 开着，但参谋正在念 —— 这半分钟不往上发（半双工）。 */
  | "muted"
  /** 这条路今天不通，用语音条那个输入框。 */
  | "failed";

export interface ListenerHooks {
  /** 听到了什么。`final` 之前会带着同一段话报很多次。字幕区显示这个。 */
  onHeard?: (text: string, final: boolean) => void;
  /** 这一句他说完了 —— 塞进 Agent 那一轮。 */
  onCommit?: (text: string) => void;
  /** 他抢话了。参谋当场闭嘴。 */
  onBargeIn?: () => void;
  onState?: (state: ListenerState) => void;
  /** 出错了。要让人看得见 —— 「麦克风灯亮着但一个字都不出来」是最坏的状态。 */
  onError?: (message: string) => void;
}

/** 上行最多积压多少毫秒的音频。超了丢最旧的 —— 追不上的时候，掉一点比越落越远好。 */
const MAX_BACKLOG_MS = 5_000;

/** 服务端说「中转还没建立」（409）之后，隔多久重连那条 SSE。 */
const RECONNECT_MS = 1_000;

export class Listener {
  private hooks: ListenerHooks;
  private session: string;

  private cfg: ClientListenConfig | null = null;
  private state: ListenerState = "off";

  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private mic: MediaStream | null = null;

  /** 下行那条 SSE。掐它用这个。 */
  private down: AbortController | null = null;
  /** 开麦一次 +1。回调回来的时候对不上就直接扔掉 —— 关了又开的那一下最容易串。 */
  private epoch = 0;

  /* --- VAD 那几个计数器，单位毫秒 --- */
  private voicedMs = 0;
  private silentMs = 0;
  /** 现在算他在说话（在往上发音频）。 */
  private voiced = false;
  /** 参谋在念，这半分钟不发。 */
  private blocked = false;

  /* --- 上行 --- */
  private outbox: Uint8Array[] = [];
  private ring: Uint8Array[] = [];
  private ringBytes = 0;
  private sending = false;

  /* --- 识别结果 --- */
  /** 还没提交的那一句。厂商报 final 或者本地静音到点，谁先到谁提交。 */
  private pending: { key: string; text: string } | null = null;
  /** 提交过的句子。厂商的 final 和本地那个定时器会想提交同一句，这个集合挡住第二次。 */
  private committed = new Set<string>();
  /** 本地那个保险定时器。 */
  private commitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(hooks: ListenerHooks = {}, session = "demo") {
    this.hooks = hooks;
    this.session = session;
  }

  get current(): ListenerState {
    return this.state;
  }

  /**
   * 开麦。
   *
   * 必须由一次真实的点击触发 —— 浏览器不给非手势的 `getUserMedia`，而且开会前就热着的麦克风
   * 本身也不该存在。语音条上那个按钮就是这一下。
   */
  async start(): Promise<void> {
    if (this.state === "starting" || this.state === "listening" || this.state === "muted") return;
    const mine = ++this.epoch;
    this.setState("starting");

    /*
     * 先建下行那条线，再要麦克风。
     *
     * 顺序是有讲究的：配置（采样率、几个阈值）在下行那一帧里，而 `AudioContext` 要用采样率
     * 才建得出来。反过来的话，前端就得自己写一份默认值 —— 那份值和 `demo/voice.json` 迟早
     * 对不上，而对不上的表现是「服务端按新阈值切句、前端按旧阈值判他在说话」。
     */
    const cfg = await this.connect(mine);
    if (!cfg || this.epoch !== mine) return;
    this.cfg = cfg;

    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          /*
           * 浏览器自带的回声消除照样开着。
           *
           * 它挡不住外接音箱那条声路（浏览器不知道那台音箱在放什么），所以真正靠得住的是
           * 上面那条半双工。但它免费，而且对笔记本自带扬声器那种情况确实有效 —— 两条一起用。
           */
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (this.epoch !== mine) {
        for (const t of mic.getTracks()) t.stop();
        return;
      }
      this.mic = mic;

      const ctx = new AudioContext({ sampleRate: cfg.sampleRate });
      this.ctx = ctx;
      await ctx.audioWorklet.addModule("/asr/mic-worklet.js");
      if (this.epoch !== mine) return;

      const node = new AudioWorkletNode(ctx, "mic", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { chunkMs: cfg.chunkMs },
      });
      node.port.onmessage = (e: MessageEvent) => {
        if (this.epoch !== mine) return;
        const data = e.data as { audio: ArrayBuffer; rms: number; rate: number };
        this.onBlock(new Float32Array(data.audio), data.rms, data.rate);
      };
      this.node = node;

      this.source = ctx.createMediaStreamSource(mic);
      /*
       * 不接到 `destination`。
       *
       * 接上去就是把麦克风原声送回音箱 —— 一个瞬间起振的啸叫。这个节点没有输出
       * （`numberOfOutputs: 0`），它只是个抽头。
       */
      this.source.connect(node);

      // 他自己把麦克风拔了、或者系统把设备切走了。
      for (const track of mic.getAudioTracks()) {
        track.addEventListener("ended", () => {
          if (this.epoch === mine) this.fail("麦克风断了。");
        });
      }

      this.setState(this.blocked ? "muted" : "listening");
    } catch (e) {
      /*
       * 最常见的两种：他点了「拒绝」，和这一页不是 https（麦克风只在安全上下文里给）。
       * 两种都不该只是一句「出错了」—— 会上那三十秒不够用来猜。
       */
      const why =
        e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")
          ? "麦克风没给权限。地址栏那个图标里可以放开；用输入框也能接着开。"
          : e instanceof Error
            ? e.message
            : "麦克风打不开。";
      this.fail(why);
    }
  }

  /** 关麦。整条链子拆干净 —— 麦克风灯还亮着的浏览器标签页在会上很难解释。 */
  stop(): void {
    this.epoch++;
    this.clearCommitTimer();

    this.down?.abort();
    this.down = null;

    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    this.source?.disconnect();
    this.source = null;
    if (this.mic) {
      for (const t of this.mic.getTracks()) t.stop();
      this.mic = null;
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }

    this.outbox = [];
    this.ring = [];
    this.ringBytes = 0;
    this.sending = false;
    this.voiced = false;
    this.voicedMs = 0;
    this.silentMs = 0;
    this.pending = null;
    this.committed.clear();

    // 让服务端把厂商那条连接也收掉，别挂着计费。
    void this.control("close");
    this.setState("off");
  }

  async toggle(): Promise<void> {
    if (this.state === "off" || this.state === "failed") await this.start();
    else this.stop();
  }

  /**
   * 参谋开口 / 念完了。
   *
   * 这是半双工那个闸门。念的时候不往上发音频，只留一个更高的门槛盯着抢话。
   */
  agentSpeaking(on: boolean): void {
    if (this.blocked === on) return;
    this.blocked = on;
    this.voicedMs = 0;
    this.silentMs = 0;
    if (on && this.voiced) {
      // 他上一句还没收尾就被参谋接上了 —— 把嘴边这一句先交出去，别丢。
      this.endUtterance();
    }
    if (this.state === "listening" || this.state === "muted") {
      this.setState(on ? "muted" : "listening");
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 下行                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * 建下行那条 SSE，等第一帧 `ready` 把配置拿回来。
   *
   * 用 `fetch` + `readSse` 而不是 `EventSource`：`EventSource` 看不见状态码，没配 key 那个
   * 503 和「网断了」在它眼里是同一件事 —— 而这两件事在会上要说的话完全不同。`/api/chat`
   * 那条流也是这么读的，编解码是同一套。
   */
  private async connect(mine: number): Promise<ClientListenConfig | null> {
    const ctl = new AbortController();
    this.down = ctl;

    let res: Response;
    try {
      res = await fetch(`/api/listen?session=${encodeURIComponent(this.session)}`, {
        signal: ctl.signal,
        headers: { Accept: "text/event-stream" },
      });
    } catch {
      if (this.epoch === mine) this.fail("识别服务连不上。");
      return null;
    }
    if (this.epoch !== mine) return null;

    if (!res.ok || !res.body) {
      const why = (await res.json().catch(() => null)) as { error?: string } | null;
      this.fail(why?.error ?? `识别服务起不来（HTTP ${res.status}）。`);
      return null;
    }

    /*
     * 先把 `ready` 那一帧等出来，剩下的帧交给一个后台循环慢慢读。
     *
     * 这个 promise 是「开麦」这件事的成败信号，所以它只等第一帧；如果流开着但一帧都不来
     * （服务端卡住），`start()` 会一直挂在这儿 —— 所以下面那个超时是必须的。
     */
    return await new Promise<ClientListenConfig | null>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.fail("识别服务没有响应。");
        resolve(null);
      }, 6_000);

      const pump = async () => {
        try {
          for await (const frame of readSse(res.body as ReadableStream<Uint8Array>)) {
            if (this.epoch !== mine) return;
            const data = frameJson(frame);
            if (frame.event === "ready") {
              const cfg = (data as { config?: ClientListenConfig } | null)?.config;
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(cfg ?? null);
              }
              continue;
            }
            this.onFrame(frame.event, data);
          }
          /*
           * 流自己结束了。
           *
           * 麦克风还开着就是断线（会议室 wifi 抖一下），不是收工 —— 重连。中转在服务端已经
           * 随着这条流关掉了，所以重连会新建一个，那也是我们要的。
           */
          if (this.epoch === mine && this.state !== "off" && this.state !== "failed") {
            setTimeout(() => {
              if (this.epoch === mine) void this.reconnect(mine);
            }, RECONNECT_MS);
          }
        } catch {
          /* abort 或者读坏了。断线那条路上面已经处理。 */
        } finally {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(null);
          }
        }
      };
      void pump();
    });
  }

  /** 断了重接。音频这一头不动 —— 麦克风、worklet、context 都还在原地。 */
  private async reconnect(mine: number): Promise<void> {
    if (this.epoch !== mine) return;
    const cfg = await this.connect(mine);
    if (cfg && this.epoch === mine) this.cfg = cfg;
  }

  private onFrame(event: string, data: unknown): void {
    if (event === "partial" || event === "final") {
      const r = data as { key?: string; text?: string } | null;
      const key = typeof r?.key === "string" ? r.key : "";
      const text = typeof r?.text === "string" ? r.text.trim() : "";
      if (!key || !text) return;
      if (this.committed.has(key)) return;

      this.pending = { key, text };
      this.hooks.onHeard?.(text, event === "final");
      if (event === "final") this.commit();
      return;
    }

    if (event === "error") {
      const r = data as { message?: string; fatal?: boolean } | null;
      const message = typeof r?.message === "string" ? r.message : "语音识别出错了。";
      if (r?.fatal) this.fail(message);
      else this.hooks.onError?.(message);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 一块音频到了                                                            */
  /* ---------------------------------------------------------------------- */

  private onBlock(samples: Float32Array, rms: number, rate: number): void {
    const cfg = this.cfg;
    if (!cfg || !samples.length) return;
    const ms = (samples.length / rate) * 1000;

    /*
     * 参谋在念的时候：只盯抢话，不发音频。
     *
     * 门槛用的是更高的那个（`bargeInRms`），而且要连续够久 —— 抢话的代价是把参谋掐断，
     * 一次误判（咳嗽、椅子响、音箱里一个重音）在会上就是参谋无缘无故闭嘴。
     */
    if (this.blocked) {
      if (rms >= cfg.bargeInRms) {
        this.voicedMs += ms;
        if (this.voicedMs >= cfg.bargeInHoldMs) {
          /*
           * 他抢话了。
           *
           * 本地立刻放闸，不等 `agentSpeaking(false)` 那一圈回来 —— 那一圈要经过 React 的
           * 一次渲染，几十毫秒里说的那几个字正是他打断时最想说的。
           */
          this.blocked = false;
          this.voicedMs = 0;
          this.silentMs = 0;
          this.setState("listening");
          this.hooks.onBargeIn?.();
        }
      } else {
        this.voicedMs = 0;
      }
      // 存进环形缓冲。放闸之后第一件事就是把它补发出去，抢话那几个字才不会丢。
      this.keep(this.toPcm16(samples, rate, cfg.sampleRate), cfg);
      return;
    }

    const loud = rms >= cfg.voiceRms;
    if (loud) {
      this.voicedMs += ms;
      this.silentMs = 0;
    } else {
      this.silentMs += ms;
      this.voicedMs = 0;
    }

    const pcm = this.toPcm16(samples, rate, cfg.sampleRate);

    // 他开口了：先把前置缓冲倒出去，再接这一块 —— 顺序不能反。
    if (!this.voiced && loud && this.voicedMs >= cfg.voiceHoldMs) {
      this.voiced = true;
      this.outbox.push(...this.ring);
      this.ring = [];
      this.ringBytes = 0;
      this.armCommitTimer();
    }

    if (this.voiced) {
      this.outbox.push(pcm);
      this.trimBacklog(cfg);
      void this.pump();
      // 静够了就收句。厂商那边通常先报 final，这里是它不报时候的保险。
      if (this.silentMs >= cfg.silenceMs + cfg.graceMs) this.endUtterance();
    } else {
      this.keep(pcm, cfg);
    }
  }

  /** 进环形缓冲，只留最近这几百毫秒。 */
  private keep(pcm: Uint8Array, cfg: ClientListenConfig): void {
    // 抢话那个判断本身要花 `bargeInHoldMs`，缓冲比它短就等于白留。
    const keepMs = Math.max(cfg.preRollMs, cfg.bargeInHoldMs + 200);
    const limit = Math.round((cfg.sampleRate * 2 * keepMs) / 1000);
    this.ring.push(pcm);
    this.ringBytes += pcm.byteLength;
    while (this.ring.length > 1 && this.ringBytes > limit) {
      this.ringBytes -= (this.ring.shift() as Uint8Array).byteLength;
    }
  }

  /** 一句话说完了：停发、让服务端把厂商那条连接收尾、把嘴边这句交出去。 */
  private endUtterance(): void {
    if (!this.voiced) return;
    this.voiced = false;
    this.voicedMs = 0;
    this.silentMs = 0;
    this.clearCommitTimer();
    void this.pump();
    void this.control("flush");
    this.commit();
  }

  /**
   * 把嘴边这一句交给 Agent。
   *
   * 两条路会走到这儿：厂商报了 `final`，和本地静音到点。`committed` 挡住第二次 —— 同一句
   * 交两遍，会上表现为参谋把同一个问题答两次，而那种错当场没法解释。
   */
  private commit(): void {
    const p = this.pending;
    if (!p || this.committed.has(p.key)) return;
    this.committed.add(p.key);
    this.pending = null;
    this.clearCommitTimer();
    this.hooks.onCommit?.(p.text);
  }

  /**
   * 一句话最长听多久。
   *
   * 静音那条路是主力，这个定时器管的是另一种情况：他一口气说了很久，中间没有一个够长的停顿
   * （念一段数字、连着问三个问题）。不设上限的话这一句会一直攒着不交，参谋在他说完之后还
   * 干站着。
   */
  private armCommitTimer(): void {
    this.clearCommitTimer();
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      if (this.pending) this.endUtterance();
    }, 30_000);
  }

  private clearCommitTimer(): void {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = null;
  }

  /* ---------------------------------------------------------------------- */
  /* 上行                                                                   */
  /* ---------------------------------------------------------------------- */

  /** 积压太多就丢最旧的。追不上的时候，掉一点比越落越远好 —— 落后的识别结果没有用。 */
  private trimBacklog(cfg: ClientListenConfig): void {
    const limit = Math.round((cfg.sampleRate * 2 * MAX_BACKLOG_MS) / 1000);
    let total = 0;
    for (const c of this.outbox) total += c.byteLength;
    while (this.outbox.length > 1 && total > limit) {
      total -= (this.outbox.shift() as Uint8Array).byteLength;
    }
  }

  /**
   * 一个一个发，不并发。
   *
   * 同一时刻只有一个 POST 在飞，攒下来的块合成一块发出去。网慢的时候它自动退化成「块更大、
   * 请求更少」，而不是退化成「块错序」—— 错序的音频厂商认出来是一句谁也听不懂的话。
   */
  private async pump(): Promise<void> {
    if (this.sending || !this.outbox.length) return;
    this.sending = true;
    const mine = this.epoch;
    try {
      while (this.outbox.length && this.epoch === mine) {
        const chunks = this.outbox;
        this.outbox = [];
        let total = 0;
        for (const c of chunks) total += c.byteLength;
        const body = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
          body.set(c, at);
          at += c.byteLength;
        }

        const res = await fetch(`/api/listen?session=${encodeURIComponent(this.session)}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: body as BodyInit,
        });
        if (this.epoch !== mine) return;
        /*
         * 409 = 服务端那个中转不在了（那条 SSE 断过）。
         *
         * 这时候要做的是把下行接回去，不是把麦克风关掉 —— 会议室的 wifi 抖一下就会走到这里。
         * 这一块音频丢掉，接回去之后接着发。
         */
        if (res.status === 409) {
          void this.reconnect(mine);
          return;
        }
      }
    } catch {
      /* 一块发失败不值得报到屏幕上：下一块 120 毫秒后就来了。 */
    } finally {
      this.sending = false;
      if (this.outbox.length && this.epoch === mine) void this.pump();
    }
  }

  private async control(action: "flush" | "close"): Promise<void> {
    try {
      await fetch(`/api/listen?session=${encodeURIComponent(this.session)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    } catch {
      /* 收尾命令送不到就算了 —— 服务端那边空转到点自己会收。 */
    }
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Float32 → PCM16 小端。
   *
   * `rate` 和要的采样率不一样时先线性重采样。这条路平时走不到（`AudioContext` 是按配置里
   * 那个采样率建的，浏览器会自己重采样麦克风输入），它挡的是浏览器不认这个采样率的情况 ——
   * 那时候拿到的音频如果按错的采样率送上去，识别出来是一段变调的胡话。
   *
   * 线性插值不带抗折叠滤波，降采样时高频会折下来。这里认这个账：这是退路，不是主路。
   */
  private toPcm16(samples: Float32Array, rate: number, want: number): Uint8Array {
    const src = rate === want ? samples : resample(samples, rate, want);
    const out = new Uint8Array(src.length * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < src.length; i++) {
      const s = Math.max(-1, Math.min(1, src[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return out;
  }

  private setState(next: ListenerState): void {
    if (this.state === next) return;
    this.state = next;
    this.hooks.onState?.(next);
  }

  /** 这条路不通了。说出来，并且把状态钉在 `failed` —— 语音条据此把输入框亮出来。 */
  private fail(message: string): void {
    this.stop();
    this.setState("failed");
    this.hooks.onError?.(message);
  }
}

function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (to >= from || !input.length) return input;
  const ratio = from / to;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const at = i * ratio;
    const a = Math.floor(at);
    const b = Math.min(a + 1, input.length - 1);
    out[i] = input[a] + (input[b] - input[a]) * (at - a);
  }
  return out;
}
