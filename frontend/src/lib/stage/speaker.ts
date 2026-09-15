"use client";

import {
  FRAME_AUDIO,
  FRAME_ERROR,
  FRAME_MARK,
  FrameReader,
} from "@/lib/tts/frames";

/**
 * 播报层的前端那一半：一个播放队列。
 *
 * 它要同时满足两件互相拉扯的事：
 *
 * 1. **接得上**。参谋说话不能一句一顿。所以音频不是「下完一段放一段」，是拿到就往
 *    `nextStart` 这个时间轴上排 —— 后一块的开始时间就是前一块的结束时间，中间没有间隙。
 * 2. **停得住**。「停止播报」按下去要毫秒级安静。所以停的时候不是等当前这块放完，是把所有
 *    已排上时间轴的 source 全部 `stop()`，同时 abort 在飞的请求。已经排到未来两秒的音频
 *    如果不主动掐掉，会在他说「停」之后继续念两秒 —— 那两秒是会上最尴尬的两秒。
 *
 * 这个类不认识 React。它只往外报三件事：字幕换了、开始/停止出声、出错了。
 *
 * ## 关于自动播放
 *
 * 浏览器不许没有用户手势就出声，`AudioContext` 一开始是 suspended 的。开场那一声因此可能
 * 是哑的 —— 所以这里挂一个一次性的全局监听：他（或者秘书）在这一页上第一次点击/按键，
 * 就把 context 唤醒。会上第一个动作一定是有的（按空格、点一下屏幕），而更实在的做法是
 * 秘书控制台上那个「唤醒声音」按钮，见 `/operator`。
 */

export interface SpeakerHooks {
  /** 现在念到哪一句。字幕跟着这个走。 */
  onCaption?: (text: string) => void;
  /** 开始出声 / 全部念完。语音条那盏灯跟着这个走。 */
  onSpeaking?: (speaking: boolean) => void;
  /** 出错了。要写到字幕上，不许静默地没声音。 */
  onError?: (message: string) => void;
}

/** 要念的一段。`line` 是固定台词的编号，命中预合成就不走厂商。 */
export type Utterance = { text: string } | { line: string; text?: string };

/** 排音频的时候留出的一点提前量。太小会在慢机器上出现咔哒声。 */
const LEAD_SECONDS = 0.12;

export class Speaker {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private hooks: SpeakerHooks = {};

  /** 还没开始取的那些段。取是串行的 —— 并发取回来的顺序不保证，而音频错序听得出来。 */
  private queue: Utterance[] = [];
  private working = false;

  /** 时间轴上「下一块从哪儿开始」。 */
  private nextStart = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private aborts = new Set<AbortController>();
  private timers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * 停一次 +1。
   *
   * 掐掉之后，在飞的那个 `await` 还是会返回一次（fetch 的 abort 不是同步的）。它回来的时候
   * 如果不看这个数，就会把上一场的音频排到新的时间轴上 —— 表现是「按了停，两秒后又自己
   * 响了一声」。
   */
  private epoch = 0;

  /** 最后念的那一段。控制台的「重播当前段」要用它。 */
  private last: Utterance | null = null;
  private speaking = false;

  /**
   * 服务端说了「没配 key」（503）。
   *
   * 记住这件事，是因为一轮话会切成好几段，每一段都会撞同一个 503 —— 那就是同一句错误信息
   * 在字幕上刷五遍，把正在流的正文整场压住。所以：报一次，之后现合成那条路直接不发请求。
   * 带编号的固定台词还是照发 —— 预合成的文件不需要 key，那条路可能还是通的。
   */
  private unavailable = false;
  private removeWakeListeners: (() => void) | null = null;

  constructor(hooks: SpeakerHooks = {}) {
    this.hooks = hooks;
  }

  /** 有没有声音在放。 */
  get isSpeaking(): boolean {
    return this.speaking;
  }

  /**
   * 把 AudioContext 叫醒。
   *
   * 第一次用户手势的时候调，或者秘书按那个按钮的时候调。多调几次没有副作用。
   */
  async unlock(): Promise<void> {
    const ctx = this.audio();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* 还是没手势。下一次点击再来。 */
      }
    }
  }

  /** 排一段进去。前面还在念就接在后面。 */
  speak(utterance: Utterance): void {
    this.queue.push(utterance);
    void this.pump();
  }

  /** 重播最后那一段。会上他说「刚才那句再说一遍」用的就是这条。 */
  replay(): void {
    if (!this.last) return;
    const again = this.last;
    this.stop();
    this.speak(again);
  }

  /**
   * 停。毫秒级安静。
   *
   * 三件事一起做：掐请求、掐已经排上时间轴的音频、掐还没到点的字幕定时器。少做任何一件，
   * 「停」这个动作就是假的。
   */
  stop(): void {
    this.epoch++;
    this.queue.length = 0;

    for (const ctl of this.aborts) ctl.abort();
    this.aborts.clear();

    for (const src of this.sources) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* 还没 start 或者已经停了。 */
      }
    }
    this.sources.clear();

    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();

    this.nextStart = 0;
    this.setSpeaking(false);
  }

  /** Release browser audio resources when the owning view unmounts. */
  dispose(): void {
    this.stop();
    this.removeWakeListeners?.();
    this.removeWakeListeners = null;
    this.gain?.disconnect();
    this.gain = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
  }

  /* ---------------------------------------------------------------------- */

  private audio(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    this.ctx = ctx;
    this.gain = gain;

    // 第一次手势唤醒。只挂一次，醒了就摘掉。
    const wake = () => {
      void ctx.resume().finally(() => {
        if (ctx.state === "running") {
          this.removeWakeListeners?.();
          this.removeWakeListeners = null;
        }
      });
    };
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    this.removeWakeListeners = () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };

    return ctx;
  }

  private setSpeaking(next: boolean) {
    if (this.speaking === next) return;
    this.speaking = next;
    this.hooks.onSpeaking?.(next);
  }

  /** 串行把队列取完。 */
  private async pump(): Promise<void> {
    if (this.working) return;
    this.working = true;
    const mine = this.epoch;
    try {
      while (this.queue.length && this.epoch === mine) {
        const utterance = this.queue.shift() as Utterance;
        this.last = utterance;
        await this.fetchAndSchedule(utterance, mine);
      }
    } finally {
      this.working = false;
      if (this.epoch === mine) this.scheduleIdle(mine);
    }
  }

  private async fetchAndSchedule(utterance: Utterance, mine: number): Promise<void> {
    const canned = "line" in utterance;
    if (this.unavailable && !canned) return;

    const ctl = new AbortController();
    this.aborts.add(ctl);
    /** 这一段还没收到句边界之前，字幕先用整段文字兜着。 */
    let captioned = false;
    const fallback = "text" in utterance ? utterance.text : undefined;

    try {
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctl.signal,
        body: JSON.stringify(utterance),
      });
      if (this.epoch !== mine) return;

      if (!res.ok || !res.body) {
        const why = (await res.json().catch(() => null)) as { error?: string } | null;
        // 503 = 服务端没配 key。这一条只报第一次，之后闭嘴（见 `unavailable`）。
        const first = !this.unavailable;
        if (res.status === 503) this.unavailable = true;
        if (first) this.hooks.onError?.(why?.error ?? `播报出不来（HTTP ${res.status}）。`);
        return;
      }

      const sampleRate = Number(res.headers.get("X-Sample-Rate")) || 22050;
      const reader = res.body.getReader();
      const frames = new FrameReader();
      /** PCM16 是两字节一个采样，chunk 会切在采样中间。多出来那一个字节留到下一块。 */
      let odd: Uint8Array | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.epoch !== mine) break;
        for (const frame of frames.push(value)) {
          if (this.epoch !== mine) break;
          if (frame.kind === FRAME_AUDIO) {
            let bytes = frame.payload;
            if (odd) {
              const merged = new Uint8Array(odd.byteLength + bytes.byteLength);
              merged.set(odd, 0);
              merged.set(bytes, odd.byteLength);
              bytes = merged;
              odd = null;
            }
            if (bytes.byteLength % 2) {
              odd = bytes.subarray(bytes.byteLength - 1);
              bytes = bytes.subarray(0, bytes.byteLength - 1);
            }
            if (!captioned && fallback) {
              captioned = true;
              this.hooks.onCaption?.(fallback);
            }
            this.schedule(bytes, sampleRate, mine);
            continue;
          }
          if (frame.kind === FRAME_MARK) {
            const text = readMark(frame.payload);
            if (text) {
              captioned = true;
              this.captionAt(text, mine);
            }
            continue;
          }
          if (frame.kind === FRAME_ERROR) {
            this.hooks.onError?.(new TextDecoder().decode(frame.payload));
          }
        }
      }
      if (this.epoch === mine) reader.cancel().catch(() => {});
    } catch (e) {
      if (this.epoch !== mine) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      this.hooks.onError?.(e instanceof Error ? e.message : "播报连不上。");
    } finally {
      this.aborts.delete(ctl);
    }
  }

  /** 把一块 PCM 排到时间轴上。 */
  private schedule(pcm: Uint8Array, sampleRate: number, mine: number): void {
    if (!pcm.byteLength || this.epoch !== mine) return;
    const ctx = this.audio();
    const samples = pcm.byteLength >> 1;
    const buffer = ctx.createBuffer(1, samples, sampleRate);
    const channel = buffer.getChannelData(0);
    /*
     * 手写 PCM16 → Float32。
     *
     * 不用 `decodeAudioData`：它要拿到一个完整的文件才解得开，而这里的音频是边下边放的 ——
     * 等文件完整就等于放弃「一秒半出声」那个指标。裸 PCM 换来的就是这一条。
     */
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < samples; i++) {
      channel[i] = view.getInt16(i * 2, true) / 32768;
    }

    const now = ctx.currentTime;
    // 落后了就重新对表：网卡了一下之后不该把后面所有音频都挤成一堆。
    if (this.nextStart < now + LEAD_SECONDS / 2) this.nextStart = now + LEAD_SECONDS;
    const at = this.nextStart;
    this.nextStart += buffer.duration;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain ?? ctx.destination);
    src.onended = () => {
      this.sources.delete(src);
    };
    this.sources.add(src);
    src.start(at);
    this.setSpeaking(true);
  }

  /**
   * 字幕换到这一句 —— 在**它的音频开始响的那一刻**，不是收到帧的那一刻。
   *
   * 句边界帧走在它那一句的音频前面，所以此刻的 `nextStart` 正好是这一句要开始响的时间。
   * 两者之间可能差一两秒（音频已经排到未来了），差这一两秒字幕就跑到嘴前面去了。
   */
  private captionAt(text: string, mine: number): void {
    const ctx = this.audio();
    const delay = Math.max(0, this.nextStart - ctx.currentTime) * 1000;
    if (delay < 30) {
      this.hooks.onCaption?.(text);
      return;
    }
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.epoch === mine) this.hooks.onCaption?.(text);
    }, delay);
    this.timers.add(t);
  }

  /** 排完了：等时间轴走到尽头再把灯灭掉。 */
  private scheduleIdle(mine: number): void {
    if (!this.ctx) {
      this.setSpeaking(false);
      return;
    }
    const delay = Math.max(0, this.nextStart - this.ctx.currentTime) * 1000 + 60;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.epoch === mine && !this.queue.length && !this.working) this.setSpeaking(false);
    }, delay);
    this.timers.add(t);
  }
}

function readMark(payload: Uint8Array): string {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}
